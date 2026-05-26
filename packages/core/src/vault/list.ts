// Vault — list (M1).
//
// Posts a `https://trusttasks.org/spec/vault/list/0.1` envelope to the VTA's
// trust-task dispatcher (`POST /api/trust-tasks`) and returns the metadata
// view of stored credentials. Read-only — secret material never crosses the
// wire (it's only released by `vault/release/0.1`, which lands in M2).
//
// Authentication: the wallet authcrypts a `atm/1.0/authenticate` DIDComm
// message to the VTA's keyAgreement key (same primitive `swapAclRest` uses)
// to obtain a short-lived bearer token, then attaches the token to the
// trust-tasks POST. No token caching in M1 — every list call does a fresh
// auth round-trip. Caching can land in M2 alongside vault/sync.
//
// Holder authentication: the wallet's holder did:peer must be in the VTA's
// ACL (placed there by the M0.7 swap-acl flow) and must carry the derived
// `VaultRead` capability — Admin / Initiator / Application / Reader pass;
// Monitor is denied.

import { packAuthcrypt, type Identity } from "../didcomm/index.js";
import type { RemoteDidcommEndpoint } from "../vta/didcomm.js";

const TASK_VAULT_LIST_0_1 = "https://trusttasks.org/spec/vault/list/0.1";
const TASK_VAULT_LIST_0_1_RESPONSE = "https://trusttasks.org/spec/vault/list/0.1#response";
const VTA_AUTHENTICATE = "https://affinidi.com/atm/1.0/authenticate";

/** Discriminator that mirrors the canonical SecretKind enum. */
export type SecretKind =
  | "password"
  | "passkey"
  | "oauth-tokens"
  | "did-self-issued"
  | "didcomm-peer"
  | "bearer-token"
  | "ssh-key"
  | "custom";

/** Tagged union — see `vault/_shared/0.1/vault-entry.schema.json` $defs/SiteTarget. */
export type SiteTarget =
  | { kind: "web-origin"; origin: string }
  | { kind: "did"; did: string }
  | { kind: "ios-app"; bundleId: string; teamId?: string }
  | { kind: "android-app"; packageName: string; sha256CertFingerprints: string[] };

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
}

/** Filters accepted by vault/list/0.1. All AND-combined. */
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
 * canonical vault/list/0.1 Trust Task envelope and return the parsed
 * entries. Single round-trip's worth of auth — no token cache in M1.
 */
export async function vaultListRest(opts: VaultListRestOptions): Promise<VaultListResponse> {
  const { baseUrl, holder, service, filter } = opts;
  const f = opts.fetch ?? fetch.bind(globalThis);
  const base = baseUrl.replace(/\/+$/, "");

  // 1. /auth/challenge → flat { challenge, sessionId, expiresAt } per
  //    `vti_common::auth::handlers::challenge::ChallengeResponse`. Fields
  //    are top-level, NOT nested under a `data` envelope.
  const cRes = await f(`${base}/auth/challenge`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ did: holder.did }),
  });
  if (!cRes.ok) {
    throw new Error(`vta /auth/challenge failed (${cRes.status}): ${await cRes.text()}`);
  }
  const cBody = (await cRes.json()) as { sessionId?: string; challenge?: string };
  if (!cBody.sessionId || !cBody.challenge) {
    throw new Error(`vta /auth/challenge: malformed response: ${JSON.stringify(cBody)}`);
  }

  // 2. Authcrypt an `atm/1.0/authenticate` message to the VTA.
  const authMsg = {
    id: globalThis.crypto.randomUUID(),
    type: VTA_AUTHENTICATE,
    from: holder.did,
    to: [service.did],
    body: { challenge: cBody.challenge, session_id: cBody.sessionId },
  };
  const packed = await packAuthcrypt(authMsg, holder, [
    { kid: service.keyAgreementKid, jwk: service.keyAgreementPublicJwk },
  ]);

  // 3. POST the packed JWE to /auth/ → AuthenticateResponse with
  //    { session, tokens: { accessToken, ... } } per vta-sdk's
  //    `protocols::auth::AuthenticateResponse`. Tokens are nested under
  //    `tokens`, NOT `data`.
  const aRes = await f(`${base}/auth/`, {
    method: "POST",
    headers: { "content-type": "application/didcomm-encrypted+json" },
    body: packed,
  });
  if (!aRes.ok) {
    throw new Error(`vta /auth/ failed (${aRes.status}): ${await aRes.text()}`);
  }
  const aBody = (await aRes.json()) as { tokens?: { accessToken?: string } };
  const accessToken = aBody.tokens?.accessToken;
  if (!accessToken) {
    throw new Error(`vta /auth/: malformed response: ${JSON.stringify(aBody)}`);
  }

  // 4. POST /api/trust-tasks with the vault/list/0.1 envelope.
  const envelope = {
    id: globalThis.crypto.randomUUID(),
    type: TASK_VAULT_LIST_0_1,
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

  if (tBody.type !== TASK_VAULT_LIST_0_1_RESPONSE) {
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
