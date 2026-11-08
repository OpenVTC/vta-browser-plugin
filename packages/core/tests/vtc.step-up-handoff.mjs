// The reader's half of the `step-up` trigger-link flow (VTI-LNK-125 – 131),
// against a fake community that signs the way a VTC does: the reply and the
// approve-request inside it, both operational (`authentication`).
//
// What is pinned is what the wallet refuses before it shows the person
// anything: a link on another flow, a request the community did not sign, one
// addressed to someone other than its subject, an expired one, and a binding
// that is not the returned operation's.

import { test } from "node:test";
import assert from "node:assert/strict";
import {
  newApproverKey,
  sendOob,
  OobRefusedError,
  buildStepUpShow,
  checkStepUpShown,
  buildStepUpAnswer,
  StepUpHandoffError,
  STEP_UP_REQUESTS_SHOW_TYPE,
  STEP_UP_APPROVE_RESPONSE_TYPE,
} from "../dist/vtc/index.js";
import { generateSigningIdentity, signTrustTask, vtcStepUpBoundTo } from "../dist/index.js";
import { parseTriggerLink, outcomeOf } from "../dist/links/index.js";

const VTC = "did:webvh:QmPEQVM1JPTyrvEgBcDXwjK4TeyLGSX1PxjgyeAisPviUx:members.example.org";
const HANDLE = "Hk2pQ9xV4mT7rW1sZ8yN3A";
const SUBJECT = "did:webvh:QmS:people.example:alice";
const ENDPOINT = "https://members.example.org/v1/trust-tasks";
const APPROVE_REQUEST = "https://trusttasks.org/spec/auth/step-up/approve-request/0.5";
const OP = {
  type: "https://trusttasks.org/spec/auth/step-up/approver/invite/0.2",
  payload: { subject: "did:key:z6MkhaXgBZDvotDkL5257faiztiGiC2QtKLGpbnnEGta2doK" },
};

const vtcKey = generateSigningIdentity();
const VM = `${VTC}#key-1`;
const vtcSigner = { ...vtcKey, did: VTC, kid: VM };
const vtcDoc = {
  id: VTC,
  verificationMethod: [
    { id: VM, type: "Multikey", controller: VTC, publicKeyMultibase: vtcKey.did.slice("did:key:".length) },
  ],
  assertionMethod: [VM],
  authentication: [VM],
};

/** The inline request the community refused the operation with. */
async function inline(over = {}) {
  const challenge = "q3XKtZJ0p8m4Ud2vWcH7Rs1aLyN6bEf9";
  return {
    subject: SUBJECT,
    challenge,
    boundTo: await vtcStepUpBoundTo(OP.type, OP.payload, challenge),
    reason: "Invite an approver",
    accepts: ["approverSigned"],
    approvers: ["did:key:z6MkrJVnaZkeFzdQyMZu1cgjg7k1pZZ6pvBQ7XJPt4swbTQ2"],
    ...over,
  };
}

/** The approve-request document the community signs to the subject. */
async function requestDoc({ payload, recipient = SUBJECT, signer = vtcSigner, expiresIn = 240_000 } = {}) {
  const doc = {
    id: crypto.randomUUID(),
    type: APPROVE_REQUEST,
    issuer: VTC,
    recipient,
    issuedAt: new Date().toISOString(),
    expiresAt: new Date(Date.now() + expiresIn).toISOString(),
    payload: payload ?? (await inline()),
  };
  await signTrustTask({ envelope: doc, signing: signer, proofPurpose: "authentication" });
  return doc;
}

/** A community answering `requests/show` with `body(doc)`, signed operationally. */
function community(body) {
  const seen = [];
  const fetch = async (url, init) => {
    const doc = JSON.parse(init.body);
    seen.push(doc);
    const out = await body(doc);
    if (out.error) {
      return new Response(
        JSON.stringify({ type: "https://trusttasks.org/spec/trust-task-error/0.3", payload: { code: out.error, retryable: false } }),
        { status: 404, headers: { "content-type": "application/json" } },
      );
    }
    const res = {
      id: crypto.randomUUID(),
      type: `${doc.type}#response`,
      issuer: VTC,
      recipient: doc.issuer,
      threadId: doc.id,
      issuedAt: new Date().toISOString(),
      payload: out.payload,
    };
    await signTrustTask({ envelope: res, signing: vtcSigner, proofPurpose: "authentication" });
    return new Response(JSON.stringify(res), { status: 200, headers: { "content-type": "application/json" } });
  };
  return { fetch, seen };
}

const opts = (fetch) => ({ vtcDid: VTC, vtcDocument: vtcDoc, trustTaskEndpoint: ENDPOINT, fetch });
const want = { vtcDid: VTC, vtcDocument: vtcDoc };

async function read(c) {
  const kA = newApproverKey();
  const reply = await sendOob(kA, buildStepUpShow(kA, VTC, HANDLE), opts(c.fetch), "show", "authentication");
  return { kA, reply };
}

