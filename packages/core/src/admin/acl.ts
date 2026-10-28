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
import { collectPages } from "../util/pages.js";

import {
  TYPE_URI as ACL_GRANT,
  RESPONSE_TYPE_URI as ACL_GRANT_RESPONSE,
  type ACLGrant02Payload,
  type ACLGrant02ResponsePayload,
  type AclEntry,
  type AuthorityScope,
  type CapabilityScope,
  type ApproveCapabilityScope,
  type CapabilityGrant,
  type KeyScope,
} from "../specs/acl/grant/0.2/payload.js";
import {
  TYPE_URI as ACL_LIST,
  RESPONSE_TYPE_URI as ACL_LIST_RESPONSE,
  type ACLList03Payload,
  type ACLList03ResponsePayload,
} from "../specs/acl/list/0.3/payload.js";
import {
  TYPE_URI as ACL_SHOW,
  RESPONSE_TYPE_URI as ACL_SHOW_RESPONSE,
  type ACLShow02ResponsePayload,
} from "../specs/acl/show/0.2/payload.js";
import {
  TYPE_URI as ACL_REVOKE,
  RESPONSE_TYPE_URI as ACL_REVOKE_RESPONSE,
  type ACLRevoke02Payload,
  type ACLRevoke02ResponsePayload,
  type Revocation,
} from "../specs/acl/revoke/0.2/payload.js";
import {
  TYPE_URI as ACL_UPDATE,
  RESPONSE_TYPE_URI as ACL_UPDATE_RESPONSE,
  type ACLUpdate02Payload,
  type ACLUpdate02ResponsePayload,
} from "../specs/acl/update/0.2/payload.js";
import {
  TYPE_URI as ACL_CHANGE_ROLE,
  RESPONSE_TYPE_URI as ACL_CHANGE_ROLE_RESPONSE,
  type ACLChangeRole02Payload,
  type ACLChangeRole02ResponsePayload,
} from "../specs/acl/change-role/0.2/payload.js";

/**
 * One access-control entry, as AclEntry 0.2 defines it.
 *
 * Re-exported so consumers get it from here rather than reaching for the
 * bindings themselves. 0.2 exists to remove the traps 0.1 carried, and the
 * removal is worth knowing because the old reading is still the intuitive one:
 *
 * - **`act` replaces `scopes`, and has no implicit form.** 0.1's empty
 *   `scopes` meant *everywhere* on an admin role and *nowhere* on every other;
 *   0.2 states `all`, `none` or a non-empty `contexts` list, and role and act
 *   scope are independent members — nothing here computes one from the other.
 * - **`keys` replaces `allowedKeys`.** 0.1's absent-means-every-key and
 *   empty-means-none are now `{scope: "all"}` and `{scope: "none"}`.
 * - **`capabilities` is a member of its own**, no longer an `ext` narrowing:
 *   `ceiling` (the whole role), `none`, or `listed` grants — see
 *   `acl-capabilities.ts` for how a listing is read.
 * - **`approve` absent means none.** So does `approveCapabilities` absent.
 */
export type {
  AclEntry,
  AuthorityScope,
  CapabilityScope,
  ApproveCapabilityScope,
  CapabilityGrant,
  KeyScope,
  Revocation,
};

/** Every `acl/*` call is issued by an identity, to an agent. */
export interface AclCallerParams {
  /** Envelope `issuer` — the caller's DIDComm identity. Its DID needs a role
   *  the agent accepts for this task; the whole family is manage-gated. */
  holder: TaskParty;
  /** The agent — envelope `recipient`. */
  service: TaskParty;
}

