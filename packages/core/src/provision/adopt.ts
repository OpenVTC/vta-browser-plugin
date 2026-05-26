// Adapt a `MinimalAdminReply` from `runProvisionIntegration` into the
// shape `installVtaMintedHolder` consumes. Decodes the multibase-encoded
// private keys, runs a defence-in-depth sanity check that the X25519
// keyAgreement secret derives correctly from the Ed25519 seed via
// Montgomery clamping (the canonical did:key derivation the VTA uses
// on its side), and returns just the seed + DIDs the wallet persists.
//
// Kept separate from `run.ts` so the round-trip + the persistence
// adapter can be unit-tested independently — the round-trip needs a
// mediator + a live VTA, the adapter is a pure byte-level transform.

import { ed25519, x25519 } from "@noble/curves/ed25519.js";
import { multibase } from "@openvtc/vti-didcomm-js";

import type { MinimalAdminReply } from "./run.js";

const ED25519_PRIV_CODEC = new Uint8Array([0x80, 0x26]); // 0x1300 varint
const X25519_PRIV_CODEC = new Uint8Array([0x82, 0x26]); // 0x1302 varint

/** Inputs for `installVtaMintedHolder` extracted from a VTA admin reply.
 *
 *  The wallet persists the Ed25519 SEED only — the X25519 keyAgreement
 *  secret is deterministic from the seed (Montgomery clamping). That's
 *  the same persistence model the v3 did:peer holder uses and what
 *  `buildHolder` reconstructs on load. */
export interface HolderInputsFromAdminReply {
  did: string;
  signingKid: string;
  keyAgreementKid: string;
  edSeed: Uint8Array;
  vtaDid: string;
  vtaUrl?: string;
}

/** Pull the wallet-persistable shape out of a `MinimalAdminReply`.
 *
 *  Decodes the multibase private keys, verifies the multicodec prefix,
 *  and cross-checks that:
 *    - the X25519 secret the VTA shipped equals `toMontgomerySecret(edSeed)`
 *      — defence against a buggy or hostile VTA that ships an X25519
 *      secret independent of the Ed25519 seed; the wallet's loader will
 *      *always* recompute X25519 from the seed, so the two MUST agree
 *      or any DIDComm authcrypt the wallet attempts later will fail in
 *      a deeply confusing way at AEAD-open time.
 *    - the Ed25519 public key the seed expands to matches the multibase
 *      identifier inside the `did:key` — confirms the wallet receives a
 *      legitimate did:key (not a forged DID claiming a key it doesn't
 *      control). */
export function holderInputsFromAdminReply(
  reply: MinimalAdminReply,
): HolderInputsFromAdminReply {
  const signingPriv = decodePrivateKey(
    reply.adminSigningPrivateMultibase,
    ED25519_PRIV_CODEC,
    "signing (Ed25519)",
  );
  const kaPriv = decodePrivateKey(
    reply.adminKaPrivateMultibase,
    X25519_PRIV_CODEC,
    "keyAgreement (X25519)",
  );

  // Cross-check 1: X25519 secret must equal Montgomery(seed). If the VTA
  // ever changes its derivation, we want to know NOW (at install time)
  // rather than silently storing the seed and then having every
  // DIDComm authcrypt fail under this DID.
  const derivedX25519 = ed25519.utils.toMontgomerySecret(signingPriv);
  if (!constantTimeEqual(derivedX25519, kaPriv)) {
    throw new Error(
      "provision-integration: VTA's ka_key.private_key_multibase does not equal " +
        "toMontgomerySecret(signing seed). The wallet stores the seed and " +
        "re-derives X25519 on demand; a mismatch would break DIDComm.",
    );
  }

  // Cross-check 2: Ed25519 public must match the did:key identifier. The
  // adminDid is `did:key:z<multibase-of-ed25519-pub>`; we extract the
  // multibase, decode it, and assert equality with edPub from the seed.
  const edPub = ed25519.getPublicKey(signingPriv);
  const didMb = extractDidKeyMultibase(reply.adminDid);
  const decodedDidKey = multibase.decodeMultikey(didMb);
  if (!constantTimeEqual(decodedDidKey.codec, multibase.MULTICODEC.ED25519_PUB)) {
    throw new Error(
      `provision-integration: adminDid '${reply.adminDid}' is not an Ed25519 did:key`,
    );
  }
  if (!constantTimeEqual(decodedDidKey.key, edPub)) {
    throw new Error(
      "provision-integration: adminDid's multibase identifier does not encode the " +
        "Ed25519 public key that the shipped seed expands to. The wallet would " +
        "publish a DID it does not actually control.",
    );
  }

  // The keyAgreement VM id convention for did:key Ed25519 (mirrored by
  // the VTA at mint.rs:124-132) is `<did>#<x25519-multibase-pub>`. The
  // wallet derives the X25519 pubkey from the seed and emits the same
  // shape so every signer-side check the wallet later runs against this
  // identity matches the verifier-side view.
  const xPub = x25519.getPublicKey(derivedX25519);
  const xMb = multibase.encodeMultikey(multibase.MULTICODEC.X25519_PUB, xPub);
  const keyAgreementKid = `${reply.adminDid}#${xMb}`;
  // signingKid: the VTA ships this in the bundle as
  // `admin.signing_key.key_id`; we trust the bundle's value. The
  // canonical shape is `<did>#<signing-multibase>`, which is the did:key
  // identifier itself (the fragment equals the multibase tag).
  const signingKid = `${reply.adminDid}#${didMb}`;

  return {
    did: reply.adminDid,
    signingKid,
    keyAgreementKid,
    edSeed: signingPriv,
    vtaDid: reply.vtaDid,
    ...(reply.vtaUrl ? { vtaUrl: reply.vtaUrl } : {}),
  };
}

function decodePrivateKey(
  multikey: string,
  expectedCodec: Uint8Array,
  label: string,
): Uint8Array {
  const { codec, key } = multibase.decodeMultikey(multikey);
  if (!constantTimeEqual(codec, expectedCodec)) {
    throw new Error(
      `provision-integration: ${label} multicodec mismatch — expected ` +
        `${hex(expectedCodec)}, got ${hex(codec)}`,
    );
  }
  if (key.length !== 32) {
    throw new Error(
      `provision-integration: ${label} key length ${key.length} != 32 bytes`,
    );
  }
  return key;
}

function extractDidKeyMultibase(did: string): string {
  if (!did.startsWith("did:key:")) {
    throw new Error(`provision-integration: '${did}' is not a did:key`);
  }
  const mb = did.slice("did:key:".length);
  if (!mb.startsWith("z")) {
    throw new Error(`provision-integration: did:key identifier '${mb}' is not base58btc multibase`);
  }
  return mb;
}

function constantTimeEqual(a: Uint8Array, b: Uint8Array): boolean {
  if (a.length !== b.length) return false;
  let acc = 0;
  for (let i = 0; i < a.length; i++) acc |= (a[i] as number) ^ (b[i] as number);
  return acc === 0;
}

function hex(bytes: Uint8Array): string {
  let s = "";
  for (let i = 0; i < bytes.length; i++) {
    s += (bytes[i] as number).toString(16).padStart(2, "0");
  }
  return s;
}
