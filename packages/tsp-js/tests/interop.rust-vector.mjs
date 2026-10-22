import { test } from "node:test";
import assert from "node:assert/strict";

import { unpack, pack } from "../dist/index.js";

// ── Cross-implementation interop, both directions, against affinidi-tsp 0.3.0 ──
//
// Rust → JS: packed by the published affinidi-tsp 0.3.0 (TSP 1.0) with
// `direct::pack` and FIXED keys — sender signing seed [0x11;32], receiver X25519
// secret [0x33;32], body "hello from rust tsp", did:web:alice.example →
// did:web:bob.example. The ephemeral is random, so these bytes are one sample,
// not a reproduction; opening them proves we read what the crate writes, down
// to the thread digest it computed at seal time.
//
// JS → Rust: a message this package packed with the same keys was handed to
// the same crate's `direct::unpack`, which recovered the sender, the receiver,
// the plaintext and a byte-identical thread digest. That run cannot live in a
// JS suite; what is pinned below instead is the deterministic part of what we
// emit — the envelope fields and the payload frame — so that if either moves,
// the run is known to be stale and has to be redone.
const RUST = {
  wireHex:
    "f8403761348ff81000e010076469643a7765623a616c6963652e6578616d706c65e8100700006469643a7765623a626f622e6578616d706c65e05024f063c9148e6c799cbf21842bcfc2327cf1b912834d0f01f11bced07185613a0842fb56e701ea30fe05a3ec417dc4c2cca1eca967b9ba9416c9937dbb49cb98908987e497cb053f8a72652b280ce0f8317a6b7a8433e729af676e9386debb4f06c97bb16c36018ca547fac469f82017f8a0160400dfa9f2e43a3b0bdc2e82ce1f73b45d875a8e12e9bc259321b0b3f6577c044d4e3b1c9626f2c3c7691d41d1708020a01929971f9ce80db9c2b62a044cd6254d0c",
  senderSignPk: "d04ab232742bb4ab3a1368bd4615e4e6d0224ab71a016baf8520a332c9778737",
  receiverEncSk: "3333333333333333333333333333333333333333333333333333333333333333",
  threadDigest: "a83deae9f9ec261f4fd98d36c6b6c5f1531d72de7406ea7c7a359cab633dbeef",
};

const fromHex = (h) => new Uint8Array(Buffer.from(h, "hex"));
const toHex = (u8) => Buffer.from(u8).toString("hex");

test("JS unpacks a message affinidi-tsp 0.3.0 packed (TSP 1.0)", async () => {
  const unpacked = await unpack(fromHex(RUST.wireHex), {
    receiverDecryptionKey: fromHex(RUST.receiverEncSk),
    senderSigningKey: fromHex(RUST.senderSignPk),
  });

  assert.equal(new TextDecoder().decode(unpacked.payload), "hello from rust tsp");
  assert.equal(unpacked.sender, "did:web:alice.example");
  assert.equal(unpacked.receiver, "did:web:bob.example");
  // Thread digest computed by JS (SHA-256 of the decrypted frame) matches
  // Rust's seal-time digest exactly.
  assert.equal(toHex(unpacked.threadDigest), RUST.threadDigest);
});

test("tampering the Rust vector fails verification", async () => {
  const bytes = fromHex(RUST.wireHex);
  bytes[bytes.length - 1] ^= 0xff; // flip a byte inside the signature
  await assert.rejects(
    unpack(bytes, {
      receiverDecryptionKey: fromHex(RUST.receiverEncSk),
      senderSigningKey: fromHex(RUST.senderSignPk),
    }),
    /signature verification failed/,
  );
});

test("JS-packed message uses the same fixed keys and self-unpacks", async () => {
  const receiverSk = fromHex(RUST.receiverEncSk);
  const { x25519, ed25519 } = await import("@noble/curves/ed25519.js");
  const senderSignSk = new Uint8Array(32).fill(0x11);
  assert.equal(toHex(ed25519.getPublicKey(senderSignSk)), RUST.senderSignPk);
  const packed = await pack(
    new TextEncoder().encode("hello from js tsp"),
    "did:web:alice.example",
    "did:web:bob.example",
    {
      senderSigningKey: senderSignSk,
      receiverEncryptionKey: x25519.getPublicKey(receiverSk),
    },
  );
  const unpacked = await unpack(packed.bytes, {
    receiverDecryptionKey: receiverSk,
    senderSigningKey: ed25519.getPublicKey(senderSignSk),
  });
  assert.equal(new TextDecoder().decode(unpacked.payload), "hello from js tsp");
});

test("the envelope fields we emit are byte-exact", async () => {
  const { encodeFields } = await import("../dist/v1/envelope.js");
  const fields = encodeFields("did:web:alice.example", "did:web:bob.example");
  assert.equal(
    toHex(fields),
    "61348f" + // YTSP
      "f81000" + // YTSP-BAA
      "e010076469643a7765623a616c6963652e6578616d706c65" + // alice, 0 lead
      "e81007" + "0000" + "6469643a7765623a626f622e6578616d706c65", // bob, 2 lead
  );
  // And they are the envelope affinidi-tsp wrote: the Rust vector opens with
  // `-E` and then exactly these bytes.
  assert.equal(RUST.wireHex.slice(6, 6 + toHex(fields).length), toHex(fields));
});

test("the payload frame we emit is byte-exact", async () => {
  const { encodePayloadFrame } = await import("../dist/v1/payload.js");
  const { frame, threadDigest } = encodePayloadFrame(
    new TextEncoder().encode("hello from js tsp rev3"),
    "direct",
    [],
    "did:web:alice.example",
  );
  assert.equal(
    toHex(frame),
    "f99014" + // -Z, 20 quadlets
      "5d2092" + // XSCS
      "e010076469643a7765623a616c6963652e6578616d706c65" + // ESSR sender VID
      "e01000" + // padding: empty field — present, not omitted
      "f80009" + // -A generic stream, 9 quadlets
      "e81008" + "0000" + "68656c6c6f2066726f6d206a73207473702072657633", // B: the body
  );
  // The digest affinidi-tsp independently recomputed from these bytes. The
  // payload frame is unchanged from Rev 3, which already carried the sender.
  assert.equal(
    toHex(threadDigest),
    "625026c6e4a2f5061e2403777cbb2bc3d1595f4c8593d5d88a61f89c9a9b4232",
  );
});