test("VTI-LNK-125: a step-up link parses as the step-up flow, and needs an expiry", () => {
  const now = 1_791_460_800;
  const link = `https://link.trustoverip.org/t#_from=${VTC}&_id=${HANDLE}&_exp=${now + 200}&_type=/vti/flow/step-up/0.1`;
  const r = parseTriggerLink(link, { now });
  assert.equal(r.ok, true);
  assert.equal(r.link.flow.spec.name, "step-up");
  assert.equal(r.link.flow.uri, "https://link.trustoverip.org/vti/flow/step-up/0.1");

  const noExp = parseTriggerLink(link.replace(`&_exp=${now + 200}`, ""), { now });
  assert.deepEqual([noExp.ok, noExp.reason], [false, "missing-exp"]);

  // Every contact parses: whether it is one of the reader's services is the
  // flow's question (VTI-LNK-128), answered before anything is sent.
  const didKey = parseTriggerLink(link.replace(VTC, "did:key:z6MkhaXgBZDvotDkL5257faiztiGiC2QtKLGpbnnEGta2doK"), { now });
  assert.equal(didKey.ok, true);
});

test("VTI-LNK-128 – 129: the flow's reasons map to the outcomes the chapter gives them", () => {
  assert.equal(outcomeOf("step-up-gone"), "expired");
  for (const r of ["not-in-records", "not-the-subject", "binding-mismatch"]) assert.equal(outcomeOf(r), "invalid");
});

test("VTI-LNK-054 / 129: the first request carries the handle twice, from a fresh key", async () => {
  const c = community(async () => ({ payload: { request: await requestDoc(), operation: OP } }));
  const { kA } = await read(c);
  const [sent] = c.seen;
  assert.equal(sent.type, STEP_UP_REQUESTS_SHOW_TYPE);
  assert.equal(sent.issuer, kA.did);
  assert.match(kA.did, /^did:key:z6Mk/);
  assert.equal(sent.recipient, VTC);
  assert.equal(sent.parentThreadId, HANDLE);
  assert.deepEqual(sent.payload, { handle: HANDLE });
  assert.equal(sent.proof.proofPurpose, "authentication");
});

test("VTI-LNK-130: a request the community signed to its subject, bound to the returned operation, checks out", async () => {
  const c = community(async () => ({ payload: { request: await requestDoc(), operation: OP } }));
  const { reply } = await read(c);
  const shown = await checkStepUpShown(reply.payload, { ...want, now: Date.now() });
  assert.equal(shown.subject, SUBJECT);
  assert.deepEqual(shown.operation, OP);
  assert.equal(shown.request.reason, "Invite an approver");

  const answer = buildStepUpAnswer(VTC, shown, { id: "urn:uuid:statement" });
  assert.equal(answer.type, STEP_UP_APPROVE_RESPONSE_TYPE);
  assert.equal(answer.issuer, SUBJECT, "the answer is the subject's");
  assert.equal(answer.recipient, VTC);
  assert.deepEqual(answer.payload, {
    subject: SUBJECT,
    challenge: shown.request.challenge,
    decision: "approved",
    evidence: { kind: "approverSigned", statement: { id: "urn:uuid:statement" } },
  });
});

test("VTI-LNK-130: an operation that is not the one the binding was computed over is binding-mismatch", async () => {
  const other = { ...OP, payload: { subject: "did:key:z6MkSomeoneElse" } };
  const c = community(async () => ({ payload: { request: await requestDoc(), operation: other } }));
  const { reply } = await read(c);
  await assert.rejects(
    checkStepUpShown(reply.payload, { ...want, now: Date.now() }),
    (e) => e instanceof StepUpHandoffError && e.reason === "binding-mismatch",
  );
});

test("VTI-LNK-130: a request someone else signed, addressed elsewhere, or expired is refused", async () => {
  const check = async (request) =>
    checkStepUpShown({ request, operation: OP }, { ...want, now: Date.now() });
  const stranger = generateSigningIdentity();
  await assert.rejects(check(await requestDoc({ signer: { ...stranger, did: VTC, kid: VM } })), /not signed by the community/);
  await assert.rejects(check(await requestDoc({ recipient: "did:webvh:QmX:else.example" })), /not addressed to its subject/);
  await assert.rejects(check(await requestDoc({ expiresIn: -1_000 })), /expired/);
  const tampered = await requestDoc();
  tampered.payload.reason = "Something gentler";
  await assert.rejects(check(tampered), /not signed by the community/);
});

test("VTI-LNK-129: a handle the community cannot answer is its notFound refusal", async () => {
  const c = community(async () => ({ error: "auth/step-up/requests/show:notFound" }));
  await assert.rejects(read(c), (e) => e instanceof OobRefusedError && e.code === "auth/step-up/requests/show:notFound");
});
