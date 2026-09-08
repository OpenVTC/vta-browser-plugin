// `release: stepUp` — the disclosure the holder has to approve afresh, every
// time.
//
// A claim type whose registry entry says `release: stepUp` (`payment.*`,
// `gov.*`) cannot leave on the two-call preview gate alone. The agent refuses
// `persona/disclosure/present` and hands back a signed approve-request; the
// holder authenticates freshly; the same preview is presented again and goes
// through.
//
// ## The binding is to the preview, and that is the whole point
//
// `CLAIM-TYPES.md` §3.2: the approval is bound to *that* preview, never to the
// session. Bound to the session, "each time" would mean "once per login",
// which is the failure the requirement exists to prevent. So this module never
// treats an elevated session as evidence of anything — a refusal is answered
// by approving, and by approving nothing else.
//
// ## The refusal is returned, not thrown
//
// Modelled on `vta/request-task.ts`'s `ConsentRequired`, and for the reason
// written there: a refusal that carries what the holder must act on is the
// worst possible thing to let propagate as an error. The caller shows
// "Error: stepUpRequired", strands the holder at the moment they were supposed
// to act, and the retry the agent explicitly offered is discarded at the last
// hop.
//
// The union return type is deliberate: a caller cannot reach the disclosure
// without saying what it does about the refusal. This landed **before** any
// surface drove a disclosure, which is the cheap moment to do it — after N
// callers exist it is a breaking change to each of them.
//
// ## One asymmetry worth knowing
//
// `ConsentRequired` is matched on `details.reason`, because the VTA rejects it
// with the standard `taskFailed` and the specific token rides in the details.
// **This one is matched on the top-level `code`**, because
// `persona/disclosure/present/1.0` declares its own extended code and the
// agent emits it there. Looking in `details` for this — the habit the
// neighbouring module teaches — finds nothing, and the flow dies silently.

import { VtaClientError } from "../vta/errors.js";
import {
  buildStepUpApproval,
  verifyStepUpApproveRequest,
  type StepUpApproveRequest,
} from "../vta/step-up.js";
import type { SigningIdentity } from "../siop/self-issued.js";
import type { TrustTask } from "../vta/protocol.js";

/**
 * The extended error code `persona/disclosure/present/1.0` rule 6 declares.
 *
 * A **top-level** `code`, not a `details.reason` — see the module header.
 */
export const DISCLOSURE_STEP_UP_REQUIRED_CODE = "persona/disclosure/present:stepUpRequired";

/** The reverse-DNS `ext` key the agent carries the disclosure's context under. */
const AUTHZ_CONTEXT_EXT_KEY = "org.openvtc.authorization-context";

/**
 * The `type` a disclosure's authorization context declares.
 *
 * Contexts are a shared channel — a Cierge share ask travels under the same
 * `ext` key — and `type` is how a renderer tells them apart. Checking it here
 * means a context for some *other* operation cannot be read as a disclosure
 * and shown with a disclosure's words.
 */
const DISCLOSURE_AUTHZ_CONTEXT_TYPE = "https://openvtc.org/persona/authorization-context/0.1";

/**
 * The `action.kind` a disclosure carries.
 *
 * Checked as well as `type`, because they answer different questions. `type`
 * says which *producer's* vocabulary the context speaks; `kind` says which
 * action within it. The persona context type carries only `disclose` today, so
 * this rejects nothing yet — it is here for the second `kind` added under this
 * type, which would otherwise be read as a disclosure, have its fields mined
 * for `claimTypes` it never had, and be shown to the holder in a disclosure's
 * words. Naming `kind` as the discriminator and then not checking it is how
 * that arrives unnoticed.
 */
const DISCLOSURE_ACTION_KIND = "disclose";

/** The agent needs a fresh approval before it will release this preview. */
export interface DisclosureStepUpRequired {
  kind: "stepUpRequired";
  /**
   * The preview that was refused. **Still valid** — the agent does not consume
   * a preview it refused for want of an approval, so this is the id to present
   * again once the approval is obtained, not a spent one.
   */
  previewId: string;
  /**
   * Whether the agent said so explicitly. A `false` here means an agent that
   * refused without promising the preview survived; treat the retry as
   * uncertain rather than assuming it.
   */
  previewRetained: boolean;
  /**
   * The agent-signed `auth/step-up/approve-request` document, **unverified**.
   *
   * Named for what it is. Nothing in it may be shown to a human or signed over
   * until {@link verifyDisclosureStepUp} has passed — the spec rule is that a
   * consumer verifies the proof *before* surfacing the reason, and here the
   * reason includes the list of attributes about to leave.
   */
  unverifiedApproveRequest: Record<string, unknown>;
}

/** What the agent says this approval would release. Read only from the
 *  verified document — the unsigned half of the refusal carries no authority. */
export interface DisclosureApprovalContext {
  /** The agent's one-line account of the act — the same string it put in the
   *  request's `reason`, so a surface may show either without them differing. */
  summary?: string;
  /** Who would receive it. */
  verifierDid?: string;
  /** The claim types that would leave. */
  claimTypes: readonly string[];
  /** The verifier's stated reason, when they gave one. */
  purpose?: string;
}

export type VerifyDisclosureStepUpResult =
  | {
      ok: true;
      /** Built only from the verified payload. */
      request: StepUpApproveRequest;
      /** What to show the holder. Verified, so safe to render. */
      context: DisclosureApprovalContext;
      /** The proven signer. */
      issuer: string;
    }
  | { ok: false; reason: string };

