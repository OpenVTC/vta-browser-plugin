import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

import { unpack, peekRevision } from "../dist/index.js";

// ── The specification's own Appendix A test vectors ──
//
// Fixture lifted verbatim from affinidi-tsp's `tests/vectors/rev3.json`, which
// was extracted from spec commit 66a1580 and checked value by value against
// `tsp_sdk` 0.10.0's own copy — the file the appendix was rendered from.
//
// These check something neither a round trip nor a two-implementation interop
// run can. A round trip passes whenever the encoder and decoder share a
// misreading, and an interop harness that packs with one implementation and
// unpacks with the other passes whenever *both* share one. These bytes are
// fixed, external, and were produced by neither of us.
//
// Three of the ten are runnable here. `direct-sealed-box` and
// `control-rfi-sealed-box` need the libsodium sealed box (§8.3), which we
// deliberately do not implement; `direct-signed-only` is an unencrypted `-E`
// frame we never receive; the three control vectors need the relationship state
// machine; `direct-hpke-base-pq` needs ML-KEM and ML-DSA. Each is skipped by
// name below rather than silently absent, so the list says what is missing
// instead of looking complete.
const VECTORS = JSON.parse(
  readFileSync(new URL("./fixtures/spec-rev3-vectors.json", import.meta.url), "utf8"),
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

test("the published vectors declare a revision we read as Rev 3", () => {
  // They carry `YTSP-ABA` — MINOR 64 under the MAJOR.MINOR reading this package
  // and affinidi-tsp both use, where our own packing emits `AAC` (MINOR 2).
  // Both must read as Rev 3, which is the whole reason `peekRevision` matches
  // Rev 2 exactly and treats everything else at MAJOR 0 as current.
  const peeked = peekRevision(b64u(VECTORS.vectors["direct-hpke-base"].message));
  assert.equal(peeked.revision, "rev3");
  assert.equal(peeked.major, 0);
  assert.equal(peeked.minor, 64);
  assert.equal(peeked.recognised, true);
});

test("direct-hpke-base — opens, verifies, and carries the published payload", async () => {
  const unpacked = await openVector("direct-hpke-base");
  assert.equal(unpacked.revision, "rev3");
  assert.equal(unpacked.messageType, "direct");
  assert.equal(unpacked.sender, id("alice").id);
  assert.equal(unpacked.receiver, id("bob").id);
  assert.equal(Buffer.from(unpacked.payload).toString("utf8"), "hello world");
  assert.deepEqual(unpacked.hops, []);
});

test("direct-hpke-base — the ESSR sender field may be the NULL VID", async () => {
  // This vector's payload frame is `-ZAJ XSCS 4BAA 4BAA -AAF 5BAE <hello world>`:
  // the sender field is `4BAA`, the NULL VID. §9.2 permits it under HPKE-Base,
  // and affinidi-tsp writes the real VID instead — so a decoder that required
  // either spelling would reject half the conformant messages in existence.
  // qb64 `-ZAJ XSCS 4BAA 4BAA -AAF 5BAE <hello world>`, which in the binary
  // domain this package works in is the layout below. The third field — the
  // ESSR sender — is `e01000`, an empty `B` var-data field: the NULL VID.
  const frame = Buffer.from(VECTORS.vectors["direct-hpke-base"].payload, "base64url");
  assert.equal(frame.subarray(0, 3).toString("hex"), "f99009", "-Z count, 9 quadlets");
  assert.equal(frame.subarray(3, 6).toString("hex"), "5d2092", "XSCS type code");
  assert.equal(frame.subarray(6, 9).toString("hex"), "e01000", "ESSR sender: NULL VID");
  assert.equal(frame.subarray(9, 12).toString("hex"), "e01000", "padding: empty field");
  assert.equal(frame.subarray(12, 15).toString("hex"), "f80005", "-A generic stream, 5 quadlets");
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
  assert.equal(inner.revision, "rev3");
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
    "control-rfi-direct": "relationship state machine (§7.2)",
    "control-rfa-direct": "relationship state machine (§7.2)",
    "control-rfd": "relationship state machine (§7.3)",
    "direct-hpke-base-pq": "ML-KEM-768/X25519 + ML-DSA-65 (§8.1/§8.2.1)",
  };
  for (const name of Object.keys(uncovered)) {
    assert.ok(VECTORS.vectors[name], `vector ${name} is in the fixture`);
  }
  const covered = ["direct-hpke-base", "nested-direct", "routed"];
  assert.deepEqual(
    new Set([...covered, ...Object.keys(uncovered)]),
    new Set(Object.keys(VECTORS.vectors)),
    "every published vector is either exercised or listed as uncovered",
  );
});
