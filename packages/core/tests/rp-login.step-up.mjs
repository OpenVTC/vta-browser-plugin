// Step-up against a did-hosting relying party, as Trust Tasks:
// `auth/step-up/start/0.1` → verified approve-request/0.3 → consent →
// `approve-response/0.5` → `auth/refresh/0.1`, all to `{base}/trust-tasks`.
//
// The RP here is a fake that answers the way the control plane does: every
// reply signed by the RP's key (`proofPurpose: authentication`), threaded to
// the request and addressed back to the requester; the approve-request inside
// the start reply signed the same way.

import { test } from "node:test";
import assert from "node:assert/strict";

import {
  AGENT_APPROVE_REQUEST_TYPES,
  RP_APPROVE_REQUEST_TYPES,
  buildStepUpApproval,
  performStepUpVta,
  stepUpVtaFinish,
  stepUpVtaStart,
  verifyStepUpApproveRequest,
  verifyTrustTaskProof,
  generateSigningIdentity,
  signTrustTask,
} from "../dist/index.js";

const TT = "https://trusttasks.org/spec/";
const START = `${TT}auth/step-up/start/0.1`;
const APPROVE_REQUEST_03 = `${TT}auth/step-up/approve-request/0.3`;
const APPROVE_REQUEST_02 = `${TT}auth/step-up/approve-request/0.2`;
const APPROVE_RESPONSE_05 = `${TT}auth/step-up/approve-response/0.5`;
const REFRESH = `${TT}auth/refresh/0.1`;
const ERROR = `${TT}trust-task-error/0.3`;

const RP = generateSigningIdentity(); // the control plane — enrolled
const STRANGER = generateSigningIdentity(); // not enrolled
const SESSION = "sess-42";
const BASE = "https://rp.example/api";

const sign = (doc, as, proofPurpose = "authentication") =>
  signTrustTask({ envelope: doc, signing: as, proofPurpose });

// ── Fixtures ────────────────────────────────────────────────────────────────

/** The RP's signed approve-request/0.3 for `holder`'s session. */
async function approveRequest(
  holder,
  { as = RP, type = APPROVE_REQUEST_03, over = {}, envelope = {}, purpose } = {},
) {
  const doc = {
    id: `urn:uuid:${crypto.randomUUID()}`,
    type,
    issuer: as.did,
    recipient: holder.did,
    issuedAt: new Date().toISOString(),
    expiresAt: new Date(Date.now() + 300_000).toISOString(),
    payload: {
      subject: holder.did,
      sessionId: SESSION,
      challenge: "a".repeat(64),
      reason: "Elevate this session to aal2",
      targetAcr: "aal2",
      acceptableEvidence: ["didSigned"],
      ...over,
    },
    ...envelope,
  };
  await sign(doc, as, purpose);
  return doc;
}

/** The RP's signed reply to `req`. `before` replaces members before signing. */
async function reply(req, payload, { as = RP, unsigned = false, before = {} } = {}) {
  const doc = {
    id: `urn:uuid:${crypto.randomUUID()}`,
    threadId: req.id,
    type: `${req.type}#response`,
    issuer: as.did,
    recipient: req.issuer,
    issuedAt: new Date().toISOString(),
    payload,
    ...before,
  };
  if (!unsigned) await sign(doc, as);
  return doc;
}

const json = (body, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });

/**
 * A fake RP. `answer(req)` returns the reply document for each request (or a
 * Response); every request is recorded with its bearer.
 */
function fakeRp(answer) {
  const calls = [];
  const fetchFn = async (url, init) => {
    assert.equal(String(url), `${BASE}/trust-tasks`, "every document goes to {base}/trust-tasks");
    const doc = JSON.parse(init.body);
    calls.push({ doc, bearer: init.headers.authorization });
    const out = await answer(doc);
    return out instanceof Response ? out : json(out);
  };
  return { fetchFn, calls };
}