/**
 * Recognise a step-up refusal inside a thrown client error.
 *
 * Returns `null` for anything else, so a caller keeps its ordinary error path.
 * Deliberately strict about the two things the retry depends on: without a
 * `previewId` there is nothing to present again, and without an approve-request
 * there is nothing for the holder to approve — in either case this is an error
 * like any other and is better surfaced as one than half-handled.
 */
export function disclosureStepUpRequiredFrom(e: unknown): DisclosureStepUpRequired | null {
  if (!(e instanceof VtaClientError)) return null;

  const body = e.details as
    | { code?: unknown; details?: Record<string, unknown> }
    | undefined;
  if (body?.code !== DISCLOSURE_STEP_UP_REQUIRED_CODE) return null;

  const d = body.details ?? {};
  const previewId = typeof d.previewId === "string" ? d.previewId : "";
  const req = d.approveRequest;
  if (!previewId || !req || typeof req !== "object") return null;

  return {
    kind: "stepUpRequired",
    previewId,
    previewRetained: d.previewRetained === true,
    unverifiedApproveRequest: req as Record<string, unknown>,
  };
}

export interface VerifyDisclosureStepUpOptions {
  /** The executors this wallet is enrolled with — its agent's DID. The
   *  approve-request's proven signer must be one of them. */
  enrolledExecutorDids: readonly string[];
  /** Defaults to now. Injected for tests. */
  now?: Date;
}

/**
 * Verify the approve-request before any of it reaches a human.
 *
 * Delegates the signature, issuer and enrolment checks to
 * {@link verifyStepUpApproveRequest}, then adds the one check that is specific
 * to a disclosure: **the `previewId` inside the signature must be the one the
 * refusal named.** The refusal's copy is unsigned. Approving against the
 * unsigned one would mean the holder read a prompt describing one disclosure
 * and authorised whichever the signed document actually named.
 */
export async function verifyDisclosureStepUp(
  refusal: DisclosureStepUpRequired,
  opts: VerifyDisclosureStepUpOptions,
): Promise<VerifyDisclosureStepUpResult> {
  const verified = await verifyStepUpApproveRequest(
    { document: refusal.unverifiedApproveRequest },
    opts,
  );
  if (!verified.ok) return verified;

  const payload = (refusal.unverifiedApproveRequest.payload ?? {}) as {
    ext?: Record<string, unknown>;
  };
  const ctx = (payload.ext?.[AUTHZ_CONTEXT_EXT_KEY] ?? {}) as Record<string, unknown>;

  if (ctx.type !== DISCLOSURE_AUTHZ_CONTEXT_TYPE) {
    return {
      ok: false,
      reason: `authorization context is ${String(ctx.type)}, not a disclosure`,
    };
  }

  // The specifics live under `action`, keyed by `kind` — the shape every
  // authorization context uses, so one renderer serves all of them.
  const action = (ctx.action ?? {}) as Record<string, unknown>;

  if (action.kind !== DISCLOSURE_ACTION_KIND) {
    return {
      ok: false,
      reason: `authorization context action is ${String(action.kind)}, not a disclosure`,
    };
  }

  if (action.previewId !== refusal.previewId) {
    return {
      ok: false,
      reason:
        "the signed approve-request names a different preview than the refusal did — " +
        "refusing rather than approving a disclosure the holder was not shown",
    };
  }

  const claimTypes = Array.isArray(action.claimTypes)
    ? action.claimTypes.filter((t): t is string => typeof t === "string")
    : [];

  return {
    ok: true,
    request: verified.request,
    issuer: verified.issuer,
    context: {
      claimTypes,
      ...(typeof ctx.summary === "string" ? { summary: ctx.summary } : {}),
      ...(typeof action.verifierDid === "string" ? { verifierDid: action.verifierDid } : {}),
      ...(typeof action.purpose === "string" ? { purpose: action.purpose } : {}),
    },
  };
}

/**
 * Sign the holder's answer to a disclosure step-up.
 *
 * Thin over {@link buildStepUpApproval} — same document, same proof — and here
 * only so a caller handling a disclosure never has to reach into `rp-login/`
 * for it. `request` must come from {@link verifyDisclosureStepUp}, never from
 * the refusal directly.
 *
 * **Minted as `0.3`, which is the whole point of this call existing.** The
 * approval is bound to one `previewId`, so the honest acknowledgement is
 * `recorded` — applied to that disclosure, elevating nothing. An approval sent
 * as 0.2 is answered `elevated`, and the session then satisfies unrelated
 * step-up gates for its window on the strength of a decision the holder made
 * about a card number.
 *
 * The agent has accepted 0.3 since VTI #1316; it had to, before this could
 * send it. Nothing else in this wallet mints 0.3 — `rp-login` answers a
 * different relying party and stays on 0.2.
 */
export async function approveDisclosureStepUp(args: {
  signing: SigningIdentity;
  /** The agent's DID — bound in-band as `recipient`. */
  agentDid: string;
  request: StepUpApproveRequest;
  approved: boolean;
  deniedReason?: string;
}): Promise<TrustTask<unknown> & { proof?: unknown }> {
  return buildStepUpApproval({
    signing: args.signing,
    rpDid: args.agentDid,
    request: args.request,
    approved: args.approved,
    responseVersion: "0.3",
    ...(args.deniedReason !== undefined ? { deniedReason: args.deniedReason } : {}),
  });
}
