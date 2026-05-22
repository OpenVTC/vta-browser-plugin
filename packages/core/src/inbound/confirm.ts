// RP→wallet confirmation protocol (Slice 2). An RP authcrypts a
// `confirm/1.0` request to the wallet's holder did:peer (routed via its
// mediator service); the wallet shows a consent prompt and authcrypts a
// `confirm-response/1.0` back. Authentication is the authcrypt envelope on
// both legs: the wallet trusts the RP because the request is authcrypted
// from the RP's DID, and the RP trusts the response because it's authcrypted
// from the holder did:peer it addressed. No extra signature needed.

import { packAuthcrypt, packAuthcryptJson, wrapForward, type Identity } from "../didcomm/index.js";
import type { RemoteDidcommEndpoint } from "../vta/didcomm.js";

export const CONFIRM_REQUEST_TYPE = "https://trusttasks.org/wallet/confirm/1.0";
export const CONFIRM_RESPONSE_TYPE = "https://trusttasks.org/wallet/confirm-response/1.0";

/** Body of an inbound confirm request (RP → wallet). */
export interface ConfirmRequest {
  /** RP-issued nonce; the wallet echoes it in the response so the RP can
   *  correlate + prevent replay. */
  challenge: string;
  /** Human-readable action the user is being asked to confirm. */
  action: string;
  /** Optional RP display name for the consent prompt. */
  rpName?: string;
}

/** A parsed, validated inbound confirm request. */
export interface ParsedConfirmRequest {
  /** The requesting RP's DID (the authcrypt sender). */
  rpDid: string;
  /** Thread id to echo on the response so the RP correlates it. */
  thid: string;
  request: ConfirmRequest;
}

/**
 * Validate a decrypted inbound DIDComm message as a `confirm/1.0` request.
 * Returns `null` if it isn't one (so an `onInbound` handler can ignore other
 * traffic). The `from` field is the authcrypt-authenticated RP DID.
 */
export function parseConfirmRequest(
  message: Record<string, unknown>,
): ParsedConfirmRequest | null {
  if (message.type !== CONFIRM_REQUEST_TYPE) return null;
  const from = typeof message.from === "string" ? message.from : null;
  if (!from) return null;
  const body = (message.body ?? {}) as Partial<ConfirmRequest>;
  if (typeof body.challenge !== "string" || typeof body.action !== "string") return null;
  const thid =
    (typeof message.thid === "string" ? message.thid : undefined) ??
    (typeof message.id === "string" ? message.id : "");
  return {
    rpDid: from,
    thid,
    request: {
      challenge: body.challenge,
      action: body.action,
      ...(typeof body.rpName === "string" ? { rpName: body.rpName } : {}),
    },
  };
}

export interface BuildConfirmResponseArgs {
  /** The wallet's holder identity (authcrypt sender of the response). */
  holder: Identity;
  /** The RP's resolved keyAgreement endpoint (authcrypt recipient). */
  rp: RemoteDidcommEndpoint;
  /** Mediator to forward through (the shared mediator for the demo). */
  mediator: RemoteDidcommEndpoint;
  /** The user's decision. */
  approved: boolean;
  /** The request's challenge, echoed back for correlation. */
  challenge: string;
  /** The request's thread id, echoed as the response `thid`. */
  thid: string;
}

/**
 * Build the outer (routing/2.0/forward) JWE for a confirm response, ready to
 * `send()` over the wallet's mediator session. Authcrypts the response to the
 * RP, then wraps it in a forward to the mediator — the same outbound shape as
 * `loginViaDidcomm`/`requestVtaApproval`.
 */
export async function buildConfirmResponse(args: BuildConfirmResponseArgs): Promise<string> {
  const message = {
    id: globalThis.crypto.randomUUID(),
    type: CONFIRM_RESPONSE_TYPE,
    from: args.holder.did,
    to: [args.rp.did],
    thid: args.thid,
    body: { approved: args.approved, challenge: args.challenge },
  };

  const inner = await packAuthcrypt(message, args.holder, [
    { kid: args.rp.keyAgreementKid, jwk: args.rp.keyAgreementPublicJwk },
  ]);
  const forwardJson = wrapForward(args.rp.did, args.holder.did, args.mediator.did, inner);
  return packAuthcryptJson(forwardJson, args.holder, [
    { kid: args.mediator.keyAgreementKid, jwk: args.mediator.keyAgreementPublicJwk },
  ]);
}
