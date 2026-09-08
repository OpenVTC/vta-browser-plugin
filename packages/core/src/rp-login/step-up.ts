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

import type { SigningIdentity } from "../siop/self-issued.js";
import { withFetchTimeout } from "../http/timeout-fetch.js";

// The verify/sign half moved down to `vta/step-up.ts`, where `persona/`'s
// disclosure gate can reach it too — see that file's header. Re-exported here
// so this module's public surface is unchanged.
import {
  buildStepUpApproval,
  verifyStepUpApproveRequest,
  type StepUpApproveRequest,
  type StepUpApproveResponsePayload,
  type StepUpStartResponse,
} from "../vta/step-up.js";
import type { TrustTask } from "../vta/protocol.js";

export * from "../vta/step-up.js";

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

/** What the consent surface may show the human for a step-up. Every member is
 *  taken from *inside* the verified approve-request document (or is the
 *  page-supplied `rpDid` after it has been checked equal to the proven
 *  issuer) — nothing here predates verification. */
export interface StepUpConsentContext {
  /** The proven signer of the approve-request (== the page's `rpDid`). */
  issuer: string;
  /** The session subject being elevated, from the verified payload. */
  subject: string;
  /** The RP session being elevated, from the verified payload. */
  sessionId: string;
  /** The RP's human-readable reason, from the verified payload. Absent when
   *  the signed document carried none — the prompt then falls back to its
   *  origin/rpDid-only text. */
  reason?: string;
}

export interface PerformStepUpVtaArgs {
  baseUrl: string;
  accessToken: string;
  /** The wallet's signing identity — must be the DID the RP session
   *  authenticated as (it signs the approve-response). */
  signing: SigningIdentity;
  /** The RP DID the page claimed. The verified approve-request's issuer must
   *  equal it, and the approve-response is audience-bound to it. */
  rpDid: string;
  /** Executors this wallet is enrolled with; the approve-request's proven
   *  signer must be in this set. */
  enrolledExecutorDids: readonly string[];
  /**
   * Ask the human. Called ONLY after the signed approve-request verified —
   * the `reason` it receives comes from inside the signature, which is what
   * lets the prompt show it at all (spec: "consumers MUST verify the proof
   * BEFORE surfacing the reason"). Return `false` to decline: nothing is
   * signed and nothing is sent to the RP — the pending challenge simply
   * lapses server-side.
   */
  requestConsent: (ctx: StepUpConsentContext) => Promise<boolean>;
  fetchFn?: typeof fetch;
  /** Timing hook — called as each flow step completes. */
  onMark?: (label: string) => void;
  /** Defaults to now. Injected for tests. */
  now?: Date;
}

export type PerformStepUpVtaResult =
  | { ok: true; tokens: StepUpVtaFinishResult }
  | {
      ok: false;
      error: string;
      /** True when the human declined the prompt (as opposed to the
       *  approve-request being refused before any prompt was shown). */
      declined: boolean;
    };

/**
 * The whole holder-side step-up flow, in its enforced order:
 *
 *   1. RP `start` (REST) → the signed `approve-request` document
 *   2. verify it ({@link verifyStepUpApproveRequest}) + issuer == `rpDid`
 *   3. `requestConsent` — the human decides on the VERIFIED reason
 *   4. only on approval: sign the `approve-response` and `finish` (REST)
 *
 * The consent prompt deliberately sits *inside* this function, between
 * verification and signing: before it, and the human would be deciding on
 * words nobody has authenticated; after it, and the wallet would have signed
 * before anyone consented. A decline sends nothing — the RP's challenge
 * expires on its own TTL, so the prompt must be answered within the
 * challenge's validity window.
 */
export async function performStepUpVta(
  args: PerformStepUpVtaArgs,
): Promise<PerformStepUpVtaResult> {
  const mark = args.onMark ?? (() => {});
  const refuse = (error: string): PerformStepUpVtaResult => ({
    ok: false,
    error,
    declined: false,
  });

  // 1. RP start (REST) → the signed `auth/step-up/approve-request/0.2`
  //    Trust-Task document (plus legacy top-level fields for cross-checking).
  const start = await stepUpVtaStart(args.baseUrl, args.accessToken, args.fetchFn);
  mark("rp start (challenge)");

  // 2. Verify BEFORE acting on anything in it — a start response with no
  //    `document`, a bad proof, or a signer outside the enrolled-executor set
  //    is refused here, and the human never sees a prompt.
  const verified = await verifyStepUpApproveRequest(start, {
    enrolledExecutorDids: args.enrolledExecutorDids,
    ...(args.now ? { now: args.now } : {}),
  });
  if (!verified.ok) {
    return refuse(`step-up approve-request refused: ${verified.reason}`);
  }
  // The RP the page named is the audience the approve-response will be bound
  // to (`recipient: rpDid`); the approve-request's proven issuer must be that
  // same party, or the wallet would be answering a question nobody it trusts
  // asked.
  if (verified.issuer !== args.rpDid) {
    return refuse(
      `step-up approve-request refused: issuer ${verified.issuer} does not match the page-supplied rpDid`,
    );
  }
  mark("verify approve-request");

  // 3. The human decides, on fields that came from inside the signature.
  const consented = await args.requestConsent({
    issuer: verified.issuer,
    subject: verified.request.subject,
    sessionId: verified.request.sessionId,
    ...(typeof verified.request.reason === "string"
      ? { reason: verified.request.reason }
      : {}),
  });
  if (!consented) {
    // Declined = nothing leaves the wallet. No denied approve-response is
    // sent; the RP's pending challenge lapses on its TTL.
    return { ok: false, error: "step-up denied by user", declined: true };
  }
  mark("user consent");

  // 4. Sign the approve-response locally (holder-self-signs — no VTA
  //    round-trip). Every echoed field comes from the *verified* payload.
  //
  //    **0.2, and it stays 0.2 until the control plane moves.** This flow
  //    answers the did-hosting control plane, not the VTA. `recorded` is a 0.3
  //    member and the VTA is the party that learned it; sending 0.3 here would
  //    be refused as an unsupported type and would take out login elevation
  //    entirely. Nothing on this path binds an approval to a single operation,
  //    so there is nothing 0.3 would buy it either.
  const approval = await buildStepUpApproval({
    signing: args.signing,
    rpDid: args.rpDid,
    request: verified.request,
    approved: true,
    responseVersion: "0.2",
  });
  mark("sign approval");

  const tokens = await stepUpVtaFinish(
    args.baseUrl,
    args.accessToken,
    approval,
    args.fetchFn,
  );
  mark("rp finish (elevate)");
  return { ok: true, tokens };
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