const session = (holder) => ({
  id: SESSION,
  subject: holder.did,
  issuedAt: new Date().toISOString(),
  expiresAt: new Date(Date.now() + 3600_000).toISOString(),
  acr: "aal2",
});

/** The honest RP: start → approve-request, approve-response → elevated,
 *  refresh → new tokens. */
function honestRp(holder, { request, ack, tokens } = {}) {
  return fakeRp(async (req) => {
    switch (req.type) {
      case START:
        return reply(req, { approveRequest: request ?? (await approveRequest(holder)) });
      case APPROVE_RESPONSE_05:
        return reply(req, ack ?? { status: "elevated", session: session(holder) });
      case REFRESH:
        return reply(req, {
          session: session(holder),
          tokens: tokens ?? {
            accessToken: "elevated-access",
            refreshToken: "elevated-refresh",
            tokenType: "Bearer",
            expiresIn: 900,
          },
        });
      default:
        throw new Error(`unexpected ${req.type}`);
    }
  });
}

const party = (holder, fetchFn) => ({
  baseUrl: BASE,
  accessToken: "aal1-access",
  signing: holder,
  rpDid: RP.did,
  fetchFn,
});

const startArgs = (holder, fetchFn) => ({
  ...party(holder, fetchFn),
  sessionId: SESSION,
  enrolledExecutorDids: [RP.did],
});

// ── buildStepUpApproval ─────────────────────────────────────────────────────

test("buildStepUpApproval: a 0.5 approval echoes the request and is the holder's attestation", async () => {
  const holder = generateSigningIdentity();
  const request = { subject: holder.did, sessionId: SESSION, challenge: "c".repeat(64) };
  const doc = await buildStepUpApproval({
    signing: holder,
    rpDid: RP.did,
    request,
    approved: true,
    responseVersion: "0.5",
  });

  assert.equal(doc.type, APPROVE_RESPONSE_05);
  assert.equal(doc.issuer, holder.did);
  assert.equal(doc.recipient, RP.did);
  assert.ok(doc.issuedAt, "0.5 requires issuedAt");
  assert.deepEqual(doc.payload, { ...request, decision: "approved" });
  const proof = await verifyTrustTaskProof(doc, { expectedProofPurpose: "assertionMethod" });
  assert.equal(proof.verified, true, proof.reason);
  assert.equal(proof.signer, holder.did);
});

test("buildStepUpApproval: a denial carries a signed deniedReason; tampering breaks the proof", async () => {
  const holder = generateSigningIdentity();
  const request = { subject: holder.did, sessionId: SESSION, challenge: "d".repeat(64) };
  const doc = await buildStepUpApproval({
    signing: holder,
    rpDid: RP.did,
    request,
    approved: false,
    deniedReason: "No.",
    responseVersion: "0.5",
  });
  assert.equal(doc.payload.decision, "denied");
  assert.equal(doc.payload.deniedReason, "No.");
  assert.equal((await verifyTrustTaskProof(doc)).verified, true);
  doc.payload.challenge = "e".repeat(64);
  assert.equal((await verifyTrustTaskProof(doc)).verified, false);
});

// ── verifyStepUpApproveRequest ──────────────────────────────────────────────

const rpOpts = { enrolledExecutorDids: [RP.did], acceptTypes: RP_APPROVE_REQUEST_TYPES };

test("verifyStepUpApproveRequest: the RP's signed 0.3 verifies, fields come from inside the signature", async () => {
  const holder = generateSigningIdentity();
  const res = await verifyStepUpApproveRequest(await approveRequest(holder), rpOpts);
  assert.equal(res.ok, true, res.reason);
  assert.equal(res.issuer, RP.did);
  assert.deepEqual(res.request, {
    subject: holder.did,
    sessionId: SESSION,
    challenge: "a".repeat(64),
    reason: "Elevate this session to aal2",
  });
});

