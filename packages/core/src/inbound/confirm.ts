// RP→wallet confirmation protocol, conformant to the published
// `confirm/{request,response}/0.1` Trust-Task specs (trusttasks-tf).
//
// An RP authcrypts a `confirm/request` to the wallet's holder DID (routed via
// its mediator); the wallet shows a consent prompt and authcrypts a
// `confirm/response` back. Both legs ride the framework DIDComm binding
// (`https://trusttasks.org/binding/didcomm/0.1/envelope`): the DIDComm message
// `type` is always {@link TRUST_TASK_ENVELOPE_TYPE} and its `body` is a full
// `TrustTask` document whose own `type` selects the operation — the same shape
// the wallet already uses for VTA passkey-VM trust-tasks (see
// `../vta/protocol.ts`).
//
// Authentication is two-layered. The authcrypt envelope authenticates the
// transport hop (the wallet trusts the RP because the request is authcrypted
// from the RP's DID; the RP trusts the response's origin because it's
// authcrypted from the holder DID it addressed). On top of that, the
// `confirm/response` carries a W3C Data Integrity `proof` — per the spec the
// proof *is* the consent record: it binds the user's `decision` over the
// `challenge` to a key the subject controls, so the RP can retain it as
// audit-grade evidence independent of the transport.

import { packAuthcrypt, packAuthcryptJson, wrapForward, type Identity } from "../didcomm/index.js";
import type { RemoteDidcommEndpoint } from "../vta/didcomm.js";
import { TRUST_TASK_ENVELOPE_TYPE, type TrustTask } from "../vta/protocol.js";
import { signTrustTask } from "../trust-tasks/sign.js";
import type { SigningIdentity } from "../siop/self-issued.js";

// Canonical RP→wallet consent specs from trusttasks-tf; payload shapes at
// https://trusttasks.org/spec/confirm/request/0.1 and /response/0.1.
export const CONFIRM_REQUEST_TYPE = "https://trusttasks.org/spec/confirm/request/0.1";
export const CONFIRM_RESPONSE_TYPE = "https://trusttasks.org/spec/confirm/response/0.1";

/** Payload of an inbound `confirm/request/0.1` (RP → wallet). */
export interface ConfirmRequestPayload {
  /** The VID whose consent the RP is asking for. The wallet MUST verify it
   *  speaks for this subject. */
  subject: string;
  /** RP-issued nonce (base64url, ≥128 bits). Echoed and signed in the
   *  response so the RP can correlate and prevent replay. */
  challenge: string;
  /** Human-readable action description, shown to the user verbatim. */
  reason: string;
  /** Optional machine-readable action category (e.g. `payment.transfer`). */
  actionType?: string;
  /** Optional structured action detail the wallet MAY surface. */
  actionDetails?: Record<string, unknown>;
  /** Advisory seconds within which the RP expects a response. */
  ttl?: number;
}

/** Payload of the `confirm/response/0.1` the wallet returns. */
export interface ConfirmResponsePayload {
  /** Echoed from the request. */
  subject: string;
  /** Echoed from the request. */
  challenge: string;
  /** The user's signed decision. */
  decision: "approved" | "denied";
  /** Required by the spec when `decision` is `denied`. */
  deniedReason?: string;
}

/** A parsed, validated inbound `confirm/request`. */
export interface ParsedConfirmRequest {
  /** The requesting RP's DID (the authcrypt sender, cross-checked against the
   *  document `issuer` when present). */
  rpDid: string;
  /** Thread id to echo on the response so the RP correlates it. */
  thid: string;
  request: ConfirmRequestPayload;
}

/**
 * Validate a decrypted inbound DIDComm message as a `confirm/request/0.1`
 * document carried over the Trust-Task DIDComm binding. Returns `null` if it
 * isn't one (so an `onInbound` handler can ignore other traffic). The `from`
 * field is the authcrypt-authenticated RP DID.
 */
