// Session introspection — `auth/whoami`, `auth/sessions/list`, `auth/revoke-session`.
//
// What a console needs to answer "who am I to this agent, what am I allowed to
// do, and what else is signed in as me".
//
// **`sessionsList` lists the caller's own sessions, and only those.** The agent
// has a separate admin REST route (`GET /auth/sessions`) that lists everyone's;
// this task deliberately does not. A management UI that showed the result under
// a heading like "all sessions" would be lying about its own scope.
//
// `whoAmI` re-resolves roles and scopes at call time rather than reading them
// out of the access token, so a role change or a revocation since the token was
// minted is visible immediately. That is the reason to call it at all: the
// token's own claims go stale and this does not.
//
// Payload and response types come from `@openvtc/trust-tasks`.

import type { Identity } from "../didcomm/index.js";
import type { TrustTaskSender } from "../vta/channel.js";
import type { RemoteDidcommEndpoint } from "../vta/didcomm.js";
import { buildTrustTask } from "../vta/trust-task.js";

import {
  TYPE_URI as AUTH_WHOAMI,
  RESPONSE_TYPE_URI as AUTH_WHOAMI_RESPONSE,
  type AuthWhoamiResponsePayload,
  type Session,
} from "@openvtc/trust-tasks/auth/whoami/0.1/payload";
import {
  TYPE_URI as AUTH_SESSIONS_LIST,
  RESPONSE_TYPE_URI as AUTH_SESSIONS_LIST_RESPONSE,
  type AuthSessionsListResponsePayload,
} from "@openvtc/trust-tasks/auth/sessions/list/0.1/payload";
import {
  TYPE_URI as AUTH_REVOKE_SESSION,
  RESPONSE_TYPE_URI as AUTH_REVOKE_SESSION_RESPONSE,
  type AuthRevokeSessionResponsePayload,
} from "@openvtc/trust-tasks/auth/revoke-session/0.1/payload";

export type { Session };

export interface SessionCallerParams {
  holder: Identity;
  service: RemoteDidcommEndpoint;
}

/**
 * Who the agent thinks the caller is, with freshly-resolved authority.
 *
 * A caller deauthorised since their token was minted does not get an empty
 * answer here — they get the agent's ACL rejection, because their authority
 * really is gone. Treat a failure as an answer, not a glitch.
 */
export async function whoAmI(
  sender: TrustTaskSender,
  params: SessionCallerParams,
): Promise<{ session: Session; roles: string[]; scopes: string[] }> {
  const envelope = buildTrustTask(
    AUTH_WHOAMI,
    {},
    { issuer: params.holder.did, recipient: params.service.did },
  );
  const res = await sender.send<AuthWhoamiResponsePayload>(envelope, {
    expectedResponseType: AUTH_WHOAMI_RESPONSE,
    operationLabel: "auth/whoami/0.1",
  });
  // `roles` and `scopes` are optional in the schema; defaulting them here saves
  // every caller the same `?? []`, and "no roles" is a real answer worth being
  // able to render. `session` is required, so it is passed through untouched.
  return { session: res.session, roles: res.roles ?? [], scopes: res.scopes ?? [] };
}

/** The caller's own active sessions — not every session at the agent. */
export async function sessionsList(
  sender: TrustTaskSender,
  params: SessionCallerParams,
): Promise<Session[]> {
  const envelope = buildTrustTask(
    AUTH_SESSIONS_LIST,
    {},
    { issuer: params.holder.did, recipient: params.service.did },
  );
  const res = await sender.send<AuthSessionsListResponsePayload>(envelope, {
    expectedResponseType: AUTH_SESSIONS_LIST_RESPONSE,
    operationLabel: "auth/sessions/list/0.1",
  });
  return res.sessions ?? [];
}

export interface SessionRevokeParams extends SessionCallerParams {
  sessionId: string;
}

/**
 * Revoke a session. The caller's own always; someone else's only with the
 * authority to manage it.
 *
 * Reports how many sessions were revoked, which is `0` for an id that was
 * already gone — a successful no-op, not a failure. Say "already signed out"
 * rather than reporting an error.
 */
export async function sessionRevoke(
  sender: TrustTaskSender,
  params: SessionRevokeParams,
): Promise<AuthRevokeSessionResponsePayload> {
  const envelope = buildTrustTask(
    AUTH_REVOKE_SESSION,
    { sessionId: params.sessionId },
    { issuer: params.holder.did, recipient: params.service.did },
  );
  return sender.send<AuthRevokeSessionResponsePayload>(envelope, {
    expectedResponseType: AUTH_REVOKE_SESSION_RESPONSE,
    operationLabel: "auth/revoke-session/0.1",
  });
}
