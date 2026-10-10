// Logging in to a relying party over DIDComm.
//
// The same two Trust Tasks as every other transport — `auth/challenge/0.1`,
// then a signed `auth/authenticate` — carried in the DIDComm trust-task
// envelope by a `DidcommVtaTransport` addressed to the RP. There is one login
// implementation, `loginViaTrustTask`; this module only builds the channel it
// runs over, for a caller that holds a mediator bridge and the RP's endpoint
// rather than a `VtaSession`.
//
// **What this replaced.** It used to authcrypt a bare `auth/authenticate`
// message with an empty body, and the RP issued a session to whoever the
// authcrypt layer reported as the sender. No challenge was read and no
// signature was checked. affinidi-webvh-service #213 removes that route: the
// RP now acts only on a proof carried in the document, so sign-in has to be
// the challenge → signed-authenticate pair.
//
// What the channel guarantees, so nothing here re-implements it:
//
// - **The document says who it is from.** `buildTrustTask` gives each document
//   a fresh `id` and an `issuedAt`; `issuer` is the signing DID and `recipient`
//   the RP's DID. `signOutboundTask` refuses an issuer that is not the signer,
//   and signs both documents with `proofPurpose: authentication`.
// - **The answer comes from the RP.** `DidcommVtaTransport.send` waits with
//   the bridge's `{ from }` filter set to the RP's DID (plus the mediator, whose
//   only admissible answer is a problem report refusing the hop), requires the
//   reply to be threaded to the request and sent by the RP, and verifies the
//   reply document's proof against the RP's DID.
//
// **The bare-authenticate form is kept, deprecated, for one case only:** a
// caller that passes no `signing`. Without a signing key there is nothing to
// put a proof on, so those options can only ever have meant the old message.
// It still works against an RP that serves the bare route, and an RP running
// affinidi-webvh-service #213 or later refuses it, exactly as it would refuse
// that caller today.

import { packAuthcrypt, packAuthcryptJson, wrapForward, type Identity } from "../didcomm/index.js";
import { DidcommVtaTransport, type RemoteDidcommEndpoint } from "../vta/didcomm.js";
import type { DidcommMessageBridge } from "../vta/transport.js";
import { asTaskSigner, type ChannelSigner } from "../vta/trust-task.js";
import { loginViaTrustTask } from "./trust-task.js";

// The canonical Trust-Task auth URIs of the deprecated bare form, matching
// `did-hosting-common`'s `MSG_AUTHENTICATE` / `MSG_AUTH_RESPONSE` verbatim.
// Matched with `===`; no both-spellings fold, per this repo's rule on
// compatibility arms.
import {
  TYPE_URI as MSG_AUTHENTICATE,
  RESPONSE_TYPE_URI as MSG_AUTH_RESPONSE,
} from "@openvtc/trust-tasks/auth/authenticate/0.1/payload";

const DEFAULT_TIMEOUT_MS = 30_000;

/** The session an RP issues on a DIDComm sign-in. */
export interface DidcommLoginResult {
  accessToken: string;
  /** Empty when the RP did not rotate a refresh token on login. */
  refreshToken: string;
  sessionId: string;
  /** When the access token expires, in Unix seconds. On the challenge flow it
   *  is computed from `expiresIn` when the reply arrives. */
  accessExpiresAt: number;
  /** When the refresh token expires, in Unix seconds, or `0` when the RP did
   *  not say. `auth/authenticate` does not report it, so the challenge flow
   *  always returns `0`. */
  refreshExpiresAt: number;
  /** Seconds until the access token expires, as the RP reported it. Absent
   *  only on the deprecated bare form. */
  expiresIn?: number;
  /** What the RP actually granted, which MAY be narrower than what was asked. */
  scope?: string[];
}

