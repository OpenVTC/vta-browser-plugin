import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

import { decodeEnvelope, isRevisionError } from "../dist/index.js";
import { encodeFields, finalizeFrame, decodeEnvelope as decodeV1 } from "../dist/v1/envelope.js";

const hex = (u8) => Buffer.from(u8).toString("hex");
const b64u = (s) => new Uint8Array(Buffer.from(s, "base64url"));

const VECTORS = JSON.parse(
  readFileSync(new URL("./fixtures/spec-v1-vectors.json", import.meta.url), "utf8"),
);

test("envelope fields are byte-exact, and three bytes shorter than Rev 2's", () => {
  const fields = encodeFields("did:web:bob.example", "did:web:alice.example");
  assert.equal(
    hex(fields.slice(0, 9)),
    "61348f" + // YTSP
      "f81000" + // version count: MAJOR 1, MINOR 0 — `YTSP-BAA`
      "e81007", // sender var-data header (19 bytes → 2 lead, D6 selector)
  );
  // 6 (version) + 24 (bob, 2 lead) + 24 (alice, 0 lead) = 54. Rev 2 was 57:
  // it ended with a 2-byte `X 00 00` TMP marker that Rev 3 deleted outright.
  assert.equal(fields.length, 54);
});

test("the -E count covers the body, which is why it is written last", () => {
  const fields = encodeFields("did:web:bob.example", "did:web:alice.example");
  const body = new Uint8Array(9).fill(0xaa);

  const frame = finalizeFrame(fields, body);
  // Rev 2's count covered only the header and so could be written first. Since
  // Rev 3 it covers fields ‖ body — 63 bytes, 21 quadlets — and cannot exist until the
  // ciphertext does.
  assert.equal(hex(frame.slice(0, 3)), "f84015"); // -E, 21 quadlets
  assert.equal(frame.length, 3 + 54 + 9);

  const decoded = decodeV1(frame);
  assert.equal(decoded.contentEnd, frame.length, "the count fixes where signable content ends");
  assert.equal(decoded.headerLen, 3 + 54, "the ciphertext field begins after the fields");
});

test("the AAD is the fields without the count code", () => {
  // §8: `aad = CONCAT(TSP_Version, VID_sndr, VID_rcvr)`. The `-E` count code is
  // deliberately outside it, which is exactly why encoding splits in two.
  const fields = encodeFields("did:web:alice.example", "did:web:bob.example");
  const frame = finalizeFrame(fields, new Uint8Array(0));
  const decoded = decodeV1(frame);
  assert.deepEqual(frame.slice(decoded.aad.begin, decoded.aad.end), fields);
  assert.equal(decoded.aad.begin, 3, "the AAD starts after the count code, not at 0");
});

test("the envelope round-trips for varied VID lengths", () => {
  for (const [s, r] of [
    ["a", "b"],
    ["did:web:x", "did:web:y"],
    ["did:key:z6Mkexample", "did:web:host.example:path"],
  ]) {
    const frame = finalizeFrame(encodeFields(s, r), new Uint8Array(0));
    const { envelope } = decodeV1(frame);
    assert.equal(envelope.sender, s);
    assert.equal(envelope.receiver, r);
  }
});

test("an empty receiver is the NULL VID, and an empty sender is refused", () => {
  // §9.1 always writes the receiver field; `4BAA` means "no receiver named".
  // A sender has no such spelling — every TSP message names who sent it — so
  // the two empty strings are not symmetric and must not be handled as if they
  // were.
  const frame = finalizeFrame(encodeFields("did:web:alice", ""), new Uint8Array(0));
  assert.equal(decodeV1(frame).envelope.receiver, "");

  const headless = finalizeFrame(encodeFields("", "did:web:bob"), new Uint8Array(0));
  assert.throws(() => decodeV1(headless), /NULL VID/);
});

test("a frame claiming more content than it holds is refused at the count", () => {
  const fields = encodeFields("did:web:alice", "did:web:bob");
  const honest = finalizeFrame(fields, new Uint8Array(0));
  // Overstate the count by one quadlet. §9.1 asks a receiver to check the
  // declared signable length, so this dies here rather than as a confusing
  // failure three layers down.
  const lying = Uint8Array.from(honest);
  lying[2] += 1;
  assert.throws(() => decodeV1(lying), /declares more content/);
});

test("the public decodeEnvelope reads 1.0, and refuses a draft before reading its VIDs", () => {
  const v1 = decodeEnvelope(b64u(VECTORS.vectors["direct-hpke-base"].message));
  assert.equal(v1.minor, 0);
  assert.equal(v1.envelope.sender, VECTORS.identifiers.alice.id);
  assert.equal(v1.envelope.receiver, VECTORS.identifiers.bob.id);

  // The same message with its version count rewritten to Rev 3's `AAC`. The
  // VIDs are byte-identical across revisions and would parse; the gate is what
  // refuses it.
  const draft = b64u(VECTORS.vectors["direct-hpke-base"].message);
  draft[7] = 0x00;
  draft[8] = 0x02;
  assert.throws(
    () => decodeEnvelope(draft),
    (err) => isRevisionError(err) && err.major === 0 && err.minor === 2,
  );
});

test("truncated and non-TSP input throws", () => {
  assert.throws(() => decodeEnvelope(new Uint8Array([0xf8, 0x40])));
  assert.throws(() => decodeEnvelope(new Uint8Array([1, 0])));
  assert.throws(() => decodeEnvelope(new Uint8Array(0)));
});
