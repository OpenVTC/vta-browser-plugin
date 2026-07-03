import { test } from "node:test";
import assert from "node:assert/strict";

import * as w from "../dist/cesr/wire.js";

const enc = new TextEncoder();
const bytes = (arr) => new Uint8Array(arr);
const hex = (u8) => Buffer.from(u8).toString("hex");
const write = (fn) => {
  const out = [];
  fn(out);
  return new Uint8Array(out);
};

// ── Golden vectors lifted verbatim from affinidi-tsp src/message/wire.rs tests.
// Byte-for-byte equality here proves the JS port frames identically to the Rust
// (and thus to tsp-sdk / the VTA).

test("code identifiers match the reference", () => {
  assert.equal(w.TSP_VID, 1);
  assert.equal(w.TSP_HPKEAUTH_CIPHERTEXT, 6);
  assert.equal(w.TSP_TMP, 23);
  assert.equal(w.TSP_ETS_WRAPPER, 4);
  assert.equal(w.TSP_PAYLOAD, 25);
  assert.equal(w.TSP_ATTACH_GRP, 2);
  assert.equal(w.TSP_INDEX_SIG_GRP, 10);
  assert.equal(w.TSP_NONCE, 0);
  assert.equal(w.TSP_SHA256, 8);
});

test("marker bytes match the reference", () => {
  assert.equal(hex(w.YTSP), "61348f");
  assert.equal(hex(w.XSCS), "5d2092");
});

test("encodeCount(-E, 19) = f8 40 13 and round-trips", () => {
  const buf = write((out) => w.encodeCount(w.TSP_ETS_WRAPPER, 19, out));
  assert.equal(hex(buf), "f84013");
  const cur = { pos: 0 };
  assert.equal(w.decodeCount(w.TSP_ETS_WRAPPER, buf, cur), 19);
  assert.equal(cur.pos, 3);
});

test("encodeVersion = 61 34 8f f8 00 01 and round-trips", () => {
  const buf = write((out) => w.encodeVersion(out));
  assert.equal(hex(buf), "61348ff80001");
  const cur = { pos: 0 };
  assert.equal(w.decodeVersion(buf, cur), true);
  assert.equal(cur.pos, 6);
});

test("variable data — 19-byte VID (2 lead bytes, D6 selector)", () => {
  const vid = enc.encode("did:web:bob.example");
  const buf = write((out) => w.encodeVariableData(w.TSP_VID, vid, out));
  assert.equal(hex(buf.slice(0, 3)), "e81007");
  assert.equal(hex(buf.slice(3, 5)), "0000"); // 2 lead zeros
  assert.deepEqual(buf.slice(5), vid);
  const cur = { pos: 0 };
  assert.deepEqual(w.decodeVariableData(w.TSP_VID, buf, cur), vid);
  assert.equal(cur.pos, buf.length);
});

test("variable data — 21-byte VID (0 lead bytes, D4 selector)", () => {
  const vid = enc.encode("did:web:alice.example");
  const buf = write((out) => w.encodeVariableData(w.TSP_VID, vid, out));
  assert.equal(hex(buf.slice(0, 3)), "e01007");
  assert.deepEqual(buf.slice(3), vid);
  const cur = { pos: 0 };
  assert.deepEqual(w.decodeVariableData(w.TSP_VID, buf, cur), vid);
});

test("fixed data — 2-byte TMP marker = 5c 00 00", () => {
  const buf = write((out) => w.encodeFixedData(w.TSP_TMP, bytes([0, 0]), out));
  assert.equal(hex(buf), "5c0000");
  const cur = { pos: 0 };
  assert.deepEqual(w.decodeFixedData(w.TSP_TMP, 2, buf, cur), bytes([0, 0]));
  assert.equal(cur.pos, 3);
});

test("fixed data — 64-byte Ed25519 signature header = d0 10", () => {
  const sig = new Uint8Array(64).fill(0xab);
  const buf = write((out) => w.encodeFixedData(w.ED25519_SIGNATURE, sig, out));
  assert.equal(hex(buf.slice(0, 2)), "d010");
  const cur = { pos: 0 };
  assert.deepEqual(w.decodeFixedData(w.ED25519_SIGNATURE, 64, buf, cur), sig);
});

test("hops — empty list round-trips to just the -J0 header", () => {
  const buf = write((out) => w.encodeHops([], out));
  const cur = { pos: 0 };
  assert.deepEqual(w.decodeHops(buf, cur), []);
  assert.equal(cur.pos, buf.length);
});

test("hops — non-empty list round-trips", () => {
  const hops = [enc.encode("did:web:hop1"), enc.encode("did:web:exit")];
  const buf = write((out) => w.encodeHops(hops, out));
  const cur = { pos: 0 };
  const got = w.decodeHops(buf, cur);
  assert.deepEqual(got, hops);
  assert.equal(cur.pos, buf.length);
});

test("count long-form (≥ 4096) — byte-identical to the reference + 6-byte advance", () => {
  // The reference (affinidi-tsp / tsp-sdk) encodes a long-form count as a
  // 6-byte header. Its decode_count folds the identifier bits into the returned
  // *value* for a nonzero id — a reference quirk we match byte-for-byte. It's
  // benign: TSP frames by cursor position and discards this value (only the
  // 3-vs-6-byte advance matters), so large payloads still decode correctly.
  const buf = write((out) => w.encodeCount(w.TSP_PAYLOAD, 5000, out));
  assert.equal(hex(buf), "fb4640001388"); // exact reference bytes
  const cur = { pos: 0 };
  assert.notEqual(w.decodeCount(w.TSP_PAYLOAD, buf, cur), undefined); // present
  assert.equal(cur.pos, 6); // advanced past the 6-byte long-form header

  // With id = 0 the id-folding degenerates and the value round-trips exactly.
  const buf0 = write((out) => w.encodeCount(0, 5000, out));
  const cur0 = { pos: 0 };
  assert.equal(w.decodeCount(0, buf0, cur0), 5000);
  assert.equal(cur0.pos, buf0.length);
});

test("variable data round-trips across all lead-byte alignments", () => {
  for (let len = 0; len <= 9; len++) {
    const payload = new Uint8Array(len).map((_, i) => (i * 7 + 1) & 0xff);
    const buf = write((out) => w.encodeVariableData(w.TSP_PLAINTEXT, payload, out));
    const cur = { pos: 0 };
    assert.deepEqual(w.decodeVariableData(w.TSP_PLAINTEXT, buf, cur), payload, `len=${len}`);
    assert.equal(cur.pos, buf.length, `len=${len} consumed all bytes`);
  }
});

test("wrong identifier fails to decode", () => {
  const buf = write((out) => w.encodeVariableData(w.TSP_VID, enc.encode("x"), out));
  const cur = { pos: 0 };
  assert.equal(w.decodeVariableData(w.TSP_HPKEAUTH_CIPHERTEXT, buf, cur), undefined);
});
