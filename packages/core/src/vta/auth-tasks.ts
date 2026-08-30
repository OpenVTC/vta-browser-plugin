// `auth/challenge` and `auth/refresh` as canonical Trust Tasks.
//
// **Not the bootstrap.** `vta/auth.ts` gets the first bearer over bespoke REST
// (`POST /auth/challenge`, then an authcrypted `POST /auth/`), and it has to:
// posting a Trust Task to `/trust-tasks` over REST requires a bearer, so a
// REST-only client cannot ask for its first token as a task. That is a genuine
// chicken-and-egg, not an oversight.
//
// These are for the transports where it does not arise. TSP and DIDComm
// authenticate the sender in the envelope itself, so a client already speaking
// either can ask for a challenge — or refresh an expiring session — as an
// ordinary task, with no bearer anywhere in the loop.

import type { Identity } from "../didcomm/index.js";
import type { TrustTaskSender } from "./channel.js";
import type { RemoteDidcommEndpoint } from "./didcomm.js";
import { buildTrustTask } from "./trust-task.js";

import {
  TYPE_URI as AUTH_CHALLENGE,
  RESPONSE_TYPE_URI as AUTH_CHALLENGE_RESPONSE,
  type AuthChallenge,
  type AuthChallengeResponsePayload,
} from "@openvtc/trust-tasks/auth/challenge/0.1/payload";
import {
  TYPE_URI as AUTH_AUTHENTICATE,
  RESPONSE_TYPE_URI as AUTH_AUTHENTICATE_RESPONSE,
  type AuthAuthenticate,
  type AuthAuthenticateResponsePayload,
} from "@openvtc/trust-tasks/auth/authenticate/0.1/payload";
import {
  TYPE_URI as AUTH_REFRESH,
  RESPONSE_TYPE_URI as AUTH_REFRESH_RESPONSE,
  type AuthRefresh,
  type AuthRefreshResponsePayload,
  type TokenBundle,
} from "@openvtc/trust-tasks/auth/refresh/0.1/payload";
import {
  TYPE_URI as AUTH_PASSKEY_LOGIN_START,
  RESPONSE_TYPE_URI as AUTH_PASSKEY_LOGIN_START_RESPONSE,
  type AuthPasskeyLoginStart,
  type AuthPasskeyLoginStartResponsePayload,
} from "@openvtc/trust-tasks/auth/passkey/login/start/0.2/payload";
import {
  TYPE_URI as AUTH_PASSKEY_LOGIN_FINISH,
  RESPONSE_TYPE_URI as AUTH_PASSKEY_LOGIN_FINISH_RESPONSE,
  type AuthPasskeyLoginFinish,
  type AuthPasskeyLoginFinishResponsePayload,
} from "@openvtc/trust-tasks/auth/passkey/login/finish/0.2/payload";

export type { TokenBundle };

export interface AuthTaskCallerParams {
  holder: Identity;
  service: RemoteDidcommEndpoint;
  /**
   * DID the document is issued by. Defaults to the holder's.
   *
   * Different only when the channel signs as someone else — a per-site persona,
   * whose key lives at the VTA. It MUST match the channel's signer:
   * `signOutboundTask` refuses the mismatch locally, which is better than the
   * consumer's `identityMismatch` with no hint that the cause is here.
   */
  issuer?: string;
}

export interface AuthChallengeParams extends AuthTaskCallerParams {
  /** DID the challenge is for. Defaults to the caller's own. */
  subject?: string;
  /** What the challenge will be spent on, e.g. `stepUp`. */
  purpose?: string;
}

