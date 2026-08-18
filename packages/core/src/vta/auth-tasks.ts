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
  TYPE_URI as AUTH_REFRESH,
  RESPONSE_TYPE_URI as AUTH_REFRESH_RESPONSE,
  type AuthRefresh,
  type AuthRefreshResponsePayload,
  type TokenBundle,
} from "@openvtc/trust-tasks/auth/refresh/0.1/payload";

export type { TokenBundle };

export interface AuthTaskCallerParams {
  holder: Identity;
  service: RemoteDidcommEndpoint;
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
    issuer: params.holder.did,
    recipient: params.service.did,
  });
  return sender.send<AuthChallengeResponsePayload>(envelope, {
    expectedResponseType: AUTH_CHALLENGE_RESPONSE,
    operationLabel: "auth/challenge/0.1",
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
    issuer: params.holder.did,
    recipient: params.service.did,
  });
  return sender.send<AuthRefreshResponsePayload>(envelope, {
    expectedResponseType: AUTH_REFRESH_RESPONSE,
    operationLabel: "auth/refresh/0.1",
  });
}
