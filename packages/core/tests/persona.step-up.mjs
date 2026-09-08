// `release: stepUp` on the wallet side: recognising the agent's refusal, and
// refusing to act on the half of it that carries no signature.
//
// Each of these is a way a reasonable implementation loses the property the
// gate exists for. The refusal looking like an ordinary error is the loud one;
// approving against the *unsigned* previewId is the quiet one.

import { test } from "node:test";
import assert from "node:assert/strict";

import {
  disclosureStepUpRequiredFrom,
  disclosureStepUpFrom,
  disclosureApprovalPayload,
  verifyDisclosureStepUp,
  approveDisclosureStepUp,
  buildStepUpApproval,
  DISCLOSURE_STEP_UP_REQUIRED_CODE,
  VtaClientError,
  generateSigningIdentity,
  signTrustTask,
  verifyTrustTaskProof,
} from "../dist/index.js";

const AGENT = generateSigningIdentity(); // the holder's agent — enrolled
const STRANGER = generateSigningIdentity(); // not enrolled
const enrolled = { enrolledExecutorDids: [AGENT.did] };

const PREVIEW = "01J0000000000000000000000A";
const AUTHZ_EXT = "org.openvtc.authorization-context";
const CONTEXT_TYPE = "https://openvtc.org/persona/authorization-context/0.1";

/** The agent-signed approve-request the refusal carries. */
async function approveRequest({ as = AGENT, previewId = PREVIEW, ctx = {} } = {}) {
  const document = {
    id: "step-up-req-1",
    type: "https://trusttasks.org/spec/auth/step-up/approve-request/0.2",
    issuer: as.did,
    recipient: "did:key:zHolder",
    issuedAt: new Date().toISOString(),
    payload: {
      subject: "did:key:zHolder",
      sessionId: "sess-42",
      challenge: "a".repeat(32),
      reason: "Approve disclosing 1 attribute to did:key:zVerifier",
      ext: {
        [AUTHZ_EXT]: {
          type: CONTEXT_TYPE,
          summary: "Approve disclosing 1 attribute to did:key:zVerifier",
          risk: "high",
          action: {
            kind: "disclose",
            previewId,
            verifierDid: "did:key:zVerifier",
            claimTypes: ["payment.card"],
            purpose: "checkout",
          },
          ...ctx,
        },
      },
    },
  };
  await signTrustTask({ envelope: document, signing: as });
  return document;
}

/** The rejection the agent throws, as the client surfaces it. */
function refusal(details) {
  return new VtaClientError("e.p.msg.bad-request", "step up required", {
    details: { code: DISCLOSURE_STEP_UP_REQUIRED_CODE, details },
  });
}

// ── Recognising it ─────────────────────────────────────────────────────────

test("the refusal is recognised on the top-level code, where the agent puts it", async () => {
  const seen = disclosureStepUpRequiredFrom(
    refusal({ previewId: PREVIEW, previewRetained: true, approveRequest: await approveRequest() }),
  );
  assert.ok(seen, "a stepUpRequired refusal was not recognised");
  assert.equal(seen.kind, "stepUpRequired");
  assert.equal(seen.previewId, PREVIEW);
  assert.equal(seen.previewRetained, true);
});

test("an ordinary error is left alone", () => {
  assert.equal(
    disclosureStepUpRequiredFrom(new VtaClientError("e.p.msg.internal-error", "boom")),
    null,
  );
  assert.equal(disclosureStepUpRequiredFrom(new Error("boom")), null);
  // The neighbouring consent refusal, which DOES ride in `details.reason`.
  // Matching loosely enough to catch this one would hand a consent flow to the
  // step-up path.
  assert.equal(
    disclosureStepUpRequiredFrom(
      new VtaClientError("e.p.msg.bad-request", "consent", {
        details: { code: "taskFailed", details: { reason: "auth:consent_required" } },
      }),
    ),
    null,
  );
});

test("a refusal missing what the retry needs is not half-handled", async () => {
  // No previewId: nothing to present again.
  assert.equal(
    disclosureStepUpRequiredFrom(refusal({ approveRequest: await approveRequest() })),
    null,
  );
  // No approve-request: nothing for the holder to approve.
  assert.equal(
    disclosureStepUpRequiredFrom(refusal({ previewId: PREVIEW, previewRetained: true })),
    null,
  );
});

test("previewRetained is only true when the agent said so", async () => {
  const seen = disclosureStepUpRequiredFrom(
    refusal({ previewId: PREVIEW, approveRequest: await approveRequest() }),
  );
  assert.equal(
    seen.previewRetained,
    false,
    "an agent that did not promise the preview survived was read as if it had",
  );
});

// ── Verifying it ───────────────────────────────────────────────────────────

