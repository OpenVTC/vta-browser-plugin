// ACL management — the canonical `acl/*` Trust Tasks.
//
// This is the surface behind `pnm acl …`: who may act at an agent, in which
// contexts, until when. It runs over a `TrustTaskSender`, so it works against a
// REST, DIDComm or TSP agent without the caller choosing.
//
// **The wire types are not written here.** Payloads, responses and type URIs
// come from `@openvtc/trust-tasks`, the generated bindings for the same JSON
// Schemas the agent's Rust is generated from. This file owns only the call
// layer: build the envelope, dispatch it, unwrap the answer. That division is
// deliberate — an earlier version of this module transcribed the shapes by hand
// from the Rust structs, which is a copy that drifts, and got the nullability of
// `acl/show`'s response wrong in the process.

import type { TaskParty, TrustTaskSender } from "../vta/channel.js";
import { buildTrustTask } from "../vta/trust-task.js";

import {
  TYPE_URI as ACL_GRANT,
  RESPONSE_TYPE_URI as ACL_GRANT_RESPONSE,
  type ACLGrantPayload,
  type ACLGrantResponsePayload,
  type AclEntry,
} from "@openvtc/trust-tasks/acl/grant/0.1/payload";
import {
  TYPE_URI as ACL_LIST,
  RESPONSE_TYPE_URI as ACL_LIST_RESPONSE,
  type ACLListPayload,
  type ACLListResponsePayload,
} from "@openvtc/trust-tasks/acl/list/0.1/payload";
import {
  TYPE_URI as ACL_SHOW,
  RESPONSE_TYPE_URI as ACL_SHOW_RESPONSE,
  type ACLShowResponsePayload,
} from "@openvtc/trust-tasks/acl/show/0.1/payload";
import {
  TYPE_URI as ACL_REVOKE,
  RESPONSE_TYPE_URI as ACL_REVOKE_RESPONSE,
  type ACLRevokePayload,
  type ACLRevokeResponsePayload,
} from "@openvtc/trust-tasks/acl/revoke/0.1/payload";
import {
  TYPE_URI as ACL_UPDATE,
  RESPONSE_TYPE_URI as ACL_UPDATE_RESPONSE,
  type ACLUpdatePayload,
  type ACLUpdateResponsePayload,
} from "@openvtc/trust-tasks/acl/update/0.1/payload";
import {
  TYPE_URI as ACL_CHANGE_ROLE,
  RESPONSE_TYPE_URI as ACL_CHANGE_ROLE_RESPONSE,
  type ACLChangeRolePayload,
  type ACLChangeRoleResponsePayload,
} from "@openvtc/trust-tasks/acl/change-role/0.1/payload";

/**
 * One access-control entry, as the specification defines it.
 *
 * Re-exported so consumers get it from here rather than reaching for the
 * bindings themselves. Two of its members carry traps the type cannot express,
 * both documented at length on the generated interface:
 *
 * - **`scopes` emptiness is role-dependent** — unrestricted for an admin role,
 *   authorized nowhere for every other.
 * - **`allowedKeys` absent and `[]` are opposite grants** — absent is every key
 *   the entry's scopes reach, present-but-empty is no keys at all. The calls
 *   below preserve that distinction.
 */
export type { AclEntry };

/** Every `acl/*` call is issued by an identity, to an agent. */
export interface AclCallerParams {
  /** Envelope `issuer` — the caller's DIDComm identity. Its DID needs a role
   *  the agent accepts for this task; the whole family is manage-gated. */
  holder: TaskParty;
  /** The agent — envelope `recipient`. */
  service: TaskParty;
}

export interface AclGrantParams extends AclCallerParams {
  /** The entry the caller wants the agent to hold. */
  entry: AclEntry;
  /** Human-readable rationale, recorded with the grant. */
  reason?: string;
}

/**
 * Add a subject to the ACL.
 *
 * Grant deliberately cannot do two things, and the agent refuses rather than
 * silently applying them: **changing an existing subject's role** belongs to
 * {@link aclChangeRole}, which compare-and-swaps against the current role, and
 * **narrowing scopes** belongs to {@link aclRevoke}. Both exist so a reduction
 * in authority always passes through the task that is named and audited as one.
 */
export async function aclGrant(
  sender: TrustTaskSender,
  params: AclGrantParams,
): Promise<AclEntry> {
  // Spread the entry rather than rebuilding it field by field: `allowedKeys: []`
  // must survive as `[]`, and a hand-rebuilt entry is where a "skip if empty"
  // creeps in and silently widens the narrowest grant to the widest.
  const payload: ACLGrantPayload = {
    entry: params.entry,
    ...(params.reason ? { reason: params.reason } : {}),
  };
  const envelope = buildTrustTask(ACL_GRANT, payload, {
    issuer: params.holder.did,
    recipient: params.service.did,
  });
  const res = await sender.send<ACLGrantResponsePayload>(envelope, {
    expectedResponseType: ACL_GRANT_RESPONSE,
    operationLabel: "acl/grant/0.1",
  });
  return res.entry;
}

