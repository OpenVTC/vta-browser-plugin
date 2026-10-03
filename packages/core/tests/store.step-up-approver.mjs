// Step-up approvers (`auth/step-up/approver/attest/0.1`), one per audience.
//
// What these pin:
//   - `boundTo` is the VTC's step-up digest, byte for byte with the Rust;
//   - a statement is refused when this wallet's approver is not offered, or
//     when the request's `boundTo` is not the digest of the operation shown;
//   - each audience gets a distinct DID, minted without a gesture once the
//     sealing key exists, and none of them is the VTA DTTE approver;
//   - the statement has attest/0.1's shape and its proof verifies;
//   - the holder signs an approve-response for `assertionMethod`;
//   - a `decision` statement binds the task-consent wire digest (not the
//     step-up one) recomputed from the action shown, and is refused otherwise.

import { test } from "node:test";
import assert from "node:assert/strict";

import {
  APPROVER_ATTEST_TYPE,
  APPROVER_REFUSAL,
  ApproverPrfSecretWrap,
  InMemoryKVStore,
  STEP_UP_APPROVER_SETUP_REQUIRED,
  TASK_CONSENT_DOMAIN,
  VTC_STEP_UP_DOMAIN,
  clearStepUpApprovers,
  domainDigest,
  ensureStepUpApprover,
  hasStepUpApproverSealKey,
  loadStepUpApprover,
  mintApproverIdentity,
  proofPurposeForDocumentType,
  signDecisionApproval,
  signEnrolAttestation,
  signStepUpApproval,
  stepUpApproverDid,
  taskConsentWireDigest,
  verifyTrustTaskProof,
  vtcStepUpBoundTo,
} from "../dist/index.js";

const VTC_A = "did:webvh:QmA:vtc-a.example";
const VTC_B = "did:webvh:QmB:vtc-b.example";
const SUBJECT = "did:webvh:QmS:persona.example";
const CHALLENGE = "c2l4dGVlbi1ieXRlcy1jaGFsbGVuZ2U";
const OP = {
  type: "https://trusttasks.org/spec/git-ns/right/break-glass/0.1",
  payload: { namespace: "ns-1", right: "ns.admin", reason: "the owner left — ü" },
};

const wrap = (n = 7) => new ApproverPrfSecretWrap(new Uint8Array(32).fill(n));

// ── boundTo against the Rust ────────────────────────────────────────────────

// Pinned vectors copied from `vti_common::task_consent::tests::
// digest_matches_its_pinned_vectors` (verifiable-trust-infrastructure,
// vti-common/src/task_consent/mod.rs). The VTC's `boundTo` is
// `domain_digest(b"vtc/step-up/v1\0", type, payload, Some(challenge))`.
const URI = "https://trusttasks.org/spec/acl/grant/0.1";
const P = { role: "admin", did: "did:key:z6MkA" };

test("domainDigest reproduces vti_common's pinned vectors", async () => {
  assert.equal(
    await domainDigest("vta/task-consent/v1\0", URI, P),
    "zQmNsLmSgtT4jrcgWEC8nHhjambJmen2phxzMKVrCoDWL4Q",
  );
  assert.equal(
    await domainDigest("vta/task-consent/v1\0", URI, P, "chal"),
    "zQmYdqiqiHsozX3N5NRnM6CmYRwWmPo4P5Pu1MVopiCfwa2",
  );
  assert.equal(
    await domainDigest(VTC_STEP_UP_DOMAIN, URI, P),
    "zQmcC7Puan5QbvK5HZ5HWSzrfr7m9pLk8ajR6JRfvB2BG7k",
  );
  assert.equal(
    await vtcStepUpBoundTo(URI, P, "chal"),
    "zQmc1qnh2HJTpPzHCsPV81Dred9WPgqRKBooU7WYZdGqJEi",
  );
});

