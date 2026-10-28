// REST auth for the VTA — the bearer half of the `RestChannel`. The channel
// (vta/rest-channel.ts) owns the POST to /trust-tasks and the response
// decode; this module owns getting the token it posts with:
//
//   - `getVtaBearer` — posts an `auth/challenge/0.1` document and then a
//     signed `auth/authenticate/0.3` to /trust-tasks for a bearer token, with
//     caching.
//   - `makeReauth` / `invalidateVtaBearer` — drop a stale cached token so a
//     401 self-heals with one retry.
//
// (Only the REST transport needs any of this — TSP and DIDComm are
// sender-authenticated by their envelope, so their channels carry no bearer.)
//
// This lived under `vault/` until it was the only thing making `vta` and
// `vault` mutually dependent: every channel needs a bearer, and reaching into
// the vault module to get one meant `import "@openvtc/pnm-core/vta"` dragged the
// whole vault surface in behind it. Nothing here was ever vault-specific — it is
// how you authenticate to a VTA over REST, whatever you then ask it to do.
//
// Bearer caching: the VTA's access token has a ~15-minute TTL, so we
// reuse it across vault ops within a conservative window. Without this,
// a single user action that chains ops (e.g. a SIOP sign-in that lists
// entries THEN signs a trust-task) fires one challenge + authenticate
// round-trip per op — and those back-to-back unauth requests from one IP
// trip the VTA's per-IP rate limit (HTTP 429 "Too Many Requests"). The
// cache is keyed by (baseUrl, holder DID) so distinct identities and
// VTAs never share a token; call `invalidateVtaBearer` after a 401 to
// force re-auth.

import { guardedFetch } from "@openvtc/vti-didcomm-js/net-guard";

import type { Identity, NetPolicy } from "../didcomm/index.js";
import type { RemoteDidcommEndpoint } from "./didcomm.js";
import { withFetchTimeout, isFetchTimeout, DEFAULT_FETCH_TIMEOUT_MS } from "../http/timeout-fetch.js";
import { authenticateSession, requestAuthChallenge } from "./auth-tasks.js";
import type { SendOpts, TrustTaskSender } from "./channel.js";
import { TRUST_TASK_PATH } from "./endpoint.js";
import { VtaClientError } from "./errors.js";
import { decodeTrustTaskHttpReply } from "./http-reply.js";
import type { TrustTask } from "./protocol.js";
import { asTaskSigner, signOutboundTask, type ChannelSigner } from "./trust-task.js";

/** Reuse window — kept well under the server's ~15-minute token TTL so a
 *  cached token can't be served past expiry (clock-skew safety margin). */
const BEARER_TTL_MS = 10 * 60_000;
const bearerCache = new Map<string, { token: string; expiresAt: number }>();
/** The sign-in currently running for a (baseUrl, holder), so concurrent
 *  callers share it. The cache only helps once a token exists: a console that
 *  loads three panes at once used to run three challenge + authenticate pairs
 *  — six anonymous requests against a per-IP budget of ten — and switching
 *  between two agents spent the rest. Cleared when it settles, success or
 *  failure, so a refusal is not replayed to the next caller. */
const bearerInflight = new Map<string, Promise<string>>();

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
 *  instead of surfacing as an auth failure.
 *
 *  Pass the token that was refused, and only that token is dropped. The VTA
 *  keeps one live token per DID — each sign-in supersedes the last (`token
 *  superseded (jti mismatch)`) — so when several requests are refused together,
 *  the first one's re-auth mints the replacement and a later one discarding it
 *  would sign in again and supersede it, refusing the first one's retry. */
export function makeReauth(opts: VtaAuthInputs): (rejected?: string) => Promise<string> {
  return (rejected) => {
    const key = bearerCacheKey(opts.baseUrl, opts.holder.did);
    if (rejected === undefined || bearerCache.get(key)?.token === rejected) bearerCache.delete(key);
    return getVtaBearer(opts);
  };
}

export interface VtaAuthInputs {
  /** VTA REST base URL — from the connection state's `restBaseUrl`. */
  baseUrl: string;
  /** Who signs in. Only its DID is read here: it is the challenge's subject
   *  and the issuer of both documents. Typed as the full identity because the
   *  channel this feeds is built from one. */
  holder: Identity;
  /** The VTA. Only its DID is read here: it is the recipient, and the signer
   *  its replies must verify as. */
  service: RemoteDidcommEndpoint;
  /** Signs the `auth/authenticate` document, whose proof *is* the sign-in.
   *  Must be the holder's key: the VTA verifies it with a `did:key` resolver
   *  and mints the session for whoever signed. */
  signing: ChannelSigner;
  /** fetch impl (defaults to global). */
  fetch?: typeof fetch;
  /** Egress policy for `baseUrl`. Strict by default — https on a public host —
   *  so a dev build talking to a VTA on `http://localhost` needs both
   *  `allowInsecure` and `allowPrivate`. See {@link vtaRestEndpointPolicy}. */
  netPolicy?: NetPolicy;
}

/**
 * The egress policy a VTA REST base URL is held to.
 *
 * `baseUrl` is configuration rather than a document endpoint, but the
 * configuration is written from a DID document (or a QR code) at onboarding, so
 * it is vetted on the same terms as one: `https:` on a public host unless the
 * caller widens it. `guardedFetch` then re-checks every request URL built from
 * it and refuses to follow a redirect — this is the one channel that carries a
 * bearer token, and an allowed host must not be able to hand it onwards.
 *
 * Exported so the channel and the bearer handshake are demonstrably held to the
 * same policy rather than to two that happen to match.
 */
