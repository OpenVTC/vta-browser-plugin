// What a page may do with the wallet's step-up approver.
//
//   - every approver call is held to the relying party the origin is pinned to,
//     so a page can neither read another community's approver DID nor have one
//     sign for another community;
//   - the approve-response 0.6 around a statement is signable only when it
//     carries, unchanged, the statement this wallet issued to this origin, for
//     the same subject, challenge and relying party, signed as the subject;
//   - the operation is rendered so nothing in it can hide;
//   - the holder signs an approve-response for `assertionMethod`.

import { strict as assert } from "node:assert";
import { test } from "node:test";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

import {
  APPROVE_RESPONSE_0_6,
  approverResponseRefusal,
  approverResponseStatementId,
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