test("verifyStepUpApproveRequest: refusals", async () => {
  const holder = generateSigningIdentity();
  const tampered = await approveRequest(holder);
  tampered.payload.reason = "Approve everything forever.";
  const cases = [
    ["no document", undefined, /no signed approve-request/],
    ["a signer the wallet is not enrolled with", await approveRequest(holder, { as: STRANGER }), /not an executor/],
    ["an unsigned document", { type: APPROVE_REQUEST_03, payload: {} }, /no proof/],
    [
      "another party's version",
      await approveRequest(holder, { type: APPROVE_REQUEST_02 }),
      /not a step-up approve-request this party mints/,
    ],
    [
      "a lapsed request",
      await approveRequest(holder, { envelope: { expiresAt: new Date(Date.now() - 1000).toISOString() } }),
      /lapsed/,
    ],
    ["an attestation-purpose proof", await approveRequest(holder, { purpose: "assertionMethod" }), /proofPurpose/],
    ["a tampered reason", tampered, /signature verification failed/],
  ];
  for (const [what, doc, why] of cases) {
    const res = await verifyStepUpApproveRequest(doc, rpOpts);
    assert.equal(res.ok, false, what);
    assert.match(res.reason, why, what);
  }
});

test("verifyStepUpApproveRequest: the agent's 0.2 passes only for a caller that accepts the agent's versions", async () => {
  const holder = generateSigningIdentity();
  const doc = await approveRequest(holder, { type: APPROVE_REQUEST_02 });
  const res = await verifyStepUpApproveRequest(doc, {
    enrolledExecutorDids: [RP.did],
    acceptTypes: AGENT_APPROVE_REQUEST_TYPES,
  });
  assert.equal(res.ok, true, res.reason);
});

// ── stepUpVtaStart ──────────────────────────────────────────────────────────

test("stepUpVtaStart: sends a signed start for the session to {base}/trust-tasks and verifies the answer", async () => {
  const holder = generateSigningIdentity();
  const { fetchFn, calls } = honestRp(holder);

  const start = await stepUpVtaStart(startArgs(holder, fetchFn));

  assert.equal(start.issuer, RP.did);
  assert.equal(start.request.sessionId, SESSION);
  assert.equal(calls.length, 1);
  const { doc, bearer } = calls[0];
  assert.equal(bearer, "Bearer aal1-access");
  assert.equal(doc.type, START);
  assert.equal(doc.issuer, holder.did);
  assert.equal(doc.recipient, RP.did);
  assert.ok(doc.issuedAt);
  assert.deepEqual(doc.payload, { sessionId: SESSION });
  const proof = await verifyTrustTaskProof(doc, { expectedProofPurpose: "authentication" });
  assert.equal(proof.verified, true, proof.reason);
  assert.equal(proof.signer, holder.did);
});

test("stepUpVtaStart: refuses an unsigned reply", async () => {
  const holder = generateSigningIdentity();
  const { fetchFn } = fakeRp(async (req) =>
    reply(req, { approveRequest: await approveRequest(holder) }, { unsigned: true }),
  );
  await assert.rejects(stepUpVtaStart(startArgs(holder, fetchFn)), /unsigned or its proof does not verify/);
});

test("stepUpVtaStart: refuses a reply signed by someone other than the RP", async () => {
  const holder = generateSigningIdentity();
  const { fetchFn } = fakeRp(async (req) =>
    reply(req, { approveRequest: await approveRequest(holder) }, { as: STRANGER }),
  );
  await assert.rejects(stepUpVtaStart(startArgs(holder, fetchFn)), /is signed by/);
});

test("stepUpVtaStart: refuses a signed reply to another request", async () => {
  const holder = generateSigningIdentity();
  const { fetchFn } = fakeRp(async (req) =>
    reply(req, { approveRequest: await approveRequest(holder) }, { before: { threadId: "urn:uuid:other" } }),
  );
  await assert.rejects(stepUpVtaStart(startArgs(holder, fetchFn)), /not to this request/);
});

test("stepUpVtaStart: refuses a signed reply addressed to someone else", async () => {
  const holder = generateSigningIdentity();
  const { fetchFn } = fakeRp(async (req) =>
    reply(req, { approveRequest: await approveRequest(holder) }, { before: { recipient: STRANGER.did } }),
  );
  await assert.rejects(stepUpVtaStart(startArgs(holder, fetchFn)), /is addressed to/);
});

