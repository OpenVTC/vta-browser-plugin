// Policy management — the canonical `policy/*` Trust Tasks.
//
// A policy row carries **Rego source** in `module`, and the agent treats it as
// authoritative: it validates the source, it never synthesises it. A
// declarative approvals row additionally carries its rules in `ext`, and the
// agent re-derives the module from those and *refuses the write* if the two
// disagree — so a caller that edits one without the other gets a rejection
// rather than a policy that says something nobody wrote.
//
// Writes are optimistically concurrent. `expectedVersion` is how a management
// UI avoids clobbering a revision it never displayed: send the version the
// operator was looking at, and a racing edit fails instead of winning.
//
// Payload and response types come from `@openvtc/trust-tasks`.

import type { TaskParty, TrustTaskSender } from "../vta/channel.js";
import { buildTrustTask } from "../vta/trust-task.js";
import { collectPages } from "../util/pages.js";

import {
  TYPE_URI as POLICY_LIST,
  RESPONSE_TYPE_URI as POLICY_LIST_RESPONSE,
  type PolicyListPayload,
  type PolicyListResponsePayload,
  type PolicyModule,
} from "../specs/policy/list/0.3/payload.js";
import {
  TYPE_URI as POLICY_GET,
  RESPONSE_TYPE_URI as POLICY_GET_RESPONSE,
  type PolicyGetResponsePayload,
} from "../specs/policy/get/0.1/payload.js";
import {
  TYPE_URI as POLICY_UPSERT,
  RESPONSE_TYPE_URI as POLICY_UPSERT_RESPONSE,
  type PolicyUpsertPayload,
  type PolicyUpsertResponsePayload,
} from "../specs/policy/upsert/0.3/payload.js";
import {
  TYPE_URI as POLICY_DELETE,
  RESPONSE_TYPE_URI as POLICY_DELETE_RESPONSE,
  type PolicyDeletePayload,
  type PolicyDeleteResponsePayload,
} from "../specs/policy/delete/0.1/payload.js";

export type { PolicyModule };

export interface PolicyCallerParams {
  holder: TaskParty;
  service: TaskParty;
}

export interface PolicyListParams extends PolicyCallerParams {
  contextId?: string;
  /** Only rows currently in force. */
  enabledOnly?: boolean;
  /** The page size to ask for — never a cap on the result. */
  limit?: number;
}

export interface PolicyListResult {
  /** Every matching row: the listing is read to the end. */
  policies: PolicyModule[];
}

/**
 * List policy rows, **read to the end**.
 *
 * `policy/list/0.3` moved to the registry-wide paging convention — `limit`
 * and `cursor` in, `nextCursor` out, absent on the last page — and dropped
 * 0.2's `truncated`. Only an absent `nextCursor` means exhaustion, so the
 * cursor is followed through `collectPages` rather than handing a pane the
 * first page: a policy engine's rule set shown in part is a rule nobody
 * reviews.
 */
export async function policyList(
  sender: TrustTaskSender,
  params: PolicyListParams,
): Promise<PolicyListResult> {
  const policies = await collectPages("policy/list", async (cursor) => {
    const payload: PolicyListPayload = {
      ...(params.contextId ? { contextId: params.contextId } : {}),
      // `!== undefined`: `enabledOnly: false` is "include disabled rows", which
      // is not the same request as omitting the filter.
      ...(params.enabledOnly !== undefined ? { enabledOnly: params.enabledOnly } : {}),
      ...(params.limit !== undefined ? { limit: params.limit } : {}),
      ...(cursor ? { cursor } : {}),
    };
    const envelope = buildTrustTask(POLICY_LIST, payload, {
      issuer: params.holder.did,
      recipient: params.service.did,
    });
    const res = await sender.send<PolicyListResponsePayload>(envelope, {
      expectedResponseType: POLICY_LIST_RESPONSE,
      operationLabel: "policy/list/0.3",
    });
    return { items: res.policies ?? [], nextCursor: res.nextCursor };
  });
  return { policies };
}

