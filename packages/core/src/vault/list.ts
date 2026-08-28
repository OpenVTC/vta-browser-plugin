// Vault — list (M1).
//
// Posts a `https://trusttasks.org/spec/vault/list/0.3` envelope to the VTA's
// trust-task dispatcher (`POST /trust-tasks`) and returns the metadata
// view of stored credentials. Read-only — secret material never crosses the
// wire (it's only released by `vault/release/0.1`, which lands in M2).
//
// Authentication: the wallet authcrypts a `auth/authenticate/0.1` DIDComm
// message to the VTA's keyAgreement key (same primitive `swapAclRest` uses)
// to obtain a short-lived bearer token, then attaches the token to the
// trust-tasks POST. No token caching in M1 — every list call does a fresh
// auth round-trip. Caching can land in M2 alongside vault/sync.
//
// Holder authentication: the wallet's holder did:peer must be in the VTA's
// ACL (placed there by the M0.7 swap-acl flow) and must carry the derived
// `VaultRead` capability — Admin / Initiator / Application / Reader pass;
// Monitor is denied.

import { type Identity } from "../didcomm/index.js";
import type { TrustTaskSender } from "../vta/channel.js";
import type { RemoteDidcommEndpoint } from "../vta/didcomm.js";
import { RestChannel } from "../vta/rest-channel.js";
import { buildTrustTask } from "../vta/trust-task.js";

import type { VtaAuthInputs } from "../vta/auth.js";

import {
  TYPE_URI as VAULT_LIST,
  RESPONSE_TYPE_URI as VAULT_LIST_RESPONSE,
  type SecretKind,
  type VaultEntry,
} from "@openvtc/trust-tasks/vault/list/0.3/payload";

/**
 * The wire types come from the generated bindings, which are compiled from the
 * same JSON Schemas the agent's own implementation is generated from.
 *
 * They used to be hand-written here from `vault/_shared/0.1` — a version older
 * than the `0.2` task this module posts, which is the drift a copy invites and
 * cannot signal. The copy had also lost a constraint the schema states:
 * `targets` is a **non-empty** array, and an entry that reaches nothing is not
 * a vault entry. The names below are this package's published API, so they are
 * kept as aliases rather than renamed to the generated spellings.
 */
export type {
  SecretKind,
  SiteTarget,
  AttachmentRef,
  VaultEntry,
} from "@openvtc/trust-tasks/vault/list/0.3/payload";

// ── Attachment integrity is a `digestMultibase`, not a hex string ───────────
//
// `AttachmentRef` at vault 0.2 carried `sha256`: a bare hex string, which
// hard-codes one algorithm into the wire contract. `vault/_shared/0.3` replaces
// it with `digestMultibase` — a self-describing multibase-encoded multihash,
// the same type `task-consent`'s `payloadDigest` uses, decodable by
// `../trust-tasks/digest.ts`.
//
// **Verify it before trusting an attachment, and decode rather than compare
// strings.** Two encodings of one digest are the same digest; two multibase
// strings that differ may not be two different files. `decodeDigestMultibase`
// is the comparison, and it refuses anything that is not a well-formed
// sha2-256 multihash rather than guessing.

/** Filters accepted by vault/list/0.3. All AND-combined. */
export interface VaultListFilter {
  contextId?: string;
  targetOriginPrefix?: string;
  targetDid?: string;
  targetIosBundleId?: string;
  targetAndroidPackage?: string;
  secretKind?: SecretKind;
  tag?: string;
  usedSince?: string;
  neverUsed?: boolean;
  expiresBefore?: string;
  breached?: boolean;
  pageSize?: number;
  cursor?: string;
}

export interface VaultListResponse {
  entries: VaultEntry[];
  truncated: boolean;
  cursor?: string;
  redactedFields?: string[];
}

export interface VaultListParams {
  /** Authcrypt sender / envelope `issuer` (the holder's DIDComm identity). */
  holder: Identity;
  /** VTA's keyAgreement endpoint — envelope `recipient`. */
  service: RemoteDidcommEndpoint;
  /** Filters (omit for "all entries the caller can read"). */
  filter?: VaultListFilter;
}

/** @deprecated REST-transport options. Kept for existing call sites; prefer
 *  {@link vaultList} with a channel from a `VtaSession`. */
export interface VaultListRestOptions extends VaultListParams, VtaAuthInputs {}

/**
 * Post the canonical vault/list/0.3 Trust Task over the given channel and
 * return the parsed metadata entries. Read-only — no secret material crosses
 * the wire.
 */
export async function vaultList(
  channel: TrustTaskSender,
  params: VaultListParams,
): Promise<VaultListResponse> {
  const envelope = buildTrustTask(VAULT_LIST, params.filter ?? {}, {
    issuer: params.holder.did,
    recipient: params.service.did,
  });
  const payload = await channel.send<{
    entries?: VaultEntry[];
    truncated?: boolean;
    cursor?: string;
    redactedFields?: string[];
  }>(envelope, {
    expectedResponseType: VAULT_LIST_RESPONSE,
    operationLabel: "vault/list/0.3",
  });

  return {
    entries: payload.entries ?? [],
    truncated: payload.truncated ?? false,
    ...(payload.cursor ? { cursor: payload.cursor } : {}),
    ...(payload.redactedFields ? { redactedFields: payload.redactedFields } : {}),
  };
}

/** @deprecated Use {@link vaultList} with a channel from a `VtaSession`.
 *  List over REST — builds a one-shot {@link RestChannel}. */
export function vaultListRest(opts: VaultListRestOptions): Promise<VaultListResponse> {
  return vaultList(new RestChannel(opts), opts);
}
