// The credential vault — the W3C credentials a holder **holds**.
//
// `vault/credentials/*`: invitations, memberships, roles. It shares the `vault`
// slug and the agent's `vault` keyspace with the password-manager surface in
// this directory, and is otherwise a different thing — the two use disjoint key
// namespaces, and a credential body is a presentable VC rather than a raw
// secret, so nothing here builds or opens a sealed envelope.
//
// Distinct again from `../credentials/`, which is the *exchange* protocol
// (offer, request, present), and from `../admin/credentials.ts`, which is the
// agent as an **issuer**. This module is the holder's own store.
//
// ## Query enumerates; get discloses
//
// `credVaultQuery` returns body-free descriptors and `credVaultGet` returns the
// credential itself, and they are separate calls on purpose: a consumer can
// browse its own vault continuously while the far narrower act of reading a
// credential's contents stays a separate, separately-recorded request. A caller
// that finds itself calling `credVaultGet` in a loop to populate a list has
// mistaken the two.
//
// **`credVaultQuery` refuses an unconstrained filter**, and so must callers.
// An empty filter returns the shape of the holder's whole life — every
// community, every role, every issuer — so the agent rejects it rather than
// answering. `includeArchived` and `includeDeleted` are modifiers and do not
// satisfy the requirement; `{ includeDeleted: true }` alone is an enumeration
// wearing a flag. {@link isRunnableCredentialQuery} is the local check, so a
// caller can disable a control rather than discover this from a rejection.
//
// Wire types come from `@openvtc/trust-tasks`, generated from the same JSON
// Schemas the agent is generated from. Specified in
// `dtgwg-trust-tasks-tf#338`, which wrote the family down from the
// implementation that had been dispatching it unspecified.

import type { TaskParty, TrustTaskSender } from "../vta/channel.js";
import { buildTrustTask } from "../vta/trust-task.js";

import {
  TYPE_URI as CRED_QUERY,
  RESPONSE_TYPE_URI as CRED_QUERY_RESPONSE,
  type VaultCredentialsQueryResponsePayload,
  type CredentialDescriptor,
  type CredentialStatus,
} from "@openvtc/trust-tasks/vault/credentials/query/0.1/payload";
import {
  TYPE_URI as CRED_GET,
  RESPONSE_TYPE_URI as CRED_GET_RESPONSE,
  type VaultCredentialsGetResponsePayload,
} from "@openvtc/trust-tasks/vault/credentials/get/0.1/payload";
import {
  TYPE_URI as CRED_RECEIVE,
  RESPONSE_TYPE_URI as CRED_RECEIVE_RESPONSE,
  type VaultCredentialsReceiveResponsePayload,
} from "@openvtc/trust-tasks/vault/credentials/receive/0.1/payload";
import {
  TYPE_URI as CRED_ARCHIVE,
  RESPONSE_TYPE_URI as CRED_ARCHIVE_RESPONSE,
} from "@openvtc/trust-tasks/vault/credentials/archive/0.1/payload";
import {
  TYPE_URI as CRED_UNARCHIVE,
  RESPONSE_TYPE_URI as CRED_UNARCHIVE_RESPONSE,
} from "@openvtc/trust-tasks/vault/credentials/unarchive/0.1/payload";
import {
  TYPE_URI as CRED_DELETE,
  RESPONSE_TYPE_URI as CRED_DELETE_RESPONSE,
} from "@openvtc/trust-tasks/vault/credentials/delete/0.1/payload";
import {
  TYPE_URI as CRED_RESTORE,
  RESPONSE_TYPE_URI as CRED_RESTORE_RESPONSE,
} from "@openvtc/trust-tasks/vault/credentials/restore/0.1/payload";
import {
  TYPE_URI as CRED_PURGE,
  RESPONSE_TYPE_URI as CRED_PURGE_RESPONSE,
} from "@openvtc/trust-tasks/vault/credentials/purge/0.1/payload";

export type { CredentialDescriptor, CredentialStatus };

/** Archival state. **Orthogonal to validity** — a credential can be `valid`
 *  and `archived`, or `revoked` and `active`. A caller that collapses the two
 *  axes mis-renders its own vault: "can I present this?" needs both, and only
 *  an `active` one may be presented. */
export type CredentialLifecycle = "active" | "archived" | "deleted";

export interface CredVaultCallerParams {
  /** Envelope `issuer`. */
  holder: TaskParty;
  /** The agent — envelope `recipient`. */
  service: TaskParty;
}

