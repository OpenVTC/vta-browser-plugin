// Audit and configuration — what an agent did, and how it is set up.
//
// The two read-mostly surfaces a console needs before it can be trusted to
// change anything: `audit/list` answers "what happened", `config/show` answers
// "under what settings", and `config/patch` is the one write, kept in the same
// file because you should never be looking at the second without the first.

import type { Identity } from "../didcomm/index.js";
import type { TrustTaskSender } from "../vta/channel.js";
import type { RemoteDidcommEndpoint } from "../vta/didcomm.js";
import { buildTrustTask } from "../vta/trust-task.js";

import {
  TYPE_URI as AUDIT_LIST,
  RESPONSE_TYPE_URI as AUDIT_LIST_RESPONSE,
  type AuditListPayload,
  type AuditListResponsePayload,
  type AuditEnvelope,
} from "@openvtc/trust-tasks/audit/list/0.1/payload";
import {
  TYPE_URI as CONFIG_SHOW,
  RESPONSE_TYPE_URI as CONFIG_SHOW_RESPONSE,
  type ConfigShowPayload,
  type ConfigShowResponsePayload,
  type ConfigField,
} from "@openvtc/trust-tasks/config/show/0.1/payload";
import {
  TYPE_URI as MESSAGING_PING,
  RESPONSE_TYPE_URI as MESSAGING_PING_RESPONSE,
  type MessagingPingPayload,
  type MessagingPingResponsePayload,
} from "@openvtc/trust-tasks/messaging/ping/0.1/payload";
import {
  TYPE_URI as CONFIG_PATCH,
  RESPONSE_TYPE_URI as CONFIG_PATCH_RESPONSE,
  type ConfigPatchPayload,
  type ConfigPatchResponsePayload,
} from "@openvtc/trust-tasks/config/patch/0.1/payload";

export type { AuditEnvelope, ConfigField };

export interface ObservabilityCallerParams {
  holder: Identity;
  service: RemoteDidcommEndpoint;
}

export interface AuditListParams extends ObservabilityCallerParams {
  /** RFC 3339 lower bound, inclusive. */
  from?: string;
  /** RFC 3339 upper bound. */
  to?: string;
  /** Audit action name, e.g. `acl.grant`. */
  action?: string;
  /** DID of the party that acted. */
  actor?: string;
  outcome?: string;
  contextId?: string;
  pageSize?: number;
  cursor?: string;
}

export interface AuditListResult {
  entries: AuditEnvelope[];
  /** The agent stopped early. **Check this before drawing conclusions** — a
   *  truncated audit page is not a complete account of what happened, and an
   *  operator reading "nothing else occurred" from a partial list is exactly
   *  the failure an audit trail exists to prevent. */
  truncated: boolean;
  cursor?: string;
}

/** Read the agent's audit trail, filtered and paged. */
export async function auditList(
  sender: TrustTaskSender,
  params: AuditListParams,
): Promise<AuditListResult> {
  const payload: AuditListPayload = {
    ...(params.from ? { from: params.from } : {}),
    ...(params.to ? { to: params.to } : {}),
    ...(params.action ? { action: params.action } : {}),
    ...(params.actor ? { actor: params.actor } : {}),
    ...(params.outcome ? { outcome: params.outcome } : {}),
    ...(params.contextId ? { contextId: params.contextId } : {}),
    ...(params.pageSize !== undefined ? { pageSize: params.pageSize } : {}),
    ...(params.cursor ? { cursor: params.cursor } : {}),
  };
  const envelope = buildTrustTask(AUDIT_LIST, payload, {
    issuer: params.holder.did,
    recipient: params.service.did,
  });
  const res = await sender.send<AuditListResponsePayload>(envelope, {
    expectedResponseType: AUDIT_LIST_RESPONSE,
    operationLabel: "audit/list/0.1",
  });
  return {
    entries: res.entries ?? [],
    truncated: res.truncated ?? false,
    ...(res.cursor ? { cursor: res.cursor } : {}),
  };
}

export interface ConfigShowParams extends ObservabilityCallerParams {
  /** Restrict to these keys. Omit for everything the caller may see.
   *
   *  Typed as a non-empty tuple because the schema says `minItems: 1`: an empty
   *  list would be a request for no keys, which is not the same as a request
   *  for all of them. */
  keys?: [string, ...string[]];
}

/** Read the agent's effective configuration. */
export async function configShow(
  sender: TrustTaskSender,
  params: ConfigShowParams,
): Promise<ConfigField[]> {
  const payload: ConfigShowPayload = {
    ...(params.keys !== undefined ? { keys: params.keys } : {}),
  };
  const envelope = buildTrustTask(CONFIG_SHOW, payload, {
    issuer: params.holder.did,
    recipient: params.service.did,
  });
  const res = await sender.send<ConfigShowResponsePayload>(envelope, {
    expectedResponseType: CONFIG_SHOW_RESPONSE,
    operationLabel: "config/show/0.1",
  });
  return res.fields ?? [];
}

export interface ConfigPatchParams extends ObservabilityCallerParams {
  /** The settings to change, keyed by config key. */
  overrides: ConfigPatchPayload["overrides"];
}

/**
 * Change settings.
 *
 * The response is three lists, and **all three matter**: `applied` took effect,
 * `pendingRestart` will not take effect until the agent restarts, and
 * `rejected` did not take at all. A UI that reports success on a 2xx without
 * reading them will tell an operator a setting is live when it is queued, or
 * when the agent refused it outright.
 */
export async function configPatch(
  sender: TrustTaskSender,
  params: ConfigPatchParams,
): Promise<ConfigPatchResponsePayload> {
  const envelope = buildTrustTask(
    CONFIG_PATCH,
    { overrides: params.overrides },
    { issuer: params.holder.did, recipient: params.service.did },
  );
  return sender.send<ConfigPatchResponsePayload>(envelope, {
    expectedResponseType: CONFIG_PATCH_RESPONSE,
    operationLabel: "config/patch/0.1",
  });
}

export interface AgentPingParams extends ObservabilityCallerParams {
  /** Echoed back by the agent. Supply one to prove the response belongs to
   *  this request rather than a cached or replayed earlier one. */
  nonce?: string;
}

/**
 * Liveness and capability check.
 *
 * `status` is `ok` or **`degraded`** — an agent that answers is not
 * necessarily an agent that is working, and a console showing a green light on
 * any response would hide exactly the state worth seeing. `protocols` is what
 * it will speak, which is the honest basis for deciding what to render.
 */
export async function agentPing(
  sender: TrustTaskSender,
  params: AgentPingParams,
): Promise<MessagingPingResponsePayload> {
  const payload: MessagingPingPayload = {
    ...(params.nonce ? { nonce: params.nonce } : {}),
  };
  const envelope = buildTrustTask(MESSAGING_PING, payload, {
    issuer: params.holder.did,
    recipient: params.service.did,
  });
  return sender.send<MessagingPingResponsePayload>(envelope, {
    expectedResponseType: MESSAGING_PING_RESPONSE,
    operationLabel: "messaging/ping/0.1",
  });
}