test("taskConsentWireDigest is vti_common's wire_digest, under the task-consent tag", async () => {
  assert.equal(TASK_CONSENT_DOMAIN, "vta/task-consent/v1\0");
  // `wire_digest(URI, &p, "chal")` in the same pinned-vector test.
  assert.equal(
    await taskConsentWireDigest(URI, P, "chal"),
    "zQmYdqiqiHsozX3N5NRnM6CmYRwWmPo4P5Pu1MVopiCfwa2",
  );
  assert.notEqual(await taskConsentWireDigest(URI, P, "chal"), await vtcStepUpBoundTo(URI, P, "chal"));
});

// ── per-audience approvers ──────────────────────────────────────────────────

test("a new audience needs the sealing key; with it, minting needs no gesture", async () => {
  const store = new InMemoryKVStore();
  await assert.rejects(ensureStepUpApprover(store, VTC_A), (e) => {
    assert.equal(e.code, STEP_UP_APPROVER_SETUP_REQUIRED);
    return true;
  });
  const a = await ensureStepUpApprover(store, VTC_A, { secretWrap: wrap() });
  assert.ok(await hasStepUpApproverSealKey(store));
  // No wrap: the sealing key's public half is enough.
  const b = await ensureStepUpApprover(store, VTC_B);
  assert.match(a, /^did:key:z6Mk/);
  assert.match(b, /^did:key:z6Mk/);
  assert.equal(await stepUpApproverDid(store, VTC_A), a);
  assert.equal(await ensureStepUpApprover(store, VTC_A), a, "stable per audience");
});

test("each audience gets a distinct approver, distinct from the VTA DTTE approver", async () => {
  const store = new InMemoryKVStore();
  const dtte = await mintApproverIdentity(store, { vtaDid: "did:key:zVta", secretWrap: wrap() });
  const a = await ensureStepUpApprover(store, VTC_A, { secretWrap: wrap() });
  const b = await ensureStepUpApprover(store, VTC_B);
  assert.notEqual(a, b);
  assert.notEqual(a, dtte.did);
  assert.notEqual(b, dtte.did);
  // Forgetting every step-up approver leaves the DTTE approver alone.
  await clearStepUpApprovers(store);
  assert.equal(await stepUpApproverDid(store, VTC_A), null);
  assert.ok(await store.get("pnm/approver-identity/v1/did:key:zVta"));
});

test("the seed is only ever stored sealed, and unseals only with the approver wrap", async () => {
  const store = new InMemoryKVStore();
  const did = await ensureStepUpApprover(store, VTC_A, { secretWrap: wrap() });
  const rec = await store.get(`pnm/step-up-approver/v1/aud/${VTC_A}`);
  assert.ok(rec.sealed?.ciphertextB64u, "sealed seed");
  assert.equal(JSON.stringify(rec).includes("privateKey"), false);
  const seal = await store.get("pnm/step-up-approver/v1/seal");
  assert.equal(seal.wrappedSecret.algorithm, "webauthn-prf-aes-gcm/approver");

  const signing = await loadStepUpApprover(store, VTC_A, wrap());
  assert.equal(signing.did, did);
  assert.equal(signing.kid, `${did}#${did.slice("did:key:".length)}`);
  // Another gesture's PRF output is another KEK.
  await assert.rejects(loadStepUpApprover(store, VTC_A, wrap(9)));
});

test("a sealed seed cannot be moved to another audience's record", async () => {
  const store = new InMemoryKVStore();
  await ensureStepUpApprover(store, VTC_A, { secretWrap: wrap() });
  await ensureStepUpApprover(store, VTC_B);
  const a = await store.get(`pnm/step-up-approver/v1/aud/${VTC_A}`);
  const b = await store.get(`pnm/step-up-approver/v1/aud/${VTC_B}`);
  await store.put(`pnm/step-up-approver/v1/aud/${VTC_B}`, { ...b, sealed: a.sealed });
  await assert.rejects(loadStepUpApprover(store, VTC_B, wrap()));
});

// ── approveStepUp ───────────────────────────────────────────────────────────