export function parseConfirmRequest(
  message: Record<string, unknown>,
): ParsedConfirmRequest | null {
  if (message.type !== TRUST_TASK_ENVELOPE_TYPE) return null;
  const from = typeof message.from === "string" ? message.from : null;
  if (!from) return null;

  const doc = (message.body ?? {}) as Partial<TrustTask<Partial<ConfirmRequestPayload>>>;
  if (doc.type !== CONFIRM_REQUEST_TYPE) return null;
  // In-band issuer, when present, must match the transport sender (SPEC §4.8.1
  // — the in-band identity is authoritative and the transport is a cross-check;
  // a mismatch is a validation failure).
  if (typeof doc.issuer === "string" && doc.issuer !== from) return null;

  const payload = (doc.payload ?? {}) as Partial<ConfirmRequestPayload>;
  if (
    typeof payload.subject !== "string" ||
    typeof payload.challenge !== "string" ||
    typeof payload.reason !== "string"
  ) {
    return null;
  }

  const thid =
    (typeof message.thid === "string" ? message.thid : undefined) ??
    (typeof doc.threadId === "string" ? doc.threadId : undefined) ??
    (typeof doc.id === "string" ? doc.id : undefined) ??
    (typeof message.id === "string" ? message.id : "");

  return {
    rpDid: from,
    thid,
    request: {
      subject: payload.subject,
      challenge: payload.challenge,
      reason: payload.reason,
      ...(typeof payload.actionType === "string" ? { actionType: payload.actionType } : {}),
      ...(payload.actionDetails && typeof payload.actionDetails === "object"
        ? { actionDetails: payload.actionDetails as Record<string, unknown> }
        : {}),
      ...(typeof payload.ttl === "number" ? { ttl: payload.ttl } : {}),
    },
  };
}

export interface BuildConfirmResponseArgs {
  /** The wallet's holder identity (authcrypt sender of the response). */
  holder: Identity;
  /** The wallet's Ed25519 signing identity — signs the Data Integrity proof.
   *  Its `did` is the response `subject`/`issuer` and its `kid` the proof's
   *  `verificationMethod`. */
  signing: SigningIdentity;
  /** The RP's resolved keyAgreement endpoint (authcrypt recipient). */
  rp: RemoteDidcommEndpoint;
  /** Mediator to forward through (the shared mediator for the demo). */
  mediator: RemoteDidcommEndpoint;
  /** The user's decision. */
  approved: boolean;
  /** The request's challenge, echoed back for correlation + binding. */
  challenge: string;
  /** The request's `subject`, echoed back verbatim. */
  subject: string;
  /** The request's thread id, echoed as the response `thid`. */
  thid: string;
  /** Human-readable rationale, attached when the user denies. */
  deniedReason?: string;
}

/**
 * Assemble and sign the `confirm/response/0.1` Trust-Task document. The proof
 * IS the consent record: the document is signed with the subject's key
 * (`proofPurpose: assertionMethod`) so the RP can retain it as audit-grade
 * evidence of the user's decision, independent of the transport. Split out
 * from {@link buildConfirmResponse} so it's directly unit-testable (the packed
 * form is a double-authcrypted JWE that can't be inspected without the RP and
 * mediator private keys).
 */
export async function buildConfirmResponseDocument(
  args: Pick<BuildConfirmResponseArgs, "signing" | "rp" | "approved" | "challenge" | "subject" | "thid" | "deniedReason">,
): Promise<TrustTask<ConfirmResponsePayload> & { proof?: unknown }> {
  const decision: "approved" | "denied" = args.approved ? "approved" : "denied";
  const payload: ConfirmResponsePayload = {
    subject: args.subject,
    challenge: args.challenge,
    decision,
    ...(decision === "denied" && args.deniedReason ? { deniedReason: args.deniedReason } : {}),
  };

  const document: TrustTask<ConfirmResponsePayload> & { proof?: unknown } = {
    id: globalThis.crypto.randomUUID(),
    type: CONFIRM_RESPONSE_TYPE,
    issuer: args.signing.did,
    recipient: args.rp.did,
    threadId: args.thid,
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

/**
 * Build the outer (routing/2.0/forward) JWE for a `confirm/response/0.1`,
 * ready to `send()` over the wallet's mediator session. Wraps the signed
 * Trust-Task document in the DIDComm binding envelope, authcrypts it to the
 * RP, then wraps that in a forward to the mediator — the same outbound shape
 * as `loginViaDidcomm`/`requestVtaApproval`.
 */
export async function buildConfirmResponse(args: BuildConfirmResponseArgs): Promise<string> {
  const document = await buildConfirmResponseDocument(args);

  const message = {
    id: document.id,
    type: TRUST_TASK_ENVELOPE_TYPE,
    from: args.holder.did,
    to: [args.rp.did],
    thid: args.thid,
    body: document,
  };

  const inner = await packAuthcrypt(message, args.holder, [
    { kid: args.rp.keyAgreementKid, jwk: args.rp.keyAgreementPublicJwk },
  ]);
  const forwardJson = wrapForward(args.rp.did, args.holder.did, args.mediator.did, inner);
  return packAuthcryptJson(forwardJson, args.holder, [
    { kid: args.mediator.keyAgreementKid, jwk: args.mediator.keyAgreementPublicJwk },
  ]);
}
