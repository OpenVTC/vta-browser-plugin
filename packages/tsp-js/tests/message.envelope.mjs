import { test } from "node:test";
import assert from "node:assert/strict";

import { encodeEnvelope, decodeEnvelope } from "../dist/index.js";

const hex = (u8) => Buffer.from(u8).toString("hex");

// Golden vector from affinidi-tsp src/message/envelope.rs
// `envelope_matches_reference_header` (reference tsp-sdk seal Bob->Alice).
test("envelope encodes byte-for-byte to the reference header (60 bytes)", () => {
  const encoded = encodeEnvelope("did:web:bob.example", "did:web:alice.example");
  const prefix = [
    0xf8, 0x40, 0x13, // -E count 19
    0x61, 0x34, 0x8f, // YTSP
    0xf8, 0x00, 0x01, // version count
    0xe8, 0x10, 0x07, 0x00, 0x00, // sender var-data header + 2 lead
  ];
  assert.equal(hex(encoded.slice(0, prefix.length)), hex(new Uint8Array(prefix)));
  assert.equal(encoded.length, 60); // 19 quadlets * 3 + 3 count = 60
  assert.equal(encoded[0], 0xf8);
});

test("envelope round-trips and reports the AAD/info length", () => {
  const encoded = encodeEnvelope("did:web:alice.example", "did:web:bob.example");
  const { envelope, headerLen } = decodeEnvelope(encoded);
  assert.equal(envelope.sender, "did:web:alice.example");
  assert.equal(envelope.receiver, "did:web:bob.example");
  assert.equal(headerLen, encoded.length);
});

test("envelope round-trips for varied VID lengths", () => {
  for (const [s, r] of [
    ["a", "b"],
    ["did:web:x", "did:web:y"],
    ["did:key:z6Mkexample", "did:web:host.example:path"],
  ]) {
    const { envelope } = decodeEnvelope(encodeEnvelope(s, r));
    assert.equal(envelope.sender, s);
    assert.equal(envelope.receiver, r);
  }
});

test("truncated envelope throws", () => {
  assert.throws(() => decodeEnvelope(new Uint8Array([0xf8, 0x40])));
  assert.throws(() => decodeEnvelope(new Uint8Array([1, 0])));
});
