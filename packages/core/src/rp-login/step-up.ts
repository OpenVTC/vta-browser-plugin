// Step-up for a did-hosting relying party, as Trust Tasks.
//
// Elevates an existing session to `aal2`. The holder asks the RP to start a
// step-up for its session; the RP answers with a signed approve-request bound
// to that session; the holder verifies it, asks the human, and answers with a
// signed approve-response; the RP elevates the session, and a refresh mints
// tokens at the new level. The wallet — not a third party — signs the approval:
// it is the holder re-proving control of the session subject over a fresh
// challenge.
//
//   1. `auth/step-up/start/0.1`            → the RP's signed approve-request/0.3
//   2. verify the reply, then the approve-request inside it
//   3. the human decides, on the verified reason
//   4. `auth/step-up/approve-response/0.5` → `elevated`
//   5. `auth/refresh/0.1`                  → tokens at the new level
//
// Every document goes to the RP's Trust Task endpoint (`{base}/trust-tasks`),
// the HTTPS binding. Each is an ordinary Trust Task, so the same documents can
// travel over any transport the RP serves them on.
//
// Every reply is checked before it is read: signed by the RP (`rpDid`), of the
// request's response type, threaded to the request, addressed back to the
// holder (`decodeTrustTaskHttpReply` with `expectedSigner` and `inReplyTo`).

import type { SigningIdentity } from "../siop/self-issued.js";
import { withFetchTimeout, isFetchTimeout, DEFAULT_FETCH_TIMEOUT_MS } from "../http/timeout-fetch.js";
import { signTrustTask } from "../trust-tasks/sign.js";
import { decodeTrustTaskHttpReply } from "../vta/rest-channel.js";
import { buildTrustTask } from "../vta/trust-task.js";
import { VtaClientError } from "../vta/errors.js";
import type { TrustTask } from "../vta/protocol.js";
import {
  RP_APPROVE_REQUEST_TYPES,
  buildStepUpApproval,
  verifyStepUpApproveRequest,
  type StepUpApproveRequest,
  type StepUpApproveResponsePayload,
} from "../vta/step-up.js";

import {
  TYPE_URI as STEP_UP_START,
  RESPONSE_TYPE_URI as STEP_UP_START_RESPONSE,
  type AuthStepUpStartPayload,
  type AuthStepUpStartResponsePayload,
} from "@openvtc/trust-tasks/auth/step-up/start/0.1/payload";
import {
  RESPONSE_TYPE_URI as APPROVE_RESPONSE_0_5_RESPONSE,
  type AuthStepUpApproveResponseRelyingPartyAck,
} from "@openvtc/trust-tasks/auth/step-up/approve-response/0.5/payload";
import {
  TYPE_URI as AUTH_REFRESH,
  RESPONSE_TYPE_URI as AUTH_REFRESH_RESPONSE,
  type AuthRefresh,
  type AuthRefreshResponsePayload,
} from "@openvtc/trust-tasks/auth/refresh/0.1/payload";

export * from "../vta/step-up.js";

/** Who the holder is talking to, and as whom. */
export interface RpStepUpParty {
  /** The RP's Trust Task base; documents are POSTed to `{baseUrl}/trust-tasks`. */
  baseUrl: string;
  /** The session's current access token. The document proof authorises; the
   *  bearer names the session the RP reads the assurance level from. */
  accessToken: string;
  /** The wallet's signing identity — the DID the RP session authenticated as. */
  signing: SigningIdentity;
  /** The RP's DID: every document is addressed to it, and every reply must be
   *  signed by it. */
  rpDid: string;
  fetchFn?: typeof fetch;
}

/** POST one signed document to the RP and return its checked reply payload. */
async function sendToRp<Res>(
  party: RpStepUpParty,
  doc: TrustTask<unknown>,
  responseType: string,
  label: string,
): Promise<Res> {
  const f = withFetchTimeout(party.fetchFn);
  const url = `${party.baseUrl.replace(/\/+$/, "")}/trust-tasks`;
  let res: Response;
  try {
    res = await f(url, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        authorization: `Bearer ${party.accessToken}`,
      },
      body: JSON.stringify(doc),
    });
  } catch (err) {
    if (isFetchTimeout(err)) {
      throw new VtaClientError(
        "e.client.timeout",
        `${label}: the relying party did not respond within ${DEFAULT_FETCH_TIMEOUT_MS / 1000}s`,
      );
    }
    throw new VtaClientError("e.client.network", (err as Error).message);
  }
  return decodeTrustTaskHttpReply<Res>(res, {
    expectedResponseType: responseType,
    operationLabel: label,
    expectedSigner: party.rpDid,
    inReplyTo: doc,
  });
}

