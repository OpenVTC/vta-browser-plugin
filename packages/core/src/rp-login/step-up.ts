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
import type { SigningIdentity } from "../siop/self-issued.js";
import type { TrustTask } from "../vta/protocol.js";

// Canonical step-up approval spec from trusttasks-tf. The proof on the
// approve-response is what the RP verifies to elevate the session's acr.
const MSG_APPROVE_RESPONSE = "https://trusttasks.org/spec/auth/step-up/approve-response/0.2";

/** The RP's `approve-request/0.2` payload, returned by {@link stepUpVtaStart}. */
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
 * returns the `approve-request` fields the wallet echoes into the signed
 * approve-response.
 */
export async function stepUpVtaStart(
  baseUrl: string,
  accessToken: string,
  fetchFn?: typeof fetch,
): Promise<StepUpApproveRequest> {
  const f = fetchFn ?? fetch.bind(globalThis);
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
  const json = (await res.json()) as Partial<StepUpApproveRequest>;
  if (!json.subject || !json.sessionId || !json.challenge) {
    throw new Error(`vta step-up start: malformed response: ${JSON.stringify(json)}`);
  }
  return {
    subject: json.subject,
    sessionId: json.sessionId,
    challenge: json.challenge,
    ...(json.reason ? { reason: json.reason } : {}),
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
  const f = fetchFn ?? fetch.bind(globalThis);
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
