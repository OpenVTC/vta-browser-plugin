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
import type { RemoteDidcommEndpoint } from "../vta/didcomm.js";

import { getVtaBearer } from "./transport.js";

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

export interface VaultListRestOptions {
  /** VTA REST base URL — from the connection state's `restBaseUrl`. */
  baseUrl: string;
  /** Authcrypt sender (the holder's DIDComm identity post-onboarding swap). */
  holder: Identity;
  /** VTA's keyAgreement endpoint (resolved via `resolveKeyAgreement`). */
  service: RemoteDidcommEndpoint;
  /** Filters (omit for "all entries the caller can read"). */
  filter?: VaultListFilter;
  /** fetch impl (defaults to global). */
  fetch?: typeof fetch;
}

/**
 * Authenticate to the VTA over REST + DIDComm-authcrypt, then post the
 * canonical vault/list/0.2 Trust Task envelope and return the parsed
 * entries. Single round-trip's worth of auth — no token cache in M1.
 */
export async function vaultListRest(opts: VaultListRestOptions): Promise<VaultListResponse> {
  const { baseUrl, holder, service, filter } = opts;
  const f = opts.fetch ?? fetch.bind(globalThis);
  const base = baseUrl.replace(/\/+$/, "");

  // 1. Authenticate via the shared, cached bearer helper (same
  //    /auth/challenge → authcrypt /auth/ → token primitive). Caching
  //    means a sign-in that lists then signs reuses one token rather than
  //    re-authing per op (which trips the VTA's per-IP unauth rate limit).
  const accessToken = await getVtaBearer({
    baseUrl,
    holder,
    service,
    ...(opts.fetch ? { fetch: opts.fetch } : {}),
  });

  // 2. POST /api/trust-tasks with the vault/list/0.2 envelope.
  const envelope = {
    id: globalThis.crypto.randomUUID(),
    type: TASK_VAULT_LIST_0_2,
    issuer: holder.did,
    recipient: service.did,
    issuedAt: new Date().toISOString(),
    payload: filter ?? {},
  };
  const tRes = await f(`${base}/api/trust-tasks`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      authorization: `Bearer ${accessToken}`,
    },
    body: JSON.stringify(envelope),
  });
  if (!tRes.ok) {
    throw new Error(
      `vta /api/trust-tasks vault/list failed (${tRes.status}): ${await tRes.text()}`,
    );
  }
  const tBody = (await tRes.json()) as {
    type?: string;
    payload?: {
      entries?: VaultEntry[];
      truncated?: boolean;
      cursor?: string;
      redactedFields?: string[];
    };
  };

  if (tBody.type !== TASK_VAULT_LIST_0_2_RESPONSE) {
    throw new Error(
      `vault/list: unexpected response type ${tBody.type ?? "(none)"} — ${JSON.stringify(tBody)}`,
    );
  }
  const entries = tBody.payload?.entries ?? [];
  return {
    entries,
    truncated: tBody.payload?.truncated ?? false,
    ...(tBody.payload?.cursor ? { cursor: tBody.payload.cursor } : {}),
    ...(tBody.payload?.redactedFields ? { redactedFields: tBody.payload.redactedFields } : {}),
  };
}
