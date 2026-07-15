// The generic page → VTA task relay.
//
// A relying party proposes `(typeUri, payload)`. That is *all* it proposes. The
// device mints the envelope — `id`, `issuedAt`, `issuer`, `recipient` — inside
// its own trust boundary, stamps the browser-attested origin, and sends it under
// its own authentication.
//
// ## Why the device mints the envelope
//
// The obvious shape is for the page to hand over a complete Trust Task and for
// the wallet to sign it. That is what `vault/sign-trust-task` does, and it is
// exactly what must not happen here. Counter-signing an RP-authored envelope
// means the wallet attests to a document it did not write: the RP chooses the
// issuer, the recipient, the expiry, the id — every field the VTA will
// subsequently trust *because the wallet signed it*. The wallet becomes a
// notary for claims it never checked.
//
// So the page's input is reduced to the only two things it is entitled to
// propose: what kind of task, and with what payload. Everything that carries
// authority is written by the device.
//
// ## What this does NOT decide
//
// Nothing about whether the task is *allowed*. That is the VTA's job, and
// deliberately so — it holds the keys, it is the Policy Decision Point and the
// Policy Enforcement Point, and it is the only component in this picture that a
// compromised page or a compromised extension cannot speak for. A relay that
// tried to make authorization decisions locally would be a second, weaker copy
// of the policy engine, running in the least trustworthy place.
//
// The relay's whole job is to carry a proposal honestly and to lie about
// nothing.

import { buildTrustTask } from "./trust-task.js";
import { VtaClientError } from "./errors.js";
import type { VtaSession } from "./session.js";

/**
 * Framework `ext` key carrying the origin of the page that proposed the task.
 *
 * Written by the *device*, from the value the browser attested — never from
 * anything the page said about itself. It rides in `payload.ext` (the
 * framework's designated extension slot), which means it is inside the payload
 * digest: the origin a human is shown when they approve is bound to the payload
 * that executes, and cannot be swapped afterwards.
 */
export const ORIGIN_EXT_KEY = "openvtc.origin";

export interface RequestTaskArgs {
  /** Type URI of the task the page is proposing. */
  type: string;
  /** The page's proposed payload. Carried verbatim — the VTA validates it
   *  against the task's schema, which is closed, so nothing can ride along. */
  payload: Record<string, unknown>;
  /** This device's holder DID — the envelope's issuer. */
  holderDid: string;
  /** The VTA this device is enrolled with — the envelope's recipient. */
  vtaDid: string;
  /**
   * The origin the *browser* attributed to the proposing page.
   *
   * Not optional in spirit: a caller with no attested origin should not be
   * relaying at all. It is typed as optional only because a non-browser caller
   * (a CLI, a test) has no origin to give, and inventing one would be worse
   * than omitting it.
   */
  origin?: string;
}

/**
 * The machine-readable reason the executor gives when a human must approve.
 *
 * IMPORTANT: this is the value the VTA carries in the trust-task-error
 * *details* (`details.reason`), NOT the top-level error `code`. The VTA emits
 * the standard Trust Task error code `taskFailed` for this rejection (see the
 * `trust-tasks-rs` `ErrorPayload`/`RejectReason::TaskFailed` mapping); the
 * consent-specific reason and payload ride in `details`. Matching this token
 * against the top-level `code` — which an earlier version did — never matches,
 * and the consent flow dies silently.
 */
export const CONSENT_REQUIRED_CODE = "auth:consent_required";

/** The VTA needs a human to approve this task before it will run it. */
export interface ConsentRequired {
  kind: "consentRequired";
  /** The salted digest of the exact payload awaiting approval. A prefix of this
   *  is what the user matches against the code on their approving device. */
  payloadDigest: string;
  challenge: string;
  approverSet: string;
  minApprovals: number;
  /** The executor-signed `task-consent/request` documents. Each is addressed to
   *  one approver and carries the effects that approver must be shown. */
  consentRequests: unknown[];
}

export interface TaskAccepted<Res> {
  kind: "accepted";
  result: Res;
}

export type RequestTaskOutcome<Res> = TaskAccepted<Res> | ConsentRequired;

/**
 * Relay one proposed task to the VTA.
 *
 * **A `requireConsent` refusal is returned, not thrown.**
 *
 * It arrives as a rejected Trust Task, so every layer beneath this one treats it
 * as an error — and the natural thing to do with an error is to let it
 * propagate. That would be a catastrophe of the quiet kind: the refusal carries
 * the executor-signed consent requests an approver must render and the digest
 * the requesting surface must display for the cross-device match. Let it
 * propagate and the caller shows the user "Error: consent_required", strands
 * them at exactly the moment they were supposed to act, and the entire
 * informed-consent flow is discarded at the last hop — the one place nobody
 * would think to look for it.
 *
 * The union return type is deliberate. A caller cannot reach the result without
 * saying what it does about a refusal.
 */
export async function requestTask<Res>(
  session: VtaSession,
  args: RequestTaskArgs,
): Promise<RequestTaskOutcome<Res>> {
  const payload: Record<string, unknown> = { ...args.payload };

  if (args.origin) {
    const ext = { ...((payload.ext as Record<string, unknown> | undefined) ?? {}) };
    // The device's stamp wins. A page that set this key itself is either
    // confused or lying, and in neither case is its answer the right one.
    ext[ORIGIN_EXT_KEY] = args.origin;
    payload.ext = ext;
  }

  const envelope = buildTrustTask(args.type, payload, {
    issuer: args.holderDid,
    recipient: args.vtaDid,
  });

  try {
    return { kind: "accepted", result: await session.send<Res>(envelope) };
  } catch (e) {
    const consent = consentRequiredFrom(e);
    if (consent) return consent;
    throw e;
  }
}

/**
 * Recognise a consent refusal inside a thrown client error.
 *
 * The executor rejects with a `trust-task-error` document whose top-level
 * `code` is the standard `taskFailed` — the consent-specific signal lives in
 * the error *details*: a machine-readable `reason` of `auth:consent_required`
 * plus the salted `payloadDigest`, `challenge`, and the executor-signed
 * `consentRequests`. We key on `details.reason`, falling back to the presence
 * of `consentRequests` so this works whether or not the VTA in front of us has
 * started emitting the explicit `reason` yet.
 *
 * Getting this wrong fails silently: the refusal looks like an ordinary error
 * and the informed-consent flow dies without a sound — which is exactly what
 * happened while this matched `auth:consent_required` against the top-level
 * `code` the VTA never sets.
 */
function consentRequiredFrom(e: unknown): ConsentRequired | null {
  if (!(e instanceof VtaClientError)) return null;

  const errorPayload = e.details as
    | { code?: unknown; details?: Record<string, unknown> }
    | undefined;
  const d = errorPayload?.details ?? {};

  const reason = typeof d.reason === "string" ? d.reason : undefined;
  const isConsentRequired =
    reason === CONSENT_REQUIRED_CODE || Array.isArray(d.consentRequests);
  if (!isConsentRequired) return null;

  const payloadDigest = typeof d.payloadDigest === "string" ? d.payloadDigest : "";
  // Without a digest there is nothing for a human to match, so there is nothing
  // we can usefully hand back. Let it surface as the error it then is.
  if (!payloadDigest) return null;

  return {
    kind: "consentRequired",
    payloadDigest,
    challenge: typeof d.challenge === "string" ? d.challenge : "",
    approverSet: typeof d.approverSet === "string" ? d.approverSet : "",
    minApprovals: typeof d.minApprovals === "number" ? d.minApprovals : 1,
    consentRequests: Array.isArray(d.consentRequests) ? d.consentRequests : [],
  };
}
