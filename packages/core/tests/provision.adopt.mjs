// Round-trip test for `holderInputsFromAdminReply` — the adapter that
// turns a VTA-minted MinimalAdminReply into the persistence-shape inputs
// the wallet stores under v4. Verifies the cross-checks that protect
// against a buggy or hostile VTA:
//   - multicodec prefix on private keys
//   - X25519 secret == Montgomery(Ed25519 seed)
//   - did:key identifier == multibase(Ed25519 pubkey)

import { test } from "node:test";
import assert from "node:assert/strict";

import { ed25519 } from "@noble/curves/ed25519.js";
import { multibase } from "@openvtc/vti-didcomm-js";

import { holderInputsFromAdminReply } from "../dist/index.js";

// Multicodec varints the VTA uses for private keys (see
// vta-service/src/keys/mod.rs::encode_private_multibase).
const ED25519_PRIV_CODEC = new Uint8Array([0x80, 0x26]); // 0x1300
const X25519_PRIV_CODEC = new Uint8Array([0x82, 0x26]); // 0x1302

function encodePrivate(codec, raw) {
  return multibase.encodeMultikey(codec, raw);
}

function mintFakeReply(overrides = {}) {
  const seed = ed25519.utils.randomSecretKey();
  const edPub = ed25519.getPublicKey(seed);
  const xPriv = ed25519.utils.toMontgomerySecret(seed);
  const edPubMb = multibase.encodeMultikey(multibase.MULTICODEC.ED25519_PUB, edPub);
  return {
    seed,
    reply: {
      adminDid: overrides.adminDid ?? `did:key:${edPubMb}`,
      adminSigningPrivateMultibase:
        overrides.adminSigningPrivateMultibase ?? encodePrivate(ED25519_PRIV_CODEC, seed),
      adminKaPrivateMultibase:
        overrides.adminKaPrivateMultibase ?? encodePrivate(X25519_PRIV_CODEC, xPriv),
      vtaDid: overrides.vtaDid ?? "did:web:vta.example",
      vtaUrl: overrides.vtaUrl,
      summary: {
        client_did: "did:key:zClient",
        admin_did: overrides.adminDid ?? `did:key:${edPubMb}`,
        bundle_id_hex: "00".repeat(16),
        secret_count: 0,
        output_count: 0,
      },
    },
    edPubMb,
  };
}

test("holderInputsFromAdminReply: round-trips a well-formed reply", () => {
  const { seed, reply, edPubMb } = mintFakeReply({ vtaUrl: "https://vta.example" });

  const out = holderInputsFromAdminReply(reply);

  assert.equal(out.did, reply.adminDid);
  assert.equal(out.signingKid, `${reply.adminDid}#${edPubMb}`);
  assert.match(out.keyAgreementKid, new RegExp(`^${reply.adminDid}#z`));
  assert.deepEqual(out.edSeed, seed);
  assert.equal(out.vtaDid, "did:web:vta.example");
  assert.equal(out.vtaUrl, "https://vta.example");
});

test("holderInputsFromAdminReply: rejects mismatched X25519 secret", () => {
  const { reply } = mintFakeReply();
  // Replace the ka_private with a DIFFERENT X25519 secret (random bytes).
  const fakeXPriv = new Uint8Array(32);
  crypto.getRandomValues(fakeXPriv);
  reply.adminKaPrivateMultibase = encodePrivate(X25519_PRIV_CODEC, fakeXPriv);

  assert.throws(
    () => holderInputsFromAdminReply(reply),
    /ka_key\.private_key_multibase does not equal toMontgomerySecret/,
  );
});

test("holderInputsFromAdminReply: rejects did:key identifier mismatch", () => {
  const { reply } = mintFakeReply();
  // Swap adminDid to encode a DIFFERENT Ed25519 pubkey while keeping the
  // private key (so the seed expands to a key that doesn't match the DID).
  const otherPub = ed25519.getPublicKey(ed25519.utils.randomSecretKey());
  const otherMb = multibase.encodeMultikey(multibase.MULTICODEC.ED25519_PUB, otherPub);
  reply.adminDid = `did:key:${otherMb}`;

  assert.throws(
    () => holderInputsFromAdminReply(reply),
    /adminDid's multibase identifier does not encode/,
  );
});

test("holderInputsFromAdminReply: rejects non-Ed25519 did:key", () => {
  const { reply } = mintFakeReply();
  // Build a did:key whose multibase tag is X25519 (a key-agreement DID).
  // The wallet's holder must sign — refusing X25519 holder DIDs is
  // load-bearing security (an X25519-only key can't produce JWS / VPs).
  const xPub = new Uint8Array(32);
  crypto.getRandomValues(xPub);
  const xMb = multibase.encodeMultikey(multibase.MULTICODEC.X25519_PUB, xPub);
  reply.adminDid = `did:key:${xMb}`;

  assert.throws(() => holderInputsFromAdminReply(reply), /not an Ed25519 did:key/);
});

test("holderInputsFromAdminReply: rejects wrong multicodec on signing key", () => {
  const { seed, reply } = mintFakeReply();
  // Encode the seed bytes with the X25519-private codec instead of
  // Ed25519-private. The check defends against a hostile VTA shipping
  // a key with a swapped multicodec tag.
  reply.adminSigningPrivateMultibase = encodePrivate(X25519_PRIV_CODEC, seed);

  assert.throws(
    () => holderInputsFromAdminReply(reply),
    /signing \(Ed25519\) multicodec mismatch/,
  );
});

test("holderInputsFromAdminReply: rejects wrong-length seed", () => {
  const { reply } = mintFakeReply();
  // 31 bytes — one short. Multibase parser is happy, our length guard
  // catches it. (Round-trip via multibase to confirm the underlying
  // bytes are exactly 31.)
  const shortSeed = new Uint8Array(31);
  reply.adminSigningPrivateMultibase = encodePrivate(ED25519_PRIV_CODEC, shortSeed);

  assert.throws(
    () => holderInputsFromAdminReply(reply),
    /signing \(Ed25519\) key length 31 != 32 bytes/,
  );
});
