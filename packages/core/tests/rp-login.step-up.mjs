// Step-up against a did-hosting relying party, the holder's half: the page
// hands the wallet the RP's signed approve-request/0.5 (from the RP's
// `auth/step-up/start/0.2` reply, which the page obtained with its own session
// key); the wallet verifies it, asks the human, and returns its signed
// approve-response/0.7. The wallet is given no session token and sends
// nothing to the RP.

import { test } from "node:test";
import assert from "node:assert/strict";

import {
  STEP_UP_APPROVE_REQUEST_TYPE,
  buildStepUpApproval,
  performRpStepUp,
  verifyRpStepUpRequest,
  verifyStepUpApproveRequest,
  verifyTrustTaskProof,
  generateSigningIdentity,
  signTrustTask,
} from "../dist/index.js";

const TT = "https://trusttasks.org/spec/";
const APPROVE_REQUEST_05 = `${TT}auth/step-up/approve-request/0.5`;
const APPROVE_REQUEST_02 = `${TT}auth/step-up/approve-request/0.2`;
const APPROVE_RESPONSE_07 = `${TT}auth/step-up/approve-response/0.7`;

const RP = generateSigningIdentity(); // the control plane — enrolled
const STRANGER = generateSigningIdentity(); // not enrolled
const SESSION = "sess-42";

const sign = (doc, as, proofPurpose = "authentication") =>
  signTrustTask({ envelope: doc, signing: as, proofPurpose });

// ── Fixtures ────────────────────────────────────────────────────────────────

/** The RP's signed approve-request/0.5 for `holder`'s session. */
async function approveRequest(
  holder,
  { as = RP, type = APPROVE_REQUEST_05, over = {}, envelope = {}, purpose } = {},
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
      accepts: ["didSigned"],
      ...over,
    },
    ...envelope,
  };
  await sign(doc, as, purpose);
  return doc;
}

// ── buildStepUpApproval ─────────────────────────────────────────────────────

test("buildStepUpApproval: a 0.7 approval echoes the request and is the holder's attestation", async () => {
  const holder = generateSigningIdentity();
  const request = { subject: holder.did, sessionId: SESSION, challenge: "c".repeat(64) };
  const doc = await buildStepUpApproval({
    signing: holder,
    rpDid: RP.did,
    request,
    approved: true,
  });

  assert.equal(doc.type, APPROVE_RESPONSE_07);
  assert.equal(doc.issuer, holder.did);
  assert.equal(doc.recipient, RP.did);
  assert.ok(doc.issuedAt, "0.7 requires issuedAt");
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
  });
  assert.equal(doc.payload.decision, "denied");
  assert.equal(doc.payload.deniedReason, "No.");
  assert.equal((await verifyTrustTaskProof(doc)).verified, true);
  doc.payload.challenge = "e".repeat(64);
  assert.equal((await verifyTrustTaskProof(doc)).verified, false);
});

// ── verifyStepUpApproveRequest ──────────────────────────────────────────────

const rpOpts = { enrolledExecutorDids: [RP.did] };

