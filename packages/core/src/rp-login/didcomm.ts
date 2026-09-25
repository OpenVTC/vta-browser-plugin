// Logging in to a relying party over DIDComm.
//
// The same two Trust Tasks as every other transport — `auth/challenge/0.1`,
// then a signed `auth/authenticate/0.1` — carried in the DIDComm trust-task
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
//   and signs `auth/authenticate` with `proofPurpose: authentication`.
// - **The answer comes from the RP.** `DidcommVtaTransport.send` waits with
//   the bridge's `{ from }` filter set to the RP's DID (plus the mediator, whose
//   only admissible answer is a problem report refusing the hop), requires the
//   reply to be threaded to the request and sent by the RP, and verifies the
//   reply document's proof against the RP's DID.

import type { Identity } from "../didcomm/index.js";
import { DidcommVtaTransport, type RemoteDidcommEndpoint } from "../vta/didcomm.js";
import type { DidcommMessageBridge } from "../vta/transport.js";
import { asTaskSigner, type ChannelSigner } from "../vta/trust-task.js";
import { loginViaTrustTask, type RpSession } from "./trust-task.js";

export interface DidcommLoginOptions {
  /** Mediator-backed bridge that ships the JWE and surfaces the decrypted,
   *  sender-authenticated reply (keyed by `thid`). */
  bridge: DidcommMessageBridge;
  /** The wallet's holder identity — the authcrypt sender. */
  holder: Identity;
  /**
   * Signs both auth documents. REQUIRED, as on every channel.
   *
   * Its DID is who signs in: it is the `issuer` of the challenge request and of
   * the authenticate document, and the challenge is requested for it. The
   * holder's own signing identity logs in as the holder; a persona's
   * `TaskSigner` logs in as the persona.
   */
  signing: ChannelSigner;
  /** The RP's DID + its keyAgreement key: the authcrypt recipient, and the
   *  documents' `recipient`. */
  service: RemoteDidcommEndpoint;
  /** The RP's mediator. When set, each message is wrapped in a
   *  routing/2.0/forward and authcrypted to the mediator. Required whenever
   *  the RP is only reachable via a mediator (the usual case). */
  mediator?: RemoteDidcommEndpoint;
  /** Capability tags to request. The RP decides what it grants. */
  scope?: string[];
  /** Per-message reply timeout (the channel's default is 30s). */
  timeoutMs?: number;
}

/**
 * Sign in to an RP over DIDComm and return the session it issues.
 *
 * Throws a `VtaClientError` from whichever step failed — see
 * `loginViaTrustTask` for why a refused challenge and a refused authenticate
 * surface separately.
 */
export async function loginViaDidcomm(opts: DidcommLoginOptions): Promise<RpSession> {
  const signer = asTaskSigner(opts.signing);
  const channel = new DidcommVtaTransport({
    bridge: opts.bridge,
    holder: opts.holder,
    vta: opts.service,
    signing: signer,
    ...(opts.mediator ? { mediator: opts.mediator } : {}),
    ...(opts.timeoutMs !== undefined ? { timeoutMs: opts.timeoutMs } : {}),
  });
  return loginViaTrustTask({
    sender: channel,
    holder: opts.holder,
    service: opts.service,
    subject: signer.did,
    ...(opts.scope && opts.scope.length > 0 ? { scope: opts.scope } : {}),
  });
}
