// Shared REST auth for the vault/* Trust Task surface — the bearer half of
// the `RestChannel`. The `RestChannel` (vta/rest-channel.ts) owns the actual
// POST to /api/trust-tasks + response decode; this module owns getting the
// token it posts with:
//
//   - `getVtaBearer` — runs the canonical /auth/challenge → DIDComm
//     authcrypt → /auth/ → bearer-token round-trip, with caching.
//   - `makeReauth` / `invalidateVtaBearer` — drop a stale cached token so a
//     401 self-heals with one retry.
//
// (Only the REST transport needs any of this — TSP and DIDComm are
// sender-authenticated by their envelope, so their channels carry no bearer.)
//
// Bearer caching: the VTA's access token has a ~15-minute TTL, so we
// reuse it across vault ops within a conservative window. Without this,
// a single user action that chains ops (e.g. a SIOP sign-in that lists
// entries THEN signs a trust-task) fires one /auth/challenge + /auth/
// round-trip per op — and those back-to-back unauth requests from one IP
// trip the VTA's per-IP rate limit (HTTP 429 "Too Many Requests"). The
// cache is keyed by (baseUrl, holder DID) so distinct identities and
// VTAs never share a token; call `invalidateVtaBearer` after a 401 to
// force re-auth.

import { packAuthcrypt, type Identity } from "../didcomm/index.js";
import type { RemoteDidcommEndpoint } from "../vta/didcomm.js";
import { withFetchTimeout } from "../http/timeout-fetch.js";

const VTA_AUTHENTICATE = "https://trusttasks.org/spec/auth/authenticate/0.1";

/** Reuse window — kept well under the server's ~15-minute token TTL so a
 *  cached token can't be served past expiry (clock-skew safety margin). */
const BEARER_TTL_MS = 10 * 60_000;
const bearerCache = new Map<string, { token: string; expiresAt: number }>();

function bearerCacheKey(baseUrl: string, holderDid: string): string {
  return `${baseUrl.replace(/\/+$/, "")}|${holderDid}`;
}

/** Drop any cached bearer for this (baseUrl, holder). Call after the VTA
 *  rejects a token with 401 so the next op re-authenticates. */
export function invalidateVtaBearer(baseUrl: string, holderDid: string): void {
  bearerCache.delete(bearerCacheKey(baseUrl, holderDid));
}

/** Build a `reauth` callback for the `RestChannel`: drop the cached bearer and
 *  mint a fresh one. Used so a 401 (a cached token that outlived its
 *  server-side session — restart/eviction) self-heals with a single retry
 *  instead of surfacing as an auth failure. */
export function makeReauth(opts: VtaAuthInputs): () => Promise<string> {
  return () => {
    invalidateVtaBearer(opts.baseUrl, opts.holder.did);
    return getVtaBearer(opts);
  };
}

export interface VtaAuthInputs {
  /** VTA REST base URL — from the connection state's `restBaseUrl`. */
  baseUrl: string;
  /** Authcrypt sender — the holder's DIDComm identity post-onboarding. */
  holder: Identity;
  /** VTA's keyAgreement endpoint (resolved via `resolveKeyAgreement`). */
  service: RemoteDidcommEndpoint;
  /** fetch impl (defaults to global). */
  fetch?: typeof fetch;
}

/**
 * Run /auth/challenge → authcrypt /auth/ → bearer token, returning a
 * cached token when one is still within its reuse window. Caching keeps a
 * multi-op user action (sign-in = list + sign, etc.) to a single /auth/
 * round-trip so it doesn't trip the VTA's per-IP unauth rate limit.
 */
export async function getVtaBearer(opts: VtaAuthInputs): Promise<string> {
  const f = withFetchTimeout(opts.fetch);
  const base = opts.baseUrl.replace(/\/+$/, "");

  const cacheKey = bearerCacheKey(base, opts.holder.did);
  const cached = bearerCache.get(cacheKey);
  if (cached && cached.expiresAt > Date.now()) {
    return cached.token;
  }

  // 1. /auth/challenge → flat { challenge, sessionId, expiresAt }.
  const cRes = await f(`${base}/auth/challenge`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ did: opts.holder.did }),
  });
  if (!cRes.ok) {
    throw new Error(`vta /auth/challenge failed (${cRes.status}): ${await cRes.text()}`);
  }
  const cBody = (await cRes.json()) as { sessionId?: string; challenge?: string };
  if (!cBody.sessionId || !cBody.challenge) {
    throw new Error(`vta /auth/challenge: malformed response: ${JSON.stringify(cBody)}`);
  }

  // 2. Authcrypt an `auth/authenticate/0.1` message to the VTA.
  const authMsg = {
    id: globalThis.crypto.randomUUID(),
    type: VTA_AUTHENTICATE,
    from: opts.holder.did,
    to: [opts.service.did],
    body: { challenge: cBody.challenge, session_id: cBody.sessionId },
  };
  const packed = await packAuthcrypt(authMsg, opts.holder, [
    {
      kid: opts.service.keyAgreementKid,
      jwk: opts.service.keyAgreementPublicJwk,
    },
  ]);

  // 3. POST → AuthenticateResponse { session, tokens: { accessToken, ... } }.
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
  bearerCache.set(cacheKey, { token: accessToken, expiresAt: Date.now() + BEARER_TTL_MS });
  return accessToken;
}