test("stepUpVtaStart: refuses an approve-request bound to a different session", async () => {
  const holder = generateSigningIdentity();
  const { fetchFn } = honestRp(holder, {
    request: await approveRequest(holder, { over: { sessionId: "someone-elses-session" } }),
  });
  await assert.rejects(stepUpVtaStart(startArgs(holder, fetchFn)), /bound to a different session/);
});

test("stepUpVtaStart: refuses an approve-request naming a different subject", async () => {
  const holder = generateSigningIdentity();
  const other = generateSigningIdentity();
  const { fetchFn } = honestRp(holder, {
    request: await approveRequest(holder, { over: { subject: other.did } }),
  });
  await assert.rejects(stepUpVtaStart(startArgs(holder, fetchFn)), /names subject/);
});

test("stepUpVtaStart: refuses an approve-request addressed to someone else", async () => {
  const holder = generateSigningIdentity();
  const { fetchFn } = honestRp(holder, {
    request: await approveRequest(holder, { envelope: { recipient: STRANGER.did } }),
  });
  await assert.rejects(stepUpVtaStart(startArgs(holder, fetchFn)), /not this wallet/);
});

test("stepUpVtaStart: refuses an approve-request whose payload has lapsed", async () => {
  const holder = generateSigningIdentity();
  const { fetchFn } = honestRp(holder, {
    request: await approveRequest(holder, { over: { expiresAt: new Date(Date.now() - 1000).toISOString() } }),
  });
  await assert.rejects(stepUpVtaStart(startArgs(holder, fetchFn)), /lapsed/);
});

test("stepUpVtaStart: refuses an approve-request signed by another enrolled executor", async () => {
  const holder = generateSigningIdentity();
  const other = generateSigningIdentity();
  const { fetchFn } = honestRp(holder, { request: await approveRequest(holder, { as: other }) });
  await assert.rejects(
    stepUpVtaStart({ ...startArgs(holder, fetchFn), enrolledExecutorDids: [RP.did, other.did] }),
    /is not the relying party/,
  );
});

test("stepUpVtaStart: a refusal keeps the RP's code", async () => {
  const holder = generateSigningIdentity();
  const { fetchFn } = fakeRp(async () =>
    json(
      {
        id: "urn:uuid:e",
        type: ERROR,
        payload: { code: "auth/step-up/start:notNeeded", message: "already aal2", retryable: false },
      },
      422,
    ),
  );
  await assert.rejects(stepUpVtaStart(startArgs(holder, fetchFn)), (err) => {
    assert.equal(err.details?.code, "auth/step-up/start:notNeeded");
    return true;
  });
});

// ── stepUpVtaFinish ─────────────────────────────────────────────────────────

function approvalFor(holder) {
  return buildStepUpApproval({
    signing: holder,
    rpDid: RP.did,
    request: { subject: holder.did, sessionId: SESSION, challenge: "a".repeat(64) },
    approved: true,
    responseVersion: "0.5",
  });
}

test("stepUpVtaFinish: sends the approval, then a signed refresh, and returns the new tokens", async () => {
  const holder = generateSigningIdentity();
  const { fetchFn, calls } = honestRp(holder);
  const approval = await approvalFor(holder);

  const tokens = await stepUpVtaFinish({ ...party(holder, fetchFn), refreshToken: "aal1-refresh", approval });

  assert.deepEqual(tokens, {
    accessToken: "elevated-access",
    refreshToken: "elevated-refresh",
    sessionId: SESSION,
  });
  assert.deepEqual(calls.map((c) => c.doc.type), [APPROVE_RESPONSE_05, REFRESH]);
  assert.equal(calls[0].doc.id, approval.id);
  const refresh = calls[1].doc;
  assert.deepEqual(refresh.payload, { refreshToken: "aal1-refresh" });
  assert.equal(refresh.recipient, RP.did);
  const proof = await verifyTrustTaskProof(refresh, { expectedProofPurpose: "authentication" });
  assert.equal(proof.verified, true, proof.reason);
});

