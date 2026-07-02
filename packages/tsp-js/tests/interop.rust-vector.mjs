import { test } from "node:test";
import assert from "node:assert/strict";

import { unpack, pack } from "../dist/index.js";

// ── Cross-implementation interop vector ──
// Generated from the Rust reference (affinidi-tsp src/message/direct.rs `pack`)
// with FIXED keys: sender_sign = [0x11;32], sender_enc = [0x22;32],
// receiver_enc = [0x33;32], body = "hello from rust tsp",
// alice.example -> bob.example. Unpacking it here proves hpke-js opens
// affinidi-tsp's HPKE-Auth ciphertext byte-for-byte (same RFC 9180 suite,
// same key schedule) and that the CESR framing agrees end-to-end.
const RUST = {
  wireHex:
    "f8401361348ff80001e010076469643a7765623a616c6963652e6578616d706c65e8100700006469643a7765623a626f622e6578616d706c655c0000e0601a5795132915e698a115677334d13dd7154f717eda8791473ccbb360671313f40544e2ae9153559a01d6aa33b93261dd0ab610231bad47e059d0eaa46038cf872ba82a282a431fd391e10f4d3c0603f82016f8a016d0100d308cdcf413984d884ff81ac2308da9d3afc9a0601e9393f664d54f9c37892897e996a0c8949ca8afa643ed39f888312094f6c34c55a1f4c3c0032f969cb707",
  senderEncPk: "0faa684ed28867b97f4a6a2dee5df8ce974e76b7018e3f22a1c4cf2678570f20",
  senderSignPk: "d04ab232742bb4ab3a1368bd4615e4e6d0224ab71a016baf8520a332c9778737",
  receiverEncSk: "3333333333333333333333333333333333333333333333333333333333333333",
  threadDigest: "9f374ced683278ee93c75b2e2e57022c166534a9426e395f64282bd81c62593c",
};

const fromHex = (h) => new Uint8Array(Buffer.from(h, "hex"));
const toHex = (u8) => Buffer.from(u8).toString("hex");

test("JS unpacks a Rust-packed TSP message byte-for-byte (HPKE-Auth interop)", async () => {
  const unpacked = await unpack(fromHex(RUST.wireHex), {
    receiverDecryptionKey: fromHex(RUST.receiverEncSk),
    senderEncryptionKey: fromHex(RUST.senderEncPk),
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
      senderEncryptionKey: fromHex(RUST.senderEncPk),
      senderSigningKey: fromHex(RUST.senderSignPk),
    }),
  );
});

test("JS-packed message uses the same fixed keys and self-unpacks", async () => {
  // Sanity: the JS pack path with the same receiver key produces a message the
  // JS unpack path opens (ephemeral is random, so bytes differ from Rust's, but
  // the receiver key + suite are identical).
  const receiverSk = fromHex(RUST.receiverEncSk);
  const { x25519, ed25519 } = await import("@noble/curves/ed25519.js");
  const senderEncSk = new Uint8Array(32).fill(0x22);
  const senderSignSk = new Uint8Array(32).fill(0x11);
  const packed = await pack(
    new TextEncoder().encode("hello from js tsp"),
    "did:web:alice.example",
    "did:web:bob.example",
    {
      senderSigningKey: senderSignSk,
      senderEncryptionKey: senderEncSk,
      receiverEncryptionKey: x25519.getPublicKey(receiverSk),
    },
  );
  const unpacked = await unpack(packed.bytes, {
    receiverDecryptionKey: receiverSk,
    senderEncryptionKey: x25519.getPublicKey(senderEncSk),
    senderSigningKey: ed25519.getPublicKey(senderSignSk),
  });
  assert.equal(new TextDecoder().decode(unpacked.payload), "hello from js tsp");
});