async function stepUpFixture() {
  const store = new InMemoryKVStore();
  const approverDid = await ensureStepUpApprover(store, VTC_A, { secretWrap: wrap() });
  const request = {
    subject: SUBJECT,
    challenge: CHALLENGE,
    boundTo: await vtcStepUpBoundTo(OP.type, OP.payload, CHALLENGE),
    reason: "Break glass on ns-1",
    accepts: ["webauthn", "approverSigned"],
    approvers: ["did:key:z6MkOther", approverDid],
  };
  return { store, approverDid, request };
}

test("approveStepUp returns a complete, verifying attest/0.1 statement", async () => {
  const { store, approverDid, request } = await stepUpFixture();
  const before = Date.now();
  const { statement, approverDid: did } = await signStepUpApproval(store, {
    request,
    operation: OP,
    audience: VTC_A,
    secretWrap: wrap(),
  });
  assert.equal(did, approverDid);
  assert.equal(statement.type, APPROVER_ATTEST_TYPE);
  assert.equal(statement.issuer, approverDid);
  assert.equal(statement.recipient, VTC_A);
  assert.match(statement.id, /^urn:uuid:[0-9a-f-]{36}$/);
  assert.ok(Date.parse(statement.issuedAt) >= before - 1000);
  assert.deepEqual(statement.payload, {
    purpose: "stepUp",
    subject: SUBJECT,
    audience: VTC_A,
    challenge: CHALLENGE,
    boundTo: request.boundTo,
  });
  assert.equal(statement.proof.cryptosuite, "eddsa-jcs-2022");
  assert.equal(statement.proof.proofPurpose, "authentication");
  assert.equal(
    statement.proof.verificationMethod,
    `${approverDid}#${approverDid.slice("did:key:".length)}`,
  );
  const v = await verifyTrustTaskProof(statement, { expectedProofPurpose: "authentication" });
  assert.equal(v.verified, true, v.reason);
  assert.equal(v.signer, approverDid);
});

test("approveStepUp refuses when this wallet's approver is not offered", async () => {
  const { store, request } = await stepUpFixture();
  await assert.rejects(
    signStepUpApproval(store, {
      request: { ...request, approvers: ["did:key:z6MkOther"] },
      operation: OP,
      audience: VTC_A,
      secretWrap: wrap(),
    }),
    (e) => e.code === APPROVER_REFUSAL.notOffered,
  );
});

test("approveStepUp refuses a boundTo that is not the digest of the operation shown", async () => {
  const { store, request } = await stepUpFixture();
  // The page shows one operation and asks for a statement bound to another.
  await assert.rejects(
    signStepUpApproval(store, {
      request,
      operation: { ...OP, payload: { ...OP.payload, namespace: "ns-2" } },
      audience: VTC_A,
      secretWrap: wrap(),
    }),
    (e) => e.code === APPROVER_REFUSAL.boundToMismatch,
  );
  // …or the same operation under another type.
  await assert.rejects(
    signStepUpApproval(store, {
      request,
      operation: { ...OP, type: "https://trusttasks.org/spec/git-ns/right/grant/0.3" },
      audience: VTC_A,
      secretWrap: wrap(),
    }),
    (e) => e.code === APPROVER_REFUSAL.boundToMismatch,
  );
  // …or a forged boundTo.
  await assert.rejects(
    signStepUpApproval(store, {
      request: { ...request, boundTo: await vtcStepUpBoundTo(OP.type, OP.payload, "x".repeat(20)) },
      operation: OP,
      audience: VTC_A,
      secretWrap: wrap(),
    }),
    (e) => e.code === APPROVER_REFUSAL.boundToMismatch,
  );
});

test("approveStepUp uses the audience's own approver, never another audience's", async () => {
  const { store, request } = await stepUpFixture();
  // VTC_B's approver is not among the approvers VTC_A offered.
  await ensureStepUpApprover(store, VTC_B);
  await assert.rejects(
    signStepUpApproval(store, { request, operation: OP, audience: VTC_B, secretWrap: wrap() }),
    (e) => e.code === APPROVER_REFUSAL.notOffered,
  );
});