export interface AclListParams extends AclCallerParams {
  /** Only entries with this role. */
  role?: string;
  /** Only entries touching this scope. */
  scope?: string;
  subjectPrefix?: string;
  pageSize?: number;
  cursor?: string;
}

export interface AclListResult {
  entries: AclEntry[];
  /** True when the agent stopped early. Independent of `cursor`: an agent may
   *  truncate without supporting pagination. */
  truncated: boolean;
  cursor?: string;
  /** Fields the agent redacted from every returned entry. */
  redactedFields: string[];
}

/** List ACL entries, filtered and paged. */
export async function aclList(
  sender: TrustTaskSender,
  params: AclListParams,
): Promise<AclListResult> {
  const payload: ACLListPayload = {
    ...(params.role ? { role: params.role } : {}),
    ...(params.scope ? { scope: params.scope } : {}),
    ...(params.subjectPrefix ? { subjectPrefix: params.subjectPrefix } : {}),
    ...(params.pageSize !== undefined ? { pageSize: params.pageSize } : {}),
    ...(params.cursor ? { cursor: params.cursor } : {}),
  };
  const envelope = buildTrustTask(ACL_LIST, payload, {
    issuer: params.holder.did,
    recipient: params.service.did,
  });
  const res = await sender.send<ACLListResponsePayload>(envelope, {
    expectedResponseType: ACL_LIST_RESPONSE,
    operationLabel: "acl/list/0.1",
  });
  return {
    entries: res.entries ?? [],
    truncated: res.truncated ?? false,
    ...(res.cursor ? { cursor: res.cursor } : {}),
    redactedFields: res.redactedFields ?? [],
  };
}

export interface AclShowParams extends AclCallerParams {
  subject: string;
}

export interface AclShowResult {
  /** `null` when the subject is not in the ACL — a successful answer, not a
   *  failure. The specification is explicit about this; an earlier hand-written
   *  version of this module was not, and typed it as always present. */
  entry: AclEntry | null;
  /** Fields the agent withheld from this caller. Empty when nothing was. */
  redactedFields: string[];
}

/** Show one entry, or report that there is none. */
export async function aclShow(
  sender: TrustTaskSender,
  params: AclShowParams,
): Promise<AclShowResult> {
  const envelope = buildTrustTask(
    ACL_SHOW,
    { subject: params.subject },
    { issuer: params.holder.did, recipient: params.service.did },
  );
  const res = await sender.send<ACLShowResponsePayload>(envelope, {
    expectedResponseType: ACL_SHOW_RESPONSE,
    operationLabel: "acl/show/0.1",
  });
  return { entry: res.entry ?? null, redactedFields: res.redactedFields ?? [] };
}

export interface AclRevokeParams extends AclCallerParams {
  subject: string;
  /**
   * The specific scopes to remove. **Omit to remove the entire entry** — those
   * are the only two meanings the specification gives this field.
   *
   * Typed as a non-empty tuple because the schema says `minItems: 1`: an empty
   * array would be a request to revoke nothing, which is not the same as
   * revoking everything and is not a legal request. A previous hand-written
   * version of this module accepted `[]` and had a test asserting it was sent.
   */
  scopes?: [string, ...string[]];
  reason?: string;
}

/** Revoke an entry, or narrow it by naming `scopes`. */
export async function aclRevoke(
  sender: TrustTaskSender,
  params: AclRevokeParams,
): Promise<ACLRevokeResponsePayload> {
  const payload: ACLRevokePayload = {
    subject: params.subject,
    ...(params.scopes !== undefined ? { scopes: params.scopes } : {}),
    ...(params.reason ? { reason: params.reason } : {}),
  };
  const envelope = buildTrustTask(ACL_REVOKE, payload, {
    issuer: params.holder.did,
    recipient: params.service.did,
  });
  return sender.send<ACLRevokeResponsePayload>(envelope, {
    expectedResponseType: ACL_REVOKE_RESPONSE,
    operationLabel: "acl/revoke/0.1",
  });
}

export interface AclChangeRoleParams extends AclCallerParams {
  subject: string;
  /** The role the caller believes the subject holds now. The agent refuses the
   *  change if the stored role differs — a compare-and-swap, not an assignment,
   *  so two admins racing cannot silently overwrite each other. */
  fromRole: string;
  toRole: string;
  reason?: string;
}

