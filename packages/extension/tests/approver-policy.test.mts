// What a page may do with the wallet's step-up approver.
//
//   - every approver call is held to the relying party the origin is pinned to,
//     so a page can neither read another community's approver DID nor have one
//     sign for another community;
//   - the approve-response 0.6 around a statement is signable only when it
//     carries, unchanged, the statement this wallet issued to this origin, for
//     the same subject, challenge and relying party, signed as the subject;
//   - the operation is rendered so nothing in it can hide;
//   - the holder signs an approve-response for `assertionMethod`;
//   - a `decision` statement comes only from `approveDecision`, never
//     `attestApprover`, and the decision 0.2 around it is signable only when it
//     carries, unchanged, the statement just issued with what the human saw.

import { strict as assert } from "node:assert";
import { test } from "node:test";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

import {
  APPROVE_RESPONSE_0_6,
  TASK_CONSENT_DECISION_0_2,
  approverGestureBinding,
  approverResponseRefusal,
  approverResponseStatementId,
  attestApproverPurposeRefusal,
  decisionResponseRefusal,
  decisionStatementId,
  decisionSummaryText,
  isApproverSignedDecision,
  pageApproverAudienceRefusal,
  renderOperationPayload,
  type IssuedApproverStatement,
} from "../src/approver-policy.ts";

const ORIGIN = "https://vtc.example";
const VTC = "did:webvh:QmV:vtc.example";
const OTHER = "did:webvh:QmO:other.example";
const SUBJECT = "did:webvh:QmS:persona.example";
const CHALLENGE = "c2l4dGVlbi1ieXRlcy1jaGFsbGVuZ2U";

test("an approver call is refused for an origin with no pin", () => {
  assert.match(pageApproverAudienceRefusal(ORIGIN, undefined, VTC) ?? "", /no relying party pinned/);
});

test("an approver call is refused for any audience but the pinned relying party", () => {
  // Reading another community's approver is exactly the correlation per-audience
  // approvers exist to prevent.
  const r = pageApproverAudienceRefusal(ORIGIN, { rpDid: VTC }, OTHER);
  assert.match(r ?? "", /pinned to/);
  assert.equal(pageApproverAudienceRefusal(ORIGIN, { rpDid: VTC }, VTC), null);
  assert.ok(pageApproverAudienceRefusal(ORIGIN, { rpDid: VTC }, undefined));
  assert.ok(pageApproverAudienceRefusal(ORIGIN, { rpDid: VTC }, 42));
});

const STATEMENT = {
  id: "urn:uuid:00000000-0000-4000-8000-000000000001",
  type: "https://trusttasks.org/spec/auth/step-up/approver/attest/0.1",
  issuer: "did:key:z6MkApprover",
  recipient: VTC,
  issuedAt: "2026-10-03T00:00:00.000Z",
  payload: { purpose: "stepUp", subject: SUBJECT, audience: VTC, challenge: CHALLENGE, boundTo: "zQmX" },
  proof: { type: "DataIntegrityProof", proofValue: "z1" },
};

const issued = (over: Partial<IssuedApproverStatement> = {}): IssuedApproverStatement => ({
  statement: STATEMENT,
  origin: ORIGIN,
  audience: VTC,
  subject: SUBJECT,
  challenge: CHALLENGE,
  expiresAt: Date.now() + 60_000,
  ...over,
});

const envelope = (over: Record<string, unknown> = {}, payload: Record<string, unknown> = {}) => ({
  id: "urn:uuid:outer",
  type: APPROVE_RESPONSE_0_6,
  issuer: SUBJECT,
  recipient: VTC,
  issuedAt: "2026-10-03T00:00:01.000Z",
  payload: {
    subject: SUBJECT,
    challenge: CHALLENGE,
    decision: "approved",
    evidence: { kind: "approverSigned", statement: structuredClone(STATEMENT) },
    ...payload,
  },
  ...over,
});

test("the approve-response carrying the statement just issued is signable, as the subject", () => {
  const e = envelope();
  assert.equal(approverResponseStatementId(e), STATEMENT.id);
  assert.equal(approverResponseRefusal(e, issued(), ORIGIN, SUBJECT), null);
});

test("an approve-response is refused without a statement this wallet issued", () => {
  assert.match(approverResponseRefusal(envelope(), undefined, ORIGIN, SUBJECT) ?? "", /no statement/);
});

test("an approve-response is refused when its statement differs from the one issued", () => {
  const altered = structuredClone(STATEMENT);
  altered.payload.boundTo = "zQmOther";
  const e = envelope({}, { evidence: { kind: "approverSigned", statement: altered } });
  assert.match(approverResponseRefusal(e, issued(), ORIGIN, SUBJECT) ?? "", /not the one/);
});

