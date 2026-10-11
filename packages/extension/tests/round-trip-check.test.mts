// How the self-test words one transport's round trip. The connection
// self-test passed every check while every request timed out, because none of
// them waited for an answer; these are the lines that do.

import { strict as assert } from "node:assert";
import { test } from "node:test";

import { roundTripCheck } from "../src/round-trip-check.js";

test("an answer passes, with its time", () => {
  const c = roundTripCheck("TSP", { kind: "answered", ms: 420 });
  assert.equal(c.id, "vta.roundtrip.tsp");
  assert.equal(c.status, "pass");
  assert.match(c.detail, /0\.4 s/);
});

test("a refusal passes the transport and shows the refusal", () => {
  const c = roundTripCheck("DIDComm", {
    kind: "answered",
    ms: 900,
    refusal: { code: "e.p.msg.forbidden", message: "permission denied: forbidden: DID not in ACL" },
  });
  assert.equal(c.status, "pass");
  assert.equal(c.code, "e.p.msg.forbidden");
  assert.match(c.detail, /DID not in ACL/);
  assert.match(c.detail, /authority/);
});

test("a lost reply fails, keeps the channel's own reading, and points at the agent", () => {
  const c = roundTripCheck("TSP", {
    kind: "failed",
    ms: 12_000,
    code: "e.client.network",
    message: "tsp: timed out awaiting reply frame — no frame arrived on this socket while waiting",
  });
  assert.equal(c.status, "fail");
  assert.match(c.detail, /12\.0 s/);
  assert.match(c.detail, /no frame arrived/);
  assert.match(c.remediation ?? "", /failed to send TSP reply/);
});

test("a REST failure points at REST, not at a mediator", () => {
  const c = roundTripCheck("REST", { kind: "failed", ms: 300, message: "405" });
  assert.match(c.remediation ?? "", /REST endpoint/);
});

test("a transport the wallet does not use is a skip, with the reason", () => {
  const c = roundTripCheck("TSP", { kind: "skipped", reason: "Prefer TSP is off" });
  assert.equal(c.status, "skip");
  assert.equal(c.detail, "Prefer TSP is off");
});