test("verifyStepUpApproveRequest: the RP's signed 0.5 verifies, fields come from inside the signature", async () => {
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
    ["an unsigned document", { type: APPROVE_REQUEST_05, payload: {} }, /no proof/],
    [
      "another party's version",
      await approveRequest(holder, { type: APPROVE_REQUEST_02 }),
      /is not https:\/\/trusttasks\.org\/spec\/auth\/step-up\/approve-request\/0\.5/,
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

test("verifyStepUpApproveRequest: a request that does not accept didSigned is refused before anyone is asked", async () => {
  const holder = generateSigningIdentity();
  for (const accepts of [["webauthn"], ["approverSigned"], "didSigned"]) {
    const doc = await approveRequest(holder, { over: { accepts } });
    const res = await verifyStepUpApproveRequest(doc, rpOpts);
    assert.equal(res.ok, false, JSON.stringify(accepts));
    assert.match(res.reason, /DID-signed/);
  }
});

test("one approve-request version for every party: the pin, and the one start/0.2 embeds", async () => {
  // The did-hosting control plane's start/0.2 reply names its request's type
  // as a schema const; the wallet pins approve-request on its own. They are
  // one version, or an RP step-up is refused at the first check.
  const { RESPONSE_PAYLOAD_SCHEMA } = await import("../dist/specs/auth/step-up/start/0.2/payload.js");
  assert.equal(
    RESPONSE_PAYLOAD_SCHEMA.$defs.Response.properties.approveRequest.properties.type.const,
    STEP_UP_APPROVE_REQUEST_TYPE,
  );
  assert.equal(STEP_UP_APPROVE_REQUEST_TYPE, APPROVE_REQUEST_05);
});

// ── verifyRpStepUpRequest ───────────────────────────────────────────────────

const args = (holder, approveRequest, over = {}) => ({
  approveRequest,
  signing: holder,
  rpDid: RP.did,
  enrolledExecutorDids: [RP.did],
  ...over,
});

test("verifyRpStepUpRequest: the RP's approve-request for this holder verifies", async () => {
  const holder = generateSigningIdentity();
  const verified = await verifyRpStepUpRequest(args(holder, await approveRequest(holder)));
  assert.equal(verified.issuer, RP.did);
  assert.deepEqual(verified.request, {
    subject: holder.did,
    sessionId: SESSION,
    challenge: "a".repeat(64),
    reason: "Elevate this session to aal2",
  });
});

test("verifyRpStepUpRequest: refuses an approve-request naming a different subject", async () => {
  const holder = generateSigningIdentity();
  const other = generateSigningIdentity();
  const doc = await approveRequest(holder, { over: { subject: other.did } });
  await assert.rejects(verifyRpStepUpRequest(args(holder, doc)), /names subject/);
});

test("verifyRpStepUpRequest: refuses an approve-request addressed to someone else", async () => {
  const holder = generateSigningIdentity();
  const doc = await approveRequest(holder, { envelope: { recipient: STRANGER.did } });
  await assert.rejects(verifyRpStepUpRequest(args(holder, doc)), /not this wallet/);
});

test("verifyRpStepUpRequest: refuses an approve-request whose payload has lapsed", async () => {
  const holder = generateSigningIdentity();
  const doc = await approveRequest(holder, { over: { expiresAt: new Date(Date.now() - 1000).toISOString() } });
  await assert.rejects(verifyRpStepUpRequest(args(holder, doc)), /lapsed/);
});

test("verifyRpStepUpRequest: refuses an approve-request signed by another enrolled executor", async () => {
  const holder = generateSigningIdentity();
  const other = generateSigningIdentity();
  const doc = await approveRequest(holder, { as: other });
  await assert.rejects(
    verifyRpStepUpRequest(args(holder, doc, { enrolledExecutorDids: [RP.did, other.did] })),
    /is not the relying party/,
  );
});

test("verifyRpStepUpRequest: refuses a page-altered approve-request", async () => {
  const holder = generateSigningIdentity();
  const doc = await approveRequest(holder);
  doc.payload.sessionId = "another-session";
  await assert.rejects(verifyRpStepUpRequest(args(holder, doc)), /signature verification failed/);
});

test("verifyRpStepUpRequest: refuses no document at all", async () => {
  const holder = generateSigningIdentity();
  await assert.rejects(verifyRpStepUpRequest(args(holder, undefined)), /no signed approve-request/);
});

// ── performRpStepUp ─────────────────────────────────────────────────────────

test("performRpStepUp: consent sees the verified reason, then a signed approve-response for the RP", async () => {
  const holder = generateSigningIdentity();
  const seen = [];
  const res = await performRpStepUp({
    ...args(holder, await approveRequest(holder)),
    requestConsent: async (ctx) => {
      seen.push(ctx);
      return true;
    },
  });

  assert.equal(res.ok, true, res.ok ? undefined : res.error);
  assert.deepEqual(seen, [
    { issuer: RP.did, subject: holder.did, sessionId: SESSION, reason: "Elevate this session to aal2" },
  ]);
  const doc = res.approveResponse;
  assert.equal(doc.type, APPROVE_RESPONSE_07);
  assert.equal(doc.issuer, holder.did);
  assert.equal(doc.recipient, RP.did);
  assert.deepEqual(doc.payload, {
    subject: holder.did,
    sessionId: SESSION,
    challenge: "a".repeat(64),
    decision: "approved",
  });
  const proof = await verifyTrustTaskProof(doc, { expectedProofPurpose: "assertionMethod" });
  assert.equal(proof.verified, true, proof.reason);
  assert.equal(proof.signer, holder.did);
});

test("performRpStepUp: a declined prompt signs nothing", async () => {
  const holder = generateSigningIdentity();
  const res = await performRpStepUp({
    ...args(holder, await approveRequest(holder)),
    requestConsent: async () => false,
  });
  assert.equal(res.ok, false);
  assert.equal(res.declined, true);
  assert.equal("approveResponse" in res, false);
});

test("performRpStepUp: a refused approve-request never reaches the human", async () => {
  const holder = generateSigningIdentity();
  let prompted = false;
  const res = await performRpStepUp({
    ...args(holder, await approveRequest(holder, { as: STRANGER })),
    requestConsent: async () => {
      prompted = true;
      return true;
    },
  });
  assert.equal(res.ok, false);
  assert.equal(res.declined, false);
  assert.match(res.error, /not an executor/);
  assert.equal(prompted, false);
});