test("an approve-response is refused for another origin, audience, subject or challenge", () => {
  assert.ok(approverResponseRefusal(envelope(), issued(), "https://evil.example", SUBJECT));
  assert.ok(approverResponseRefusal(envelope({ recipient: OTHER }), issued(), ORIGIN, SUBJECT));
  assert.ok(
    approverResponseRefusal(envelope({}, { subject: "did:key:zElse" }), issued(), ORIGIN, SUBJECT),
  );
  assert.ok(
    approverResponseRefusal(envelope({}, { challenge: "x".repeat(20) }), issued(), ORIGIN, SUBJECT),
  );
});

test("an approve-response is signed only as its subject", () => {
  assert.match(
    approverResponseRefusal(envelope(), issued(), ORIGIN, undefined) ?? "",
    /signed as its subject/,
  );
  assert.ok(approverResponseRefusal(envelope(), issued(), ORIGIN, "did:key:z6MkApprover"));
  assert.ok(approverResponseRefusal(envelope({ issuer: OTHER }), issued(), ORIGIN, SUBJECT));
});

test("an approve-response is refused once its statement has lapsed", () => {
  assert.match(
    approverResponseRefusal(envelope(), issued({ expiresAt: Date.now() - 1 }), ORIGIN, SUBJECT) ?? "",
    /lapsed/,
  );
});

test("an approve-response carrying anything else is refused", () => {
  // Another evidence kind is a page forging a passkey answer.
  assert.ok(
    approverResponseRefusal(
      envelope({}, { evidence: { kind: "webauthn", assertion: {} } }),
      issued(),
      ORIGIN,
      SUBJECT,
    ),
  );
  assert.ok(approverResponseRefusal(envelope({}, { decision: "denied" }), issued(), ORIGIN, SUBJECT));
  assert.ok(approverResponseRefusal(envelope({}, { extra: 1 }), issued(), ORIGIN, SUBJECT));
  assert.ok(approverResponseRefusal(envelope({ proof: {} }), issued(), ORIGIN, SUBJECT));
  assert.ok(
    approverResponseRefusal(
      envelope({ type: "https://trusttasks.org/spec/auth/step-up/approve-response/0.4" }),
      issued(),
      ORIGIN,
      SUBJECT,
    ),
  );
});

test("the operation is rendered whole, with invisible characters spelled out", () => {
  const text = renderOperationPayload({ name: "safe‮exe.txt", n: 1, nested: { a: [1, 2] } });
  assert.match(text, /\\u202E/);
  assert.equal(text.includes("‮"), false);
  assert.match(text, /"nested"/);
  assert.match(text, /"n": 1/);
});

