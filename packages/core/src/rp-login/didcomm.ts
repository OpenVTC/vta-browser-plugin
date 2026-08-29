// DIDComm session login to a did-hosting Relying Party.
//
// Unlike the REST SIOPv2 flow (`loginViaSiop`), there is **no `id_token`**.
// Over DIDComm the authcrypt layer (ECDH-1PU) already authenticates the
// sender DID to the recipient, so "login" is just: authcrypt an
// `authenticate` message to the RP's control DID → the RP checks its ACL on
// the authenticated sender → it returns a session JWT. The holder DID and
// ACL grant are exactly the same as the REST path.
//
// Server contract (did-hosting-control `handle_authenticate`):
//   request  type = MSG_AUTHENTICATE, authcrypted, body ignored
//   reply    type = MSG_AUTH_RESPONSE, thid = request id,
//            body = { session_id, access_token, access_expires_at,
//                     refresh_token, refresh_expires_at }
//   on ACL/other failure the reply is a problem-report (different type).

import { packAuthcrypt, packAuthcryptJson, wrapForward, type Identity } from "../didcomm/index.js";
import type { RemoteDidcommEndpoint } from "../vta/didcomm.js";
import type { DidcommMessageBridge } from "../vta/transport.js";

// The canonical Trust-Task auth URIs, matching `did-hosting-common`'s
// `MSG_AUTHENTICATE` / `MSG_AUTH_RESPONSE` verbatim. This package sent the
// retired `affinidi.com/webvh/1.0/*` pair, which the control plane's DIDComm
// router no longer binds — so the request did not route, and a reply under the
// canonical type would have been rejected here as the wrong type anyway. Login
// over DIDComm could not succeed against a current RP at all.
//
// Matched with `===` against the spelling the RP declares today; no
// both-spellings fold, per this repo's rule on compatibility arms.
const MSG_AUTHENTICATE = "https://trusttasks.org/spec/auth/authenticate/0.1";
const MSG_AUTH_RESPONSE = "https://trusttasks.org/spec/auth/authenticate/0.1#response";

const DEFAULT_TIMEOUT_MS = 30_000;

export interface DidcommLoginResult {
  accessToken: string;
  refreshToken: string;
  sessionId: string;
  accessExpiresAt: number;
  refreshExpiresAt: number;
}

export interface DidcommLoginOptions {
  /** Mediator-backed bridge that ships the JWE and surfaces the decrypted,
   *  sender-authenticated reply (keyed by `thid`). */
  bridge: DidcommMessageBridge;
  /** The wallet's holder identity (authcrypt sender; its DID is the one the
   *  RP ACL-checks). */
  holder: Identity;
  /** The RP's control DID + its keyAgreement key (authcrypt recipient). */
  service: RemoteDidcommEndpoint;
  /** The RP's mediator. When set, the message is wrapped in a
   *  routing/2.0/forward and authcrypted to the mediator. Required whenever
   *  the RP is only reachable via a mediator (the usual case). */
  mediator?: RemoteDidcommEndpoint;
  /** Reply timeout (default 30s). */
  timeoutMs?: number;
}

/**
 * Authenticate to a did-hosting RP over DIDComm and return its session
 * tokens. Throws if the RP replies with anything other than a
 * `MSG_AUTH_RESPONSE` (e.g. a problem-report when the holder DID isn't in
 * the RP's ACL).
 */
export async function loginViaDidcomm(opts: DidcommLoginOptions): Promise<DidcommLoginResult> {
  const { bridge, holder, service, mediator } = opts;
  const timeoutMs = opts.timeoutMs ?? DEFAULT_TIMEOUT_MS;

  const requestId = globalThis.crypto.randomUUID();
  const message = {
    id: requestId,
    type: MSG_AUTHENTICATE,
    from: holder.did,
    to: [service.did],
    // Empty, because the RP's DIDComm handler authenticates on the **authcrypt
    // sender** and reads nothing from the body (`run_authenticate(&state,
    // sender)`).
    //
    // Worth naming as a conformance gap rather than leaving to be discovered:
    // the canonical `auth/authenticate/0.1` schema declares `challenge` and
    // `sessionId` REQUIRED, and the RP obtains a challenge from a REST-only
    // `POST /api/auth/challenge`. So this message carries a canonical type over
    // a body that does not satisfy it — a shape the RP chose when it bound its
    // sender-authenticated handler to that URI, and which this package now
    // matches rather than diverges from. Closing it properly means the
    // challenge-based flow over a `TrustTaskSender`, the same shape
    // `vta/auth-tasks.ts` already uses against the VTA.
    body: {},
  };

  const inner = await packAuthcrypt(message, holder, [
    { kid: service.keyAgreementKid, jwk: service.keyAgreementPublicJwk },
  ]);

  let outer = inner;
  if (mediator) {
    const forwardJson = wrapForward(service.did, holder.did, mediator.did, inner);
    outer = await packAuthcryptJson(forwardJson, holder, [
      { kid: mediator.keyAgreementKid, jwk: mediator.keyAgreementPublicJwk },
    ]);
  }

  const reply = await bridge.sendAndAwaitReply(outer, requestId, { timeoutMs });

  if (reply.thid !== requestId) {
    throw new Error(`didcomm login: reply thid ${reply.thid ?? "(none)"} != request ${requestId}`);
  }
  if (reply.from !== service.did) {
    throw new Error(`didcomm login: reply from ${reply.from ?? "(none)"} != RP ${service.did}`);
  }
  if (reply.type !== MSG_AUTH_RESPONSE) {
    // Most commonly a problem-report (e.g. holder DID not in the RP's ACL).
    throw new Error(
      `didcomm login: ${reply.type ?? "(no type)"} — ${JSON.stringify(reply.body ?? {})}`,
    );
  }

  const body = (reply.body ?? {}) as {
    session_id?: string;
    access_token?: string;
    refresh_token?: string;
    access_expires_at?: number;
    refresh_expires_at?: number;
  };
  if (!body.access_token || !body.session_id || !body.refresh_token) {
    throw new Error(`didcomm login: malformed authenticate-response body: ${JSON.stringify(body)}`);
  }
  return {
    accessToken: body.access_token,
    refreshToken: body.refresh_token,
    sessionId: body.session_id,
    accessExpiresAt: body.access_expires_at ?? 0,
    refreshExpiresAt: body.refresh_expires_at ?? 0,
  };
}
