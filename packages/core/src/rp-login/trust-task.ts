// Logging in to a relying party as an ordinary pair of Trust Tasks.
//
// `auth/challenge/0.1` then `auth/authenticate/0.2`, over any
// `TrustTaskSender` — so a login runs on whichever transport the RP advertises,
// priority TSP > DIDComm > REST, exactly as every VTA operation has since #79.
//
// **What this replaced.** `didcomm.ts` used to send a bespoke DIDComm message
// and the RP authenticated on the authcrypt sender, reading nothing from the
// body. That was a different rule than the RP applies over HTTPS, it existed
// only on one transport, and it made the `challenge` the canonical task
// declares REQUIRED into a field nobody checked. `loginViaDidcomm` is now this
// function over a DIDComm channel, and affinidi-webvh-service #213 removes the
// bare route on the RP side.
//
// **The proof is the authentication.** The channel signs every outbound
// document (`signOutboundTask`, SPEC §7.2 item 7a) and the RP establishes the
// caller from that signature. Possession of a challenge proves nothing on its
// own; possession plus a signature over a document carrying it proves control
// of the VID. That is what makes this identical over three transports rather
// than three rules — the guarantee rides with the document, not the pipe.
//
// **Both proofs declare `proofPurpose: authentication`.** The channel chooses
// it from the document type (`proofPurposeForDocumentType`), as it does for
// every operational document; on the authenticate it is literally the sign-in.
//
// Requires an RP that dispatches the auth family as Trust Tasks
// (affinidi-webvh-service #171). Against one that does not, the challenge comes
// back `unsupportedType`.

import { authenticateSession, isDidKey, requestAuthChallenge } from "../vta/auth-tasks.js";
import { VtaClientError } from "../vta/errors.js";
import type { TaskParty, TrustTaskSender } from "../vta/channel.js";

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
  /** The `did:key` the RP bound to this session. Present only when one was
   *  requested, and then always equal to it (see {@link loginViaTrustTask}). */
  sessionKey?: string;
}

export interface TrustTaskLoginOptions {
  /** Any transport that can carry a Trust Task to the RP. A `VtaSession`
   *  built against the RP's control DID gives the full chain. */
  sender: TrustTaskSender;
  /** The wallet's holder identity — the transport identity, and the default
   *  document `issuer`. */
  holder: TaskParty;
  /**
   * DID to log in AS, when that is not the holder — a per-site persona.
   *
   * The RP checks the challenge subject against the DID that signed
   * (`session.did != input.signer_did` in vti-common's `handle_authenticate`),
   * so this has to be both: the challenge is requested for it, and the channel
   * has to sign as it. Supplying one whose key the channel cannot sign with
   * fails at `signOutboundTask`, locally, naming both DIDs.
   */
  subject?: string;
  /** The RP's DID: the `recipient` of both documents. */
  service: TaskParty;
  /** Capability tags to request. The RP decides what it grants. */
  scope?: string[];
  /**
   * A `did:key` for the RP to bind to the new session (`auth/authenticate/0.2`).
   * The subject's proof on the authenticate document covers it. After login,
   * the holder of that key can sign the session's ordinary requests without
   * the subject's key. It never counts where an `assertionMethod` attestation
   * is required, such as approving a step-up.
   *
   * It must be a `did:key` ({@link isDidKey}). Anything else is refused here,
   * before the subject signs.
   */
  sessionKey?: string;
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
  // Who is signing in. The holder unless a persona was named — and the same
  // value has to reach both steps, or the RP refuses on the signer check.
  const subject = opts.subject ?? holder.did;

  // Checked before anything goes out. The subject's signature is what
  // authorises the binding, so a value the spec would refuse must never
  // reach a document it signs.
  if (opts.sessionKey !== undefined && !isDidKey(opts.sessionKey)) {
    throw new VtaClientError(
      "e.client.invalid_session_key",
      "sessionKey must be a did:key (did:key:z…), with no fragment",
    );
  }

  // The guard that used to live here — "the signing identity must be the
  // holder" — has moved to where it can actually be checked.
  // `loginViaTrustTask` never signs; the channel does, and `signOutboundTask`
  // compares the envelope's issuer against the signer's DID on every outbound
  // document. Re-asserting it here would only have said the holder is the only
  // possible signer, which stopped being true when a channel could sign as a
  // persona whose key lives at the VTA.

  const challenge = await requestAuthChallenge(sender, {
    holder,
    service,
    issuer: subject,
    // The RP binds the challenge to the identity it verified, so naming a
    // subject here cannot widen anything — it is a statement of intent that
    // lets the RP refuse early if it disagrees.
    subject,
    purpose: "login",
  });

  const authed = await authenticateSession(sender, {
    holder,
    service,
    issuer: subject,
    challenge: challenge.challenge,
    sessionId: challenge.sessionId,
    ...(opts.scope && opts.scope.length > 0 ? { scope: opts.scope } : {}),
    ...(opts.sessionKey !== undefined ? { sessionKey: opts.sessionKey } : {}),
  });

  // The RP must bind the key or refuse the login
  // (`auth/authenticate:sessionKeyUnsupported`). It may not quietly sign us
  // in without it. A session without the key would reject every call the
  // page signs with it. Worse, the page would believe the key speaks for a
  // session it has nothing to do with.
  if (opts.sessionKey !== undefined && authed.session.sessionKey !== opts.sessionKey) {
    throw new VtaClientError(
      "e.client.session_key_not_bound",
      `the relying party did not bind the requested session key (got ${
        authed.session.sessionKey ?? "none"
      })`,
    );
  }

  const tokens = authed.tokens;
  return {
    accessToken: tokens.accessToken,
    ...(tokens.refreshToken ? { refreshToken: tokens.refreshToken } : {}),
    sessionId: challenge.sessionId,
    expiresIn: tokens.expiresIn,
    ...(tokens.scope && tokens.scope.length > 0 ? { scope: tokens.scope } : {}),
    ...(opts.sessionKey !== undefined ? { sessionKey: opts.sessionKey } : {}),
  };
}
