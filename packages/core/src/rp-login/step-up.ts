// Step-up for a did-hosting relying party: the holder's half.
//
// Elevates an existing session to `aal2`. The relying party's console opens
// the step-up itself — it sends `auth/step-up/start/0.2` signed by the session
// key its login bound — and hands the wallet only what came back: the RP's
// signed `approve-request/0.5`, a single-use challenge bound to that session
// and its subject. The wallet verifies it, asks the human, and returns its
// signed `approve-response/0.7`. The console sends the decision and renews the
// session with its own session key.
//
//   1. verify the approve-request (signed by the RP, addressed to and naming
//      this holder, not lapsed)
//   2. the human decides, on the verified reason
//   3. sign the approve-response (`assertionMethod`, as the holder)
//
// The wallet is never given the session's access or refresh token, and sends
// nothing to the RP: a session key may never sign an approval, so the
// holder's signature over the RP's challenge is the one thing only the wallet
// can contribute.

import type { SigningIdentity } from "../siop/self-issued.js";
import { VtaClientError } from "../vta/errors.js";
import type { TrustTask } from "../vta/protocol.js";
import {
  buildStepUpApproval,
  verifyStepUpApproveRequest,
  type StepUpApproveRequest,
  type StepUpApproveResponsePayload,
} from "../vta/step-up.js";

export * from "../vta/step-up.js";

export interface RpStepUpRequestArgs {
  /** The RP's signed `approve-request/0.5`, exactly as the page received it
   *  in the RP's `auth/step-up/start/0.2` reply. Untrusted until verified. */
  approveRequest: Record<string, unknown> | undefined;
  /** The wallet's signing identity — the DID the RP session authenticated as. */
  signing: SigningIdentity;
  /** The RP's DID: the approve-request must be signed by it, and the
   *  approve-response is addressed to it. */
  rpDid: string;
  /** Executors this wallet is enrolled with; the approve-request's proven
   *  signer must be one of them. */
  enrolledExecutorDids: readonly string[];
  /** Defaults to now. Injected for tests. */
  now?: Date;
}

/** An approve-request that has passed every check in {@link verifyRpStepUpRequest}. */
export interface VerifiedStepUpRequest {
  request: StepUpApproveRequest;
  /** The proven signer of the approve-request — the RP. */
  issuer: string;
  expiresAt?: string;
}

/**
 * Verify the approve-request a page hands the wallet before anything in it is
 * used.
 *
 * Throws unless all of these hold:
 *  - it is an approve-request/0.5 whose own proof verifies, signed by an
 *    enrolled executor that is the RP itself;
 *  - it is addressed to the holder and names the holder as its subject;
 *  - it has not lapsed.
 *
 * The session it is bound to is the RP's statement, inside the RP's
 * signature: the wallet echoes it into the approve-response, and the RP
 * accepts that only for the session it bound the challenge to.
 */
export async function verifyRpStepUpRequest(
  args: RpStepUpRequestArgs,
): Promise<VerifiedStepUpRequest> {
  const verified = await verifyStepUpApproveRequest(args.approveRequest, {
    enrolledExecutorDids: args.enrolledExecutorDids,
    ...(args.now ? { now: args.now } : {}),
  });
  const refuse = (why: string): never => {
    throw new VtaClientError("e.client.parse", `step-up approve-request refused: ${why}`);
  };
  if (!verified.ok) return refuse(verified.reason);
  if (verified.issuer !== args.rpDid) {
    refuse(`issuer ${verified.issuer} is not the relying party ${args.rpDid}`);
  }
  if (args.approveRequest?.recipient !== args.signing.did) {
    refuse(`it is addressed to ${String(args.approveRequest?.recipient)}, not this wallet`);
  }
  if (verified.request.subject !== args.signing.did) {
    refuse(`it names subject ${verified.request.subject}, not ${args.signing.did}`);
  }
  return {
    request: verified.request,
    issuer: verified.issuer,
    ...(verified.expiresAt !== undefined ? { expiresAt: verified.expiresAt } : {}),
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

export interface PerformRpStepUpArgs extends RpStepUpRequestArgs {
  /**
   * Ask the human. Called ONLY after the signed approve-request verified —
   * the `reason` it receives comes from inside the signature, which is what
   * lets the prompt show it at all (spec: "consumers MUST verify the proof
   * BEFORE surfacing the reason"). Return `false` to decline: nothing is
   * signed, and the RP's pending challenge lapses on its TTL.
   */
  requestConsent: (ctx: StepUpConsentContext) => Promise<boolean>;
  /** Timing hook — called as each flow step completes. */
  onMark?: (label: string) => void;
}

export type PerformRpStepUpResult =
  | {
      ok: true;
      /** The signed approve-response/0.7, for the page to send to the RP. */
      approveResponse: TrustTask<StepUpApproveResponsePayload> & { proof?: unknown };
    }
  | {
      ok: false;
      error: string;
      /** True when the human declined the prompt (as opposed to the
       *  approve-request being refused before any prompt was shown). */
      declined: boolean;
    };

/**
 * The whole holder-side step-up, in its enforced order:
 *
 *   1. verify the page-supplied approve-request ({@link verifyRpStepUpRequest})
 *   2. `requestConsent` — the human decides on the VERIFIED reason
 *   3. only on approval: sign the approve-response
 *
 * The consent prompt deliberately sits *inside* this function, between
 * verification and signing: before it, and the human would be deciding on
 * words nobody has authenticated; after it, and the wallet would have signed
 * before anyone consented.
 */
export async function performRpStepUp(args: PerformRpStepUpArgs): Promise<PerformRpStepUpResult> {
  const mark = args.onMark ?? (() => {});

  // 1. Verify before acting on anything in it. An approve-request that does
  //    not verify, or one for another holder or relying party, is refused
  //    here, and the human never sees a prompt.
  let verified: VerifiedStepUpRequest;
  try {
    verified = await verifyRpStepUpRequest(args);
  } catch (err) {
    return { ok: false, error: (err as Error).message, declined: false };
  }
  mark("verify approve-request");

  // 2. The human decides, on fields that came from inside the signature.
  const consented = await args.requestConsent({
    issuer: verified.issuer,
    subject: verified.request.subject,
    sessionId: verified.request.sessionId,
    ...(typeof verified.request.reason === "string" ? { reason: verified.request.reason } : {}),
  });
  if (!consented) {
    return { ok: false, error: "step-up denied by user", declined: true };
  }
  mark("user consent");

  // 3. Sign the approve-response locally (holder-self-signs). Every echoed
  //    field comes from the *verified* payload.
  const approveResponse = await buildStepUpApproval({
    signing: args.signing,
    rpDid: args.rpDid,
    request: verified.request,
    approved: true,
  });
  mark("sign approval");
  return { ok: true, approveResponse };
}
