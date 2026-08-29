// Logging in to a relying party as an ordinary pair of Trust Tasks.
//
// `auth/challenge/0.1` then `auth/authenticate/0.1`, over any
// `TrustTaskSender` — so a login runs on whichever transport the RP advertises,
// priority TSP > DIDComm > REST, exactly as every VTA operation has since #79.
//
// **What this replaces.** `didcomm.ts` sends a bespoke DIDComm message and the
// RP authenticates on the authcrypt sender, reading nothing from the body. That
// works, but it is a different rule than the RP applies over HTTPS, it exists
// only on one transport, and it makes the `challenge` the canonical task
// declares REQUIRED into a field nobody checks. A challenge that is never
// checked is not a weaker guarantee than one that is — it is no guarantee, and
// the difference is invisible from the client.
//
// **The proof is the authentication.** The channel signs every outbound
// document (`signOutboundTask`, SPEC §7.2 item 7a) and the RP establishes the
// caller from that signature. Possession of a challenge proves nothing on its
// own; possession plus a signature over a document carrying it proves control
// of the VID. That is what makes this identical over three transports rather
// than three rules — the guarantee rides with the document, not the pipe.
//
// Requires an RP that dispatches the auth family as Trust Tasks
// (affinidi-webvh-service #171). Against one that does not, the challenge comes
// back `unsupportedType` and the caller can fall back to `loginViaDidcomm`.

import type { SigningIdentity } from "../siop/self-issued.js";
import { authenticateSession, requestAuthChallenge } from "../vta/auth-tasks.js";
import type { TrustTaskSender } from "../vta/channel.js";
import type { Identity } from "../didcomm/index.js";
import type { RemoteDidcommEndpoint } from "../vta/didcomm.js";

/** The session an RP issues on a successful login. */
export interface RpSession {
  accessToken: string;
  /** Absent when the RP does not rotate refresh tokens on login. */
  refreshToken?: string;
  sessionId: string;
  /** Seconds until the access token expires, as the RP reported it. */
  expiresIn: number;
  /** What the RP actually granted — MAY be narrower than what was asked. */
  scope?: string[];
}

export interface TrustTaskLoginOptions {
  /** Any transport that can carry a Trust Task to the RP. A `VtaSession`
   *  built against the RP's control DID gives the full chain. */
  sender: TrustTaskSender;
  /** The wallet's holder identity — the envelope `issuer`, and the VID the
   *  RP's ACL is checked against. */
  holder: Identity;
  /** Signs the documents. Its DID MUST be the holder's: the proof is what
   *  authenticates, so a signature by anything else authenticates nobody. */
  signing: SigningIdentity;
  /** The RP's control DID + keyAgreement — the envelope `recipient`. */
  service: RemoteDidcommEndpoint;
  /** Capability tags to request. The RP decides what it grants. */
  scope?: string[];
}

/**
 * Log in to a relying party: ask for a challenge, spend it, return the session.
 *
 * Throws a `VtaClientError` from whichever step failed. The two are not
 * collapsed into one error: a refused *challenge* means the RP will not talk to
 * this DID at all (no ACL entry, rate limited), while a refused *authenticate*
 * means the challenge was rejected — expired, replayed, or bound to a different
 * subject. Those want different things from a caller, so they surface
 * differently.
 */
export async function loginViaTrustTask(
  opts: TrustTaskLoginOptions,
): Promise<RpSession> {
  const { sender, holder, service } = opts;

  if (opts.signing.did !== holder.did) {
    // Refused here rather than at the RP, because the failure the RP returns
    // for this is `permissionDenied` with no hint that the cause is local.
    throw new Error(
      `rp-login: signing identity ${opts.signing.did} is not the holder ${holder.did}; ` +
        "the document proof is what authenticates, so it must be the holder's",
    );
  }

  const challenge = await requestAuthChallenge(sender, {
    holder,
    service,
    // The RP binds the challenge to the identity it verified, so naming a
    // subject here cannot widen anything — it is a statement of intent that
    // lets the RP refuse early if it disagrees.
    subject: holder.did,
    purpose: "login",
  });

  const authed = await authenticateSession(sender, {
    holder,
    service,
    challenge: challenge.challenge,
    sessionId: challenge.sessionId,
    ...(opts.scope && opts.scope.length > 0 ? { scope: opts.scope } : {}),
  });

  const tokens = authed.tokens;
  return {
    accessToken: tokens.accessToken,
    ...(tokens.refreshToken ? { refreshToken: tokens.refreshToken } : {}),
    sessionId: challenge.sessionId,
    expiresIn: tokens.expiresIn,
    ...(tokens.scope && tokens.scope.length > 0 ? { scope: tokens.scope } : {}),
  };
}
