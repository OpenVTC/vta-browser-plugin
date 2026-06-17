// Vault — upsert (M2A.5).
//
// Posts a `https://trusttasks.org/spec/vault/upsert/0.2` envelope to the
// VTA's trust-task dispatcher. The cleartext secret is wrapped in a
// DIDComm authcrypt envelope (the `didcomm-authcrypt` variant of the
// canonical SealedEnvelope schema), so the long-term credential rides
// the wire as ciphertext only — even the VTA's own logs see just the
// JWE.
//
// Flow:
//  1. Build the cleartext VaultSecret JSON.
//  2. Pack it as authcrypt: sender = holder's keyAgreement, recipient =
//     VTA's keyAgreement (same primitive the auth handshake uses, just
//     pointing the opposite direction with a different message body).
//  3. Bearer-auth via `getVtaBearer` (REST + DIDComm-authcrypt /auth/
//     round-trip).
//  4. POST the upsert envelope with `sealedSecret: { envelope:
//     "didcommAuthcrypt", jwe }`.
//  5. Return the maintainer's response (metadata view + `created` flag).

import { packAuthcrypt, type Identity } from "../didcomm/index.js";
import type { RemoteDidcommEndpoint } from "../vta/didcomm.js";

import type { SecretKind, SiteTarget, VaultEntry } from "./list.js";
import { getVtaBearer, postTrustTask, type VtaAuthInputs } from "./transport.js";

const TASK_VAULT_UPSERT = "https://trusttasks.org/spec/vault/upsert/0.2";
const TASK_VAULT_UPSERT_RESPONSE = "https://trusttasks.org/spec/vault/upsert/0.2#response";
const INNER_MSG_TYPE = "https://openvtc.org/vault/upsert/secret-envelope/1.0";

/** Optional driver config on Password-kind entries — instructs the
 *  VTA to POST these credentials at a specific URL during
 *  `vault/proxy-login/0.1`. Mirrors
 *  `vault/_shared/0.1/vault-secret#/$defs/PasswordLoginConfig`. */
export interface PasswordLoginConfig {
  loginUrl: string;
  format?: "json" | "formUrlencoded";
  usernameField?: string;
  passwordField?: string;
  totpField?: string;
  extraFields?: Record<string, string>;
  successStatus?: number[];
}

/** Cleartext shape of the inner DIDComm message body — matches the
 *  canonical `vault/_shared/0.1/vault-secret#/$defs/VaultSecret` tagged
 *  union. M2A ships Password / Passkey / OauthTokens / BearerToken /
 *  Custom; M2B.4 adds `did-self-issued`. `didcomm-peer` and `ssh-key`
 *  follow when the UI grows fields for them. */
export type VaultSecret =
  | {
      kind: "password";
      username?: string;
      password: string;
      loginConfig?: PasswordLoginConfig;
      secureNotes?: string;
    }
  | {
      kind: "passkey";
      credentialId: string;
      privateKey: string;
      algorithm?: string;
      rpId: string;
      userHandle?: string;
      secureNotes?: string;
    }
  | {
      kind: "oauthTokens";
      provider: string;
      refreshToken: string;
      accessToken?: string;
      accessTokenExpiresAt?: string;
      scopes?: string[];
      secureNotes?: string;
    }
  | {
      kind: "didSelfIssued";
      /** The persona DID the entry acts AS (becomes the SIOP `iss`
       *  + `sub`). */
      did: string;
      /** Key the VTA uses to sign the id_token. References a key the
       *  VTA's keystore can resolve — typically `<did>#key-0`. */
      signingKeyId: string;
      secureNotes?: string;
    }
  | {
      kind: "bearerToken";
      token: string;
      headerName?: string;
      headerPrefix?: string;
      secureNotes?: string;
    }
  | {
      kind: "custom";
      fields: Array<{ name: string; value: string; hidden?: boolean; kind?: string }>;
      secureNotes?: string;
    };

