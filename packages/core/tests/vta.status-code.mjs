// Framework status codes → the typed `VtaErrorCode` the UI branches on.
//
// Two things are pinned here, and they fail in opposite directions.
//
// The **standard** set (SPEC §8.3) is the framework's, not this library's, and
// it grows: `idConflict` was added after `coerceTrustTaskCode`'s switch was
// written, and a code the switch has never heard of does not raise anything —
// it lands in the `bad_request` default and reports a duplicate-id rejection,
// whose fix is a fresh id, as a malformed request. So the mapping is asserted
// against `STANDARD_CODES` itself: a code the framework adds and this switch
// ignores shows up here rather than as a wrong bucket in a user's UI.
//
// The **extended** set (§8.5) is namespaced so it cannot collide with the
// standard one, and this library reads the local part anyway as a courtesy.
// That is a deliberate imprecision, so it is stated rather than assumed.

import { test } from "node:test";
import assert from "node:assert/strict";

import { STANDARD_CODES } from "@openvtc/trust-tasks/_runtime/codes";
import { coerceTrustTaskCode } from "../dist/vta/trust-task.js";

test("idConflict is a conflict, not a generic bad request", () => {
  // The regression this test exists for. `trust-tasks-rs` and the TypeScript
  // framework runtime both emit it; it is absent from `trust-task-error/0.3`'s
  // enum, which is why those runtimes emit `0.5` documents.
  assert.equal(coerceTrustTaskCode("idConflict"), "e.p.msg.conflict");
});

test("every framework standard code maps to a real VtaErrorCode", () => {
  // Not asserting *which* bucket for most of them — that is a judgement the
  // switch owns. Asserting that none of them falls through to something
  // unusable, and that the set being iterated is the framework's own.
  const buckets = new Set([
    "e.p.msg.forbidden",
    "e.p.msg.conflict",
    "e.p.msg.internal",
    "e.p.msg.bad_request",
  ]);
  for (const code of STANDARD_CODES) {
    assert.ok(buckets.has(coerceTrustTaskCode(code)), `${code} → unmapped`);
  }
});

test("the frozen framework 0.1 snake_case spellings still map", () => {
  // A 0.1 peer is still a supported peer. `normalizeCode` folds these to the
  // canonical 0.2 spelling *only* because they are standard codes.
  assert.equal(coerceTrustTaskCode("permission_denied"), "e.p.msg.forbidden");
  assert.equal(coerceTrustTaskCode("internal_error"), "e.p.msg.internal");
  assert.equal(coerceTrustTaskCode("id_conflict"), "e.p.msg.conflict");
});

test("an extended code is read by its local part, and only as a courtesy", () => {
  // Pinned in `tsp.channel.mjs` too, from the channel side. The namespace is
  // what makes an extended code unambiguous, and reading past it is a guess —
  // a good one for a UI bucket, worthless for deciding meaning.
  assert.equal(
    coerceTrustTaskCode("vault/list:permissionDenied"),
    "e.p.msg.forbidden",
  );
  // A local part that is not a standard code gets no special treatment.
  assert.equal(
    coerceTrustTaskCode("provision/integration:contextRequired"),
    "e.p.msg.bad_request",
  );
});

test("a missing or empty code is a bad request, not a crash", () => {
  assert.equal(coerceTrustTaskCode(undefined), "e.p.msg.bad_request");
  assert.equal(coerceTrustTaskCode(""), "e.p.msg.bad_request");
});
