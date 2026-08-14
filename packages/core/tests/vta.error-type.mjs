// Which reply documents count as framework *errors*.
//
// This is a one-line predicate guarding a very asymmetric failure: a document
// it does not recognise is not treated as a failed operation, it is decoded as a
// successful one (`parseTrustTaskReply` returns the payload as the result). So
// under-matching here does not surface as an error with the wrong wording — it
// surfaces as a rejection the caller reports as success.

import { test } from "node:test";
import assert from "node:assert/strict";

import {
  isTrustTaskErrorType,
  TRUST_TASK_ERROR_TYPE,
  TRUST_TASK_ERROR_TYPE_0_2,
  TRUST_TASK_ERROR_TYPE_0_3,
} from "../dist/vta/protocol.js";

test("every framework error-document minor version is recognised", () => {
  // 0.3 is the one that matters operationally: `trust-tasks-rs` has emitted it
  // since its 0.3 release, so it is what a current VTA actually sends. It was
  // absent from the enumerated list this predicate used to be, which meant the
  // wallet read every real rejection as a success.
  for (const type of [
    TRUST_TASK_ERROR_TYPE,
    TRUST_TASK_ERROR_TYPE_0_2,
    TRUST_TASK_ERROR_TYPE_0_3,
  ]) {
    assert.equal(isTrustTaskErrorType(type), true, type);
  }
});

test("a future minor version is recognised without a code change", () => {
  // The whole point of matching the slug. SPEC.md §5.2's forward-minor rule says
  // a consumer SHOULD accept a later minor, and the cost of not doing so is not
  // a missing feature — it is silent success on failure.
  assert.equal(
    isTrustTaskErrorType("https://trusttasks.org/spec/trust-task-error/0.9"),
    true,
  );
  assert.equal(
    isTrustTaskErrorType("https://trusttasks.org/spec/trust-task-error/0.42"),
    true,
  );
});

test("a major version bump is NOT assumed compatible", () => {
  // 1.x is where the payload shape may genuinely change, so it must come back
  // through a deliberate code change rather than be silently decoded with 0.x
  // assumptions.
  assert.equal(
    isTrustTaskErrorType("https://trusttasks.org/spec/trust-task-error/1.0"),
    false,
  );
});

test("a success document is not an error", () => {
  assert.equal(
    isTrustTaskErrorType("https://trusttasks.org/spec/vta/webvh/dids/update/1.0#response"),
    false,
  );
  // Nor is anything that merely mentions the slug — a task type could.
  assert.equal(
    isTrustTaskErrorType("https://evil.example/spec/trust-task-error/0.3"),
    false,
  );
  assert.equal(
    isTrustTaskErrorType("https://trusttasks.org/spec/trust-task-error/0.3/extra"),
    false,
  );
});

test("a missing or non-string type is not an error document", () => {
  assert.equal(isTrustTaskErrorType(undefined), false);
  assert.equal(isTrustTaskErrorType(""), false);
  assert.equal(isTrustTaskErrorType(null), false);
  assert.equal(isTrustTaskErrorType(42), false);
});