export interface DidcommLoginOptions {
  /** Mediator-backed bridge that ships the JWE and surfaces the decrypted,
   *  sender-authenticated reply (keyed by `thid`). */
  bridge: DidcommMessageBridge;
  /** The wallet's holder identity: the authcrypt sender. */
  holder: Identity;
  /** The RP's control DID + its keyAgreement key: the authcrypt recipient, and
   *  the documents' `recipient`. */
  service: RemoteDidcommEndpoint;
  /** The RP's mediator. When set, each message is wrapped in a
   *  routing/2.0/forward and authcrypted to the mediator. Required whenever
   *  the RP is only reachable via a mediator (the usual case). */
  mediator?: RemoteDidcommEndpoint;
  /** Per-message reply timeout (default 30s). */
  timeoutMs?: number;
  /**
   * Signs both auth documents, and should always be supplied.
   *
   * Its DID is who signs in: it is the `issuer` of the challenge request and of
   * the authenticate document, and the challenge is requested for it. It must
   * be `holder`'s DID: the RP acts on a DIDComm document only when its signer
   * is its sender, and the channel refuses the mismatch before sending. A
   * persona, whose keys stay at the VTA, signs in over REST instead.
   *
   * Optional only so that callers written before it existed still compile.
   * Omitting it is deprecated: it sends the bare `auth/authenticate`, which
   * RPs running affinidi-webvh-service #213 or later refuse.
   */
  signing?: ChannelSigner;
  /** Capability tags to request. The RP decides what it grants. Ignored by the
   *  deprecated bare form. */
  scope?: string[];
}

/**
 * Sign in to an RP over DIDComm and return the session it issues.
 *
 * With `signing`, this is `auth/challenge` then a signed `auth/authenticate`
 * over a DIDComm channel addressed to the RP, and it throws a `VtaClientError`
 * from whichever step failed (see `loginViaTrustTask` for why the two surface
 * separately). Without it, it sends the deprecated bare authenticate (see the
 * module header).
 */
export async function loginViaDidcomm(opts: DidcommLoginOptions): Promise<DidcommLoginResult> {
  if (opts.signing === undefined) return loginViaBareAuthenticate(opts);

  const signer = asTaskSigner(opts.signing);
  const channel = new DidcommVtaTransport({
    bridge: opts.bridge,
    holder: opts.holder,
    vta: opts.service,
    signing: signer,
    ...(opts.mediator ? { mediator: opts.mediator } : {}),
    ...(opts.timeoutMs !== undefined ? { timeoutMs: opts.timeoutMs } : {}),
  });
  const session = await loginViaTrustTask({
    sender: channel,
    holder: opts.holder,
    service: opts.service,
    subject: signer.did,
    ...(opts.scope && opts.scope.length > 0 ? { scope: opts.scope } : {}),
  });
  return {
    accessToken: session.accessToken,
    refreshToken: session.refreshToken ?? "",
    sessionId: session.sessionId,
    accessExpiresAt: Math.floor(Date.now() / 1000) + session.expiresIn,
    refreshExpiresAt: 0,
    expiresIn: session.expiresIn,
    ...(session.scope ? { scope: session.scope } : {}),
  };
}

/**
 * The deprecated bare form: authcrypt an `auth/authenticate` with an empty
 * body and take the session the RP issues to the authcrypt sender.
 *
 * Server contract (did-hosting-control `handle_authenticate`, before
 * affinidi-webvh-service #213):
 *   request  type = MSG_AUTHENTICATE, authcrypted, body ignored
 *   reply    type = MSG_AUTH_RESPONSE, thid = request id,
 *            body = { session_id, access_token, access_expires_at,
 *                     refresh_token, refresh_expires_at }
 *   on ACL/other failure the reply is a problem-report (different type).
 */
async function loginViaBareAuthenticate(opts: DidcommLoginOptions): Promise<DidcommLoginResult> {
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
    // That is the conformance gap the challenge flow above closes: the
    // canonical schema declares `challenge` and `sessionId` REQUIRED.
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

  // Only the RP answers a login: a reply on this thread from anyone else is
  // never handed back.
  const reply = await bridge.sendAndAwaitReply(outer, requestId, {
    timeoutMs,
    from: service.did,
  });

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
