// Round-trip test for the spec-conformant `confirm/{request,response}/0.1`
// flow. Proves:
//   1. `buildConfirmResponseDocument` emits a spec-shaped Trust-Task document
//      (issuer/recipient/payload{subject,challenge,decision}) with an
//      eddsa-jcs-2022 proof that verifies against the holder's did:key — this
//      is the exact document + proof the RP (rp-sdk-js) must verify.
//   2. Tampering with the signed payload breaks verification.
//   3. `parseConfirmRequest` accepts a spec-shaped request over the DIDComm
//      binding and rejects malformed / non-confirm traffic.

import { test } from "node:test";
import assert from "node:assert/strict";

import {
  buildConfirmResponseDocument,
  parseConfirmRequest,
  verifyTrustTaskProof,
  signTrustTask,
  generateSigningIdentity,
  CONFIRM_REQUEST_TYPE,
  CONFIRM_RESPONSE_TYPE,
  TRUST_TASK_ENVELOPE_TYPE,
} from "../dist/index.js";

const CHALLENGE = "VHJhbnNmZXJDb25maXJtTm9uY2VYWQ"; // ≥128-bit base64url nonce

test("buildConfirmResponseDocument: signed approved response verifies", async () => {
  const holder = generateSigningIdentity();
  const rpDid = generateSigningIdentity().did;

  const doc = await buildConfirmResponseDocument({
    signing: holder,
    rp: { did: rpDid },
    approved: true,
    subject: holder.did,
    challenge: CHALLENGE,
    thid: "req-thread-1",
  });

  // Spec document shape.
  assert.equal(doc.type, CONFIRM_RESPONSE_TYPE);
  assert.equal(doc.issuer, holder.did);
  assert.equal(doc.recipient, rpDid);
  assert.equal(doc.threadId, "req-thread-1");
  assert.equal(doc.payload.subject, holder.did);
  assert.equal(doc.payload.challenge, CHALLENGE);
  assert.equal(doc.payload.decision, "approved");
  assert.ok(!("deniedReason" in doc.payload), "approved response has no deniedReason");
  assert.equal(doc.proof.type, "DataIntegrityProof");
  assert.equal(doc.proof.cryptosuite, "eddsa-jcs-2022");
  assert.equal(doc.proof.proofPurpose, "assertionMethod");
  assert.equal(doc.proof.verificationMethod, holder.kid);

  // The proof IS the consent record — it must verify against the subject key.
  const result = await verifyTrustTaskProof(doc, { expectedProofPurpose: "assertionMethod" });
  assert.equal(result.verified, true, result.reason);
  assert.equal(result.signer, holder.did);
});

test("buildConfirmResponseDocument: denied response carries a signed deniedReason", async () => {
  const holder = generateSigningIdentity();
  const rpDid = generateSigningIdentity().did;

  const doc = await buildConfirmResponseDocument({
    signing: holder,
    rp: { did: rpDid },
    approved: false,
    subject: holder.did,
    challenge: CHALLENGE,
    thid: "req-thread-2",
    deniedReason: "User does not recognize this transfer.",
  });

  assert.equal(doc.payload.decision, "denied");
  assert.equal(doc.payload.deniedReason, "User does not recognize this transfer.");
  const result = await verifyTrustTaskProof(doc);
  assert.equal(result.verified, true, result.reason);
});

test("verifyTrustTaskProof: rejects a tampered decision", async () => {
  const holder = generateSigningIdentity();
  const doc = await buildConfirmResponseDocument({
    signing: holder,
    rp: { did: generateSigningIdentity().did },
    approved: false, // signed as denied…
    subject: holder.did,
    challenge: CHALLENGE,
    thid: "t",
  });
  doc.payload.decision = "approved"; // …flipped after signing

  const result = await verifyTrustTaskProof(doc);
  assert.equal(result.verified, false);
});

