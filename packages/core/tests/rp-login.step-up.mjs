// Unit test for the holder-self-signs step-up: `buildStepUpApproval` emits a
// spec `auth/step-up/approve-response/0.2` Trust-Task document whose
// eddsa-jcs-2022 proof verifies against the subject key. This is the exact
// document + proof the did-hosting RP verifies at `/auth/step-up/vta/finish`
// (a Rust cross-impl fixture test in affinidi-webvh-service verifies a document
// produced by THIS function).

import { test } from "node:test";
import assert from "node:assert/strict";

import {
  buildStepUpApproval,
  verifyStepUpApproveRequest,
  verifyTrustTaskProof,
  generateSigningIdentity,
  signTrustTask,
} from "../dist/index.js";

const APPROVE_RESPONSE_TYPE = "https://trusttasks.org/spec/auth/step-up/approve-response/0.2";
const APPROVE_REQUEST_TYPE_02 = "https://trusttasks.org/spec/auth/step-up/approve-request/0.2";
const APPROVE_REQUEST_TYPE_01 = "https://trusttasks.org/spec/auth/step-up/approve-request/0.1";

test("buildStepUpApproval: signed approved response echoes the request and verifies", async () => {
  const holder = generateSigningIdentity();
  const rpDid = "did:web:rp.example";
  const request = { subject: holder.did, sessionId: "sess-1", challenge: "c".repeat(64) };

  const doc = await buildStepUpApproval({ signing: holder, rpDid, request, approved: true });

  assert.equal(doc.type, APPROVE_RESPONSE_TYPE);
  assert.equal(doc.issuer, holder.did);
  assert.equal(doc.recipient, rpDid); // audience binding (SPEC §4.8.2)
  assert.equal(doc.payload.subject, holder.did);
  assert.equal(doc.payload.sessionId, "sess-1");
  assert.equal(doc.payload.challenge, request.challenge);
  assert.equal(doc.payload.decision, "approved");
  assert.ok(!("deniedReason" in doc.payload));
  assert.equal(doc.proof.proofPurpose, "assertionMethod");
  assert.equal(doc.proof.verificationMethod, holder.kid);

  const result = await verifyTrustTaskProof(doc, { expectedProofPurpose: "assertionMethod" });
  assert.equal(result.verified, true, result.reason);
  assert.equal(result.signer, holder.did);
});

test("buildStepUpApproval: denied response carries a signed deniedReason", async () => {
  const holder = generateSigningIdentity();
  const request = { subject: holder.did, sessionId: "sess-2", challenge: "d".repeat(64) };

  const doc = await buildStepUpApproval({
    signing: holder,
    rpDid: "did:web:rp.example",
    request,
    approved: false,
    deniedReason: "User declined.",
  });

  assert.equal(doc.payload.decision, "denied");
  assert.equal(doc.payload.deniedReason, "User declined.");
  const result = await verifyTrustTaskProof(doc);
  assert.equal(result.verified, true, result.reason);
});

test("buildStepUpApproval: tampering the signed challenge breaks verification", async () => {
  const holder = generateSigningIdentity();
  const request = { subject: holder.did, sessionId: "sess-3", challenge: "e".repeat(64) };
  const doc = await buildStepUpApproval({ signing: holder, rpDid: "did:web:rp.example", request, approved: true });
  doc.payload.challenge = "f".repeat(64); // flip after signing

  const result = await verifyTrustTaskProof(doc);
  assert.equal(result.verified, false);
});

// ── verifyStepUpApproveRequest: the inbound half ─────────────────────────────
//
// The RP's `start` response now carries a full signed
// `auth/step-up/approve-request/0.2` document. Every field the wallet surfaces
// or echoes into the signed approve-response must come from *inside* that
// signature, and the signer must be an executor the wallet is enrolled with.

const RP = generateSigningIdentity(); // the control plane / RP — enrolled
const STRANGER = generateSigningIdentity(); // not enrolled

function requestPayload(over = {}) {
  return {
    subject: "did:key:zSubject",
    sessionId: "sess-42",
    challenge: "a".repeat(32),
    reason: "Confirm the transfer of $1,000 to ACME Corp.",
    expiresAt: new Date(Date.now() + 300_000).toISOString(),
    ...over,
  };
}

