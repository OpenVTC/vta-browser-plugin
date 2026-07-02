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
import type { VtaAuthInputs } from "../vault/transport.js";

import type { TrustTaskChannel } from "./channel.js";
import type { RemoteDidcommEndpoint } from "./didcomm.js";
import { RestChannel } from "./rest-channel.js";
import { buildTrustTask } from "./trust-task.js";

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

export interface VtaListDidsParams {
  /** Authcrypt sender (the holder's DIDComm identity post-onboarding swap). */
  holder: Identity;
  /** VTA's keyAgreement endpoint (resolved via `resolveKeyAgreement`). */
  service: RemoteDidcommEndpoint;
  /** Restrict to one context. Omit for every DID the caller can see. */
  contextId?: string;
}

/** @deprecated REST-transport options. Kept for existing call sites; prefer
 *  {@link vtaListDids} with a channel from a `VtaSession`. */
export interface VtaListDidsOptions extends VtaListDidsParams, VtaAuthInputs {}

/** List the webvh DIDs the VTA hosts, optionally scoped to one context.
 *
 *  These are the personas a `did-self-issued` vault entry can act AS:
 *  the VTA holds their signing keys, so it can mint a SIOP id_token as
 *  any of them. */
export async function vtaListDids(
  channel: TrustTaskChannel,
  params: VtaListDidsParams,
): Promise<WebvhDidRecord[]> {
  const envelope = buildTrustTask(
    TASK_WEBVH_DIDS_LIST_1_0,
    params.contextId ? { context_id: params.contextId } : {},
    { issuer: params.holder.did, recipient: params.service.did },
  );
  const result = await channel.send<ListDidsResultBody>(envelope, {
    expectedResponseType: TASK_WEBVH_DIDS_LIST_1_0_RESPONSE,
    operationLabel: "webvh/dids/list",
  });
  return result.dids ?? [];
}

/** @deprecated Use {@link vtaListDids} with a channel from a `VtaSession`.
 *  List over REST — builds a one-shot {@link RestChannel}. */
export function vtaListDidsRest(opts: VtaListDidsOptions): Promise<WebvhDidRecord[]> {
  return vtaListDids(new RestChannel(opts), opts);
}
