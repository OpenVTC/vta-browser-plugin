// Shared transport for the vault/* Trust Task REST surface.
//
// Two helpers, reused by every vault/* operation (upsert, delete, release,
// and — eventually — list/get when they're migrated off the inlined auth
// flow in `list.ts`):
//
//   - `getVtaBearer` — runs the canonical /auth/challenge → DIDComm
//     authcrypt → /auth/ → bearer-token round-trip. Same auth primitive
//     `swapAclRest` and `vaultListRest` already use.
//   - `postTrustTask` — POSTs an authenticated Trust Task envelope to
//     /api/trust-tasks and validates the response shape.
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
import { isTrustTaskErrorType } from "../vta/protocol.js";

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

/** Build a `reauth` callback for {@link postTrustTask}: drop the cached
 *  bearer and mint a fresh one. Pass it so a 401 (a cached token that
 *  outlived its server-side session — restart/eviction) self-heals with a
 *  single retry instead of surfacing as an auth failure. */
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
  const f = opts.fetch ?? fetch.bind(globalThis);
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

export interface VaultTaskRequest {
  /** Trust Task type URI (matches the request URI in the canonical spec). */
  type: string;
  /** Payload object — task-specific shape. */
  payload: unknown;
  /** Optional issuer DID; set when the consumer signs a `proof`. */
  issuer?: string;
  /** Optional recipient DID — the maintainer's DID. Audience-binds the doc. */
  recipient?: string;
}

export interface PostTrustTaskOpts<R> {
  baseUrl: string;
  bearer: string;
  envelope: VaultTaskRequest;
  /** Expected response `type` URI (the `<request>#response` form). */
  expectedResponseType: string;
  fetch?: typeof fetch;
  /** Internal: used to enrich error messages. */
  operationLabel?: string;
  /** Called once on a 401 to obtain a fresh bearer; the request is then
   *  retried with it. Lets a stale cached token (server restart / session
   *  eviction) self-heal. Build one with {@link makeReauth}. */
  reauth?: () => Promise<string>;
}

/**
 * POST an authenticated Trust Task envelope to /api/trust-tasks. The
 * framework's dispatcher returns either a `<task>#response` document
 * (success) or a `trust-task-error/0.1` document (reject). This helper
 * differentiates the two: success returns the parsed `payload` cast as
 * `R`; reject throws an `Error` carrying the framework's error code +
 * comment so callers see "vault/upsert:version_conflict — ..." rather
 * than a raw 400.
 */
export async function postTrustTask<R>(opts: PostTrustTaskOpts<R>): Promise<R> {
  const f = opts.fetch ?? fetch.bind(globalThis);
  const base = opts.baseUrl.replace(/\/+$/, "");
  const op = opts.operationLabel ?? opts.envelope.type;

  const reqId = globalThis.crypto.randomUUID();
  const fullEnvelope = {
    id: reqId,
    type: opts.envelope.type,
    ...(opts.envelope.issuer ? { issuer: opts.envelope.issuer } : {}),
    ...(opts.envelope.recipient ? { recipient: opts.envelope.recipient } : {}),
    issuedAt: new Date().toISOString(),
    payload: opts.envelope.payload,
  };

  const body = JSON.stringify(fullEnvelope);
  const doPost = (bearer: string) =>
    f(`${base}/api/trust-tasks`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        authorization: `Bearer ${bearer}`,
      },
      body,
    });

  let res = await doPost(opts.bearer);
  // A cached bearer can outlive its server-side session (VTA restart or
  // session eviction). On 401, re-authenticate once and retry so the user
  // doesn't see a spurious auth failure mid-flow.
  if (res.status === 401 && opts.reauth) {
    res = await doPost(await opts.reauth());
  }
  if (!res.ok) {
    throw new Error(`${op}: /api/trust-tasks failed (${res.status}): ${await res.text()}`);
  }
  const doc = (await res.json()) as {
    type?: string;
    payload?: unknown;
  };

  if (doc.type === opts.expectedResponseType) {
    return doc.payload as R;
  }

  // Trust Task error envelope: type = trust-task-error/{0.1,0.2} with
  // payload.code = "<slug>:<error>" and payload.message = explanation.
  // (The framework field is `message`; older code read a non-existent
  // `comment` and silently dropped all error detail.) Accept both the 0.1
  // and 0.2 error documents — a 0.2-capable VTA emits trust-task-error/0.2.
  if (isTrustTaskErrorType(doc.type)) {
    const errPayload = doc.payload as {
      code?: string;
      message?: string;
      details?: unknown;
    };
    const code = errPayload?.code ?? "unknown";
    const message = errPayload?.message ?? "(no message)";
    throw new Error(`${code}: ${message}`);
  }

  throw new Error(
    `${op}: unexpected response type ${doc.type ?? "(none)"} — ${JSON.stringify(doc)}`,
  );
}
