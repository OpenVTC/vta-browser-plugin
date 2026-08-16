// `hpkeOpen` — the VTA sealed-bundle decryption path.
//
// This path used to call hpke-js directly; it now calls the ecosystem's single
// RFC 9180 implementation (`@openvtc/vti-tsp-js/hpke`, pure @noble, no
// WebCrypto). hpke-js is kept here as a DEV-dependency to seal the fixtures, so
// these tests pin the port against the implementation it replaced: the wallet
// must still open exactly what the VTA — which uses an independent Rust
// implementation of the same suite — produces.
//
// The seal side is deliberately the *other* implementation. A round-trip
// against our own seal would pass even if both directions drifted together.

import { test } from "node:test";
import assert from "node:assert/strict";

import { CipherSuite, DhkemX25519HkdfSha256, HkdfSha256 } from "@hpke/core";
import { Chacha20Poly1305 } from "@hpke/chacha20poly1305";
import { ed25519, x25519 } from "@noble/curves/ed25519.js";

import { hpkeOpen, buildChunkAad } from "../dist/index.js";

// Must byte-match `HPKE_INFO` in src/provision/hpke.ts and the Rust
// `vta-sdk/src/sealed_transfer/hpke.rs`.
const INFO = new TextEncoder().encode("vta-sealed-transfer/v1");

const suite = () =>
  new CipherSuite({
    kem: new DhkemX25519HkdfSha256(),
    kdf: new HkdfSha256(),
    aead: new Chacha20Poly1305(),
  });

const ab = (u8) => u8.buffer.slice(u8.byteOffset, u8.byteOffset + u8.byteLength);

/** The wallet's X25519 secret is Montgomery(Ed25519 seed) — same derivation as
 *  `bundle-secret.ts` and the VTA's Rust side. */
function recipient() {
  const seed = ed25519.utils.randomSecretKey();
  const secret = ed25519.utils.toMontgomerySecret(seed);
  return { secret, publicKey: x25519.getPublicKey(secret) };
}

/** Seal a chunk the way the VTA does: base mode, pinned info, chunk-header AAD. */
async function sealChunk(recipientPk, plaintext, aad) {
  const s = suite();
  const recipientPublicKey = await s.kem.importKey("raw", ab(recipientPk), true);
  const sender = await s.createSenderContext({ recipientPublicKey, info: ab(INFO) });
  const ciphertext = new Uint8Array(await sender.seal(ab(plaintext), ab(aad)));
  return { kemEncap: new Uint8Array(sender.enc), ciphertext };
}

const AAD = () =>
  buildChunkAad({
    version: 1,
    bundleId: new Uint8Array(16).fill(7),
    chunkIndex: 0,
    totalChunks: 1,
    digestAlgo: "sha-256",
  });

test("opens a chunk sealed by an independent HPKE implementation", async () => {
  const r = recipient();
  const pt = new TextEncoder().encode("CBOR-ish ChunkPlaintext bytes");
  const aad = AAD();
  const sealed = await sealChunk(r.publicKey, pt, aad);

  const opened = await hpkeOpen({
    recipientSecret: r.secret,
    kemEncap: sealed.kemEncap,
    ciphertext: sealed.ciphertext,
    aad,
  });
  assert.deepEqual(opened, pt);
});

test("an empty chunk plaintext round-trips (ciphertext is just the tag)", async () => {
  const r = recipient();
  const aad = AAD();
  const sealed = await sealChunk(r.publicKey, new Uint8Array(0), aad);
  assert.equal(sealed.ciphertext.length, 16);

  const opened = await hpkeOpen({
    recipientSecret: r.secret,
    kemEncap: sealed.kemEncap,
    ciphertext: sealed.ciphertext,
    aad,
  });
  assert.deepEqual(opened, new Uint8Array(0));
});

test("the wrong recipient secret fails the AEAD", async () => {
  const r = recipient();
  const other = recipient();
  const aad = AAD();
  const sealed = await sealChunk(r.publicKey, new TextEncoder().encode("secret"), aad);

  await assert.rejects(() =>
    hpkeOpen({
      recipientSecret: other.secret,
      kemEncap: sealed.kemEncap,
      ciphertext: sealed.ciphertext,
      aad,
    }),
  );
});

test("a tampered chunk header (AAD) fails the AEAD", async () => {
  const r = recipient();
  const aad = AAD();
  const sealed = await sealChunk(r.publicKey, new TextEncoder().encode("secret"), aad);

  // Same bundle, different chunk index — the header must be bound.
  const wrongAad = buildChunkAad({
    version: 1,
    bundleId: new Uint8Array(16).fill(7),
    chunkIndex: 1,
    totalChunks: 1,
    digestAlgo: "sha-256",
  });

  await assert.rejects(() =>
    hpkeOpen({
      recipientSecret: r.secret,
      kemEncap: sealed.kemEncap,
      ciphertext: sealed.ciphertext,
      aad: wrongAad,
    }),
  );
});

test("a tampered ciphertext fails the AEAD", async () => {
  const r = recipient();
  const aad = AAD();
  const sealed = await sealChunk(r.publicKey, new TextEncoder().encode("secret"), aad);
  sealed.ciphertext[0] ^= 0x01;

  await assert.rejects(() =>
    hpkeOpen({
      recipientSecret: r.secret,
      kemEncap: sealed.kemEncap,
      ciphertext: sealed.ciphertext,
      aad,
    }),
  );
});

test("the info string is bound — a bundle sealed under a different info cannot open", async () => {
  const r = recipient();
  const aad = AAD();
  const s = suite();
  const recipientPublicKey = await s.kem.importKey("raw", ab(r.publicKey), true);
  const sender = await s.createSenderContext({
    recipientPublicKey,
    info: ab(new TextEncoder().encode("vta-sealed-transfer/v2")),
  });
  const ciphertext = new Uint8Array(await sender.seal(ab(new TextEncoder().encode("x")), ab(aad)));

  await assert.rejects(() =>
    hpkeOpen({
      recipientSecret: r.secret,
      kemEncap: new Uint8Array(sender.enc),
      ciphertext,
      aad,
    }),
  );
});

test("malformed key lengths are rejected before any crypto runs", async () => {
  const r = recipient();
  const aad = AAD();
  const sealed = await sealChunk(r.publicKey, new TextEncoder().encode("x"), aad);

  await assert.rejects(
    () =>
      hpkeOpen({
        recipientSecret: r.secret.slice(0, 31),
        kemEncap: sealed.kemEncap,
        ciphertext: sealed.ciphertext,
        aad,
      }),
    /recipientSecret must be 32 bytes \(got 31\)/,
  );

  await assert.rejects(
    () =>
      hpkeOpen({
        recipientSecret: r.secret,
        kemEncap: sealed.kemEncap.slice(0, 16),
        ciphertext: sealed.ciphertext,
        aad,
      }),
    /kemEncap must be 32 bytes \(got 16\)/,
  );
});
