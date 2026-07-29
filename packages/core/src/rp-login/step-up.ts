// VTA-approval step-up for a did-hosting Relying Party — holder-self-signs.
//
// Elevates an existing `aal1` session to `aal2`. The RP issues a challenge
// bound to the caller's session; the holder signs a spec
// `auth/step-up/approve-response/0.2` Trust-Task document (a W3C Data Integrity
// proof over the session-subject `did:key`); the RP verifies that proof and
// mints a higher-assurance session token. The wallet — not the VTA — signs the
// approval, so no DIDComm round-trip and no trusted third party are involved;
// the proof is the holder re-proving control of the session subject over a
// fresh challenge.
//
// Three steps:
//   1. RP start  (REST) → approve-request payload {subject, sessionId, challenge}
//   2. Wallet    (local) → signed approve-response/0.2 document
//   3. RP finish (REST) → elevated session tokens
//
// Server contract (step 1 + 3 REST responses are **snake_case**, unlike the
// camelCase login responses).

import { signTrustTask } from "../trust-tasks/sign.js";
import { verifyTrustTaskProof } from "../trust-tasks/verify.js";
import type { SigningIdentity } from "../siop/self-issued.js";
import type { TrustTask } from "../vta/protocol.js";
import { withFetchTimeout } from "../http/timeout-fetch.js";

// Canonical step-up approval spec from trusttasks-tf. The proof on the
// approve-response is what the RP verifies to elevate the session's acr.
const MSG_APPROVE_RESPONSE = "https://trusttasks.org/spec/auth/step-up/approve-response/0.2";
/** The RP→approver request halves this wallet accepts. 0.2 is what the
 *  did-hosting control plane mints on `start`; 0.1 is the VTA-pushed flavor
 *  (same required payload members) — both are gated identically. */
export const STEP_UP_APPROVE_REQUEST_TYPES = [
  "https://trusttasks.org/spec/auth/step-up/approve-request/0.2",
  "https://trusttasks.org/spec/auth/step-up/approve-request/0.1",
] as const;

/** The RP's `approve-request/0.2` payload, verified out of the signed
 *  Trust-Task document by {@link verifyStepUpApproveRequest}. */
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

/** Raw body of the RP's step-up `start` response: the legacy top-level fields
 *  plus the signed `auth/step-up/approve-request/0.2` Trust-Task `document`.
 *  Nothing here is trusted until {@link verifyStepUpApproveRequest} passes —
 *  in particular the legacy fields exist only for the cross-check; every value
 *  the wallet acts on comes out of the verified document. */
export interface StepUpStartResponse {
  subject?: string;
  sessionId?: string;
  challenge?: string;
  reason?: string;
  /** The full signed `auth/step-up/approve-request/0.2` document. REQUIRED —
   *  a start response without it is refused (the proofless legacy path was
   *  removed deliberately once the control plane began signing requests). */
  document?: Record<string, unknown>;
}

export type VerifyStepUpApproveRequestResult =
  | {
      ok: true;
      /** Built ONLY from the verified document's payload — never from the
       *  legacy top-level fields. */
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
  /** Defaults to now. Injected for tests. */
  now?: Date;
}

/**
 * Verify an RP step-up approve-request before anything derived from it is
 * shown to a human or signed over.
 *
 * Spec rule (auth/step-up/approve-request/0.2): the `reason` is the basis of
 * the user's consent decision, so "consumers MUST verify the proof BEFORE
 * surfacing the reason". Accordingly:
 *
 *  - the signed `document` is REQUIRED — a start response without one is
 *    refused outright (the legacy proofless `{subject, sessionId, challenge,
 *    reason}` path was removed deliberately; the control plane now always
 *    returns a signed document);
 *  - its Data-Integrity proof must verify (`eddsa-jcs-2022`,
 *    `assertionMethod`), the in-band `issuer` must equal the proven signer,
 *    and that signer must be an executor this wallet is enrolled with;
 *  - when the legacy top-level fields are also present they must agree with
 *    the verified payload (a mismatch means someone altered the unsigned
 *    copy — refuse rather than guess);
 *  - the returned request is built ONLY from the verified document.
 */
