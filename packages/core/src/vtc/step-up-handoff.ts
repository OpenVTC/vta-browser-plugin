// The reader's half of the `step-up` trigger-link flow (VTI-LNK-125 – 131).
//
// A party acting for the person with a key they delegated — an assistant, say
// — is refused a gated act by a community with the step-up inline and a
// single-use handle beside it. It shows the person a `step-up` link. This
// module is what the wallet does with that link once it has decided the
// community is one it holds an identity at:
//
//   1. `buildStepUpShow`: `auth/step-up/requests/show/0.1`, from a key made
//      for this exchange, carrying the handle as `handle` and as
//      `parentThreadId` (VTI-LNK-054, 129). `sendOob` signs and posts it and
//      checks the reply is the community's.
//   2. `checkStepUpShown`: the reply's `request` is a document in its own
//      right — signed by the community, addressed to the step-up's subject,
//      unexpired — and its `boundTo` is recomputed from the returned operation
//      and the request's challenge (VTI-LNK-130, VTI-APV-015). Nothing the
//      party that made the link said is taken; it never reaches the wallet.
//   3. `buildStepUpAnswer`: the approve-response the subject signs, carrying
//      the approver's statement, sent to the community directly and never
//      back through the link's producer (VTI-LNK-131).

import { vtcStepUpBoundTo } from "../trust-tasks/domain-digest.js";
import type { SigningIdentity } from "../siop/self-issued.js";
import {
  TYPE_URI as REQUESTS_SHOW,
  type Payload as ShowPayload,
  type Response as ShowResponse,
} from "../specs/auth/step-up/requests/show/0.1/payload.js";
import { TYPE_URI as APPROVE_REQUEST } from "../specs/auth/step-up/approve-request/0.5/payload.js";
import { TYPE_URI as APPROVE_RESPONSE } from "../specs/auth/step-up/approve-response/0.7/payload.js";
import { assertSignedByCommunity, OobReplyInvalidError, type OobDocument } from "./oob-sign-in.js";

export { REQUESTS_SHOW as STEP_UP_REQUESTS_SHOW_TYPE, APPROVE_RESPONSE as STEP_UP_APPROVE_RESPONSE_TYPE };

/** A step-up the community's reply did not bear out, by the reason the flow
 *  stops with (VTI-LNK-130). */
export class StepUpHandoffError extends Error {
  constructor(
    readonly reason: "binding-mismatch" | "not-the-subject",
    message: string,
  ) {
    super(message);
    this.name = "StepUpHandoffError";
  }
}

function envelope<P>(type: string, issuer: string, recipient: string, payload: P): OobDocument<P> {
  return {
    id: globalThis.crypto.randomUUID(),
    type,
    issuer,
    recipient,
    issuedAt: new Date().toISOString(),
    payload,
  };
}

/** `auth/step-up/requests/show/0.1`: issuer the exchange's own key, recipient
 *  the community, the handle as `payload.handle` and as `parentThreadId`. */
export function buildStepUpShow(
  kA: SigningIdentity,
  vtcDid: string,
  handle: string,
): OobDocument<ShowPayload> {
  return { ...envelope<ShowPayload>(REQUESTS_SHOW, kA.did, vtcDid, { handle }), parentThreadId: handle };
}

/** A step-up, read and checked. */
export interface ShownStepUp {
  /** The step-up's subject: the identity the operation acts as. */
  subject: string;
  /** The approve-request payload, as the community signed it. */
  request: Record<string, unknown> & { subject: string; challenge: string; boundTo: string };
  /** The operation, exactly as the community received it. */
  operation: { type: string; payload: Record<string, unknown> };
  /** When the request stops being answerable (epoch ms). */
  expiresAt: number;
}

export interface StepUpShownExpectations {
  vtcDid: string;
  /** The community's verified DID document, the one the reply was checked
   *  against. */
  vtcDocument: Record<string, unknown>;
  /** Epoch milliseconds. */
  now: number;
}

/**
 * Check the reply to `requests/show` (VTI-LNK-130). The `request` must be an
 * `approve-request/0.5` document the community signed (`authentication`, an
 * operational proof), addressed to the step-up's subject and unexpired; the
 * binding recomputed from the returned operation and its challenge must be
 * the request's `boundTo`, or the flow stops `binding-mismatch`. Malformed
 * replies throw {@link OobReplyInvalidError}.
 */
export async function checkStepUpShown(
  reply: ShowResponse,
  want: StepUpShownExpectations,
): Promise<ShownStepUp> {
  const bad = (what: string): never => {
    throw new OobReplyInvalidError(`step-up request: ${what}`);
  };
  const doc = reply?.request as unknown as OobDocument<Record<string, unknown>> | undefined;
  if (!doc || typeof doc !== "object") bad("no request");
  if (doc!.type !== APPROVE_REQUEST) bad(`a ${String(doc!.type)}, not an approve-request`);
  if (doc!.issuer !== want.vtcDid) bad("not issued by the community");
  await assertSignedByCommunity(doc!, want.vtcDid, want.vtcDocument, "step-up request", "authentication");
  const p = doc!.payload;
  if (!p || typeof p !== "object") bad("no payload");
  const subject = p.subject;
  const challenge = p.challenge;
  const boundTo = p.boundTo;
  if (typeof subject !== "string" || typeof challenge !== "string" || typeof boundTo !== "string") {
    bad("no subject, challenge or binding");
  }
  if (doc!.recipient !== subject) bad("not addressed to its subject");
  const expiresAt = typeof doc!.expiresAt === "string" ? Date.parse(doc!.expiresAt) : Number.NaN;
  if (!Number.isFinite(expiresAt)) bad("no expiry");
  if (expiresAt <= want.now) bad("expired");
  const op = reply.operation;
  if (!op || typeof op.type !== "string" || !op.payload || typeof op.payload !== "object") {
    bad("no operation");
  }
  const recomputed = await vtcStepUpBoundTo(op.type, op.payload, challenge as string);
  if (recomputed !== boundTo) {
    throw new StepUpHandoffError(
      "binding-mismatch",
      "the step-up is not bound to the operation the community returned",
    );
  }
  return {
    subject: subject as string,
    request: p as ShownStepUp["request"],
    operation: { type: op.type, payload: op.payload as Record<string, unknown> },
    expiresAt,
  };
}

/** The approve-response the subject signs: approved, with the approver's
 *  statement as evidence (approve-response 0.7). Unsigned; the person's agent
 *  signs it as the subject. */
export function buildStepUpAnswer(
  vtcDid: string,
  shown: ShownStepUp,
  statement: Record<string, unknown>,
): OobDocument {
  return envelope(APPROVE_RESPONSE, shown.subject, vtcDid, {
    subject: shown.subject,
    challenge: shown.request.challenge,
    decision: "approved",
    evidence: { kind: "approverSigned", statement },
  });
}
