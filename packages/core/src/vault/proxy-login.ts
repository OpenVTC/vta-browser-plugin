// Vault — proxy-login (M2B.3).
//
// Posts a `https://trusttasks.org/spec/vault/proxy-login/0.2` envelope.
// The VTA performs the login at the bound third-party site on the
// holder's behalf, returns a `SessionBlob` (cookies + headers needed to
// operate the resulting session) inside a `didcomm-authcrypt` JWE, and
// the holder unpacks it locally — exactly the same outer machinery as
// `vault/release`, just with a `SessionBlob` cleartext payload instead
// of a `VaultSecret`.
//
// The long-term credential (the entry's password, DID signing key, or
// OAuth refresh token) never leaves the VTA in this flow. The holder
// only ever sees the short-lived session material — a SIOPv2 id_token
// for DID-self-issued entries (M2B.2b), a cookie jar for Password POST
// (M2B.5), etc.
//
// Callers MUST treat the returned `sessionBlob` like a release secret:
// in-memory only, wiped no later than `expiresAt`. The maintainer caps
// `expiresAt` server-side; the wallet honours it via a setTimeout that
// clears the in-memory copy.
//
// M2B.3 implements the response side; the actual injection of cookies /
// headers into the page lives in the extension (declarativeNetRequest
// for headers, chrome.cookies.set for cookies) — those bindings live in
// the extension layer because @openvtc/pnm-core is browser-agnostic.

import { unpackMessage, type Identity } from "../didcomm/index.js";

import type { SiteTarget } from "./list.js";
import { getVtaBearer, postTrustTask, type VtaAuthInputs } from "./transport.js";

const TASK_VAULT_PROXY_LOGIN = "https://trusttasks.org/spec/vault/proxy-login/0.2";
const TASK_VAULT_PROXY_LOGIN_RESPONSE =
  "https://trusttasks.org/spec/vault/proxy-login/0.2#response";

/** Refresh hint the maintainer attaches to the SessionBlob — the holder
 *  uses this to decide whether to background-refresh, refresh on 401, or
 *  wait for the maintainer to drive renewal. Mirrors
 *  `vault/_shared/0.2/session-blob#/$defs/RefreshHint` (lowerCamelCase). */
export type SessionRefreshHint = "maintainerOnly" | "on401" | "beforeExpiry";

/** A single cookie returned in a SessionBlob. Mirrors
 *  `vault/_shared/0.1/session-blob#/$defs/CookieJarEntry`. */
export interface SessionCookie {
  name: string;
  value: string;
  domain: string;
  path: string;
  /** RFC 3339 — cookie's own expiry as the third party set it. The
   *  holder MUST treat the blob-level `expiresAt` as an outer bound
   *  regardless of this field. */
  expires?: string;
  secure?: boolean;
  httpOnly?: boolean;
  sameSite?: "Strict" | "Lax" | "None";
}

/** A request header the holder attaches to outbound requests to the
 *  bound origin. Typically `Authorization: Bearer <id_token>` for the
 *  SIOP path. */
export interface SessionHeader {
  name: string;
  value: string;
}

/** A storage entry (localStorage / sessionStorage) the holder writes
 *  into the bound origin. */
export interface SessionStorageItem {
  key: string;
  value: string;
}

/** The cleartext payload of a successful `vault/proxy-login/0.2`
 *  response. Mirrors `vault/_shared/0.1/session-blob`. */
export interface SessionBlob {
  /** Maintainer-assigned opaque id. Echoed at the response root for
   *  audit logging without unsealing. */
  sessionId: string;
  /** RFC 3339. Holder MUST discard the blob at this time. */
  expiresAt: string;
  cookies?: SessionCookie[];
  headers?: SessionHeader[];
  localStorage?: SessionStorageItem[];
  sessionStorage?: SessionStorageItem[];
  /** Web origin this session is for. Holder MUST refuse to inject the
   *  session into any other origin. Absent only for pure-DIDComm RPs
   *  (no browser origin to bind to). */
  bindOrigin?: string;
  refreshHint?: SessionRefreshHint;
}

export interface VaultProxyLoginRestOptions extends VtaAuthInputs {
  entryId: string;
  /** When the entry has multiple targets, names which one to log in
   *  against. The maintainer falls back to the entry's first DID-shaped
   *  or web-origin target if omitted. */
  target?: SiteTarget;
  /** Caller-supplied nonce, embedded verbatim by the maintainer as the
   *  SIOP id_token's `nonce` claim. The canonical use is threading the
   *  RP's `/auth/challenge` value through so the resulting id_token
   *  passes the RP's exact-match nonce check. Drivers without a nonce
   *  concept (Password POST, OAuth refresh) ignore. Bounded
   *  `[1, 512]` chars by the canonical schema; longer values would fail
   *  server-side validation. */
  nonce?: string;
  /** Caller-supplied TTL ceiling in seconds; the maintainer caps further.
   *  Honoured up to the server's cap (300 s in M2B.2b). */
  ttlSecondsHint?: number;
}

