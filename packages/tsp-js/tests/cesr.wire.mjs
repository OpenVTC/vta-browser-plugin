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
  assert.equal(w.TSP_HPKE_BASE_CIPHERTEXT, 5); // Rev 3 `F`
  assert.equal(w.TSP_SEALED_BOX_CIPHERTEXT, 2); // Rev 3 `C` (§8.3, recognised only)
  assert.equal(w.TSP_GENERIC_STREAM, 0); // Rev 3 `-A`
  assert.equal(w.TSP_HPKEAUTH_CIPHERTEXT, 6); // Rev 2 `G`, struck from the Rev 3 table
  assert.equal(w.TSP_TMP, 23); // Rev 2 only
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

test("encodeVersion = 61 34 8f f8 00 02 — YTSP-AAC, the Rev 3 marker", () => {
  // Rev 2 was `f8 00 01` (`YTSP-AAB`). One byte, and it is the byte the whole
  // dual-revision dispatch turns on, so it is pinned rather than round-tripped.
  const buf = write((out) => w.encodeVersion(out));
  assert.equal(hex(buf), "61348ff80002");
  const cur = { pos: 0 };
  assert.deepEqual(w.readVersion(buf, cur), { major: 0, minor: 2 });
  assert.equal(cur.pos, 6);
});

test("readVersion reads a Rev 2 marker without judging it", () => {
  // The discriminator has to parse a revision it does not implement the codec
  // for — that is the entire job. MINOR comes back unjudged; `peekRevision`
  // decides, and `readVersion` does not get an opinion.
  const rev2 = bytes([0x61, 0x34, 0x8f, 0xf8, 0x00, 0x01]);
  const cur = { pos: 0 };
  assert.deepEqual(w.readVersion(rev2, cur), { major: 0, minor: 1 });
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

// Hop lists are no longer here: Rev 3 §9.2 made the `-J` count the group's byte
// length where Rev 2 counted VIDs, so the same bytes mean two different things
// and neither codec can share one implementation. Each revision owns its own —
// `rev3/payload.ts` and `rev2/reader.ts` — and they are exercised through
// `message.routed.mjs` and the published `routed` vector respectively.

test("count long-form (≥ 4096) — Rev 3 spells it --X, and the count is exact", () => {
  // Two things changed here and both were invisible to a round trip.
  //
  // The spelling: Rev 2 emitted `-0X#####` (second selector `0`), from a
  // superseded draft of the CESR v2 tables; Rev 3 pins the master table for
  // genus `-_AAACAA`, which carries only `--X#####`. Encoder and decoder agree
  // either way, so only pinned bytes catch it.
  const buf = write((out) => w.encodeCount(w.TSP_PAYLOAD, 5000, out));
  assert.equal(hex(buf), "fbe640001388");
  assert.equal(hex(buf).slice(0, 4), "fbe6", "second selector is DASH, not '0'");

  // The value: this test used to assert only that *a* count came back, and
  // called the wrong one "a reference quirk ... benign, TSP frames by cursor
  // position and discards this value". It was neither a quirk nor benign —
  // affinidi-tsp fixed the same bug on its side ("every long-framed message
  // decoded to a wrong length"), and Rev 3 is where it bites: the `-E` and `-Z`
  // counts are now load-bearing lengths, not skippable headers.
  const cur = { pos: 0 };
  assert.equal(w.decodeCount(w.TSP_PAYLOAD, buf, cur), 5000);
  assert.equal(cur.pos, 6);

  const buf0 = write((out) => w.encodeCount(0, 5000, out));
  const cur0 = { pos: 0 };
  assert.equal(w.decodeCount(0, buf0, cur0), 5000);
  assert.equal(cur0.pos, buf0.length);
});

test("count long-form — a Rev 2 header decodes only under the Rev 2 form", () => {
  // `-0Z` + 5000. Hand-built, because nothing in this package emits one any
  // more: the Rev 2 reader is the only caller that passes LONG_COUNT_REV2, and
  // the Rev 3 decoder must *not* accept these bytes — a decoder loose enough to
  // take either spelling would read a Rev 2 frame as Rev 3 and then fail
  // somewhere that says nothing about why.
  const rev2 = bytes([0xfb, 0x46, 0x40, 0x00, 0x13, 0x88]);
  const asRev2 = { pos: 0 };
  assert.equal(w.decodeCount(w.TSP_PAYLOAD, rev2, asRev2, w.LONG_COUNT_REV2), 5000);
  assert.equal(asRev2.pos, 6);

  const asRev3 = { pos: 0 };
  assert.equal(w.decodeCount(w.TSP_PAYLOAD, rev2, asRev3), undefined);
  assert.equal(asRev3.pos, 0, "a refused decode advances nothing");
});

test("isTsp accepts both framings, and nothing else", () => {
  // `0xFB` is the byte a Rev 3 message leads with past ~12 KB, because the `-E`
  // count now covers the ciphertext. An ingress classifier that knows only
  // `0xF8` starts dropping large messages the day Rev 3 is switched on.
  assert.equal(w.isTsp(bytes([0xf8, 0x40, 0x13])), true);
  assert.equal(w.isTsp(bytes([0xfb, 0xe6, 0x40])), true);
  assert.equal(w.isTsp(enc.encode('{"protected":"..."}')), false); // DIDComm JSON
  assert.equal(w.isTsp(enc.encode("eyJhbGciOiJ")), false); // compact JWS
  assert.equal(w.isTsp(bytes([])), false);
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
