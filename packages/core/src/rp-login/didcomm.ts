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
// **The bare-authenticate form is gone.** A caller without `signing` used to
// get the old message; no RP serves it — did-hosting-control refuses
// `auth/authenticate/0.1` by name as a retired bare-message form — so
// `signing` is required and there is one login.

import type { Identity } from "../didcomm/index.js";
import { DidcommVtaTransport, type RemoteDidcommEndpoint } from "../vta/didcomm.js";
import type { DidcommMessageBridge } from "../vta/transport.js";
import { asTaskSigner, type ChannelSigner } from "../vta/trust-task.js";
import { loginViaTrustTask } from "./trust-task.js";

/** The session an RP issues on a DIDComm sign-in. */
export interface DidcommLoginResult {
  accessToken: string;
  /** Empty when the RP did not rotate a refresh token on login. */
  refreshToken: string;
  sessionId: string;
  /** When the access token expires, in Unix seconds, computed from
   *  `expiresIn` when the reply arrives. */
  accessExpiresAt: number;
  /** When the refresh token expires, in Unix seconds, or `0` when the RP did
   *  not say. `auth/authenticate` does not report it, so this is always `0`. */
  refreshExpiresAt: number;
  /** Seconds until the access token expires, as the RP reported it. */
  expiresIn: number;
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
   * Signs both auth documents. Required: the RP acts only on a proof inside
   * the document, so there is nothing to sign in with without it.
   *
   * Its DID is who signs in: it is the `issuer` of the challenge request and of
   * the authenticate document, and the challenge is requested for it. It must
   * be `holder`'s DID: the RP acts on a DIDComm document only when its signer
   * is its sender, and the channel refuses the mismatch before sending. A
   * persona, whose keys stay at the VTA, signs in over REST instead.
   */
  signing: ChannelSigner;
  /** Capability tags to request. The RP decides what it grants. */
  scope?: string[];
}

/**
 * Sign in to an RP over DIDComm and return the session it issues.
 *
 * This is `auth/challenge` then a signed `auth/authenticate` over a DIDComm
 * channel addressed to the RP, and it throws a `VtaClientError` from whichever
 * step failed (see `loginViaTrustTask` for why the two surface separately).
 */
export async function loginViaDidcomm(opts: DidcommLoginOptions): Promise<DidcommLoginResult> {
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
