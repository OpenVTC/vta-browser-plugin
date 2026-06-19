// VTA — list webvh DIDs (optionally scoped to one context).
//
// Posts a `vta/webvh/dids/list/1.0` envelope to the VTA's trust-task
// dispatcher (`POST /api/trust-tasks`, the same path `vaultListRest`
// uses) and returns the DID records the VTA hosts. The popup's
// AddEntryForm calls this with the selected context to populate the
// Persona-DID dropdown for a `did-self-issued` entry: these are exactly
// the DIDs the VTA can mint a SIOP id_token AS (it holds their keys).
//
// Wire shapes mirror `vta-sdk::protocols::did_management::list`
// (`ListDidsWebvhBody` / `ListDidsWebvhResultBody`) and
// `vta-sdk::webvh::WebvhDidRecord`. Unlike the camelCase vault tasks,
// the did_management bodies derive serde's default casing, so the wire
// is **snake_case** (`context_id`, `server_id`, …). Auth + dispatch
// reuse the shared vault transport helpers.

import type { Identity } from "../didcomm/index.js";
import { getVtaBearer, makeReauth, postTrustTask, type VtaAuthInputs } from "../vault/transport.js";

import type { RemoteDidcommEndpoint } from "./didcomm.js";

const TASK_WEBVH_DIDS_LIST_1_0 = "https://trusttasks.org/spec/vta/webvh/dids/list/1.0";
const TASK_WEBVH_DIDS_LIST_1_0_RESPONSE = `${TASK_WEBVH_DIDS_LIST_1_0}#response`;

/** One webvh DID record as returned by `vta/webvh/dids/list/1.0`.
 *  Mirrors `vta-sdk::webvh::WebvhDidRecord` — **snake_case** on the
 *  wire. Only the fields the wallet consumes are typed; the VTA also
 *  sends `mnemonic`, `scid`, `log_entry_count`, timestamps, etc. which
 *  we ignore here. */
export interface WebvhDidRecord {
  /** The hosted DID (`did:webvh:…`). The persona a did-self-issued
   *  entry acts AS — becomes the SIOP `iss`/`sub`. */
  did: string;
  /** Context this DID belongs to (matches a `ContextRecord.id`). */
  context_id: string;
  /** Hosting server the DID is registered with. */
  server_id?: string;
  /** Whether the DID is portable across hosting servers. */
  portable?: boolean;
}

interface ListDidsResultBody {
  dids?: WebvhDidRecord[];
}

export interface VtaListDidsOptions {
  /** VTA REST base URL — from the connection state's `restBaseUrl`. */
  baseUrl: string;
  /** Authcrypt sender (the holder's DIDComm identity post-onboarding swap). */
  holder: Identity;
  /** VTA's keyAgreement endpoint (resolved via `resolveKeyAgreement`). */
  service: RemoteDidcommEndpoint;
  /** Restrict to one context. Omit for every DID the caller can see. */
  contextId?: string;
  /** fetch impl (defaults to global). */
  fetch?: typeof fetch;
}

/** List the webvh DIDs the VTA hosts, optionally scoped to one context.
 *
 *  These are the personas a `did-self-issued` vault entry can act AS:
 *  the VTA holds their signing keys, so it can mint a SIOP id_token as
 *  any of them. Same cached-bearer auth + dispatch primitive as
 *  `vaultListRest` (challenge → authcrypt → bearer → POST), including
 *  the one-shot 401 re-auth retry. */
export async function vtaListDids(opts: VtaListDidsOptions): Promise<WebvhDidRecord[]> {
  const auth: VtaAuthInputs = {
    baseUrl: opts.baseUrl,
    holder: opts.holder,
    service: opts.service,
    ...(opts.fetch ? { fetch: opts.fetch } : {}),
  };
  const bearer = await getVtaBearer(auth);

  const result = await postTrustTask<ListDidsResultBody>({
    baseUrl: opts.baseUrl,
    bearer,
    envelope: {
      type: TASK_WEBVH_DIDS_LIST_1_0,
      issuer: opts.holder.did,
      recipient: opts.service.did,
      payload: opts.contextId ? { context_id: opts.contextId } : {},
    },
    expectedResponseType: TASK_WEBVH_DIDS_LIST_1_0_RESPONSE,
    operationLabel: "webvh/dids/list",
    reauth: makeReauth(auth),
    ...(opts.fetch ? { fetch: opts.fetch } : {}),
  });

  return result.dids ?? [];
}
