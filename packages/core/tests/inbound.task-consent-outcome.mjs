// The executor's answer to a decision this device sent.
//
// A refusal is the worst inbound event in the ceremony: a human was shown a
// change, agreed to it, and the agreement did not take — so unlike a lost
// prompt, the person believes they have acted. The wallet used to drop that
// reply unread, because nothing recognised it and the inbound handler's final
// branch ignores what it cannot name. An approval the VTA rejected then looked,
// from this side, exactly like one that worked.
//
// These pin the two halves that matter: the answer is *read*, and it is read
// only when it comes from an executor this device is enrolled with.

import { test } from "node:test";
import assert from "node:assert/strict";

import {
  parseTaskConsentOutcome,
  TASK_CONSENT_DECISION_RESPONSE_TYPE,
} from "../dist/inbound/task-consent.js";
import {
  TRUST_TASK_ENVELOPE_TYPE,
  TRUST_TASK_ERROR_TYPE,
  TRUST_TASK_ERROR_TYPE_0_2,
} from "../dist/vta/protocol.js";

const VTA = "did:webvh:zScid:vta.example:glenn-vta";
const OPTS = { enrolledExecutorDids: [VTA] };
const THID = "urn:uuid:decision-1";

function envelope(body, overrides = {}) {
  return {
    id: "urn:uuid:reply-1",
    type: TRUST_TASK_ENVELOPE_TYPE,
    from: VTA,
    to: ["did:key:zApprover"],
    thid: THID,
    body,
    ...overrides,
  };
}

function errorDoc(type, payload) {
  return { id: "urn:uuid:err-1", type, threadId: THID, payload };
}

test("a permissionDenied refusal is read, not dropped", () => {
  // Precisely the reply that went unread in the field: the transport gate
  // refused the approver, and the wallet said nothing.
  const outcome = parseTaskConsentOutcome(
    envelope(
      errorDoc(TRUST_TASK_ERROR_TYPE_0_2, {
        code: "permissionDenied",
        message: "DID not in ACL: did:key:zApprover",
        retryable: false,
      }),
    ),
    OPTS,
  );
  assert.ok(outcome, "the refusal must be recognised");
  assert.equal(outcome.accepted, false);
  assert.equal(outcome.code, "permissionDenied");
  assert.equal(outcome.retryable, false);
  assert.match(outcome.message, /not in ACL/);
  assert.equal(outcome.thid, THID, "correlates to the decision we sent");
});

test("the 0.1 error type is read too, with its snake_case code left alone", () => {
  // `code` is opaque: 0.1 says permission_denied, 0.2 says permissionDenied.
  // Normalising here would invite a caller to branch on one casing.
  const outcome = parseTaskConsentOutcome(
    envelope(
      errorDoc(TRUST_TASK_ERROR_TYPE, { code: "permission_denied", retryable: false }),
    ),
    OPTS,
  );
  assert.equal(outcome.accepted, false);
  assert.equal(outcome.code, "permission_denied");
});

test("details ride through — that is where a task-specific reason lives", () => {
  const outcome = parseTaskConsentOutcome(
    envelope(
      errorDoc(TRUST_TASK_ERROR_TYPE_0_2, {
        code: "taskFailed",
        retryable: false,
        details: { payloadDigest: "abc123" },
      }),
    ),
    OPTS,
  );
  assert.deepEqual(outcome.details, { payloadDigest: "abc123" });
});

test("a missing retryable reads as not-retryable, never as optimism", () => {
  const outcome = parseTaskConsentOutcome(
    envelope(errorDoc(TRUST_TASK_ERROR_TYPE_0_2, { code: "internalError" })),
    OPTS,
  );
  assert.equal(outcome.retryable, false);
});

test("an accepted decision reports the status and the tally", () => {
  const outcome = parseTaskConsentOutcome(
    envelope({
      id: "urn:uuid:ok-1",
      type: TASK_CONSENT_DECISION_RESPONSE_TYPE,
      threadId: THID,
      payload: { status: "granted", payloadDigest: "abc123", approvals: 1 },
    }),
    OPTS,
  );
  assert.equal(outcome.accepted, true);
  assert.equal(outcome.status, "granted");
  assert.equal(outcome.approvals, 1);
  assert.equal(outcome.payloadDigest, "abc123");
});

test("a partial approval is accepted, and says how many more are needed", () => {
  const outcome = parseTaskConsentOutcome(
    envelope({
      id: "urn:uuid:ok-2",
      type: TASK_CONSENT_DECISION_RESPONSE_TYPE,
      threadId: THID,
      payload: { status: "pending", payloadDigest: "abc123", approvals: 1, needed: 2 },
    }),
    OPTS,
  );
  assert.equal(outcome.accepted, true);
  assert.equal(outcome.status, "pending");
  assert.equal(outcome.needed, 2);
});

test("a reply from anyone but an enrolled executor is not believed", () => {
  // An unauthenticated party must not be able to tell this device its approval
  // failed — that is an invitation to approve a second time — nor that one
  // succeeded when it did not.
  const outcome = parseTaskConsentOutcome(
    envelope(errorDoc(TRUST_TASK_ERROR_TYPE_0_2, { code: "permissionDenied", retryable: false }), {
      from: "did:key:zSomeoneElse",
    }),
    OPTS,
  );
  assert.equal(outcome, null);
});

test("an unattributable reply is dropped", () => {
  // No `from` means the transport could not authenticate the sender, and
  // nothing downstream re-verifies this document.
  const outcome = parseTaskConsentOutcome(
    envelope(errorDoc(TRUST_TASK_ERROR_TYPE_0_2, { code: "permissionDenied", retryable: false }), {
      from: undefined,
    }),
    OPTS,
  );
  assert.equal(outcome, null);
});

test("anything that is not an answer returns null, so other handlers still see it", () => {
  // The one case a caller may ignore. A consent *request* must fall through to
  // the parser that prompts a human — returning an outcome here would swallow
  // the prompt, which is the failure this whole module exists to prevent.
  for (const body of [
    { id: "x", type: "https://trusttasks.org/spec/task-consent/request/0.1", payload: {} },
    { id: "x", type: "https://trusttasks.org/spec/vta/webvh/dids/update/1.0", payload: {} },
    {},
  ]) {
    assert.equal(parseTaskConsentOutcome(envelope(body), OPTS), null);
  }
  assert.equal(
    parseTaskConsentOutcome(
      { type: "https://didcomm.org/messagepickup/3.0/status", from: VTA },
      OPTS,
    ),
    null,
  );
});

test("the thid falls back to the document threadId when the envelope omits it", () => {
  const outcome = parseTaskConsentOutcome(
    envelope(errorDoc(TRUST_TASK_ERROR_TYPE_0_2, { code: "permissionDenied", retryable: false }), {
      thid: undefined,
    }),
    OPTS,
  );
  assert.equal(outcome.thid, THID);
});

test("an answer with no correlation at all is still reported", () => {
  // Losing the thread costs detail, never the report: a refusal the wallet
  // cannot match to a specific decision is still a refusal the human needs.
  const outcome = parseTaskConsentOutcome(
    envelope({ id: "e", type: TRUST_TASK_ERROR_TYPE_0_2, payload: { code: "taskFailed", retryable: false } }, {
      thid: undefined,
    }),
    OPTS,
  );
  assert.equal(outcome.accepted, false);
  assert.equal(outcome.thid, undefined);
});