export interface AclGrantParams extends AclCallerParams {
  /** The entry the caller wants the agent to hold. `act`, `keys` and
   *  `capabilities` are required by the type because 0.2 has no default for
   *  any of them: an entry that omits one is malformed, not unrestricted. */
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
 * **narrowing** any axis of an existing entry belongs to {@link aclRevoke} or
 * {@link aclUpdate}. A grant to a subject already present with the same role
 * is a re-assertion or a widening, never a reduction — so a reduction in
 * authority always passes through a task that is named and audited as one.
 */
export async function aclGrant(
  sender: TrustTaskSender,
  params: AclGrantParams,
): Promise<AclEntry> {
  // Spread the entry rather than rebuilding it field by field: a hand-rebuilt
  // entry is where a "skip if empty" creeps in, and every scope member here is
  // REQUIRED and explicit — dropping one is a refusal, not a default.
  const payload: ACLGrant02Payload = {
    entry: params.entry,
    ...(params.reason ? { reason: params.reason } : {}),
  };
  const envelope = buildTrustTask(ACL_GRANT, payload, {
    issuer: params.holder.did,
    recipient: params.service.did,
  });
  const res = await sender.send<ACLGrant02ResponsePayload>(envelope, {
    expectedResponseType: ACL_GRANT_RESPONSE,
    operationLabel: "acl/grant/0.2",
  });
  return res.entry;
}

/**
 * How a `context` filter is read. `acl/list/0.3` has **no default** — 0.1
 * defaulted to acting-in, and a revocation sweep that meant `subtree` got the
 * ancestors that keep their authority instead of the leaf grants it existed
 * to cut, in a result short enough to read as complete.
 *
 * - `actingIn` — who may act in this context: entries scoped to it or an
 *   ancestor, and every unrestricted (`act: all`) entry;
 * - `subtree` — entries granted at or beneath it, never an unrestricted one;
 * - `any` — either.
 */
export type AclListDirection = NonNullable<ACLList03Payload["direction"]>;

/**
 * The context filter and its direction travel together or not at all — the
 * agent refuses either without the other, and the type says so first.
 */
export type AclContextFilter =
  | { context: string; direction: AclListDirection }
  | { context?: undefined; direction?: undefined };

export type AclListParams = AclCallerParams &
  AclContextFilter & {
    /** Only entries with this role. */
    role?: string;
    /** Only entries whose **effective** capability set holds this one. */
    capability?: string;
    subjectPrefix?: string;
    /** The page size to ask for — never a cap on the result. */
    limit?: number;
  };

export interface AclListResult {
  /** Every matching entry: the listing is read to the end. */
  entries: AclEntry[];
  /** Fields the agent redacted from returned entries, across every page. */
  redactedFields: string[];
}

/**
 * List ACL entries, filtered, **read to the end**.
 *
 * `acl/list/0.3` pages by `cursor` / `nextCursor` and only an absent
 * `nextCursor` means the last page. Returning the first page would hand an
 * access pane a list that looks complete past the agent's page size (100 by
 * default) — and an ACL is the one listing where an entry missing from the
 * screen is a grant nobody reviews. So the cursor is followed through
 * `collectPages`, which throws rather than truncating when the far side will
 * not end.
 */
export async function aclList(
  sender: TrustTaskSender,
  params: AclListParams,
): Promise<AclListResult> {
  const redacted = new Set<string>();
  const entries = await collectPages("acl/list", async (cursor) => {
    const payload: ACLList03Payload = {
      ...(params.role ? { role: params.role } : {}),
      ...(params.context !== undefined
        ? { context: params.context, direction: params.direction }
        : {}),
      ...(params.capability ? { capability: params.capability } : {}),
      ...(params.subjectPrefix ? { subjectPrefix: params.subjectPrefix } : {}),
      ...(params.limit !== undefined ? { limit: params.limit } : {}),
      ...(cursor ? { cursor } : {}),
    };
    const envelope = buildTrustTask(ACL_LIST, payload, {
      issuer: params.holder.did,
      recipient: params.service.did,
    });
    const res = await sender.send<ACLList03ResponsePayload>(envelope, {
      expectedResponseType: ACL_LIST_RESPONSE,
      operationLabel: "acl/list/0.3",
    });
    for (const f of res.redactedFields ?? []) redacted.add(f);
    return { items: res.entries ?? [], nextCursor: res.nextCursor };
  });
  return { entries, redactedFields: [...redacted] };
}

export interface AclShowParams extends AclCallerParams {
  subject: string;
}

export interface AclShowResult {
  /** `null` when the subject is not in the ACL — a successful answer, not a
   *  failure. The specification is explicit about this; an earlier hand-written
   *  version of this module was not, and typed it as always present. An entry
   *  the caller may not audit is also `null`, so the read does not disclose
   *  existence. */
  entry: AclEntry | null;
  /** Fields the agent withheld from this caller. Empty when nothing was. Never
   *  `act`, `keys` or `capabilities`: those are not redactable. */
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
  const res = await sender.send<ACLShow02ResponsePayload>(envelope, {
    expectedResponseType: ACL_SHOW_RESPONSE,
    operationLabel: "acl/show/0.2",
  });
  return { entry: res.entry ?? null, redactedFields: res.redactedFields ?? [] };
}

export interface AclRevokeParams extends AclCallerParams {
  subject: string;
  /**
   * What to take away, stated — there is no default:
   *
   * - `{ kind: "entry" }` removes the entry and all of its authority;
   * - `{ kind: "act", act }` narrows the act scope to `act`, which the agent
   *   refuses (`notNarrowing`) unless it is strictly narrower than the stored
   *   one.
   *
   * 0.1 spelled "remove the entry" as an omitted `scopes`, so the most
   * destructive request was the one with the least written in it.
   */
  revocation: Revocation;
  reason?: string;
}

/** Revoke an entry, or narrow its act scope. */
export async function aclRevoke(
  sender: TrustTaskSender,
  params: AclRevokeParams,
): Promise<ACLRevoke02ResponsePayload> {
  const payload: ACLRevoke02Payload = {
    subject: params.subject,
    revocation: params.revocation,
    ...(params.reason ? { reason: params.reason } : {}),
  };
  const envelope = buildTrustTask(ACL_REVOKE, payload, {
    issuer: params.holder.did,
    recipient: params.service.did,
  });
  return sender.send<ACLRevoke02ResponsePayload>(envelope, {
    expectedResponseType: ACL_REVOKE_RESPONSE,
    operationLabel: "acl/revoke/0.2",
  });
}

export interface AclChangeRoleParams extends AclCallerParams {
  subject: string;
  /** The role the caller believes the subject holds now. The agent refuses the
   *  change with `stateMismatch` if the stored role differs — a
   *  compare-and-swap, not an assignment, so two admins racing cannot silently
   *  overwrite each other. */
  fromRole: string;
  toRole: string;
  reason?: string;
}

/**
 * Move a subject between roles, compare-and-swapped against `fromRole`.
 *
 * Only the role moves. The act scope is carried across **as stated** and the
 * entry's capabilities are re-evaluated against the new role's ceiling: a move
 * the agent cannot hold — a listed capability outside the new ceiling, or an
 * entry that acts nowhere promoted to a role that cannot — is refused rather
 * than reinterpreted through the new role.
 */
export async function aclChangeRole(
  sender: TrustTaskSender,
  params: AclChangeRoleParams,
): Promise<ACLChangeRole02ResponsePayload> {
  const payload: ACLChangeRole02Payload = {
    subject: params.subject,
    fromRole: params.fromRole,
    toRole: params.toRole,
    ...(params.reason ? { reason: params.reason } : {}),
  };
  const envelope = buildTrustTask(ACL_CHANGE_ROLE, payload, {
    issuer: params.holder.did,
    recipient: params.service.did,
  });
  return sender.send<ACLChangeRole02ResponsePayload>(envelope, {
    expectedResponseType: ACL_CHANGE_ROLE_RESPONSE,
    operationLabel: "acl/change-role/0.2",
  });
}

export interface AclUpdateParams extends AclCallerParams {
  /** VID of the entry to amend. It MUST already exist — this does not create
   *  one, and an agent refuses (`notFound`) rather than upserting. */
  subject: string;
  /**
   * Replacement label. `null` clears it; omitted leaves it unchanged.
   *
   * The distinction between omitted and stated runs through every member
   * below and is the reason this call takes `null` at all rather than treating
   * absence as "clear": on a partial update, absent and cleared are opposite
   * intentions, and a wrapper that collapses them silently wipes whatever it
   * did not mention.
   */
  label?: string | null;
  /**
   * Replacement act scope, applied **wholesale, not merged**.
   *
   * **Narrowing is refused here by the agent, deliberately**
   * (`narrowingNotPermitted`). A reduction in act authority has to pass
   * through {@link aclRevoke} with `{ kind: "act" }`, which is named and
   * audited as a revocation. This is not a limitation to work around.
   */
  act?: AuthorityScope;
  /**
   * Replacement approve scope — what the subject may **ratify for others**,
   * as distinct from what it may do itself.
   *
   * Widening this is an escalation vector rather than a convenience: a subject
   * able to ratify can manufacture an approval for an operation it could not
   * itself authorize. It confers nothing without `approveCapabilities`, which
   * absent means none.
   */
  approve?: AuthorityScope;
  /** Replacement approvable-capability scope. This agent's approve authority
   *  has no capability axis, so it accepts `ceiling` or `none` only. */
  approveCapabilities?: ApproveCapabilityScope;
  /**
   * Replacement capability scope — what the subject may do **within** the
   * role it holds. Omitted leaves it alone; `{scope: "ceiling"}` is the whole
   * role (a privilege *increase* from a narrowed entry); `listed` narrows.
   * Build one with `narrowingToSend`, which carries an additive grant through
   * and refuses the shapes this agent cannot hold.
   */
  capabilities?: CapabilityScope;
  /**
   * Replacement key scope, applied wholesale: `{scope: "all"}` reaches every
   * key the act scope does (a privilege *increase* from a filtered entry),
   * `{scope: "none"}` no keys at all, `listed` exactly those.
   */
  keys?: KeyScope;
  /** Replacement expiry. `null` makes the entry **permanent** — a privilege
   *  increase, which an agent gates at least as strictly as the grant was. */
  expiresAt?: string | null;
  /** Replacement per-entry step-up. Additive only: it may raise the assurance
   *  required of this subject above the system floor, never lower it. */
  stepUp?: ACLUpdate02Payload["stepUp"];
  /** Rationale, recorded with the change. */
  reason?: string;
}

/**
 * Amend the non-role members of an existing ACL entry.
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
  // on two of these members, and a `params.x ? …` guard drops exactly the
  // values that mean the most.
  const payload: ACLUpdate02Payload = {
    subject: params.subject,
    ...(params.label !== undefined ? { label: params.label } : {}),
    ...(params.act !== undefined ? { act: params.act } : {}),
    ...(params.approve !== undefined ? { approve: params.approve } : {}),
    ...(params.approveCapabilities !== undefined
      ? { approveCapabilities: params.approveCapabilities }
      : {}),
    ...(params.capabilities !== undefined ? { capabilities: params.capabilities } : {}),
    ...(params.keys !== undefined ? { keys: params.keys } : {}),
    ...(params.expiresAt !== undefined ? { expiresAt: params.expiresAt } : {}),
    ...(params.stepUp !== undefined ? { stepUp: params.stepUp } : {}),
    ...(params.reason !== undefined ? { reason: params.reason } : {}),
  };
  const envelope = buildTrustTask(ACL_UPDATE, payload, {
    issuer: params.holder.did,
    recipient: params.service.did,
  });
  const res = await sender.send<ACLUpdate02ResponsePayload>(envelope, {
    expectedResponseType: ACL_UPDATE_RESPONSE,
    operationLabel: "acl/update/0.2",
  });
  return res.entry;
}
