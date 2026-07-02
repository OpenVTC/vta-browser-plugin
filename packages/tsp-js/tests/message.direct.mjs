import { test } from "node:test";
import assert from "node:assert/strict";

import { pack, unpack } from "../dist/index.js";
import { ed25519, x25519 } from "@noble/curves/ed25519.js";

const enc = new TextEncoder();
const dec = new TextDecoder();

// Mirrors affinidi-tsp src/message/direct.rs tests (random keys, JS-internal
// pack→unpack round-trip). Byte-exact cross-impl vectors against the Rust crate
// are a follow-up (needs fixed-key vectors generated from Rust).
function genKeys() {
  const senderSign = ed25519.utils.randomSecretKey();
  const senderEnc = x25519.utils.randomSecretKey();
  const receiverEnc = x25519.utils.randomSecretKey();
  return {
    packKeys: {
      senderSigningKey: senderSign,
      senderEncryptionKey: senderEnc,
      receiverEncryptionKey: x25519.getPublicKey(receiverEnc),
    },
    unpackKeys: {
      receiverDecryptionKey: receiverEnc,
      senderEncryptionKey: x25519.getPublicKey(senderEnc),
      senderSigningKey: ed25519.getPublicKey(senderSign),
    },
  };
}

test("pack → unpack round-trips (payload, sender, receiver, thread digest)", async () => {
  const k = genKeys();
  const body = enc.encode("Hello, TSP world!");
  const packed = await pack(body, "did:web:alice.example", "did:web:bob.example", k.packKeys);

  // First byte is the -E count code.
  assert.equal(packed.bytes[0], 0xf8);
  assert.equal(packed.threadDigest.length, 32);

  const unpacked = await unpack(packed.bytes, k.unpackKeys);
  assert.equal(dec.decode(unpacked.payload), "Hello, TSP world!");
  assert.equal(unpacked.sender, "did:web:alice.example");
  assert.equal(unpacked.receiver, "did:web:bob.example");
  // Thread digest is SHA-256 of the plaintext frame — identical on both sides.
  assert.deepEqual(unpacked.threadDigest, packed.threadDigest);
});

test("empty payload round-trips", async () => {
  const k = genKeys();
  const packed = await pack(new Uint8Array(0), "did:web:a.example", "did:web:b.example", k.packKeys);
  const unpacked = await unpack(packed.bytes, k.unpackKeys);
  assert.equal(unpacked.payload.length, 0);
});

test("tampered wire bytes fail (signature)", async () => {
  const k = genKeys();
  const packed = await pack(enc.encode("original"), "did:web:a.example", "did:web:b.example", k.packKeys);
  const tampered = packed.bytes.slice();
  tampered[Math.floor(tampered.length / 2)] ^= 0xff;
  await assert.rejects(unpack(tampered, k.unpackKeys));
});

test("wrong receiver key fails", async () => {
  const k = genKeys();
  const packed = await pack(enc.encode("secret"), "did:web:a.example", "did:web:b.example", k.packKeys);
  const wrong = { ...k.unpackKeys, receiverDecryptionKey: x25519.utils.randomSecretKey() };
  await assert.rejects(unpack(packed.bytes, wrong));
});

test("wrong sender signing key fails to verify", async () => {
  const k = genKeys();
  const packed = await pack(enc.encode("secret"), "did:web:a.example", "did:web:b.example", k.packKeys);
  const wrong = { ...k.unpackKeys, senderSigningKey: ed25519.getPublicKey(ed25519.utils.randomSecretKey()) };
  await assert.rejects(unpack(packed.bytes, wrong));
});

test("larger payloads round-trip (multi-block)", async () => {
  const k = genKeys();
  const body = new Uint8Array(4096).map((_, i) => (i * 31 + 7) & 0xff);
  const packed = await pack(body, "did:web:a.example", "did:web:b.example", k.packKeys);
  const unpacked = await unpack(packed.bytes, k.unpackKeys);
  assert.deepEqual(unpacked.payload, body);
});