export interface VaultProxyLoginResponse {
  /** Cleartext session material. The caller MUST schedule a wipe at
   *  `expiresAt` and MUST NOT inject the session into any origin other
   *  than `sessionBlob.bindOrigin`. */
  sessionBlob: SessionBlob;
  /** Mirrors `sessionBlob.sessionId` — exposed for audit logging before
   *  unsealing. */
  sessionId: string;
  /** Mirrors `sessionBlob.expiresAt`. */
  expiresAt: string;
}

/**
 * Ask the VTA to perform a login at the bound third party using the
 * vault entry's secret material; receive an authcrypt-sealed
 * `SessionBlob` (cookies / headers) that lets the holder operate the
 * resulting session WITHOUT ever holding the long-term credential.
 *
 * The unpacked SessionBlob is returned in plaintext — callers MUST:
 *   1. Schedule a wipe at `expiresAt` (setTimeout in the popup; the
 *      countdown pattern in `vault/release` is the reference).
 *   2. Refuse to inject the session into any origin other than
 *      `sessionBlob.bindOrigin` (the holder's content script / DNR
 *      rules enforce this — @openvtc/pnm-core is browser-agnostic and only
 *      surfaces the constraint).
 */
export async function vaultProxyLoginRest(
  opts: VaultProxyLoginRestOptions,
): Promise<VaultProxyLoginResponse> {
  const bearer = await getVtaBearer({
    baseUrl: opts.baseUrl,
    holder: opts.holder,
    service: opts.service,
    ...(opts.fetch ? { fetch: opts.fetch } : {}),
  });

  // Server returns { sealedSessionBlob: SealedEnvelope, sessionId, expiresAt }.
  // We accept only the authcrypt variant — every other variant is a future /
  // unsupported envelope kind and we reject with a clear error rather than
  // silently failing in the JWE unpack. The 0.2 wire tag is lowerCamelCase
  // (`didcommAuthcrypt`); the legacy kebab form is tolerated for resilience
  // against VTA deployment skew.
  interface WireResponse {
    sealedSessionBlob:
      | { envelope: "didcommAuthcrypt" | "didcomm-authcrypt"; jwe: string }
      | { envelope: "hpkeArmored" }
      | { envelope: "tspMessage" };
    sessionId: string;
    expiresAt: string;
  }

  const wire = await postTrustTask<WireResponse>({
    baseUrl: opts.baseUrl,
    bearer,
    envelope: {
      type: TASK_VAULT_PROXY_LOGIN,
      payload: {
        entryId: opts.entryId,
        ...(opts.target !== undefined ? { target: opts.target } : {}),
        ...(opts.nonce !== undefined ? { nonce: opts.nonce } : {}),
        ...(opts.ttlSecondsHint !== undefined
          ? { ttlSecondsHint: opts.ttlSecondsHint }
          : {}),
      },
      issuer: opts.holder.did,
      recipient: opts.service.did,
    },
    expectedResponseType: TASK_VAULT_PROXY_LOGIN_RESPONSE,
    operationLabel: "vault/proxy-login/0.2",
    ...(opts.fetch ? { fetch: opts.fetch } : {}),
  });

  if (
    wire.sealedSessionBlob.envelope !== "didcommAuthcrypt" &&
    wire.sealedSessionBlob.envelope !== "didcomm-authcrypt"
  ) {
    throw new Error(
      `vault/proxy-login: unsupported envelope ${wire.sealedSessionBlob.envelope} — this wallet only understands didcommAuthcrypt`,
    );
  }

  // The VTA authcrypts the SessionBlob to the holder; the unpacker
  // needs the VTA's keyAgreement public JWK to verify the sender
  // binding (the `skid` in the JWE's protected header). Without it,
  // vti-didcomm-js raises "sender.publicJwk required for authcrypt".
  // The service endpoint structure carries the resolved VTA pubkey
  // from the holder's onboarding handshake.
  const unpacked = await unpackMessage(
    {
      input: wire.sealedSessionBlob.jwe,
      sender_public_jwk: opts.service.keyAgreementPublicJwk,
    },
    opts.holder,
  );
  if (unpacked.kind !== "encrypted") {
    throw new Error(
      `vault/proxy-login: unpacked JWE was not authcrypt-encrypted (kind=${unpacked.kind})`,
    );
  }
  // Defence-in-depth: anoncrypt-only would be a downgrade — the VTA
  // MUST authenticate as the signer so a relay can't substitute a
  // different SessionBlob.
  if (!unpacked.authenticated) {
    throw new Error(
      "vault/proxy-login: unpacked JWE was not authenticated (anoncrypt downgrade)",
    );
  }

  const body = (unpacked.message as Record<string, unknown>).body as
    | Record<string, unknown>
    | undefined;
  if (!body || typeof body !== "object") {
    throw new Error("vault/proxy-login: unpacked DIDComm message has no body");
  }
  // Cast at the wire boundary — the server has already canonical-schema-
  // validated the SessionBlob shape before sealing it.
  const sessionBlob = body as unknown as SessionBlob;

  return {
    sessionBlob,
    sessionId: wire.sessionId,
    expiresAt: wire.expiresAt,
  };
}

export type { Identity };