test("the holder signs a page's document for the purpose its type decides", () => {
  // The holder path used to hard-code `authentication`; an approve-response
  // must be the holder's `assertionMethod` (approve-response 0.6, consumer
  // step 1a), exactly as the VTA's vault/sign-trust-task decides it.
  const offscreen = readFileSync(
    fileURLToPath(new URL("../src/offscreen.ts", import.meta.url)),
    "utf8",
  );
  const fn = /async function doSignTrustTask\([\s\S]*?\n}\n/.exec(offscreen)?.[0] ?? "";
  assert.ok(fn, "doSignTrustTask not found");
  assert.match(fn, /proofPurpose: proofPurposeForDocumentType\(/);
  assert.equal(/proofPurpose: "authentication"/.test(fn), false);
});

// ── approveDecision ─────────────────────────────────────────────────────────

const src = (file: string) =>
  readFileSync(fileURLToPath(new URL(`../src/${file}`, import.meta.url)), "utf8");

const fnBody = (text: string, name: string) =>
  new RegExp(`async function ${name}\\([\\s\\S]*?\n}\n`).exec(text)?.[0] ?? "";

test("approveDecision is held to the pinned relying party before anything else", () => {
  // The same gate as every approver call: no pin, or another audience, is
  // refused before the offscreen is asked anything or a prompt is raised.
  assert.match(pageApproverAudienceRefusal(ORIGIN, undefined, VTC) ?? "", /no relying party pinned/);
  assert.match(pageApproverAudienceRefusal(ORIGIN, { rpDid: VTC }, OTHER) ?? "", /pinned to/);
  const fn = fnBody(src("background.ts"), "handleApproveDecision");
  assert.ok(fn, "handleApproveDecision not found");
  const gate = fn.indexOf("approverAudienceGate(req.origin, params?.audience)");
  const check = fn.indexOf('op: "check-decision"');
  const prompt = fn.indexOf("requestApproverConsent(");
  const sign = fn.indexOf('op: "sign-decision"');
  assert.ok(gate > 0 && gate < check && check < prompt && prompt < sign, "gate → check → prompt → sign");
});

test("the offscreen re-runs the decision checks beside the key", () => {
  const off = src("offscreen.ts");
  const check = /case "check-decision": \{[\s\S]*?\n    \}/.exec(off)?.[0] ?? "";
  const sign = /case "sign-decision": \{[\s\S]*?\n    \}/.exec(off)?.[0] ?? "";
  assert.match(check, /checkDecisionApproval\(/);
  assert.match(sign, /signDecisionApproval\(/);
  assert.match(sign, /wrapFrom\(req\.prfOutputB64u\)/, "signs only with the gesture's PRF output");
});

test("attestApprover signs enrolment only: purpose decision goes through approveDecision", () => {
  assert.equal(attestApproverPurposeRefusal("enrol"), null);
  assert.match(attestApproverPurposeRefusal("decision") ?? "", /approveDecision/);
  assert.match(attestApproverPurposeRefusal("stepUp") ?? "", /approveStepUp/);
  assert.ok(attestApproverPurposeRefusal(undefined));
  assert.ok(attestApproverPurposeRefusal("other"));
  const fn = fnBody(src("background.ts"), "handleAttestApprover");
  assert.match(fn, /attestApproverPurposeRefusal\(params\?\.purpose\)/);
});

const DIGEST = "zQmYdqiqiHsozX3N5NRnM6CmYRwWmPo4P5Pu1MVopiCfwa2";
const ADMIN = "did:webvh:QmA:admin.example";

const DECISION_STATEMENT = {
  id: "urn:uuid:00000000-0000-4000-8000-000000000002",
  type: "https://trusttasks.org/spec/auth/step-up/approver/attest/0.1",
  issuer: "did:key:z6MkApprover",
  recipient: VTC,
  issuedAt: "2026-10-03T00:00:00.000Z",
  payload: { purpose: "decision", subject: ADMIN, audience: VTC, challenge: CHALLENGE, boundTo: DIGEST },
  proof: { type: "DataIntegrityProof", proofValue: "z2" },
};

const issuedDecision = (over: Partial<IssuedApproverStatement> = {}): IssuedApproverStatement => ({
  statement: DECISION_STATEMENT,
  origin: ORIGIN,
  audience: VTC,
  subject: ADMIN,
  challenge: CHALLENGE,
  expiresAt: Date.now() + 60_000,
  purpose: "decision",
  payloadDigest: DIGEST,
  decision: "approve",
  actionId: "act_1",
  ...over,
});

const decisionDoc = (over: Record<string, unknown> = {}, payload: Record<string, unknown> = {}) => ({
  id: "urn:uuid:decision",
  type: TASK_CONSENT_DECISION_0_2,
  issuer: ADMIN,
  recipient: VTC,
  issuedAt: "2026-10-03T00:00:01.000Z",
  payload: {
    challenge: CHALLENGE,
    payloadDigest: DIGEST,
    decision: "approve",
    actionId: "act_1",
    evidence: { kind: "approverSigned", statement: structuredClone(DECISION_STATEMENT) },
    ...payload,
  },
  ...over,
});

test("the decision carrying the statement just issued is signable, as its subject", () => {
  const d = decisionDoc();
  assert.equal(isApproverSignedDecision(d), true);
  assert.equal(decisionStatementId(d), DECISION_STATEMENT.id);
  assert.equal(decisionResponseRefusal(d, issuedDecision(), ORIGIN, ADMIN), null);
});

test("a decision without approverSigned evidence is not routed to the exemption", () => {
  assert.equal(isApproverSignedDecision(decisionDoc({}, { evidence: undefined })), false);
  assert.equal(
    isApproverSignedDecision(decisionDoc({}, { evidence: { kind: "webauthn", assertion: {} } })),
    false,
  );
  assert.equal(decisionStatementId(decisionDoc({}, { evidence: { kind: "webauthn" } })), null);
});

test("a decision is refused without a statement this wallet issued, or one issued for a step-up", () => {
  assert.match(decisionResponseRefusal(decisionDoc(), undefined, ORIGIN, ADMIN) ?? "", /no statement/);
  assert.match(
    decisionResponseRefusal(decisionDoc(), issuedDecision({ purpose: "stepUp" }), ORIGIN, ADMIN) ?? "",
    /not issued for a decision/,
  );
  // …and the other way: an approve-response cannot spend a decision statement.
  assert.match(
    approverResponseRefusal(envelope(), issued({ purpose: "decision" }), ORIGIN, SUBJECT) ?? "",
    /issued for a decision/,
  );
});

test("a decision is refused when it says other than what the human approved", () => {
  // Approved as approve, signed as deny (and vice versa).
  assert.match(
    decisionResponseRefusal(decisionDoc({}, { decision: "deny" }), issuedDecision(), ORIGIN, ADMIN) ?? "",
    /not the approve/,
  );
  assert.ok(
    decisionResponseRefusal(decisionDoc(), issuedDecision({ decision: "deny" }), ORIGIN, ADMIN),
  );
  assert.ok(
    decisionResponseRefusal(decisionDoc({}, { payloadDigest: "zQmOther" }), issuedDecision(), ORIGIN, ADMIN),
  );
  assert.ok(
    decisionResponseRefusal(decisionDoc({}, { challenge: "x".repeat(20) }), issuedDecision(), ORIGIN, ADMIN),
  );
  assert.ok(
    decisionResponseRefusal(decisionDoc({}, { reason: "unseen" }), issuedDecision(), ORIGIN, ADMIN),
  );
  assert.equal(
    decisionResponseRefusal(
      decisionDoc({}, { reason: "seen" }),
      issuedDecision({ reason: "seen" }),
      ORIGIN,
      ADMIN,
    ),
    null,
  );
  assert.ok(
    decisionResponseRefusal(decisionDoc({}, { actionId: "act_2" }), issuedDecision(), ORIGIN, ADMIN),
  );
  assert.ok(decisionResponseRefusal(decisionDoc({}, { ext: {} }), issuedDecision(), ORIGIN, ADMIN));
});

test("a decision is refused for another origin, relying party or signer, or once lapsed", () => {
  assert.ok(decisionResponseRefusal(decisionDoc(), issuedDecision(), "https://evil.example", ADMIN));
  assert.ok(decisionResponseRefusal(decisionDoc({ recipient: OTHER }), issuedDecision(), ORIGIN, ADMIN));
  assert.match(
    decisionResponseRefusal(decisionDoc(), issuedDecision(), ORIGIN, undefined) ?? "",
    /signed as the statement's subject/,
  );
  assert.ok(decisionResponseRefusal(decisionDoc(), issuedDecision(), ORIGIN, "did:key:z6MkApprover"));
  assert.ok(decisionResponseRefusal(decisionDoc({ issuer: OTHER }), issuedDecision(), ORIGIN, ADMIN));
  assert.match(
    decisionResponseRefusal(decisionDoc(), issuedDecision({ expiresAt: Date.now() - 1 }), ORIGIN, ADMIN) ??
      "",
    /lapsed/,
  );
  assert.ok(decisionResponseRefusal(decisionDoc({ proof: {} }), issuedDecision(), ORIGIN, ADMIN));
});

test("a decision is refused when its statement differs from the one issued", () => {
  const altered = structuredClone(DECISION_STATEMENT);
  altered.payload.boundTo = "zQmOther";
  const d = decisionDoc({}, { evidence: { kind: "approverSigned", statement: altered } });
  assert.match(decisionResponseRefusal(d, issuedDecision(), ORIGIN, ADMIN) ?? "", /not the one/);
});

test("the decision statement is spent before the decision is signed", () => {
  const fn = fnBody(src("background.ts"), "handleSignApproverDecision");
  const refuse = fn.indexOf("decisionResponseRefusal(");
  const spend = fn.indexOf("chrome.storage.session.remove(key!)");
  const sign = fn.indexOf("OFFSCREEN_SIGN_TRUST_TASK");
  assert.ok(refuse > 0 && refuse < spend && spend < sign, "check → spend → sign");
  // And a decision claiming approverSigned evidence never reaches the generic prompt.
  const route = fnBody(src("background.ts"), "handleSignTrustTask");
  assert.ok(
    route.indexOf("isApproverSignedDecision(") < route.indexOf("pageSignRefusal("),
    "routed before the generic path",
  );
});

test("the gesture is bound to the decision's approve or deny", () => {
  const base = { kind: "decision" as const, origin: ORIGIN, audience: VTC, subject: ADMIN, challenge: CHALLENGE, boundTo: DIGEST };
  assert.notEqual(
    approverGestureBinding({ ...base, decision: "approve" }),
    approverGestureBinding({ ...base, decision: "deny" }),
  );
  // Existing bindings are unchanged.
  assert.equal(
    approverGestureBinding({ kind: "stepUp", origin: ORIGIN, audience: VTC, subject: SUBJECT, challenge: CHALLENGE, boundTo: "b" }),
    ["vta-approver/stepUp", VTC, SUBJECT, CHALLENGE, "b"].join("\0"),
  );
});

test("the VTC's summary is reduced to its title and effect", () => {
  assert.equal(
    decisionSummaryText({ title: "Grant a role", effect: "adds an admin", fields: { x: 1 } }),
    "Grant a role — adds an admin",
  );
  assert.equal(decisionSummaryText(undefined), undefined);
  assert.equal(decisionSummaryText([1]), undefined);
});
