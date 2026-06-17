// Vault — release (M2A.5).
//
// Posts a `https://trusttasks.org/spec/vault/release/0.2` envelope and
// unpacks the maintainer's authcrypt-sealed response into the cleartext
// `VaultSecret`. The secret bytes only ever live in the holder's local
// memory for the duration of the `ttlSeconds` the maintainer caps; the
// caller MUST wipe them at TTL even if the user hasn't finished
// interacting (in practice: a `setTimeout` that clears the popup's
// "reveal" state).

import { unpackMessage, type Identity } from "../didcomm/index.js";

import type { SecretKind } from "./list.js";
import { getVtaBearer, makeReauth, postTrustTask, type VtaAuthInputs } from "./transport.js";
import type { VaultSecret } from "./upsert.js";

const TASK_VAULT_RELEASE = "https://trusttasks.org/spec/vault/release/0.2";
const TASK_VAULT_RELEASE_RESPONSE = "https://trusttasks.org/spec/vault/release/0.2#response";

export interface VaultReleaseRestOptions extends VtaAuthInputs {
  entryId: string;
  /** Caller's preferred cache TTL in seconds. The maintainer caps
   *  server-side (M2A.3 ceiling is 60 s); honoured up to the cap. */
  ttlSecondsHint?: number;
}

export interface VaultReleaseResponse {
  /** Unpacked secret material. Caller MUST wipe / zero this reference
   *  no later than `ttlSeconds` after the release call returned. */
  secret: VaultSecret;
  /** Maintainer-declared discriminator — mirrors `secret.kind`. */
  secretKind: SecretKind;
  /** Enforced cache TTL. Already capped by the maintainer; the caller
   *  MUST honour it. */
  ttlSeconds: number;
}

/**
 * Release the cleartext secret material of a vault entry. The
 * maintainer authcrypts the secret to the holder's keyAgreement key;
 * this helper unpacks the resulting JWE locally.
 *
 * The unpacked secret is returned in plaintext — callers MUST schedule
 * a wipe at `ttlSeconds` (e.g. via `setTimeout`) and MUST NOT persist
 * the cleartext beyond that window (no disk, no logs, no syncing
 * storage).
 */
export async function vaultReleaseRest(
  opts: VaultReleaseRestOptions,
): Promise<VaultReleaseResponse> {
  const auth: VtaAuthInputs = {
    baseUrl: opts.baseUrl,
    holder: opts.holder,
    service: opts.service,
    ...(opts.fetch ? { fetch: opts.fetch } : {}),
  };
  const bearer = await getVtaBearer(auth);

  // Server returns { sealedSecret: SealedEnvelope, secretKind, ttlSeconds }.
  // We accept only the authcrypt variant — every other variant is a future /
  // unsupported envelope kind and we reject loudly so the user sees an
  // actionable error rather than a silent "decrypt failed". The 0.2 wire tag
  // is lowerCamelCase (`didcommAuthcrypt`); we also tolerate the legacy
  // kebab form for resilience against VTA deployment skew.
  interface WireResponse {
    sealedSecret:
      | { envelope: "didcommAuthcrypt" | "didcomm-authcrypt"; jwe: string }
      | { envelope: "hpkeArmored" }
      | { envelope: "tspMessage" };
    secretKind: SecretKind;
    ttlSeconds: number;
  }

  const wire = await postTrustTask<WireResponse>({
    baseUrl: opts.baseUrl,
    bearer,
    envelope: {
      type: TASK_VAULT_RELEASE,
      payload: {
        entryId: opts.entryId,
        ...(opts.ttlSecondsHint !== undefined
          ? { ttlSecondsHint: opts.ttlSecondsHint }
          : {}),
      },
      issuer: opts.holder.did,
      recipient: opts.service.did,
    },
    expectedResponseType: TASK_VAULT_RELEASE_RESPONSE,
    operationLabel: "vault/release/0.2",
    reauth: makeReauth(auth),
    ...(opts.fetch ? { fetch: opts.fetch } : {}),
  });

  if (
    wire.sealedSecret.envelope !== "didcommAuthcrypt" &&
    wire.sealedSecret.envelope !== "didcomm-authcrypt"
  ) {
    throw new Error(
      `vault/release: unsupported envelope ${wire.sealedSecret.envelope} — this wallet only understands didcommAuthcrypt`,
    );
  }

  // The VTA authcrypts the secret to the holder; the unpacker needs
  // the VTA's keyAgreement public JWK to verify the sender binding.
  // Same shape as vault/proxy-login — see that file for the longer
  // explanation. Latent in this file since M2A.3 (release was never
  // end-to-end tested with a real VTA before M2B.4 demos exposed
  // the failure on the parallel proxy-login path).
  const unpacked = await unpackMessage(
    {
      input: wire.sealedSecret.jwe,
      sender_public_jwk: opts.service.keyAgreementPublicJwk,
    },
    opts.holder,
  );
  if (unpacked.kind !== "encrypted") {
    throw new Error(
      `vault/release: unpacked JWE was not authcrypt-encrypted (kind=${unpacked.kind})`,
    );
  }
  // Defence-in-depth: the unpacked message MUST be authenticated (the
  // VTA's signature verified) — anoncrypt-only would be a downgrade.
  if (!unpacked.authenticated) {
    throw new Error("vault/release: unpacked JWE was not authenticated (anoncrypt downgrade)");
  }

  // The cleartext body IS the VaultSecret JSON. Cast it directly — the
  // server-side validation already ensured the variant discriminator
  // matches `secretKind`.
  const body = (unpacked.message as Record<string, unknown>).body as
    | Record<string, unknown>
    | undefined;
  if (!body || typeof body !== "object") {
    throw new Error("vault/release: unpacked DIDComm message has no body");
  }
  return {
    secret: body as unknown as VaultSecret,
    secretKind: wire.secretKind,
    ttlSeconds: wire.ttlSeconds,
  };
}

// `Identity` is re-imported here so consumers of `vault/release` don't need
// to import it from `didcomm/index` separately — keeps the public surface
// flat (`import { vaultReleaseRest, type Identity } from "@openvtc/pnm-core"`).
export type { Identity };