/** The indexed fields a query may constrain on. At least one is REQUIRED. */
export interface CredentialFilter {
  /** Match credentials carrying this VC `type` tag. */
  type?: string;
  /** Match credentials held for this community or context DID. */
  communityDid?: string;
  /** Match credentials from this issuer DID. */
  issuerDid?: string;
  /** Match the agent's semantic classification — `invite`, `membership`,
   *  `role`, `endorsement`, `personhood`, or an agent-defined token. */
  purpose?: string;
  /** Match the validity dimension. */
  status?: CredentialStatus;
}

export interface CredVaultQueryParams extends CredVaultCallerParams, CredentialFilter {
  /** Also return archived credentials. A **modifier, not a filter** — it does
   *  not satisfy the at-least-one-filter requirement. */
  includeArchived?: boolean;
  /** Also return soft-deleted tombstones, so a trash view can offer restore or
   *  purge. Same modifier semantics. */
  includeDeleted?: boolean;
}

/**
 * Whether this filter is one the agent will run.
 *
 * Exported so a caller can decide *before* sending — a search box that knows
 * an empty query is refused can stay disabled and say why, rather than firing a
 * request that comes back as an error the user has to interpret.
 *
 * The modifiers are deliberately not counted. They widen what a filter matches;
 * they do not constrain anything.
 */
export function isRunnableCredentialQuery(filter: CredentialFilter): boolean {
  return Boolean(
    filter.type || filter.communityDid || filter.issuerDid || filter.purpose || filter.status,
  );
}

/**
 * Search stored credentials. Returns **body-free** descriptors.
 *
 * Throws before sending when the filter constrains nothing — the agent would
 * refuse it as an enumeration, and failing here names the reason at the call
 * site instead of surfacing a `filterRequired` from three layers down.
 */
export async function credVaultQuery(
  sender: TrustTaskSender,
  params: CredVaultQueryParams,
): Promise<CredentialDescriptor[]> {
  if (!isRunnableCredentialQuery(params)) {
    throw new Error(
      "vault/credentials/query needs at least one of type, communityDid, issuerDid, purpose " +
        "or status. An unconstrained query enumerates the whole vault and the agent refuses " +
        "it; includeArchived and includeDeleted are modifiers and do not count.",
    );
  }
  const envelope = buildTrustTask(
    CRED_QUERY,
    {
      ...(params.type ? { type: params.type } : {}),
      ...(params.communityDid ? { communityDid: params.communityDid } : {}),
      ...(params.issuerDid ? { issuerDid: params.issuerDid } : {}),
      ...(params.purpose ? { purpose: params.purpose } : {}),
      ...(params.status ? { status: params.status } : {}),
      ...(params.includeArchived ? { includeArchived: true } : {}),
      ...(params.includeDeleted ? { includeDeleted: true } : {}),
    },
    { issuer: params.holder.did, recipient: params.service.did },
  );
  const res = await sender.send<VaultCredentialsQueryResponsePayload>(envelope, {
    expectedResponseType: CRED_QUERY_RESPONSE,
    operationLabel: "vault/credentials/query/0.1",
  });
  return res.credentials ?? [];
}

export interface CredVaultGetParams extends CredVaultCallerParams {
  /** Handle from a {@link CredentialDescriptor}. Opaque — never derive one. */
  id: string;
}

/**
 * Fetch one credential's full body, for presentation.
 *
 * The only call in this module that returns credential contents. An archived or
 * soft-deleted credential is not returned: those states mean "not for use", and
 * a body handed back is a body that can be presented.
 *
 * Hold the result no longer than the presentation it was fetched for. The agent
 * remains the record — only it sees a later revocation or lifecycle change, and
 * a cached body outlives both.
 */
export async function credVaultGet(
  sender: TrustTaskSender,
  params: CredVaultGetParams,
): Promise<Record<string, unknown>> {
  const envelope = buildTrustTask(
    CRED_GET,
    { id: params.id },
    { issuer: params.holder.did, recipient: params.service.did },
  );
  const res = await sender.send<VaultCredentialsGetResponsePayload>(envelope, {
    expectedResponseType: CRED_GET_RESPONSE,
    operationLabel: "vault/credentials/get/0.1",
  });
  return res.credential as Record<string, unknown>;
}

export interface CredVaultReceiveParams extends CredVaultCallerParams {
  /** The verifiable credential. */
  credential: Record<string, unknown>;
  /** Handle to store under. Absent, the agent derives one from the
   *  credential's own `id`. Supplying it makes a retry after an ambiguous
   *  failure replace rather than duplicate. */
  id?: string;
  /** Context to hold it in. Absent, the caller's own. */
  contextId?: string;
  /** Credential format, where the body does not make it evident. */
  format?: string;
}

/**
 * Verify and store a received credential.
 *
 * The agent verifies the proof against the issuer key resolved from its DID
 * **before** storing, and stores nothing that fails. There is no `purpose`
 * parameter on purpose: the agent derives the classification from the
 * credential's type tags, so a caller cannot file a credential under a
 * classification its contents do not support.
 */