test("approveStepUp refuses a request that does not accept approverSigned", async () => {
  const { store, request } = await stepUpFixture();
  await assert.rejects(
    signStepUpApproval(store, {
      request: { ...request, accepts: ["webauthn"] },
      operation: OP,
      audience: VTC_A,
      secretWrap: wrap(),
    }),
    (e) => e.code === APPROVER_REFUSAL.notApproverSigned,
  );
});

// ── attestApprover (enrol) ──────────────────────────────────────────────────

test("an enrolment statement signs what it is given, for purpose enrol", async () => {
  const store = new InMemoryKVStore();
  const { statement, approverDid } = await signEnrolAttestation(store, {
    subject: SUBJECT,
    audience: VTC_A,
    challenge: CHALLENGE,
    boundTo: "enr_0123456789",
    secretWrap: wrap(),
  });
  assert.equal(await stepUpApproverDid(store, VTC_A), approverDid);
  assert.equal(statement.issuer, approverDid);
  assert.equal(statement.recipient, VTC_A);
  assert.deepEqual(statement.payload, {
    purpose: "enrol",
    subject: SUBJECT,
    audience: VTC_A,
    challenge: CHALLENGE,
    boundTo: "enr_0123456789",
  });
  assert.equal(statement.proof.proofPurpose, "authentication");
  const v = await verifyTrustTaskProof(statement, { expectedProofPurpose: "authentication" });
  assert.equal(v.verified, true, v.reason);
});

test("an enrolment statement refuses members outside attest/0.1's bounds", async () => {
  const store = new InMemoryKVStore();
  await assert.rejects(
    signEnrolAttestation(store, {
      subject: SUBJECT,
      audience: VTC_A,
      challenge: "short",
      boundTo: "x",
      secretWrap: wrap(),
    }),
    (e) => e.code === APPROVER_REFUSAL.malformed,
  );
});

// ── approveDecision (purpose: decision) ─────────────────────────────────────

// A VTC action as `vtc/admin/actions/list/0.1` lists it, and the decision an
// administrator (SUBJECT) answers it with. `payloadDigest` is the wire digest
// salted with the challenge the VTC issued this administrator.
const ACTION = {
  actionId: "act_01J9ZK",
  type: URI,
  payload: P,
};

async function decisionFixture(decision = "approve") {
  const store = new InMemoryKVStore();
  const approverDid = await ensureStepUpApprover(store, VTC_A, { secretWrap: wrap() });
  return {
    store,
    approverDid,
    decision: {
      challenge: CHALLENGE,
      payloadDigest: await taskConsentWireDigest(ACTION.type, ACTION.payload, CHALLENGE),
      decision,
    },
  };
}

test("approveDecision returns a complete, verifying attest/0.1 statement for purpose decision", async () => {
  const { store, approverDid, decision } = await decisionFixture();
  const { statement, approverDid: did } = await signDecisionApproval(store, {
    subject: SUBJECT,
    action: ACTION,
    decision,
    audience: VTC_A,
    secretWrap: wrap(),
  });
  assert.equal(did, approverDid);
  assert.equal(statement.type, APPROVER_ATTEST_TYPE);
  assert.equal(statement.issuer, approverDid);
  assert.equal(statement.recipient, VTC_A);
  assert.match(statement.id, /^urn:uuid:[0-9a-f-]{36}$/);
  assert.deepEqual(statement.payload, {
    purpose: "decision",
    subject: SUBJECT,
    audience: VTC_A,
    challenge: CHALLENGE,
    boundTo: decision.payloadDigest,
  });
  assert.equal(statement.proof.cryptosuite, "eddsa-jcs-2022");
  assert.equal(statement.proof.proofPurpose, "authentication");
  const v = await verifyTrustTaskProof(statement, { expectedProofPurpose: "authentication" });
  assert.equal(v.verified, true, v.reason);
  assert.equal(v.signer, approverDid);
});

test("approveDecision vouches for a deny as well", async () => {
  const { store, decision } = await decisionFixture("deny");
  const { statement } = await signDecisionApproval(store, {
    subject: SUBJECT,
    action: ACTION,
    decision,
    audience: VTC_A,
    secretWrap: wrap(),
  });
  assert.equal(statement.payload.purpose, "decision");
});