export function vtaRestEndpointPolicy(netPolicy?: NetPolicy): {
  label: string;
  schemes: string[];
} & NetPolicy {
  return { label: "VTA REST", schemes: ["https:"], ...netPolicy };
}

/**
 * Get a bearer token for the VTA's REST surface, returning a cached one when it
 * is still within its reuse window. Caching keeps a multi-op user action
 * (sign-in = list + sign, etc.) to one sign-in so it does not trip the VTA's
 * per-IP rate limit on anonymous requests. Concurrent callers with no token
 * yet share the one sign-in already running rather than each starting their
 * own.
 *
 * Two Trust Tasks, both POSTed to `/trust-tasks` with no bearer: an
 * `auth/challenge/0.1` naming the holder as its subject, then an
 * `auth/authenticate/0.3` carrying the challenge, whose proof is the
 * authentication. The VTA recognises this family by the document's `type` and
 * dispatches it ahead of the session check (vti #1858).
 *
 * This replaced `POST /auth/challenge` and an authcrypted `POST /auth/`, which
 * the VTA deleted in that release. A wallet still using them got a 405 from
 * every VTA on it, and nothing over REST worked at all.
 */
export async function getVtaBearer(opts: VtaAuthInputs): Promise<string> {
  const base = opts.baseUrl.replace(/\/+$/, "");
  const cacheKey = bearerCacheKey(base, opts.holder.did);
  const cached = bearerCache.get(cacheKey);
  if (cached && cached.expiresAt > Date.now()) {
    return cached.token;
  }
  const running = bearerInflight.get(cacheKey);
  if (running) return running;

  const signIn = signInForBearer(opts, cacheKey).finally(() => {
    if (bearerInflight.get(cacheKey) === signIn) bearerInflight.delete(cacheKey);
  });
  bearerInflight.set(cacheKey, signIn);
  return signIn;
}

async function signInForBearer(opts: VtaAuthInputs, cacheKey: string): Promise<string> {
  const sender = preSessionSender(opts);
  const challenge = await requestAuthChallenge(sender, {
    holder: opts.holder,
    service: opts.service,
    // REQUIRED by the VTA's handler, though optional in the spec: the
    // challenge is minted for this DID and spent only by its signature.
    subject: opts.holder.did,
  });
  const authed = await authenticateSession(sender, {
    holder: opts.holder,
    service: opts.service,
    challenge: challenge.challenge,
    sessionId: challenge.sessionId,
  });
  const accessToken = authed.tokens?.accessToken;
  if (!accessToken) {
    throw new VtaClientError("e.client.parse", "auth/authenticate: the reply carries no access token");
  }
  // The token's own lifetime when it says, less a margin for clock skew and a
  // request in flight; never longer than the fixed window.
  const lifetimeMs =
    typeof authed.tokens.expiresIn === "number"
      ? Math.min(BEARER_TTL_MS, authed.tokens.expiresIn * 1000 - 60_000)
      : BEARER_TTL_MS;
  bearerCache.set(cacheKey, { token: accessToken, expiresAt: Date.now() + lifetimeMs });
  return accessToken;
}

/**
 * Posts a pre-session document to `/trust-tasks` with no bearer, and reads the
 * reply the way the REST channel does: signed by the VTA, threaded to the
 * request, body before status. The channel cannot carry these itself, since
 * every request it makes starts by asking this module for a bearer.
 */
function preSessionSender(opts: VtaAuthInputs): TrustTaskSender {
  // Guard inside the timeout wrapper so both hold: every URL is checked before
  // it is dialed (throwing `BlockedEndpointError` with
  // `code: "E_BLOCKED_ENDPOINT"`) and every request is still bounded (R1.2).
  // The cast states what the library's JSDoc types loosely — `guardedFetch`
  // returns a drop-in for the `fetch` it wrapped.
  const guarded = guardedFetch(opts.fetch, vtaRestEndpointPolicy(opts.netPolicy)) as typeof fetch;
  const f = withFetchTimeout(guarded);
  const url = `${opts.baseUrl.replace(/\/+$/, "")}${TRUST_TASK_PATH}`;
  const signer = asTaskSigner(opts.signing);
  return {
    async send<Res>(envelope: TrustTask<unknown>, sendOpts: SendOpts = {}): Promise<Res> {
      const label = sendOpts.operationLabel ?? envelope.type;
      await signOutboundTask(envelope, signer);
      let res: Response;
      try {
        res = await f(url, {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify(envelope),
        });
      } catch (err) {
        if (isFetchTimeout(err)) {
          throw new VtaClientError(
            "e.client.timeout",
            `${label}: VTA did not respond within ${DEFAULT_FETCH_TIMEOUT_MS / 1000}s`,
          );
        }
        // A refused endpoint keeps its own code (`E_BLOCKED_ENDPOINT`), which
        // callers match structurally; only a network failure is rewrapped.
        if ((err as { code?: unknown }).code !== undefined) throw err;
        throw new VtaClientError("e.client.network", (err as Error).message);
      }
      return decodeTrustTaskHttpReply<Res>(res, {
        ...(sendOpts.expectedResponseType !== undefined
          ? { expectedResponseType: sendOpts.expectedResponseType }
          : {}),
        operationLabel: label,
        expectedSigner: opts.service.did,
        inReplyTo: envelope,
      });
    },
  };
}