test("stepUpVtaFinish: keeps the presented refresh token when the RP does not rotate it", async () => {
  const holder = generateSigningIdentity();
  const { fetchFn } = honestRp(holder, {
    tokens: { accessToken: "elevated-access", tokenType: "Bearer", expiresIn: 900 },
  });
  const tokens = await stepUpVtaFinish({
    ...party(holder, fetchFn),
    refreshToken: "aal1-refresh",
    approval: await approvalFor(holder),
  });
  assert.equal(tokens.refreshToken, "aal1-refresh");
});

test("stepUpVtaFinish: refuses an acknowledgement that elevated nothing, and does not refresh", async () => {
  const holder = generateSigningIdentity();
  const { fetchFn, calls } = honestRp(holder, { ack: { status: "rejected", reason: "challenge expired" } });
  await assert.rejects(
    stepUpVtaFinish({ ...party(holder, fetchFn), refreshToken: "r", approval: await approvalFor(holder) }),
    /did not elevate the session \(rejected: challenge expired\)/,
  );
  assert.equal(calls.length, 1);
});

test("stepUpVtaFinish: refuses an unsigned acknowledgement", async () => {
  const holder = generateSigningIdentity();
  const { fetchFn } = fakeRp(async (req) => reply(req, { status: "elevated" }, { unsigned: true }));
  await assert.rejects(
    stepUpVtaFinish({ ...party(holder, fetchFn), refreshToken: "r", approval: await approvalFor(holder) }),
    /unsigned or its proof does not verify/,
  );
});

// ── performStepUpVta ────────────────────────────────────────────────────────

const flowArgs = (holder, fetchFn, requestConsent) => ({
  ...startArgs(holder, fetchFn),
  refreshToken: "aal1-refresh",
  requestConsent,
});

test("performStepUpVta: consent sees the verified reason, then approve-response and refresh", async () => {
  const holder = generateSigningIdentity();
  const { fetchFn, calls } = honestRp(holder);
  const seen = [];

  const res = await performStepUpVta(
    flowArgs(holder, fetchFn, async (ctx) => {
      seen.push(ctx);
      return true;
    }),
  );

  assert.equal(res.ok, true, res.ok ? undefined : res.error);
  assert.equal(res.tokens.accessToken, "elevated-access");
  assert.deepEqual(seen, [
    { issuer: RP.did, subject: holder.did, sessionId: SESSION, reason: "Elevate this session to aal2" },
  ]);
  assert.deepEqual(calls.map((c) => c.doc.type), [START, APPROVE_RESPONSE_05, REFRESH]);
  const approval = calls[1].doc;
  assert.equal(approval.payload.challenge, "a".repeat(64));
  assert.equal(approval.payload.decision, "approved");
});

test("performStepUpVta: a declined prompt sends nothing after start", async () => {
  const holder = generateSigningIdentity();
  const { fetchFn, calls } = honestRp(holder);
  const res = await performStepUpVta(flowArgs(holder, fetchFn, async () => false));
  assert.equal(res.ok, false);
  assert.equal(res.declined, true);
  assert.deepEqual(calls.map((c) => c.doc.type), [START]);
});

test("performStepUpVta: a refused approve-request never reaches the human", async () => {
  const holder = generateSigningIdentity();
  const { fetchFn, calls } = honestRp(holder, {
    request: await approveRequest(holder, { over: { sessionId: "someone-elses-session" } }),
  });
  let prompted = false;
  const res = await performStepUpVta(
    flowArgs(holder, fetchFn, async () => {
      prompted = true;
      return true;
    }),
  );
  assert.equal(res.ok, false);
  assert.equal(res.declined, false);
  assert.match(res.error, /bound to a different session/);
  assert.equal(prompted, false);
  assert.deepEqual(calls.map((c) => c.doc.type), [START]);
});