/** A signed approve-request document, plus the legacy top-level echo. */
async function startResponse({
  as = RP,
  type = APPROVE_REQUEST_TYPE_02,
  over = {},
  unsigned = false,
  legacy = true,
  withDocument = true,
} = {}) {
  const payload = requestPayload(over);
  const document = {
    id: "step-up-req-1",
    type,
    issuer: as.did,
    recipient: "did:key:zApprover",
    issuedAt: new Date().toISOString(),
    payload,
  };
  if (!unsigned) await signTrustTask({ envelope: document, signing: as });
  return {
    ...(legacy
      ? { subject: payload.subject, sessionId: payload.sessionId, challenge: payload.challenge }
      : {}),
    ...(withDocument ? { document } : {}),
  };
}

const enrolled = { enrolledExecutorDids: [RP.did] };

test("verifyStepUpApproveRequest: a signed request from an enrolled executor verifies, fields come from the document", async () => {
  const start = await startResponse();
  // Tamper the *legacy* reason only — it carries no authority and is not
  // cross-checked; what the human sees must come from inside the signature.
  start.reason = "Totally harmless, do not read the signed copy.";
  const res = await verifyStepUpApproveRequest(start, enrolled);
  assert.equal(res.ok, true, res.reason);
  assert.equal(res.issuer, RP.did);
  assert.equal(res.request.subject, "did:key:zSubject");
  assert.equal(res.request.sessionId, "sess-42");
  assert.equal(res.request.challenge, "a".repeat(32));
  assert.equal(res.request.reason, "Confirm the transfer of $1,000 to ACME Corp.");
});

test("verifyStepUpApproveRequest: no document → refused (the proofless legacy shape never prompts)", async () => {
  const res = await verifyStepUpApproveRequest(
    await startResponse({ withDocument: false }),
    enrolled,
  );
  assert.equal(res.ok, false);
  assert.match(res.reason, /no signed approve-request document/);
});

test("verifyStepUpApproveRequest: a signer the wallet is not enrolled with is refused", async () => {
  const res = await verifyStepUpApproveRequest(await startResponse({ as: STRANGER }), enrolled);
  assert.equal(res.ok, false);
  assert.match(res.reason, /not an executor this wallet is enrolled with/);
});

test("verifyStepUpApproveRequest: an unsigned document is refused", async () => {
  const res = await verifyStepUpApproveRequest(await startResponse({ unsigned: true }), enrolled);
  assert.equal(res.ok, false);
});

test("verifyStepUpApproveRequest: a tampered reason breaks the proof", async () => {
  const start = await startResponse();
  start.document.payload.reason = "Approve everything forever.";
  const res = await verifyStepUpApproveRequest(start, enrolled);
  assert.equal(res.ok, false);
});

test("verifyStepUpApproveRequest: legacy fields that disagree with the signed copy are refused", async () => {
  const start = await startResponse();
  start.sessionId = "some-other-session";
  const res = await verifyStepUpApproveRequest(start, enrolled);
  assert.equal(res.ok, false);
  assert.match(res.reason, /legacy field sessionId/);
});

test("verifyStepUpApproveRequest: the VTA-pushed 0.1 flavor passes the same gate", async () => {
  const res = await verifyStepUpApproveRequest(
    await startResponse({ type: APPROVE_REQUEST_TYPE_01, legacy: false }),
    enrolled,
  );
  assert.equal(res.ok, true, res.reason);
});

test("verifyStepUpApproveRequest: any other document type is refused", async () => {
  const res = await verifyStepUpApproveRequest(
    await startResponse({ type: APPROVE_RESPONSE_TYPE }),
    enrolled,
  );
  assert.equal(res.ok, false);
});

test("verifyStepUpApproveRequest: a lapsed request is refused", async () => {
  const res = await verifyStepUpApproveRequest(
    await startResponse({ over: { expiresAt: new Date(Date.now() - 1000).toISOString() } }),
    enrolled,
  );
  assert.equal(res.ok, false);
  assert.match(res.reason, /lapsed/);
});
