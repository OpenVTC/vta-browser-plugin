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
// only when the transport authenticated it as the executor the decision was
// sent to. The message's own `from` is sender-written and never consulted.

import { test } from "node:test";
import assert from "node:assert/strict";

import { generateSigningIdentity } from "../dist/siop/self-issued.js";
import { signTrustTask } from "../dist/trust-tasks/sign.js";
import {
  parseTaskConsentOutcome,
  taskConsentOutcomeThread,
  TASK_CONSENT_DECISION_RESPONSE_TYPE,
} from "../dist/inbound/task-consent.js";
import {
  TRUST_TASK_ENVELOPE_TYPE,
  TRUST_TASK_ERROR_TYPE,
  TRUST_TASK_ERROR_TYPE_0_2,
} from "../dist/vta/protocol.js";

const VTA = "did:webvh:zScid:vta.example:glenn-vta";
const OPTS = { senderDid: VTA, expectedExecutorDid: VTA };
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

test("a permissionDenied refusal is read, not dropped", async () => {
  // Precisely the reply that went unread in the field: the transport gate
  // refused the approver, and the wallet said nothing.
  const outcome = await parseTaskConsentOutcome(
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

test("the 0.1 error type is read too, with its snake_case code left alone", async () => {
  // `code` is opaque: 0.1 says permission_denied, 0.2 says permissionDenied.
  // Normalising here would invite a caller to branch on one casing.
  const outcome = await parseTaskConsentOutcome(
    envelope(
      errorDoc(TRUST_TASK_ERROR_TYPE, { code: "permission_denied", retryable: false }),
    ),
    OPTS,
  );
  assert.equal(outcome.accepted, false);
  assert.equal(outcome.code, "permission_denied");
});

test("details ride through — that is where a task-specific reason lives", async () => {
  const outcome = await parseTaskConsentOutcome(
    envelope(
      errorDoc(TRUST_TASK_ERROR_TYPE_0_2, {
        code: "taskFailed",
        retryable: false,
        details: { payloadDigest: "zQmSK9pGKFnmc77pqyNAPJyPKt8rMqctngfg3vwuMArwGYZ" },
      }),
    ),
    OPTS,
  );
  assert.deepEqual(outcome.details, { payloadDigest: "zQmSK9pGKFnmc77pqyNAPJyPKt8rMqctngfg3vwuMArwGYZ" });
});

test("a missing retryable reads as not-retryable, never as optimism", async () => {
  const outcome = await parseTaskConsentOutcome(
    envelope(errorDoc(TRUST_TASK_ERROR_TYPE_0_2, { code: "internalError" })),
    OPTS,
  );
  assert.equal(outcome.retryable, false);
});

test("an accepted decision reports the status and the tally", async () => {
  const outcome = await parseTaskConsentOutcome(
    envelope({
      id: "urn:uuid:ok-1",
      type: TASK_CONSENT_DECISION_RESPONSE_TYPE,
      threadId: THID,
      payload: { status: "granted", payloadDigest: "zQmSK9pGKFnmc77pqyNAPJyPKt8rMqctngfg3vwuMArwGYZ", approvals: 1 },
    }),
    OPTS,
  );
  assert.equal(outcome.accepted, true);
  assert.equal(outcome.status, "granted");
  assert.equal(outcome.approvals, 1);
  assert.equal(outcome.payloadDigest, "zQmSK9pGKFnmc77pqyNAPJyPKt8rMqctngfg3vwuMArwGYZ");
});

test("a partial approval is accepted, and says how many more are needed", async () => {
  const outcome = await parseTaskConsentOutcome(
    envelope({
      id: "urn:uuid:ok-2",
      type: TASK_CONSENT_DECISION_RESPONSE_TYPE,
      threadId: THID,
      payload: { status: "pending", payloadDigest: "zQmSK9pGKFnmc77pqyNAPJyPKt8rMqctngfg3vwuMArwGYZ", approvals: 1, needed: 2 },
    }),
    OPTS,
  );
  assert.equal(outcome.accepted, true);
  assert.equal(outcome.status, "pending");
  assert.equal(outcome.needed, 2);
});

test("a refusal whose `from` names the VTA but whose sender is someone else is not believed", async () => {
  // The forged notice: an attacker authcrypts with its own key and writes the
  // VTA's DID into `from`. Believing it would tell the human their approval
  // failed — an invitation to approve a second time — and make the wallet
  // forget the decision it is waiting on.
  const outcome = await parseTaskConsentOutcome(
    envelope(errorDoc(TRUST_TASK_ERROR_TYPE_0_2, { code: "permissionDenied", retryable: false })),
    { senderDid: "did:key:zSomeoneElse", expectedExecutorDid: VTA },
  );
  assert.equal(outcome, null);
});

test("only the executor the decision went to may answer it", async () => {
  // Another executor this device is enrolled with did not receive the
  // decision, so it cannot report on it either.
  const outcome = await parseTaskConsentOutcome(
    envelope(errorDoc(TRUST_TASK_ERROR_TYPE_0_2, { code: "permissionDenied", retryable: false }), {
      from: "did:web:control-plane.example",
    }),
    { senderDid: "did:web:control-plane.example", expectedExecutorDid: VTA },
  );
  assert.equal(outcome, null);
});

test("a reply with no authenticated sender is dropped", async () => {
  for (const senderDid of [null, undefined, ""]) {
    const outcome = await parseTaskConsentOutcome(
      envelope(errorDoc(TRUST_TASK_ERROR_TYPE_0_2, { code: "permissionDenied", retryable: false })),
      { senderDid, expectedExecutorDid: VTA },
    );
    assert.equal(outcome, null);
  }
});

test("`from` is not consulted — a missing one does not matter when the sender is proven", async () => {
  const outcome = await parseTaskConsentOutcome(
    envelope(errorDoc(TRUST_TASK_ERROR_TYPE_0_2, { code: "permissionDenied", retryable: false }), {
      from: undefined,
    }),
    OPTS,
  );
  assert.equal(outcome?.accepted, false);
});

test("an in-band issuer contradicting the sender is dropped", async () => {
  const doc = { ...errorDoc(TRUST_TASK_ERROR_TYPE_0_2, { code: "permissionDenied", retryable: false }), issuer: "did:key:zSomeoneElse" };
  assert.equal(await parseTaskConsentOutcome(envelope(doc), OPTS), null);
});

// ── A reply that carries a proof ────────────────────────────────────────

const SIGNED_VTA = generateSigningIdentity();
const ATTACKER = generateSigningIdentity();
const SIGNED_OPTS = { senderDid: SIGNED_VTA.did, expectedExecutorDid: SIGNED_VTA.did };

async function signedResponse({ signer = SIGNED_VTA, issuer = SIGNED_VTA.did } = {}) {
  const doc = {
    id: "urn:uuid:ok-signed",
    type: TASK_CONSENT_DECISION_RESPONSE_TYPE,
    issuer,
    threadId: THID,
    payload: { status: "granted", payloadDigest: "zQmSK9pGKFnmc77pqyNAPJyPKt8rMqctngfg3vwuMArwGYZ" },
  };
  await signTrustTask({ envelope: doc, signing: signer });
  return envelope(doc, { from: SIGNED_VTA.did });
}

test("a reply signed by the executor is believed", async () => {
  const outcome = await parseTaskConsentOutcome(await signedResponse(), SIGNED_OPTS);
  assert.equal(outcome?.accepted, true);
  assert.equal(outcome.status, "granted");
});

test("a reply whose proof is by another key is dropped, even from the right sender", async () => {
  const outcome = await parseTaskConsentOutcome(
    await signedResponse({ signer: ATTACKER, issuer: SIGNED_VTA.did }),
    SIGNED_OPTS,
  );
  assert.equal(outcome, null);
});

test("a signed reply edited after signing is dropped", async () => {
  const msg = await signedResponse();
  msg.body.payload.status = "denied";
  assert.equal(await parseTaskConsentOutcome(msg, SIGNED_OPTS), null);
});

test("the thread a reply answers is readable before it is trusted", () => {
  assert.equal(taskConsentOutcomeThread(envelope({})), THID);
  assert.equal(taskConsentOutcomeThread(envelope({ threadId: "t-doc" }, { thid: undefined })), "t-doc");
  assert.equal(taskConsentOutcomeThread({ body: {} }), undefined);
});

test("anything that is not an answer returns null, so other handlers still see it", async () => {
  // The one case a caller may ignore. A consent *request* must fall through to
  // the parser that prompts a human — returning an outcome here would swallow
  // the prompt, which is the failure this whole module exists to prevent.
  for (const body of [
    { id: "x", type: "https://trusttasks.org/spec/task-consent/request/0.1", payload: {} },
    { id: "x", type: "https://trusttasks.org/spec/vta/webvh/dids/update/1.0", payload: {} },
    {},
  ]) {
    assert.equal(await parseTaskConsentOutcome(envelope(body), OPTS), null);
  }
  assert.equal(
    await parseTaskConsentOutcome(
      { type: "https://didcomm.org/messagepickup/3.0/status", from: VTA },
      OPTS,
    ),
    null,
  );
});

test("the thid falls back to the document threadId when the envelope omits it", async () => {
  const outcome = await parseTaskConsentOutcome(
    envelope(errorDoc(TRUST_TASK_ERROR_TYPE_0_2, { code: "permissionDenied", retryable: false }), {
      thid: undefined,
    }),
    OPTS,
  );
  assert.equal(outcome.thid, THID);
});

test("an answer with no correlation at all is still reported", async () => {
  // Losing the thread costs detail, never the report: a refusal the wallet
  // cannot match to a specific decision is still a refusal the human needs.
  const outcome = await parseTaskConsentOutcome(
    envelope({ id: "e", type: TRUST_TASK_ERROR_TYPE_0_2, payload: { code: "taskFailed", retryable: false } }, {
      thid: undefined,
    }),
    OPTS,
  );
  assert.equal(outcome.accepted, false);
  assert.equal(outcome.thid, undefined);
});