/** Build and sign one of the holder's operational requests to the RP. */
async function operationalRequest<P>(
  party: RpStepUpParty,
  type: string,
  payload: P,
): Promise<TrustTask<P>> {
  const doc = buildTrustTask(type, payload, {
    id: `urn:uuid:${globalThis.crypto.randomUUID()}`,
    issuer: party.signing.did,
    recipient: party.rpDid,
  });
  // `authentication`: a request is the holder's own operational message. The
  // approve-response is the one attestation in this flow (`assertionMethod`).
  await signTrustTask({
    envelope: doc as unknown as Record<string, unknown> & { proof?: unknown },
    signing: party.signing,
    proofPurpose: "authentication",
  });
  return doc;
}

export interface StepUpVtaStartArgs extends RpStepUpParty {
  /** The RP session to elevate. */
  sessionId: string;
  /** Executors this wallet is enrolled with; the approve-request's proven
   *  signer must be one of them. */
  enrolledExecutorDids: readonly string[];
  /** Defaults to now. Injected for tests. */
  now?: Date;
}

/** An approve-request that has passed every check in {@link stepUpVtaStart}. */
export interface VerifiedStepUpStart {
  request: StepUpApproveRequest;
  /** The proven signer of the approve-request — the RP. */
  issuer: string;
  expiresAt?: string;
}

/**
 * Step 1 — ask the RP to start a step-up for `sessionId`, and verify what it
 * answers before anything in it is used.
 *
 * Throws unless all of these hold:
 *  - the reply is the RP's signed `start#response` to this request;
 *  - it carries an approve-request/0.3 whose own proof verifies, signed by an
 *    enrolled executor that is the RP itself;
 *  - the approve-request is addressed to the holder, names the holder as its
 *    subject, and is bound to `sessionId` — an approve-request for another
 *    session is refused, never answered.
 */
export async function stepUpVtaStart(args: StepUpVtaStartArgs): Promise<VerifiedStepUpStart> {
  const payload: AuthStepUpStartPayload = { sessionId: args.sessionId };
  const doc = await operationalRequest(args, STEP_UP_START, payload);
  const reply = await sendToRp<AuthStepUpStartResponsePayload>(
    args,
    doc,
    STEP_UP_START_RESPONSE,
    "auth/step-up/start/0.1",
  );

  const approveRequest = reply.approveRequest as unknown as Record<string, unknown> | undefined;
  const verified = await verifyStepUpApproveRequest(approveRequest, {
    enrolledExecutorDids: args.enrolledExecutorDids,
    acceptTypes: RP_APPROVE_REQUEST_TYPES,
    ...(args.now ? { now: args.now } : {}),
  });
  const refuse = (why: string): never => {
    throw new VtaClientError("e.client.parse", `step-up approve-request refused: ${why}`);
  };
  if (!verified.ok) return refuse(verified.reason);
  if (verified.issuer !== args.rpDid) {
    refuse(`issuer ${verified.issuer} is not the relying party ${args.rpDid}`);
  }
  if (approveRequest?.recipient !== args.signing.did) {
    refuse(`it is addressed to ${String(approveRequest?.recipient)}, not this wallet`);
  }
  if (verified.request.subject !== args.signing.did) {
    refuse(`it names subject ${verified.request.subject}, not ${args.signing.did}`);
  }
  if (verified.request.sessionId !== args.sessionId) {
    refuse("it is bound to a different session");
  }
  return {
    request: verified.request,
    issuer: verified.issuer,
    ...(verified.expiresAt !== undefined ? { expiresAt: verified.expiresAt } : {}),
  };
}

