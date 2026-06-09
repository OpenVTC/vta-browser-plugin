// REST client for the VTA's contexts API.
//
// Used by the popup's AddEntryForm to fetch the operator's accessible
// contexts (instead of guessing from the contexts already on loaded
// vault entries) and to create a new context inline when the operator
// picks "+ New context…" in the picker.
//
// Authentication: same primitive every authenticated REST call uses —
// authcrypted `auth/authenticate/0.1` to the VTA's keyAgreement key,
// followed by a bearer-token-authed JSON request. The auth round-trip
// is identical to `vault/list/0.1` (no token cache).
//
// Mirrors `vta-sdk::protocols::context_management::{list, create}`
// wire shapes — snake_case fields, no `data` envelope.

import { packAuthcrypt } from "../didcomm/index.js";
import type { Identity } from "../didcomm/index.js";
import type { RemoteDidcommEndpoint } from "./didcomm.js";

const VTA_AUTHENTICATE = "https://trusttasks.org/spec/auth/authenticate/0.1";

/** One context record as returned by `GET /contexts` and `POST /contexts`.
 *  Field naming mirrors the VTA's `CreateContextResultBody` exactly. */
export interface ContextRecord {
  id: string;
  name: string;
  did: string | null;
  description: string | null;
  base_path: string;
  created_at: string;
  updated_at: string;
}

/** Wire shape of `GET /contexts`. */
interface ListContextsBody {
  contexts: ContextRecord[];
}

export interface VtaListContextsOptions {
  /** VTA REST base URL (from `#vta-rest`, e.g. `http://localhost:8100`). */
  baseUrl: string;
  /** The wallet's holder identity — its DID must be in the VTA's ACL
   *  with any role (`/contexts` is `AuthClaims`-gated, not admin-only).
   *  The DID is also the authcrypt sender. */
  holder: Identity;
  /** The VTA's DID + keyAgreement key (inner authcrypt recipient). */
  service: RemoteDidcommEndpoint;
  /** fetch impl override (defaults to global). */
  fetch?: typeof fetch;
}

/** List the contexts the holder has access to.
 *
 *  Super-admins see every context; context-admins see only the contexts
 *  they're scoped into. Per-context Reader/Application/Initiator roles
 *  also see their own contexts (the `/contexts` route is gated by any
 *  authenticated user; the operation filters by `has_context_access`).
 *
 *  Same auth shape as `vaultListRest` — challenge → authcrypt → bearer.
 *  No token caching: each call does a fresh round-trip. Acceptable for
 *  the AddEntryForm's on-mount fetch; can grow a cache layer later. */
export async function vtaListContexts(
  opts: VtaListContextsOptions,
): Promise<ContextRecord[]> {
  const { baseUrl, holder, service } = opts;
  const f = opts.fetch ?? fetch.bind(globalThis);
  const base = baseUrl.replace(/\/+$/, "");

  const accessToken = await authenticate(base, holder, service, f);

  const res = await f(`${base}/contexts`, {
    method: "GET",
    headers: { authorization: `Bearer ${accessToken}` },
  });
  if (!res.ok) {
    throw new Error(`vta /contexts failed (${res.status}): ${await res.text()}`);
  }
  const body = (await res.json()) as ListContextsBody;
  return body.contexts ?? [];
}

export interface VtaCreateContextOptions extends VtaListContextsOptions {
  /** Context id — the operator-chosen short name (e.g. `work`,
   *  `openvtc-glenn`). Must be unique on the VTA; conflict surfaces as
   *  HTTP 409 / Conflict. */
  id: string;
  /** Human-readable name; the VTA records this verbatim for audit /
   *  display. Defaults to `id` if omitted. */
  name?: string;
  /** Optional free-form description. */
  description?: string;
}

/** Create a new context on the VTA.
 *
 *  Auth: **super-admin only** (`/contexts` POST is gated by
 *  `SuperAdminAuth` server-side). The wallet's holder must be a global
 *  admin (Admin role with empty `allowed_contexts`); context-admins
 *  surface as `Forbidden` and the popup should refuse to enter this
 *  path for them.
 *
 *  Returns the freshly-created context record (the VTA echoes back
 *  `base_path`, `created_at`, etc.) so the caller can use the new id
 *  immediately without a second list call. */
export async function vtaCreateContext(
  opts: VtaCreateContextOptions,
): Promise<ContextRecord> {
  const { baseUrl, holder, service, id, name, description } = opts;
  const f = opts.fetch ?? fetch.bind(globalThis);
  const base = baseUrl.replace(/\/+$/, "");

  const accessToken = await authenticate(base, holder, service, f);

  const reqBody: { id: string; name: string; description?: string } = {
    id,
    name: name ?? id,
    ...(description ? { description } : {}),
  };
  const res = await f(`${base}/contexts`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      authorization: `Bearer ${accessToken}`,
    },
    body: JSON.stringify(reqBody),
  });
  if (!res.ok) {
    throw new Error(`vta /contexts create failed (${res.status}): ${await res.text()}`);
  }
  return (await res.json()) as ContextRecord;
}

/** Run the wallet's standard challenge + authcrypt + token round-trip
 *  and return the access token. Same primitive every authenticated
 *  REST call here uses; not exported because callers should pick a
 *  domain-specific helper that runs this internally. */
async function authenticate(
  base: string,
  holder: Identity,
  service: RemoteDidcommEndpoint,
  f: typeof fetch,
): Promise<string> {
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
  return accessToken;
}
