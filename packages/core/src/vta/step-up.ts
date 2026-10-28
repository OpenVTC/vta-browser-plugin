// The half of the step-up ceremony that is not the relying party's exchange:
// verifying an approve-request that arrives signed, and building the signed
// approve-response that answers it.
//
// **It lives here, one layer below `rp-login/`, because two unrelated callers
// need it.** The did-hosting control plane answers `auth/step-up/start` with an
// approve-request; `persona/`'s disclosure gate gets one back inside a
// Trust-Task *refusal* from the agent. Same document family, same verification
// rules, same response — and `rp-login/` and `persona/` are the same layer, so
// neither can import the other.
//
// `rp-login/step-up.ts` re-exports every name here.
//
// The rule that makes this security-relevant rather than plumbing: a consumer
// MUST verify the approve-request's proof BEFORE surfacing its reason.
// Everything a human is shown, and everything the wallet signs over, comes out
// of the verified payload.

import { signTrustTask } from "../trust-tasks/sign.js";
import { verifyTrustTaskProof } from "../trust-tasks/verify.js";
import type { SigningIdentity } from "../siop/self-issued.js";
import type { TrustTask } from "./protocol.js";

import { TYPE_URI as MSG_APPROVE_RESPONSE } from "../specs/auth/step-up/approve-response/0.6/payload.js";
import { RESPONSE_PAYLOAD_SCHEMA as STEP_UP_START_RESPONSE_SCHEMA } from "../specs/auth/step-up/start/0.2/payload.js";

/**
 * The approve-request version the agent mints — in a disclosure step-up
 * refusal and in the one it pushes alike (vta-service `step_up.rs`,
 * `STEP_UP_APPROVE_REQUEST_TYPE`).
 *
 * **A literal, and the one approve-request URI here that is not read from a
 * pinned specification.** Three counterparties speak three versions of this
 * slug today — the agent mints 0.2, a VTC's inline refusal carries 0.4
 * (`trust-tasks/approver-attest.ts`, the version pinned), the did-hosting
 * control plane mints 0.5 — so no single pin can name all three. It goes once
 * the agent mints the version the others do; until then it is one version,
 * matched with `===`, not an accept-list.
 */
export const AGENT_APPROVE_REQUEST_TYPES = [
  "https://trusttasks.org/spec/auth/step-up/approve-request/0.2",
] as const;

/** The approve-request version the did-hosting control plane answers
 *  `auth/step-up/start/0.2` with: the one that specification embeds, read out
 *  of its schema so the two cannot drift. */
export const RP_APPROVE_REQUEST_TYPES = [
  STEP_UP_START_RESPONSE_SCHEMA.$defs.Response.properties.approveRequest.properties.type.const,
] as const;

/** The approve-request payload, verified out of the signed Trust-Task
 *  document by {@link verifyStepUpApproveRequest}. */
export interface StepUpApproveRequest {
  /** The VID whose session is being elevated — the wallet must speak for it. */
  subject: string;
  /** The session the RP wants elevated. Echoed into the response. */
  sessionId: string;
  /** RP-issued nonce the approve-response signs over. */
  challenge: string;
  /** Human-readable reason to surface for consent. */
  reason?: string;
}

export type VerifyStepUpApproveRequestResult =
  | {
      ok: true;
      /** Built ONLY from the verified document's payload. */
      request: StepUpApproveRequest;
      /** The proven signer (== the document's `issuer`). */
      issuer: string;
      expiresAt?: string;
    }
  | { ok: false; reason: string };

export interface VerifyStepUpApproveRequestOptions {
  /** The executors this wallet is enrolled with (its VTA DID(s) plus any
   *  operator-enrolled executor DIDs, e.g. the webvh control plane). The
   *  approve-request's proven signer must be in this set. */
  enrolledExecutorDids: readonly string[];
  /**
   * The approve-request versions this caller's relying party mints —
   * {@link RP_APPROVE_REQUEST_TYPES} or {@link AGENT_APPROVE_REQUEST_TYPES}.
   * Required: which versions are acceptable is a property of the party that
   * asked, and a document of another party's version is refused.
   */
  acceptTypes: readonly string[];
  /** Defaults to now. Injected for tests. */
  now?: Date;
}

/**
 * Verify an RP step-up approve-request before anything derived from it is
 * shown to a human or signed over.
 *
 * Spec rule: the `reason` is the basis of the user's consent decision, so
 * "consumers MUST verify the proof BEFORE surfacing the reason". Accordingly:
 *
 *  - the document is REQUIRED, and must be one of `acceptTypes`;
 *  - its Data-Integrity proof must verify (`eddsa-jcs-2022`,
 *    `proofPurpose: authentication` — a request is its issuer's operational
 *    message; `assertionMethod` is for the approver's attestation, the
 *    approve-response), the in-band `issuer` must equal the proven signer, and
 *    that signer must be an executor this wallet is enrolled with;
 *  - it must not have lapsed (`expiresAt` on the document or in the payload);
 *  - the returned request is built ONLY from the verified document.
 */