test("what the holder is shown comes out of the signature", async () => {
  const seen = disclosureStepUpRequiredFrom(
    refusal({ previewId: PREVIEW, previewRetained: true, approveRequest: await approveRequest() }),
  );
  const res = await verifyDisclosureStepUp(seen, enrolled);
  assert.ok(res.ok, res.ok ? "" : res.reason);
  assert.equal(res.issuer, AGENT.did);
  assert.deepEqual(res.context.claimTypes, ["payment.card"]);
  assert.equal(res.context.verifierDid, "did:key:zVerifier");
  assert.equal(res.context.purpose, "checkout");
  assert.equal(res.context.summary, "Approve disclosing 1 attribute to did:key:zVerifier");
  assert.equal(res.request.challenge, "a".repeat(32));
});

test("a request signed by someone the wallet is not enrolled with is refused", async () => {
  const seen = disclosureStepUpRequiredFrom(
    refusal({
      previewId: PREVIEW,
      previewRetained: true,
      approveRequest: await approveRequest({ as: STRANGER }),
    }),
  );
  const res = await verifyDisclosureStepUp(seen, enrolled);
  assert.equal(res.ok, false);
});

test("the signed previewId must be the one the refusal named", async () => {
  // The refusal's `previewId` is unsigned. An implementation that read the
  // context from the signature but kept the unsigned id — or the reverse —
  // would show the holder one disclosure and approve another.
  const seen = disclosureStepUpRequiredFrom(
    refusal({
      previewId: PREVIEW,
      previewRetained: true,
      approveRequest: await approveRequest({
        ctx: {
          action: {
            kind: "disclose",
            previewId: "01JSOMETHINGELSE00000000AA",
            verifierDid: "did:key:zVerifier",
            claimTypes: ["payment.card"],
          },
        },
      }),
    }),
  );
  const res = await verifyDisclosureStepUp(seen, enrolled);
  assert.equal(
    res.ok,
    false,
    "a refusal whose unsigned previewId disagreed with the signed one was approved",
  );
  assert.match(res.reason, /different preview/);
});

test("a tampered context does not survive the proof", async () => {
  const doc = await approveRequest();
  // Add a claim type after signing — the shape of an attacker widening what
  // the holder believes they are approving.
  doc.payload.ext[AUTHZ_EXT].action.claimTypes.push("gov.passport");
  const seen = disclosureStepUpRequiredFrom(
    refusal({ previewId: PREVIEW, previewRetained: true, approveRequest: doc }),
  );
  const res = await verifyDisclosureStepUp(seen, enrolled);
  assert.equal(res.ok, false, "a context altered after signing was shown to the holder");
});

// ── Answering it ───────────────────────────────────────────────────────────

test("the approval is a signed approve-response the agent can verify", async () => {
  const seen = disclosureStepUpRequiredFrom(
    refusal({ previewId: PREVIEW, previewRetained: true, approveRequest: await approveRequest() }),
  );
  const verified = await verifyDisclosureStepUp(seen, enrolled);
  assert.ok(verified.ok);

  const holder = generateSigningIdentity();
  const approval = await approveDisclosureStepUp({
    signing: holder,
    agentDid: AGENT.did,
    request: verified.request,
    approved: true,
  });

  assert.equal(approval.payload.decision, "approved");
  assert.equal(approval.payload.challenge, "a".repeat(32));
  assert.equal(approval.recipient, AGENT.did, "the approval is not bound to the agent as audience");
  const proof = await verifyTrustTaskProof(approval, { expectedProofPurpose: "assertionMethod" });
  assert.equal(proof.verified, true, proof.reason ?? "");
});

test("a context for some other operation is not read as a disclosure", async () => {
  // Every authorization context travels under the same `ext` key — a Cierge
  // share ask included. Without the `type` check, one of those would be shown
  // to the holder in a disclosure's words, and its `action` read for claim
  // types it never had.
  const doc = await approveRequest({
    ctx: {
      type: "https://openvtc.org/cierge/authorization-context/0.1",
      action: { kind: "share", from: "finance", to: "travel" },
    },
  });
  const seen = disclosureStepUpRequiredFrom(
    refusal({ previewId: PREVIEW, previewRetained: true, approveRequest: doc }),
  );
  const res = await verifyDisclosureStepUp(seen, enrolled);
  assert.equal(res.ok, false, "a share ask was accepted as a disclosure approval");
  assert.match(res.reason, /not a disclosure/);
});

test("an action of another kind under the same context type is refused", async () => {
  // `type` and `kind` answer different questions — which producer's vocabulary,
  // and which action within it. A second `kind` added under the persona type is
  // the case this exists for: without the check it would be read as a
  // disclosure, its fields mined for claim types it never had, and shown to the
  // holder in a disclosure's words.
  const doc = await approveRequest({
    ctx: {
      action: { kind: "revoke", previewId: PREVIEW, claimTypes: ["payment.card"] },
    },
  });
  const seen = disclosureStepUpRequiredFrom(
    refusal({ previewId: PREVIEW, previewRetained: true, approveRequest: doc }),
  );
  const res = await verifyDisclosureStepUp(seen, enrolled);
  assert.equal(res.ok, false, "an action of another kind was approved as a disclosure");
  assert.match(res.reason, /not a disclosure/);
});