/** Ask for a challenge to sign. */
export async function requestAuthChallenge(
  sender: TrustTaskSender,
  params: AuthChallengeParams,
): Promise<AuthChallengeResponsePayload> {
  const payload: AuthChallenge = {
    ...(params.subject ? { subject: params.subject } : {}),
    ...(params.purpose ? { purpose: params.purpose } : {}),
  };
  const envelope = buildTrustTask(AUTH_CHALLENGE, payload, {
    issuer: params.issuer ?? params.holder.did,
    recipient: params.service.did,
  });
  return sender.send<AuthChallengeResponsePayload>(envelope, {
    expectedResponseType: AUTH_CHALLENGE_RESPONSE,
    operationLabel: "auth/challenge/0.1",
  });
}

export interface AuthAuthenticateParams extends AuthTaskCallerParams {
  /** The exact `challenge` from the prior `auth/challenge` reply. */
  challenge: string;
  /** The `sessionId` that came with it. The consumer looks the challenge
   *  binding up by this, so the pair travels together or not at all. */
  sessionId: string;
  /** Capability tags to ask for. The consumer decides what it grants; the
   *  issued bundle's `scope` MAY be a subset. */
  scope?: string[];
}

/**
 * Spend a challenge and get a session.
 *
 * **The proof over this document is the authentication.** The channel signs
 * every outbound Trust Task (`signOutboundTask`, SPEC §7.2 item 7a), and the
 * consumer establishes the caller from that signature — binding it to the
 * asserted `issuer`, or filling the issuer from the authenticated transport
 * when the document asserts none. Possession of the challenge alone proves
 * nothing; possession plus a signature over a document carrying it proves
 * control of the VID, which is the whole point of the two-step.
 *
 * That is why this works identically over TSP, DIDComm and REST: the proof
 * travels with the document, so the guarantee does not depend on which
 * transport carried it.
 */
export async function authenticateSession(
  sender: TrustTaskSender,
  params: AuthAuthenticateParams,
): Promise<AuthAuthenticateResponsePayload> {
  const payload: AuthAuthenticate = {
    challenge: params.challenge,
    sessionId: params.sessionId,
    ...(params.scope && params.scope.length > 0 ? { scope: params.scope } : {}),
  };
  const envelope = buildTrustTask(AUTH_AUTHENTICATE, payload, {
    issuer: params.issuer ?? params.holder.did,
    recipient: params.service.did,
  });
  return sender.send<AuthAuthenticateResponsePayload>(envelope, {
    expectedResponseType: AUTH_AUTHENTICATE_RESPONSE,
    operationLabel: "auth/authenticate/0.1",
  });
}

export interface AuthRefreshParams extends AuthTaskCallerParams {
  /** The refresh token from a previous authentication. */
  refreshToken: string;
  /** Narrow the new session's scope. Omit to keep what the old one had —
   *  naming scopes here can only reduce, never widen. */
  scope?: string[];
}

/**
 * Exchange a refresh token for a fresh session.
 *
 * **The response may rotate the refresh token.** `tokens.refreshToken` is
 * optional: when the agent sends a new one, the old one is spent and a caller
 * that keeps using it will find itself logged out at the worst moment. Store
 * whatever comes back before acting on the access token.
 */
export async function refreshAuthSession(
  sender: TrustTaskSender,
  params: AuthRefreshParams,
): Promise<AuthRefreshResponsePayload> {
  const payload: AuthRefresh = {
    refreshToken: params.refreshToken,
    ...(params.scope ? { scope: params.scope } : {}),
  };
  const envelope = buildTrustTask(AUTH_REFRESH, payload, {
    issuer: params.issuer ?? params.holder.did,
    recipient: params.service.did,
  });
  return sender.send<AuthRefreshResponsePayload>(envelope, {
    expectedResponseType: AUTH_REFRESH_RESPONSE,
    operationLabel: "auth/refresh/0.1",
  });
}