export async function verifyStepUpApproveRequest(
  doc: Record<string, unknown> | undefined,
  opts: VerifyStepUpApproveRequestOptions,
): Promise<VerifyStepUpApproveRequestResult> {
  const refuse = (reason: string): VerifyStepUpApproveRequestResult => ({ ok: false, reason });

  if (!doc || typeof doc !== "object") {
    return refuse("no signed approve-request document");
  }
  const type = doc.type;
  if (typeof type !== "string" || !opts.acceptTypes.includes(type)) {
    return refuse(`document type ${String(type)} is not a step-up approve-request this party mints`);
  }

  const verification = await verifyTrustTaskProof(doc, {
    expectedProofPurpose: "authentication",
  });
  if (!verification.verified || !verification.signer) {
    return refuse(verification.reason ?? "proof did not verify");
  }
  if (typeof doc.issuer !== "string" || doc.issuer !== verification.signer) {
    return refuse("issuer does not match the proven signer");
  }
  if (!opts.enrolledExecutorDids.includes(verification.signer)) {
    return refuse(
      `signed by ${verification.signer}, not an executor this wallet is enrolled with`,
    );
  }

  const payload = (doc.payload ?? {}) as {
    subject?: unknown;
    sessionId?: unknown;
    challenge?: unknown;
    reason?: unknown;
    expiresAt?: unknown;
  };
  if (
    typeof payload.subject !== "string" ||
    typeof payload.sessionId !== "string" ||
    typeof payload.challenge !== "string"
  ) {
    return refuse("verified document is missing subject/sessionId/challenge");
  }

  const now = opts.now ?? new Date();
  for (const at of [doc.expiresAt, payload.expiresAt]) {
    if (typeof at !== "string") continue;
    const expiry = new Date(at);
    if (Number.isNaN(expiry.getTime()) || expiry <= now) {
      return refuse(`approve-request lapsed at ${at}`);
    }
  }

  return {
    ok: true,
    issuer: verification.signer,
    request: {
      subject: payload.subject,
      sessionId: payload.sessionId,
      challenge: payload.challenge,
      // The reason a human may be shown comes from inside the signature.
      ...(typeof payload.reason === "string" ? { reason: payload.reason } : {}),
    },
    ...(typeof doc.expiresAt === "string"
      ? { expiresAt: doc.expiresAt }
      : typeof payload.expiresAt === "string"
        ? { expiresAt: payload.expiresAt }
        : {}),
  };
}

/** Payload of the `approve-response/0.6` the wallet signs. */
export interface StepUpApproveResponsePayload {
  subject: string;
  sessionId: string;
  challenge: string;
  decision: "approved" | "denied";
  deniedReason?: string;
}

export interface BuildStepUpApprovalArgs {
  /** The wallet's Ed25519 signing identity — its `did` is the response
   *  `subject`/`issuer` and its `kid` the proof's `verificationMethod`. It
   *  MUST be the DID the RP session authenticated as. */
  signing: SigningIdentity;
  /** The RP's DID — bound in-band as `recipient` so the signed proof commits
   *  to this audience (SPEC §4.8.2). */
  rpDid: string;
  /** The verified approve-request being answered. */
  request: StepUpApproveRequest;
  /** The user's decision. */
  approved: boolean;
  /** Human-readable rationale, attached when the user denies. */
  deniedReason?: string;
}

/**
 * Build and sign an `auth/step-up/approve-response/0.6` Trust-Task document —
 * the version the agent and the did-hosting control plane both serve. The DI
 * proof (`eddsa-jcs-2022`, `proofPurpose: assertionMethod`) over the subject key
 * is what the RP verifies.
 */
export async function buildStepUpApproval(
  args: BuildStepUpApprovalArgs,
): Promise<TrustTask<StepUpApproveResponsePayload> & { proof?: unknown }> {
  const decision: "approved" | "denied" = args.approved ? "approved" : "denied";
  const payload: StepUpApproveResponsePayload = {
    subject: args.request.subject,
    sessionId: args.request.sessionId,
    challenge: args.request.challenge,
    decision,
    ...(decision === "denied" && args.deniedReason ? { deniedReason: args.deniedReason } : {}),
  };

  const document: TrustTask<StepUpApproveResponsePayload> & { proof?: unknown } = {
    id: globalThis.crypto.randomUUID(),
    type: MSG_APPROVE_RESPONSE,
    issuer: args.signing.did,
    recipient: args.rpDid,
    issuedAt: new Date().toISOString(),
    payload,
  };

  await signTrustTask({
    envelope: document as unknown as Record<string, unknown> & { proof?: unknown },
    signing: args.signing,
    proofPurpose: "assertionMethod",
  });
  return document;
}