test("approveDecision refuses a payloadDigest that is not the digest of the action shown", async () => {
  const { store, decision } = await decisionFixture();
  const sign = (over) =>
    signDecisionApproval(store, {
      subject: SUBJECT,
      action: ACTION,
      decision,
      audience: VTC_A,
      secretWrap: wrap(),
      ...over,
    });
  const mismatch = (e) => e.code === APPROVER_REFUSAL.boundToMismatch;
  // The page shows one payload and asks for a statement bound to another…
  await assert.rejects(sign({ action: { ...ACTION, payload: { ...P, role: "reader" } } }), mismatch);
  // …or the same payload under another type…
  await assert.rejects(
    sign({ action: { ...ACTION, type: "https://trusttasks.org/spec/acl/revoke/0.1" } }),
    mismatch,
  );
  // …or another administrator's challenge (the VTC salts per approver)…
  await assert.rejects(sign({ decision: { ...decision, challenge: "y".repeat(24) } }), mismatch);
  // …or the step-up digest, which is the wrong domain for a decision…
  await assert.rejects(
    sign({
      decision: { ...decision, payloadDigest: await vtcStepUpBoundTo(URI, P, CHALLENGE) },
    }),
    mismatch,
  );
  // …or the unsalted, executor-internal digest.
  await assert.rejects(
    sign({ decision: { ...decision, payloadDigest: await domainDigest(TASK_CONSENT_DOMAIN, URI, P) } }),
    mismatch,
  );
});

test("approveDecision refuses malformed input and an approver that is the subject", async () => {
  const { store, approverDid, decision } = await decisionFixture();
  const sign = (over) =>
    signDecisionApproval(store, {
      subject: SUBJECT,
      action: ACTION,
      decision,
      audience: VTC_A,
      secretWrap: wrap(),
      ...over,
    });
  const malformed = (e) => e.code === APPROVER_REFUSAL.malformed;
  await assert.rejects(sign({ decision: { ...decision, decision: "approved" } }), malformed);
  await assert.rejects(sign({ decision: { ...decision, challenge: "short" } }), malformed);
  await assert.rejects(sign({ subject: "not-a-did" }), malformed);
  await assert.rejects(sign({ action: { type: URI } }), malformed);
  await assert.rejects(sign({ subject: approverDid }), (e) => e.code === APPROVER_REFUSAL.subjectIsApprover);
});

test("approveDecision never mints: an audience with no approver is refused", async () => {
  const { store, decision } = await decisionFixture();
  await assert.rejects(
    signDecisionApproval(store, {
      subject: SUBJECT,
      action: ACTION,
      decision,
      audience: VTC_B,
      secretWrap: wrap(),
    }),
    (e) => e.code === APPROVER_REFUSAL.notEnrolled,
  );
  assert.equal(await stepUpApproverDid(store, VTC_B), null);
});

// ── the purpose rule ────────────────────────────────────────────────────────

test("an approve-response is signed for assertionMethod; operational documents for authentication", () => {
  const S = "https://trusttasks.org/spec/";
  assert.equal(proofPurposeForDocumentType(`${S}auth/step-up/approve-response/0.6`), "assertionMethod");
  assert.equal(proofPurposeForDocumentType(`${S}task-consent/decision/0.2`), "assertionMethod");
  assert.equal(proofPurposeForDocumentType(`${S}confirm/response/0.1`), "assertionMethod");
  // The executor's reply is operational.
  assert.equal(
    proofPurposeForDocumentType(`${S}auth/step-up/approve-response/0.6#response`),
    "authentication",
  );
  assert.equal(proofPurposeForDocumentType(`${S}git-ns/right/grant/0.3`), "authentication");
  assert.equal(proofPurposeForDocumentType(`${S}auth/step-up/approver/attest/0.1`), "authentication");
  // A private registry's reuse of the slug is not classified.
  assert.equal(
    proofPurposeForDocumentType("https://example.com/spec/auth/step-up/approve-response/0.6"),
    "authentication",
  );
});
