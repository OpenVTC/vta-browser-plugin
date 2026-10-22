import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

import { unpack, peekRevision } from "../dist/index.js";
import * as wire from "../dist/cesr/wire.js";

// ── The specification's own Appendix A test vectors ──
//
// Fixture from Appendix A of the released specification, TSP 1.0
// (trustoverip/tswg-tsp-specification ccda6b3), which packs `YTSP-BAA`. It
// replaced the Rev 3 `YTSP-AAC` vectors: the version is inside the signed
// envelope, the AAD and every SAID, so every message changed with it, and the
// confidential ones gained the sender VID in their payload.
//
// These check something neither a round trip nor a two-implementation interop
// run can. A round trip passes whenever the encoder and decoder share a
// misreading, and an interop harness that packs with one implementation and
// unpacks with the other passes whenever *both* share one. These bytes are
// fixed, external, and were produced by neither of us.
//
// Three of the eleven are exercised here and the four HPKE-Base control vectors
// in `control.spec-vectors.mjs`. `direct-sealed-box` and `control-rfi-sealed-box`
// need the libsodium sealed box (§8.3), which we deliberately do not implement;
// `direct-signed-only` is an unencrypted `-E` frame we never receive;
// `direct-hpke-base-pq` needs ML-KEM and ML-DSA. Each is skipped by
// name below rather than silently absent, so the list says what is missing
// instead of looking complete.
const VECTORS = JSON.parse(
  readFileSync(new URL("./fixtures/spec-v1-vectors.json", import.meta.url), "utf8"),
);

const b64u = (s) => new Uint8Array(Buffer.from(s, "base64url"));
const id = (name) => VECTORS.identifiers[name];

/** Unpack a named vector as its declared receiver. */
const openVector = (name) => {
  const v = VECTORS.vectors[name];
  const sender = id(v.sender);
  const receiver = id(v.receiver);
  return unpack(b64u(v.message), {
    receiverDecryptionKey: b64u(receiver.skE),
    senderSigningKey: b64u(sender.pkS),
  });
};

test("the published vectors declare the version we pack: YTSP-BAA", () => {
  // A stale fixture would fail every open on MAJOR anyway; this is the test
  // whose failure says so in as many words.
  for (const [name, v] of Object.entries(VECTORS.vectors)) {
    const peeked = peekRevision(b64u(v.message));
    assert.equal(peeked.major, 1, name);
    assert.equal(peeked.minor, 0, name);
    assert.equal(peeked.recognised, true, name);
    assert.equal(v.message.slice(4, 12), "YTSP-BAA", `${name} carries YTSP-BAA in qb64`);
  }
});

test("direct-hpke-base — opens, verifies, and carries the published payload", async () => {
  const unpacked = await openVector("direct-hpke-base");
  assert.equal(unpacked.messageType, "direct");
  assert.equal(unpacked.sender, id("alice").id);
  assert.equal(unpacked.receiver, id("bob").id);
  assert.equal(Buffer.from(unpacked.payload).toString("utf8"), "hello world");
  assert.deepEqual(unpacked.hops, []);
});

test("direct-hpke-base — the ESSR sender field names the sender", async () => {
  // 1.0 requires the sender VID in every confidential payload (§3.2), where
  // Rev 3 let HPKE-Base write the NULL VID `4BAA` — which is what this vector
  // carried at `YTSP-AAC`. Now: `-ZAc XSCS 4BAT <alice> 4BAA -AAF 5BAE <hello
  // world>`, and the field after the type code is alice's VID.
  const frame = b64u(VECTORS.vectors["direct-hpke-base"].payload);
  assert.equal(Buffer.from(frame.subarray(3, 6)).toString("hex"), "5d2092", "XSCS type code");
  const cur = { pos: 6 };
  const sender = new TextDecoder().decode(wire.decodeVariableData(wire.TSP_VID, frame, cur));
  assert.equal(sender, id("alice").id, "ESSR sender: the sender's VID, not 4BAA");
  await assert.doesNotReject(() => openVector("direct-hpke-base"));
});

test("nested-direct — the inner message is carried raw, not in a B field", async () => {
  const unpacked = await openVector("nested-direct");
  assert.equal(unpacked.messageType, "nested");
  assert.deepEqual(unpacked.hops, []);
  // Rev 2 wrapped the inner message in an enclosing `B` var-data field; Rev 3
  // carries it raw. Reading the payload as a whole TSP message is what says we
  // stripped nothing and added nothing: it must still lead with a `-E` frame.
  const inner = peekRevision(unpacked.payload);
  assert.deepEqual([inner.major, inner.minor], [1, 0]);
});

test("routed — the hop list survives the -J byte-length count", async () => {
  const unpacked = await openVector("routed");
  assert.equal(unpacked.messageType, "routed");
  // Rev 3 §9.2 made the `-J` count the group's byte length rather than the
  // number of VIDs. A decoder still reading it as a VID count reads this
  // vector's hop list as ~13 hops and runs off the end of the frame.
  assert.ok(unpacked.hops.length >= 1, "a routed message names at least one onward hop");
  for (const hop of unpacked.hops) assert.match(hop, /^did:/);
});

test("a wrong verifying key is a signature failure, not a decrypt failure", async () => {
  const v = VECTORS.vectors["direct-hpke-base"];
  await assert.rejects(
    () =>
      unpack(b64u(v.message), {
        receiverDecryptionKey: b64u(id("bob").skE),
        senderSigningKey: b64u(id("bob").pkS), // Bob did not send this
      }),
    /signature verification failed/,
  );
});

test("vectors this implementation does not cover are named, not omitted", () => {
  const uncovered = {
    "direct-sealed-box": "libsodium sealed box (§8.3) — deliberately not implemented",
    "control-rfi-sealed-box": "libsodium sealed box (§8.3)",
    "direct-signed-only": "unencrypted -E frame; we neither send nor expect one",
    "direct-hpke-base-pq": "ML-KEM-768/X25519 + ML-DSA-65 (§8.1/§8.2.1)",
  };
  for (const name of Object.keys(uncovered)) {
    assert.ok(VECTORS.vectors[name], `vector ${name} is in the fixture`);
  }
  // The HPKE-Base control vectors are opened, and their digests re-derived, in
  // `control.spec-vectors.mjs`.
  const covered = [
    "direct-hpke-base",
    "nested-direct",
    "routed",
    "control-rfi-direct",
    "control-rfa-direct",
    "control-rfd",
    "control-rfi-referral",
  ];
  assert.deepEqual(
    new Set([...covered, ...Object.keys(uncovered)]),
    new Set(Object.keys(VECTORS.vectors)),
    "every published vector is either exercised or listed as uncovered",
  );
});