test("an action with no kind at all is refused", async () => {
  // The shape a producer that forgot the discriminator emits. Absence is not
  // permission.
  const doc = await approveRequest({
    ctx: { action: { previewId: PREVIEW, claimTypes: ["payment.card"] } },
  });
  const seen = disclosureStepUpRequiredFrom(
    refusal({ previewId: PREVIEW, previewRetained: true, approveRequest: doc }),
  );
  const res = await verifyDisclosureStepUp(seen, enrolled);
  assert.equal(res.ok, false, "an action with no kind was approved as a disclosure");
});

test("the disclosure approval is minted as 0.3, and rp-login's is not", async () => {
  // The split this wallet has to hold: it answers TWO relying parties with
  // different capabilities. The agent accepts 0.3 (VTI #1316); the did-hosting
  // control plane does not. Getting it wrong is silent in both directions —
  // too low and a bound approval needlessly elevates a session, too high and
  // every step-up against that party is refused as an unsupported type.
  const seen = disclosureStepUpRequiredFrom(
    refusal({ previewId: PREVIEW, previewRetained: true, approveRequest: await approveRequest() }),
  );
  const verified = await verifyDisclosureStepUp(seen, enrolled);
  assert.ok(verified.ok);

  const holder = generateSigningIdentity();
  const disclosure = await approveDisclosureStepUp({
    signing: holder,
    agentDid: AGENT.did,
    request: verified.request,
    approved: true,
  });
  assert.equal(
    disclosure.type,
    "https://trusttasks.org/spec/auth/step-up/approve-response/0.3",
    "a bound disclosure approval must be minted 0.3, or the agent answers `elevated` and the \
     session is raised on the strength of a decision about one card number",
  );

  // The same builder, answering the other relying party, stays on 0.2.
  const rp = await buildStepUpApproval({
    signing: holder,
    rpDid: "did:web:rp.example",
    request: verified.request,
    approved: true,
    responseVersion: "0.2",
  });
  assert.equal(
    rp.type,
    "https://trusttasks.org/spec/auth/step-up/approve-response/0.2",
    "the version must be per relying party, not a property of the builder",
  );

  // Both still verify — the payload is identical across the two versions, which
  // is why only the acknowledgement needed a new one.
  for (const doc of [disclosure, rp]) {
    const proof = await verifyTrustTaskProof(doc, { expectedProofPurpose: "assertionMethod" });
    assert.equal(proof.verified, true, proof.reason ?? "");
  }
});

test("a refusal that was not thrown is recognised the same way", () => {
  // The wallet dispatches this task itself, so the agent's refusal arrives as
  // `{code, details}` fields rather than inside an exception. One rule, two
  // entry points — a second implementation would be the same three checks
  // written twice and would drift on the third change, not the first.
  const seen = disclosureStepUpFrom(DISCLOSURE_STEP_UP_REQUIRED_CODE, {
    previewId: PREVIEW,
    previewRetained: true,
    approveRequest: { type: "x", payload: {} },
  });
  assert.ok(seen);
  assert.equal(seen.previewId, PREVIEW);
  assert.equal(seen.previewRetained, true);

  // And the same strictness: without a previewId there is nothing to present
  // again, without an approve-request nothing to approve.
  assert.equal(disclosureStepUpFrom(DISCLOSURE_STEP_UP_REQUIRED_CODE, { previewId: PREVIEW }), null);
  assert.equal(disclosureStepUpFrom("taskFailed", { previewId: PREVIEW, approveRequest: {} }), null);
  assert.equal(disclosureStepUpFrom(undefined, undefined), null, "a success is not a refusal");
});

test("the approval echoes only what the verified request said", async () => {
  const seen = disclosureStepUpRequiredFrom(
    refusal({ previewId: PREVIEW, previewRetained: true, approveRequest: await approveRequest() }),
  );
  const verified = await verifyDisclosureStepUp(seen, enrolled);
  assert.ok(verified.ok);

  const payload = disclosureApprovalPayload(verified.request, true);
  assert.equal(payload.subject, "did:key:zHolder");
  assert.equal(payload.sessionId, "sess-42");
  assert.equal(payload.challenge, "a".repeat(32));
  assert.equal(payload.decision, "approved");

  // No proof of its own, deliberately: this goes as an ordinary Trust Task and
  // the channel signs it as the holder with `assertionMethod`, which IS the
  // gate. A second proof here would duplicate or overwrite that one.
  assert.equal("proof" in payload, false);
  assert.equal("type" in payload, false, "a payload, not a document");
});

test("a denial is expressible, and says so rather than staying silent", () => {
  const payload = disclosureApprovalPayload(
    { subject: "did:key:zHolder", sessionId: "s", challenge: "c".repeat(32) },
    false,
  );
  assert.equal(payload.decision, "denied");
});
