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
  verifyTrustTaskProof,
  generateSigningIdentity,
} from "../dist/index.js";

const APPROVE_RESPONSE_TYPE = "https://trusttasks.org/spec/auth/step-up/approve-response/0.2";

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