export interface StepUpVtaFinishResult {
  accessToken: string;
  refreshToken: string;
  sessionId: string;
}

export interface StepUpVtaFinishArgs extends RpStepUpParty {
  /** The session's refresh token, spent on `auth/refresh` once the RP has
   *  elevated the session. */
  refreshToken: string;
  /** The signed approve-response/0.5 from {@link buildStepUpApproval}. */
  approval: TrustTask<StepUpApproveResponsePayload> & { proof?: unknown };
}

/**
 * Step 3 — send the signed approve-response, then renew the session so its
 * tokens carry the new level.
 *
 * The approve-response mints nothing: the RP answers `elevated` and records the
 * new level on the session, and `auth/refresh` re-reads it. Throws unless the
 * RP answers `elevated` and the refresh returns an access token.
 */
export async function stepUpVtaFinish(args: StepUpVtaFinishArgs): Promise<StepUpVtaFinishResult> {
  const ack = await sendToRp<AuthStepUpApproveResponseRelyingPartyAck>(
    args,
    args.approval,
    APPROVE_RESPONSE_0_5_RESPONSE,
    "auth/step-up/approve-response/0.5",
  );
  if (ack.status !== "elevated") {
    throw new VtaClientError(
      "e.client.parse",
      `the relying party did not elevate the session (${ack.status}${ack.reason ? `: ${ack.reason}` : ""})`,
    );
  }

  const refresh: AuthRefresh = { refreshToken: args.refreshToken };
  const doc = await operationalRequest(args, AUTH_REFRESH, refresh);
  const renewed = await sendToRp<AuthRefreshResponsePayload>(
    args,
    doc,
    AUTH_REFRESH_RESPONSE,
    "auth/refresh/0.1",
  );
  if (typeof renewed.tokens?.accessToken !== "string" || renewed.tokens.accessToken === "") {
    throw new VtaClientError("e.client.parse", "auth/refresh/0.1: the reply carries no access token");
  }
  return {
    accessToken: renewed.tokens.accessToken,
    // A refresh that does not rotate leaves the presented token live.
    refreshToken: renewed.tokens.refreshToken ?? args.refreshToken,
    sessionId: renewed.session?.id ?? args.approval.payload.sessionId,
  };
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

export interface PerformStepUpVtaArgs extends RpStepUpParty {
  /** The session's refresh token — renewed once the session is elevated. */
  refreshToken: string;
  /** The RP session to elevate. */
  sessionId: string;
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
 *   1. `start` → the RP's signed approve-request, verified
 *      ({@link stepUpVtaStart})
 *   2. `requestConsent` — the human decides on the VERIFIED reason
 *   3. only on approval: sign the approve-response and `finish`
 *      ({@link stepUpVtaFinish})
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

  // 1. Start, and verify before acting on anything in it. A reply that is not
  //    the RP's signed answer, an approve-request that does not verify, or one
  //    for another session or subject is refused here, and the human never
  //    sees a prompt.
  let start: VerifiedStepUpStart;
  try {
    start = await stepUpVtaStart(args);
  } catch (err) {
    return { ok: false, error: (err as Error).message, declined: false };
  }
  mark("rp start (verified approve-request)");

  // 2. The human decides, on fields that came from inside the signature.
  const consented = await args.requestConsent({
    issuer: start.issuer,
    subject: start.request.subject,
    sessionId: start.request.sessionId,
    ...(typeof start.request.reason === "string" ? { reason: start.request.reason } : {}),
  });
  if (!consented) {
    // Declined = nothing leaves the wallet. No denied approve-response is
    // sent; the RP's pending challenge lapses on its TTL.
    return { ok: false, error: "step-up denied by user", declined: true };
  }
  mark("user consent");

  // 3. Sign the approve-response locally (holder-self-signs). Every echoed
  //    field comes from the *verified* payload.
  const approval = await buildStepUpApproval({
    signing: args.signing,
    rpDid: args.rpDid,
    request: start.request,
    approved: true,
    responseVersion: "0.5",
  });
  mark("sign approval");

  const tokens = await stepUpVtaFinish({ ...args, approval });
  mark("rp finish (elevate + refresh)");
  return { ok: true, tokens };
}