export interface PolicyGetParams extends PolicyCallerParams {
  id: string;
}

/** Fetch one policy row, Rego source included. */
export async function policyGet(
  sender: TrustTaskSender,
  params: PolicyGetParams,
): Promise<PolicyModule> {
  const envelope = buildTrustTask(
    POLICY_GET,
    { id: params.id },
    { issuer: params.holder.did, recipient: params.service.did },
  );
  // Single-member envelope: the row *is* the answer, so unwrap it — the same
  // shape `aclShow` and `keysShow` return. Multi-member responses (upsert's
  // `{policy, wasCreated}`) are handed back whole, because there both members say
  // something the caller needs.
  const res = await sender.send<PolicyGetResponsePayload>(envelope, {
    expectedResponseType: POLICY_GET_RESPONSE,
    operationLabel: "policy/get/0.1",
  });
  return res.policy;
}

export interface PolicyUpsertParams extends PolicyCallerParams {
  /** Target row. Omit to have the agent allocate one. */
  id?: string;
  name: string;
  description?: string;
  /** Rego source. Required — there is no server-side synthesis. */
  module: string;
  appliesTo?: string[];
  priority?: number;
  enabled: boolean;
  /**
   * The version the caller believes the row is at. When present it must equal
   * the stored version, else the write is refused.
   *
   * Send it whenever editing something an operator was shown. Omitting it means
   * "last write wins", which for a policy row means one admin silently undoing
   * another's change.
   */
  expectedVersion?: number;
  /** Declarative approvals rules. Must agree with `module`. */
  ext?: PolicyUpsertPayload["ext"];
}

/**
 * Create or update a policy row.
 *
 * The response's `wasCreated` (0.2's `created`, renamed in 0.3 to follow the
 * registry's boolean naming) says which of the two happened — passed through,
 * never defaulted, because defaulting it would paper over a non-conformant
 * agent.
 */
export async function policyUpsert(
  sender: TrustTaskSender,
  params: PolicyUpsertParams,
): Promise<PolicyUpsertResponsePayload> {
  const payload: PolicyUpsertPayload = {
    ...(params.id ? { id: params.id } : {}),
    name: params.name,
    ...(params.description ? { description: params.description } : {}),
    module: params.module,
    ...(params.appliesTo ? { appliesTo: params.appliesTo } : {}),
    ...(params.priority !== undefined ? { priority: params.priority } : {}),
    // Always sent: `enabled` is required, and it is the field where an omission
    // would read as the opposite of what the caller meant.
    enabled: params.enabled,
    ...(params.expectedVersion !== undefined
      ? { expectedVersion: params.expectedVersion }
      : {}),
    ...(params.ext !== undefined ? { ext: params.ext } : {}),
  };
  const envelope = buildTrustTask(POLICY_UPSERT, payload, {
    issuer: params.holder.did,
    recipient: params.service.did,
  });
  return sender.send<PolicyUpsertResponsePayload>(envelope, {
    expectedResponseType: POLICY_UPSERT_RESPONSE,
    operationLabel: "policy/upsert/0.3",
  });
}

export interface PolicyDeleteParams extends PolicyCallerParams {
  id: string;
  /** Same optimistic-concurrency guard as upsert. */
  expectedVersion?: number;
  reason?: string;
}

/** Delete a policy row. */
export async function policyDelete(
  sender: TrustTaskSender,
  params: PolicyDeleteParams,
): Promise<PolicyDeleteResponsePayload> {
  const payload: PolicyDeletePayload = {
    id: params.id,
    ...(params.expectedVersion !== undefined
      ? { expectedVersion: params.expectedVersion }
      : {}),
    ...(params.reason ? { reason: params.reason } : {}),
  };
  const envelope = buildTrustTask(POLICY_DELETE, payload, {
    issuer: params.holder.did,
    recipient: params.service.did,
  });
  return sender.send<PolicyDeleteResponsePayload>(envelope, {
    expectedResponseType: POLICY_DELETE_RESPONSE,
    operationLabel: "policy/delete/0.1",
  });
}