/** Transition a subject between roles, compare-and-swapped against `fromRole`. */
export async function aclChangeRole(
  sender: TrustTaskSender,
  params: AclChangeRoleParams,
): Promise<ACLChangeRoleResponsePayload> {
  const payload: ACLChangeRolePayload = {
    subject: params.subject,
    fromRole: params.fromRole,
    toRole: params.toRole,
    ...(params.reason ? { reason: params.reason } : {}),
  };
  const envelope = buildTrustTask(ACL_CHANGE_ROLE, payload, {
    issuer: params.holder.did,
    recipient: params.service.did,
  });
  return sender.send<ACLChangeRoleResponsePayload>(envelope, {
    expectedResponseType: ACL_CHANGE_ROLE_RESPONSE,
    operationLabel: "acl/change-role/0.1",
  });
}

export interface AclUpdateParams extends AclCallerParams {
  /** VID of the entry to amend. It MUST already exist — this does not create
   *  one, and an agent refuses rather than upserting. */
  subject: string;
  /**
   * Replacement label. `null` clears it; omitted leaves it unchanged.
   *
   * The three-way distinction runs through every member below and is the
   * reason this call takes `null` at all rather than treating absence as
   * "clear": on a partial update, absent and cleared are opposite intentions,
   * and a wrapper that collapses them silently wipes whatever it did not
   * mention.
   */
  label?: string | null;
  /**
   * Replacement scope set, applied **wholesale, not merged** — send the full
   * intended set, not the additions.
   *
   * **Narrowing is refused here by the agent, deliberately.** A reduction in
   * authority has to pass through {@link aclRevoke}, which is named and
   * audited as a revocation. This is not a limitation to work around by
   * calling update twice.
   */
  scopes?: string[];
  /**
   * Replacement key filter, applied wholesale. Three distinct meanings, and
   * the agent acts on all three:
   *
   * - **omitted** — leave the filter as it is;
   * - **`null`** — REMOVE the filter, so the subject reaches every key within
   *   its scopes again. A privilege *increase*, gated like clearing an expiry;
   * - **`[]`** — set the filter to no keys at all. The narrowest possible
   *   grant, and the opposite of `null`.
   *
   * Unlike `scopes`, a narrowing here is accepted rather than routed to
   * revoke — `acl/revoke/0.1` cannot express a per-key reduction. The agent
   * must still audit it as a reduction and apply it to live sessions.
   */
  allowedKeys?: string[] | null;
  /** Replacement expiry. `null` makes the entry **permanent** — a privilege
   *  increase, which an agent gates at least as strictly as the grant was. */
  expiresAt?: string | null;
  /** Replacement per-entry step-up. Additive only: it may raise the assurance
   *  required of this subject above the system floor, never lower it. */
  stepUp?: ACLUpdatePayload["stepUp"];
  /**
   * Replacement approve-authority — what the subject may **confer on others**,
   * as distinct from what it may exercise itself.
   *
   * Widening this is an escalation vector rather than a convenience: a subject
   * able to confer can manufacture an approver for an operation it could not
   * itself authorize. Agents gate it more strictly than the rest.
   */
  approve?: ACLUpdatePayload["approve"];
  /** Rationale, recorded with the change. */
  reason?: string;
}

/**
 * Amend the non-role attributes of an existing ACL entry.
 *
 * Role changes are not expressible here at all — they go through
 * {@link aclChangeRole}, which compare-and-swaps against the current role.
 * That split is the point: every path that alters authority is a task with its
 * own name in the audit trail.
 */
export async function aclUpdate(
  sender: TrustTaskSender,
  params: AclUpdateParams,
): Promise<AclEntry> {
  // `!== undefined` throughout, never truthiness. `null` is a live instruction
  // on five of these members and `[]` is the narrowest grant on one — both are
  // falsy, and a `params.x ? …` guard drops exactly the values that mean the
  // most.
  const payload: ACLUpdatePayload = {
    subject: params.subject,
    ...(params.label !== undefined ? { label: params.label } : {}),
    ...(params.scopes !== undefined ? { scopes: params.scopes } : {}),
    ...(params.allowedKeys !== undefined ? { allowedKeys: params.allowedKeys } : {}),
    ...(params.expiresAt !== undefined ? { expiresAt: params.expiresAt } : {}),
    ...(params.stepUp !== undefined ? { stepUp: params.stepUp } : {}),
    ...(params.approve !== undefined ? { approve: params.approve } : {}),
    ...(params.reason !== undefined ? { reason: params.reason } : {}),
  };
  const envelope = buildTrustTask(ACL_UPDATE, payload, {
    issuer: params.holder.did,
    recipient: params.service.did,
  });
  const res = await sender.send<ACLUpdateResponsePayload>(envelope, {
    expectedResponseType: ACL_UPDATE_RESPONSE,
    operationLabel: "acl/update/0.1",
  });
  return res.entry;
}