export async function verifyStepUpApproveRequest(
  start: StepUpStartResponse,
  opts: VerifyStepUpApproveRequestOptions,
): Promise<VerifyStepUpApproveRequestResult> {
  const refuse = (reason: string): VerifyStepUpApproveRequestResult => ({ ok: false, reason });

  const doc = start.document;
  if (!doc || typeof doc !== "object") {
    return refuse(
      "start response carried no signed approve-request document — refusing the proofless legacy shape",
    );
  }
  const type = doc.type;
  if (typeof type !== "string" || !(STEP_UP_APPROVE_REQUEST_TYPES as readonly string[]).includes(type)) {
    return refuse(`document type ${String(type)} is not a step-up approve-request`);
  }

  const verification = await verifyTrustTaskProof(doc, {
    expectedProofPurpose: "assertionMethod",
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

  // Legacy top-level fields, when present, must agree with what was signed.
  // They carry no authority of their own; a disagreement means the unsigned
  // copy was altered in flight and nothing here should be acted on.
  for (const k of ["subject", "sessionId", "challenge"] as const) {
    if (typeof start[k] === "string" && start[k] !== payload[k]) {
      return refuse(`legacy field ${k} does not match the signed document`);
    }
  }

  if (typeof payload.expiresAt === "string") {
    const expiry = new Date(payload.expiresAt);
    if (Number.isNaN(expiry.getTime()) || expiry <= (opts.now ?? new Date())) {
      return refuse(`approve-request lapsed at ${payload.expiresAt}`);
    }
  }

  return {
    ok: true,
    issuer: verification.signer,
    request: {
      subject: payload.subject,
      sessionId: payload.sessionId,
      challenge: payload.challenge,
      // The reason a human may be shown comes from inside the signature, never
      // from the unsigned top-level copy.
      ...(typeof payload.reason === "string" ? { reason: payload.reason } : {}),
    },
    ...(typeof payload.expiresAt === "string" ? { expiresAt: payload.expiresAt } : {}),
  };
}

/** Payload of the `approve-response/0.2` the wallet signs. */
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
  /** The approve-request the RP returned from {@link stepUpVtaStart}. */
  request: StepUpApproveRequest;
  /** The user's decision. */
  approved: boolean;
  /** Human-readable rationale, attached when the user denies. */
  deniedReason?: string;
}

/**
 * Build and sign the `auth/step-up/approve-response/0.2` Trust-Task document.
 * The DI proof (`eddsa-jcs-2022`, `proofPurpose: assertionMethod`) over the
 * subject key is what the RP verifies to elevate the session.
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
    payload,
  };

  await signTrustTask({
    envelope: document as unknown as Record<string, unknown> & { proof?: unknown },
    signing: args.signing,
    proofPurpose: "assertionMethod",
  });
  return document;
}

/**
 * Step 1 — RP start. Authenticated with the existing `aal1` access token,
 * returns the raw start response: the signed `approve-request` `document`
 * plus the legacy top-level fields. **Nothing in it is trusted yet** — the
 * caller MUST pass it through {@link verifyStepUpApproveRequest} before
 * surfacing or signing anything derived from it.
 */
export async function stepUpVtaStart(
  baseUrl: string,
  accessToken: string,
  fetchFn?: typeof fetch,
): Promise<StepUpStartResponse> {
  const f = withFetchTimeout(fetchFn);
  const base = baseUrl.replace(/\/+$/, "");
  const res = await f(`${base}/auth/step-up/vta/start`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      authorization: `Bearer ${accessToken}`,
    },
    body: JSON.stringify({}),
  });
  if (!res.ok) {
    throw new Error(`vta step-up start: failed (${res.status}): ${await res.text()}`);
  }
  const json = (await res.json()) as unknown;
  if (!json || typeof json !== "object") {
    throw new Error(`vta step-up start: malformed response: ${JSON.stringify(json)}`);
  }
  const body = json as Record<string, unknown>;
  return {
    ...(typeof body.subject === "string" ? { subject: body.subject } : {}),
    ...(typeof body.sessionId === "string" ? { sessionId: body.sessionId } : {}),
    ...(typeof body.challenge === "string" ? { challenge: body.challenge } : {}),
    ...(typeof body.reason === "string" ? { reason: body.reason } : {}),
    ...(body.document && typeof body.document === "object"
      ? { document: body.document as Record<string, unknown> }
      : {}),
  };
}

export interface StepUpVtaFinishResult {
  accessToken: string;
  refreshToken: string;
  sessionId: string;
}

/**
 * Step 3 — RP finish. Submits the signed `approve-response/0.2` document and
 * returns the elevated session tokens. Response body is **snake_case**.
 */
export async function stepUpVtaFinish(
  baseUrl: string,
  accessToken: string,
  approval: TrustTask<StepUpApproveResponsePayload> & { proof?: unknown },
  fetchFn?: typeof fetch,
): Promise<StepUpVtaFinishResult> {
  const f = withFetchTimeout(fetchFn);
  const base = baseUrl.replace(/\/+$/, "");
  const res = await f(`${base}/auth/step-up/vta/finish`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      authorization: `Bearer ${accessToken}`,
    },
    body: JSON.stringify(approval),
  });
  if (!res.ok) {
    throw new Error(`vta step-up finish: failed (${res.status}): ${await res.text()}`);
  }
  const body = (await res.json()) as {
    session_id?: string;
    access_token?: string;
    access_expires_at?: number;
    refresh_token?: string;
    refresh_expires_at?: number;
  };
  if (!body.access_token || !body.session_id || !body.refresh_token) {
    throw new Error(`vta step-up finish: malformed response body: ${JSON.stringify(body)}`);
  }
  return {
    accessToken: body.access_token,
    refreshToken: body.refresh_token,
    sessionId: body.session_id,
  };
}