test("verifyTrustTaskProof: rejects a wrong required proofPurpose", async () => {
  const holder = generateSigningIdentity();
  const doc = await buildConfirmResponseDocument({
    signing: holder,
    rp: { did: generateSigningIdentity().did },
    approved: true,
    subject: holder.did,
    challenge: CHALLENGE,
    thid: "t",
  });
  const result = await verifyTrustTaskProof(doc, { expectedProofPurpose: "authentication" });
  assert.equal(result.verified, false);
});

test("parseConfirmRequest: accepts a spec request over the DIDComm binding", async () => {
  const rp = generateSigningIdentity();
  const subject = generateSigningIdentity().did;

  const requestDoc = {
    id: "confirm-req-1",
    type: CONFIRM_REQUEST_TYPE,
    issuer: rp.did,
    recipient: subject,
    issuedAt: "2026-05-23T18:00:00Z",
    payload: {
      subject,
      challenge: CHALLENGE,
      reason: "Confirm transfer of $1,000 to did:web:bob.example",
      actionType: "payment.transfer",
      actionDetails: { amount: "1000", currency: "USD" },
      ttl: 180,
    },
  };
  await signTrustTask({ envelope: requestDoc, signing: rp, proofPurpose: "assertionMethod" });

  const message = {
    id: requestDoc.id,
    type: TRUST_TASK_ENVELOPE_TYPE,
    from: rp.did,
    to: [subject],
    thid: "confirm-req-1",
    body: requestDoc,
  };

  const parsed = parseConfirmRequest(message);
  assert.ok(parsed, "parsed a valid confirm request");
  assert.equal(parsed.rpDid, rp.did);
  assert.equal(parsed.thid, "confirm-req-1");
  assert.equal(parsed.request.subject, subject);
  assert.equal(parsed.request.challenge, CHALLENGE);
  assert.equal(parsed.request.reason, "Confirm transfer of $1,000 to did:web:bob.example");
  assert.equal(parsed.request.actionType, "payment.transfer");
  assert.deepEqual(parsed.request.actionDetails, { amount: "1000", currency: "USD" });
  assert.equal(parsed.request.ttl, 180);

  // The RP's request proof is verifiable too (the wallet MAY verify it).
  const rpProof = await verifyTrustTaskProof(requestDoc);
  assert.equal(rpProof.verified, true, rpProof.reason);
  assert.equal(rpProof.signer, rp.did);
});

test("parseConfirmRequest: rejects non-binding, wrong-type, and issuer-mismatch traffic", () => {
  const rp = generateSigningIdentity();
  const subject = generateSigningIdentity().did;
  const goodBody = {
    type: CONFIRM_REQUEST_TYPE,
    issuer: rp.did,
    payload: { subject, challenge: CHALLENGE, reason: "why" },
  };

  // Not the binding envelope type.
  assert.equal(parseConfirmRequest({ type: CONFIRM_REQUEST_TYPE, from: rp.did, body: goodBody }), null);
  // No authcrypt sender.
  assert.equal(parseConfirmRequest({ type: TRUST_TASK_ENVELOPE_TYPE, body: goodBody }), null);
  // Body isn't a confirm/request document.
  assert.equal(
    parseConfirmRequest({
      type: TRUST_TASK_ENVELOPE_TYPE,
      from: rp.did,
      body: { type: "https://trusttasks.org/spec/other/1.0", payload: {} },
    }),
    null,
  );
  // In-band issuer contradicts the transport sender (SPEC §4.8.1).
  assert.equal(
    parseConfirmRequest({
      type: TRUST_TASK_ENVELOPE_TYPE,
      from: "did:key:zSomeoneElse",
      body: goodBody,
    }),
    null,
  );
  // Missing a required payload field (reason).
  assert.equal(
    parseConfirmRequest({
      type: TRUST_TASK_ENVELOPE_TYPE,
      from: rp.did,
      body: { type: CONFIRM_REQUEST_TYPE, issuer: rp.did, payload: { subject, challenge: CHALLENGE } },
    }),
    null,
  );
});
