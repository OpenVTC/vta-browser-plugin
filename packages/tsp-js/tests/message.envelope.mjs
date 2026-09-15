import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

import { decodeEnvelope } from "../dist/index.js";
import { encodeFields, finalizeFrame, decodeEnvelope as decodeRev3 } from "../dist/rev3/envelope.js";

const hex = (u8) => Buffer.from(u8).toString("hex");
const b64u = (s) => new Uint8Array(Buffer.from(s, "base64url"));

const VECTORS = JSON.parse(
  readFileSync(new URL("./fixtures/spec-rev3-vectors.json", import.meta.url), "utf8"),
);

test("Rev 3 envelope fields are byte-exact, and three bytes shorter than Rev 2", () => {
  const fields = encodeFields("did:web:bob.example", "did:web:alice.example");
  assert.equal(
    hex(fields.slice(0, 9)),
    "61348f" + // YTSP
      "f80002" + // version count: MAJOR 0, MINOR 2 — `YTSP-AAC`
      "e81007", // sender var-data header (19 bytes → 2 lead, D6 selector)
  );
  // 6 (version) + 24 (bob, 2 lead) + 24 (alice, 0 lead) = 54. Rev 2 was 57:
  // it ended with a 2-byte `X 00 00` TMP marker that Rev 3 deletes outright.
  assert.equal(fields.length, 54);
});

test("the -E count covers the body, which is why it is written last", () => {
  const fields = encodeFields("did:web:bob.example", "did:web:alice.example");
  const body = new Uint8Array(9).fill(0xaa);

  const frame = finalizeFrame(fields, body);
  // Rev 2's count covered only the header and so could be written first. Rev 3's
  // covers fields ‖ body — 63 bytes, 21 quadlets — and cannot exist until the
  // ciphertext does.
  assert.equal(hex(frame.slice(0, 3)), "f84015"); // -E, 21 quadlets
  assert.equal(frame.length, 3 + 54 + 9);

  const decoded = decodeRev3(frame);
  assert.equal(decoded.contentEnd, frame.length, "the count fixes where signable content ends");
  assert.equal(decoded.headerLen, 3 + 54, "the ciphertext field begins after the fields");
});

test("the AAD is the fields without the count code", () => {
  // §8: `aad = CONCAT(TSP_Version, VID_sndr, VID_rcvr)`. The `-E` count code is
  // deliberately outside it, which is exactly why encoding splits in two.
  const fields = encodeFields("did:web:alice.example", "did:web:bob.example");
  const frame = finalizeFrame(fields, new Uint8Array(0));
  const decoded = decodeRev3(frame);
  assert.deepEqual(frame.slice(decoded.aad.begin, decoded.aad.end), fields);
  assert.equal(decoded.aad.begin, 3, "the AAD starts after the count code, not at 0");
});

test("Rev 3 envelope round-trips for varied VID lengths", () => {
  for (const [s, r] of [
    ["a", "b"],
    ["did:web:x", "did:web:y"],
    ["did:key:z6Mkexample", "did:web:host.example:path"],
  ]) {
    const frame = finalizeFrame(encodeFields(s, r), new Uint8Array(0));
    const { envelope } = decodeRev3(frame);
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
  assert.equal(decodeRev3(frame).envelope.receiver, "");

  const headless = finalizeFrame(encodeFields("", "did:web:bob"), new Uint8Array(0));
  assert.throws(() => decodeRev3(headless), /NULL VID/);
});

test("a frame claiming more content than it holds is refused at the count", () => {
  const fields = encodeFields("did:web:alice", "did:web:bob");
  const honest = finalizeFrame(fields, new Uint8Array(0));
  // Overstate the count by one quadlet. §9.1 asks a receiver to check the
  // declared signable length, so this dies here rather than as a confusing
  // failure three layers down.
  const lying = Uint8Array.from(honest);
  lying[2] += 1;
  assert.throws(() => decodeRev3(lying), /declares more content/);
});

test("the public decodeEnvelope dispatches, and reports which revision it read", () => {
  // Rev 3, from the published vectors.
  const rev3 = decodeEnvelope(b64u(VECTORS.vectors["direct-hpke-base"].message));
  assert.equal(rev3.revision, "rev3");
  assert.equal(rev3.minor, 64); // the vectors carry `ABA`
  assert.equal(rev3.envelope.sender, VECTORS.identifiers.alice.id);
  assert.equal(rev3.envelope.receiver, VECTORS.identifiers.bob.id);

  // Rev 2, from the pinned Rust interop vector in `interop.rust-vector.mjs`.
  const rev2Wire = Buffer.from(
    "f8401361348ff80001e010076469643a7765623a616c6963652e6578616d706c65e8100700006469643a7765623a626f622e6578616d706c655c0000e0601a5795132915e698a115677334d13dd7154f717eda8791473ccbb360671313f40544e2ae9153559a01d6aa33b93261dd0ab610231bad47e059d0eaa46038cf872ba82a282a431fd391e10f4d3c0603f82016f8a016d0100d308cdcf413984d884ff81ac2308da9d3afc9a0601e9393f664d54f9c37892897e996a0c8949ca8afa643ed39f888312094f6c34c55a1f4c3c0032f969cb707",
    "hex",
  );
  const rev2 = decodeEnvelope(new Uint8Array(rev2Wire));
  assert.equal(rev2.revision, "rev2");
  assert.equal(rev2.minor, 1);
  assert.equal(rev2.envelope.sender, "did:web:alice.example");
  assert.equal(rev2.envelope.receiver, "did:web:bob.example");
});

test("truncated and non-TSP input throws", () => {
  assert.throws(() => decodeEnvelope(new Uint8Array([0xf8, 0x40])));
  assert.throws(() => decodeEnvelope(new Uint8Array([1, 0])));
  assert.throws(() => decodeEnvelope(new Uint8Array(0)));
});