export interface VaultUpsertRestOptions extends VtaAuthInputs {
  /** Omit to create with a maintainer-assigned ULID; supply to update or
   *  upsert-with-id. */
  id?: string;
  /** REQUIRED on update — the consumer's last-observed `version`. */
  expectedVersion?: number;
  contextId: string;
  targets: SiteTarget[];
  label: string;
  secretKind: SecretKind;
  tags?: string[];
  notes?: string;
  favicon?: string;
  selectors?: string[];
  customFieldNames?: string[];
  expiresAt?: string;
  /** REQUIRED on create unless secretKind is `did-self-issued` or
   *  `didcomm-peer`. On update, supply to rotate the secret; omit to
   *  keep the existing secret untouched. */
  secret?: VaultSecret;
  /** Metadata fields to explicitly null out. */
  clearFields?: Array<
    "notes" | "favicon" | "expiresAt" | "tags" | "selectors" | "customFieldNames"
  >;
}

export interface VaultUpsertResponse {
  entry: VaultEntry;
  created: boolean;
}

/**
 * Create or update a vault entry. The cleartext secret never crosses
 * the wire in plain — it's authcrypt-packed to the VTA's keyAgreement
 * key. The maintainer unseals server-side, validates the variant
 * against `secretKind`, and persists.
 */
export async function vaultUpsertRest(
  opts: VaultUpsertRestOptions,
): Promise<VaultUpsertResponse> {
  const bearer = await getVtaBearer({
    baseUrl: opts.baseUrl,
    holder: opts.holder,
    service: opts.service,
    ...(opts.fetch ? { fetch: opts.fetch } : {}),
  });

  // Build the sealedSecret envelope — only built when `secret` is
  // supplied. Update paths that keep the existing secret pass no
  // sealedSecret at all.
  let sealedSecret: { envelope: "didcommAuthcrypt"; jwe: string } | undefined;
  if (opts.secret) {
    const jwe = await packSecretAsAuthcrypt({
      secret: opts.secret,
      holder: opts.holder,
      service: opts.service,
    });
    sealedSecret = { envelope: "didcommAuthcrypt", jwe };
  }

  const payload = {
    ...(opts.id ? { id: opts.id } : {}),
    ...(opts.expectedVersion !== undefined ? { expectedVersion: opts.expectedVersion } : {}),
    contextId: opts.contextId,
    targets: opts.targets,
    label: opts.label,
    secretKind: opts.secretKind,
    ...(opts.tags ? { tags: opts.tags } : {}),
    ...(opts.notes !== undefined ? { notes: opts.notes } : {}),
    ...(opts.favicon ? { favicon: opts.favicon } : {}),
    ...(opts.selectors ? { selectors: opts.selectors } : {}),
    ...(opts.customFieldNames ? { customFieldNames: opts.customFieldNames } : {}),
    ...(opts.expiresAt ? { expiresAt: opts.expiresAt } : {}),
    ...(sealedSecret ? { sealedSecret } : {}),
    ...(opts.clearFields ? { clearFields: opts.clearFields } : {}),
  };

  return postTrustTask<VaultUpsertResponse>({
    baseUrl: opts.baseUrl,
    bearer,
    envelope: {
      type: TASK_VAULT_UPSERT,
      payload,
      issuer: opts.holder.did,
      recipient: opts.service.did,
    },
    expectedResponseType: TASK_VAULT_UPSERT_RESPONSE,
    operationLabel: "vault/upsert/0.2",
    ...(opts.fetch ? { fetch: opts.fetch } : {}),
  });
}

async function packSecretAsAuthcrypt(opts: {
  secret: VaultSecret;
  holder: Identity;
  service: RemoteDidcommEndpoint;
}): Promise<string> {
  const innerMsg = {
    id: globalThis.crypto.randomUUID(),
    type: INNER_MSG_TYPE,
    from: opts.holder.did,
    to: [opts.service.did],
    body: opts.secret as unknown as Record<string, unknown>,
  };
  return packAuthcrypt(innerMsg, opts.holder, [
    { kid: opts.service.keyAgreementKid, jwk: opts.service.keyAgreementPublicJwk },
  ]);
}