// ── Passkey login as a Trust Task ───────────────────────────────────────────
//
// A two-step ceremony: `start` returns the WebAuthn request options and an
// `authId` binding them; the browser runs `navigator.credentials.get()`;
// `finish` submits the assertion under that `authId` and gets a session back.
//
// **Distinct from the bespoke REST bootstrap in `vta/auth.ts`,** and subject to
// the same constraint as everything else in this file: posting a Trust Task
// over REST needs a bearer, so a REST-only client cannot log in this way. Over
// TSP or DIDComm the envelope authenticates the sender, and this works.
//
// **Pinned at 0.2, and the version carries meaning.** 0.2 adds `purpose`, which
// separates "log this session in" from "raise this session's assurance for one
// operation". Sending a step-up as a login is not a naming preference — it asks
// the agent for a broader session than the operation needed.

/** The `purpose` a passkey assertion is spent on. */
export type PasskeyLoginPurpose = "login" | "stepUp";

export interface PasskeyLoginStartParams extends AuthTaskCallerParams {
  /** DID being authenticated. Defaults to the caller's own. */
  subject?: string;
  /**
   * `login` for a new session, `stepUp` to raise an existing one.
   *
   * The agent echoes what it actually granted on `finish`. Read that rather
   * than assuming the request was honoured — the two differ in what the
   * resulting session may do.
   */
  purpose?: PasskeyLoginPurpose;
}

/**
 * Open a passkey login ceremony.
 *
 * The returned `options` go straight to `navigator.credentials.get()`; the
 * `authId` binds that ceremony and is what {@link finishPasskeyLogin} submits
 * under. It is single-use and the agent expires it, so do not open one
 * speculatively ahead of the user gesture.
 */
export async function startPasskeyLogin(
  sender: TrustTaskSender,
  params: PasskeyLoginStartParams,
): Promise<AuthPasskeyLoginStartResponsePayload> {
  const payload: AuthPasskeyLoginStart = {
    ...(params.subject !== undefined ? { subject: params.subject } : {}),
    ...(params.purpose !== undefined ? { purpose: params.purpose } : {}),
  };
  const envelope = buildTrustTask(AUTH_PASSKEY_LOGIN_START, payload, {
    issuer: params.issuer ?? params.holder.did,
    recipient: params.service.did,
  });
  return sender.send<AuthPasskeyLoginStartResponsePayload>(envelope, {
    expectedResponseType: AUTH_PASSKEY_LOGIN_START_RESPONSE,
    operationLabel: "auth/passkey/login/start/0.2",
  });
}

export interface PasskeyLoginFinishParams extends AuthTaskCallerParams {
  /** The `authId` from {@link startPasskeyLogin}. Single-use. */
  authId: string;
  /** The WebAuthn assertion, base64url-encoded per the specification. */
  credential: AuthPasskeyLoginFinish["credential"];
}

/**
 * Submit the assertion and take the session.
 *
 * Two things in the answer are easy to skip and both matter:
 *
 * - **`purpose`** is what the agent granted, not what was asked for. Treating
 *   a `stepUp` as a `login` means believing a session is broader than it is.
 * - **`tokens` is optional.** A `stepUp` typically raises the session already
 *   in hand rather than minting a bundle, so its absence is the normal case
 *   there and is not a failure. Where tokens *are* present they replace what
 *   was held — including the refresh token, which the agent may rotate.
 */
export async function finishPasskeyLogin(
  sender: TrustTaskSender,
  params: PasskeyLoginFinishParams,
): Promise<AuthPasskeyLoginFinishResponsePayload> {
  const payload: AuthPasskeyLoginFinish = {
    authId: params.authId,
    credential: params.credential,
  };
  const envelope = buildTrustTask(AUTH_PASSKEY_LOGIN_FINISH, payload, {
    issuer: params.issuer ?? params.holder.did,
    recipient: params.service.did,
  });
  return sender.send<AuthPasskeyLoginFinishResponsePayload>(envelope, {
    expectedResponseType: AUTH_PASSKEY_LOGIN_FINISH_RESPONSE,
    operationLabel: "auth/passkey/login/finish/0.2",
  });
}