export async function credVaultReceive(
  sender: TrustTaskSender,
  params: CredVaultReceiveParams,
): Promise<VaultCredentialsReceiveResponsePayload> {
  const envelope = buildTrustTask(
    CRED_RECEIVE,
    {
      credential: params.credential,
      ...(params.id ? { id: params.id } : {}),
      ...(params.contextId ? { contextId: params.contextId } : {}),
      ...(params.format ? { format: params.format } : {}),
    },
    { issuer: params.holder.did, recipient: params.service.did },
  );
  return sender.send<VaultCredentialsReceiveResponsePayload>(envelope, {
    expectedResponseType: CRED_RECEIVE_RESPONSE,
    operationLabel: "vault/credentials/receive/0.1",
  });
}

/** What a lifecycle transition reports back. `lifecycle` is the state *after*
 *  it — echoed rather than inferred from the verb that was called. */
export interface CredVaultLifecycleResult {
  id: string;
  lifecycle: CredentialLifecycle;
  /** Restore deadline. Present after a default `delete`; **absent after a
   *  forced one**, and that absence is how a caller knows nothing can be
   *  restored. */
  graceUntil?: string;
}

export interface CredVaultLifecycleParams extends CredVaultCallerParams {
  id: string;
  /** Recorded with the transition. Must not carry credential contents — it
   *  lands in a trail read by people entitled to know a credential changed
   *  state without being entitled to know what it said. */
  reason?: string;
}

function lifecycleCall(
  sender: TrustTaskSender,
  params: CredVaultLifecycleParams,
  type: string,
  responseType: string,
  label: string,
  extra: Record<string, unknown> = {},
): Promise<CredVaultLifecycleResult> {
  const envelope = buildTrustTask(
    type,
    { id: params.id, ...(params.reason ? { reason: params.reason } : {}), ...extra },
    { issuer: params.holder.did, recipient: params.service.did },
  );
  return sender.send<CredVaultLifecycleResult>(envelope, {
    expectedResponseType: responseType,
    operationLabel: label,
  });
}

/** Hide from default query results and refuse for presentation. Reversible
 *  with {@link credVaultUnarchive}; the credential is untouched. */
export function credVaultArchive(
  sender: TrustTaskSender,
  params: CredVaultLifecycleParams,
): Promise<CredVaultLifecycleResult> {
  return lifecycleCall(
    sender, params, CRED_ARCHIVE, CRED_ARCHIVE_RESPONSE, "vault/credentials/archive/0.1");
}

/** Return an archived credential to active. Refuses a soft-deleted one — that
 *  comes back through {@link credVaultRestore}, which has a deadline. */
export function credVaultUnarchive(
  sender: TrustTaskSender,
  params: CredVaultLifecycleParams,
): Promise<CredVaultLifecycleResult> {
  return lifecycleCall(
    sender, params, CRED_UNARCHIVE, CRED_UNARCHIVE_RESPONSE, "vault/credentials/unarchive/0.1");
}

export interface CredVaultDeleteParams extends CredVaultLifecycleParams {
  /**
   * Erase immediately instead of tombstoning. **Irrecoverable** — no grace
   * window, no restore, and the result carries no `graceUntil`.
   *
   * The default path exists because a credential cannot be re-obtained by
   * asking nicely: re-issuance means going back to the issuer, and for an
   * invitation or a one-time membership that may not be possible at all.
   */
  force?: boolean;
}

/** Move to a recoverable tombstone, or erase outright with `force`. */
export function credVaultDelete(
  sender: TrustTaskSender,
  params: CredVaultDeleteParams,
): Promise<CredVaultLifecycleResult> {
  return lifecycleCall(
    sender, params, CRED_DELETE, CRED_DELETE_RESPONSE, "vault/credentials/delete/0.1",
    params.force ? { force: true } : {});
}

/** Return a soft-deleted credential to active, while its grace window lasts.
 *  After `graceUntil` the agent has erased it and there is nothing to restore. */
export function credVaultRestore(
  sender: TrustTaskSender,
  params: CredVaultLifecycleParams,
): Promise<CredVaultLifecycleResult> {
  return lifecycleCall(
    sender, params, CRED_RESTORE, CRED_RESTORE_RESPONSE, "vault/credentials/restore/0.1");
}

/** Erase immediately and irrecoverably. No tombstone, no grace window. */
export function credVaultPurge(
  sender: TrustTaskSender,
  params: CredVaultLifecycleParams,
): Promise<CredVaultLifecycleResult> {
  return lifecycleCall(
    sender, params, CRED_PURGE, CRED_PURGE_RESPONSE, "vault/credentials/purge/0.1");
}
