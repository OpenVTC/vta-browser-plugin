// The consent payload, against the schema the registry publishes.
//
// These are the cases a hand-written `typeof` block cannot express, and every
// one of them reached a human before this was validated. The first is the
// reason the rest were worth doing: a `sideEffects` value outside the schema's
// enum is not rejected by a `typeof === "string"` check, and the consent
// surface renders severity by comparing against the three known values —
// `destructive` gets the danger colour, `mutating` the warning colour, and
// **anything else falls through to the reassuring one**. So a schema violation
// arrived looking like the safest thing the UI can draw.

import { test } from "node:test";
import assert from "node:assert/strict";

import { validateAgainstSchema, describeViolations } from "../dist/trust-tasks/validate.js";
import { PAYLOAD_SCHEMA } from "@openvtc/trust-tasks/task-consent/request/0.1/payload";

/** A payload the published schema accepts. Overrides are applied on top. */
function payload(over = {}) {
  return {
    challenge: "9c1f4b7a2e6d80f35a4c9b1e7d2f6083",
    taskType: "https://trusttasks.org/spec/webvh/dids/update/1.0",
    payloadDigest: "zQmSK9pGKFnmc77pqyNAPJyPKt8rMqctngfg3vwuMArwGYZ",
    sideEffects: "mutating",
    exposure: { discloses: "none", actsAsSubject: false },
    effects: [{ kind: "documentChange", summary: "Adds a FileStore endpoint." }],
    requester: "did:key:zRequesterBrowser",
    approverSet: "operators",
    minApprovals: 1,
    excludeRequester: true,
    expiresAt: "2030-01-01T00:00:00Z",
    ...over,
  };
}

const check = (over) => validateAgainstSchema(PAYLOAD_SCHEMA, payload(over));

test("the baseline fixture satisfies the published schema", () => {
  const res = check({});
  assert.equal(res.valid, true, res.valid ? "" : describeViolations(res.violations));
});

test("a sideEffects outside the enum is refused — the fail-open this closes", () => {
  // `typeof === "string"` accepted every one of these. The UI's severity
  // comparison then failed to match `destructive` or `mutating` and painted the
  // calm colour, so the worst possible value rendered as the most reassuring.
  for (const bad of ["destructiv", "DESTRUCTIVE", "catastrophic", ""]) {
    const res = check({ sideEffects: bad });
    assert.equal(res.valid, false, `accepted sideEffects: ${JSON.stringify(bad)}`);
  }
  // And the three the schema does define still pass.
  for (const ok of ["none", "mutating", "destructive"]) {
    assert.equal(check({ sideEffects: ok }).valid, true, ok);
  }
});

test("minApprovals below 1 is refused — a threshold nothing has to meet", () => {
  // Checked as `typeof === "number"` before, which admits 0. A consent surface
  // showing "0 of 1 approvals needed" is describing a gate that is already open.
  for (const bad of [0, -1, 1.5]) {
    assert.equal(check({ minApprovals: bad }).valid, false, `accepted ${bad}`);
  }
  assert.equal(check({ minApprovals: 1 }).valid, true);
});

test("a payloadDigest that is not a digestMultibase is refused", () => {
  // This one was live: the test fixtures for this family carried the *hex*
  // form of the shared cross-repo digest long after the multibase cutover, and
  // the `typeof === "string"` check accepted it every time. The schema's
  // `DigestMultibase` pattern is what noticed.
  const hex = "3b0c7f1d9e2a5648c1f30b7ae4d2986153ca0f7b8d41e6295af03c8bd71e4a62";
  assert.equal(check({ payloadDigest: hex }).valid, false, "bare hex accepted");
});

test("a member the schema forbids is refused, not ignored", () => {
  // `additionalProperties: false`. An unknown member is a producer and consumer
  // disagreeing about the contract, and letting it through means the disagreement
  // surfaces somewhere further along with no trace of where it entered.
  assert.equal(check({ surprise: "hello" }).valid, false);
});

test("free-text members are bounded, per framework 0.5 §7.3 item 19", () => {
  // `note` is 500. The bound exists so a consent surface is never handed
  // unbounded prose to render — the schema is where that is enforced, and there
  // was no check for it here at all.
  assert.equal(check({ note: "x".repeat(500) }).valid, true);
  assert.equal(check({ note: "x".repeat(501) }).valid, false);
});

test("a rejection reports every violation, not just the first", () => {
  // `shortCircuit: false`. Reporting one member at a time makes a human fix
  // them one round-trip at a time.
  const res = check({ sideEffects: "nope", minApprovals: 0 });
  assert.equal(res.valid, false);
  const text = describeViolations(res.violations);
  assert.match(text, /sideEffects/);
  assert.match(text, /minApprovals/);
});

test("an unusable schema refuses rather than passes", () => {
  // The silent skip this module exists to remove: "nothing to check" must never
  // read as "checked, fine".
  for (const notASchema of [undefined, null, "{}", 42]) {
    assert.equal(validateAgainstSchema(notASchema, payload()).valid, false);
  }
});
