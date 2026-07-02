// Vault — list (M1).
//
// Posts a `https://trusttasks.org/spec/vault/list/0.2` envelope to the VTA's
// trust-task dispatcher (`POST /api/trust-tasks`) and returns the metadata
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
import type { TrustTaskChannel } from "../vta/channel.js";
import type { RemoteDidcommEndpoint } from "../vta/didcomm.js";
import { RestChannel } from "../vta/rest-channel.js";
import { buildTrustTask } from "../vta/trust-task.js";

import type { VtaAuthInputs } from "./transport.js";

const TASK_VAULT_LIST_0_2 = "https://trusttasks.org/spec/vault/list/0.2";
const TASK_VAULT_LIST_0_2_RESPONSE = "https://trusttasks.org/spec/vault/list/0.2#response";

/** Discriminator that mirrors the canonical SecretKind enum. */
export type SecretKind =
  | "password"
  | "passkey"
  | "oauthTokens"
  | "didSelfIssued"
  | "didcommPeer"
  | "bearerToken"
  | "sshKey"
  | "custom";

/** Tagged union — see `vault/_shared/0.1/vault-entry.schema.json` $defs/SiteTarget. */
export type SiteTarget =
  | { kind: "webOrigin"; origin: string }
  | { kind: "did"; did: string }
  | { kind: "iosApp"; bundleId: string; teamId?: string }
  | { kind: "androidApp"; packageName: string; sha256CertFingerprints: string[] };

/** Metadata view of a single vault entry. No secret bytes. */
export interface VaultEntry {
  id: string;
  contextId: string;
  targets: SiteTarget[];
  label: string;
  secretKind: SecretKind;
  tags?: string[];
  notes?: string;
  favicon?: string;
  selectors?: string[];
  customFieldNames?: string[];
  attachments?: Array<{
    id: string;
    name: string;
    sizeBytes: number;
    sha256: string;
    contentType?: string;
  }>;
  expiresAt?: string;
  breachedAt?: string;
  passwordChangedAt?: string;
  createdAt: string;
  createdBy?: string;
  updatedAt: string;
  updatedBy?: string;
  lastUsedAt?: string;
  version: number;
  /** Cached DID the entry acts AS for DID-shaped flows. Mirrors the
   *  `did` field of `did-self-issued` / `didcomm-peer` secrets;
   *  absent for kinds without a DID concept. Maintainer-derived from
   *  the secret at every upsert — a producer-supplied value on the
   *  wire is ignored. */
  principalDid?: string;
}

/** Filters accepted by vault/list/0.2. All AND-combined. */
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
 * Post the canonical vault/list/0.2 Trust Task over the given channel and
 * return the parsed metadata entries. Read-only — no secret material crosses
 * the wire.
 */
export async function vaultList(
  channel: TrustTaskChannel,
  params: VaultListParams,
): Promise<VaultListResponse> {
  const envelope = buildTrustTask(TASK_VAULT_LIST_0_2, params.filter ?? {}, {
    issuer: params.holder.did,
    recipient: params.service.did,
  });
  const payload = await channel.send<{
    entries?: VaultEntry[];
    truncated?: boolean;
    cursor?: string;
    redactedFields?: string[];
  }>(envelope, {
    expectedResponseType: TASK_VAULT_LIST_0_2_RESPONSE,
    operationLabel: "vault/list/0.2",
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
