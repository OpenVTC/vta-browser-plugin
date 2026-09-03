// VTA — list webvh DIDs (optionally scoped to one context).
//
// Posts a `vta/webvh/dids/list/1.0` envelope to the VTA's trust-task
// dispatcher (`POST /trust-tasks`, the same path `vaultListRest`
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

import type { TrustTaskSender } from "./channel.js";
import type { RemoteDidcommEndpoint } from "./didcomm.js";
import { RestChannel, type RestChannelOptions } from "./rest-channel.js";
import { buildTrustTask } from "./trust-task.js";

import {
  TYPE_URI as TASK_WEBVH_DIDS_LIST_1_0,
  type WebvhDidRecord,
} from "@openvtc/trust-tasks/vta/webvh/dids/list/1.0/payload";
const TASK_WEBVH_DIDS_LIST_1_0_RESPONSE = `${TASK_WEBVH_DIDS_LIST_1_0}#response`;

/** A hosted DID as the registry declares it.
 *
 *  Taken from the binding rather than declared here. The hand-written version
 *  this replaces had drifted in both directions at once: it marked `serverId`
 *  and `portable` OPTIONAL where the schema makes them required, and it omitted
 *  seven members the agent actually sends (`mnemonic`, `scid`, `logEntryCount`,
 *  `preRotationCount`, `nextFragmentId`, `createdAt`, `updatedAt`). Neither
 *  kind of drift announces itself: the first invites guards that can never
 *  fire, the second hides data a caller would have used. */
export type { WebvhDidRecord };

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
export interface VtaListDidsOptions extends VtaListDidsParams, RestChannelOptions {}

/** List the webvh DIDs the VTA hosts, optionally scoped to one context.
 *
 *  These are the personas a `did-self-issued` vault entry can act AS:
 *  the VTA holds their signing keys, so it can mint a SIOP id_token as
 *  any of them. */
export async function vtaListDids(
  channel: TrustTaskSender,
  params: VtaListDidsParams,
): Promise<WebvhDidRecord[]> {
  const envelope = buildTrustTask(
    TASK_WEBVH_DIDS_LIST_1_0,
    // camelCase, per the published schema. This sent `context_id` until
    // `vta/webvh/dids/list/1.0` was specified: the schema names `contextId`
    // and sets `additionalProperties: false`, so the old spelling was not a
    // tolerated synonym — it made the whole payload malformed, and a
    // conforming agent refuses it. The filter silently did nothing before
    // that, which is the worse half: an unfiltered list looks like a working
    // one until you count the rows.
    params.contextId ? { contextId: params.contextId } : {},
    { issuer: params.holder.did, recipient: params.service.did },
  );
  const result = await channel.send<ListDidsResultBody>(envelope, {
    expectedResponseType: TASK_WEBVH_DIDS_LIST_1_0_RESPONSE,
    operationLabel: "webvh/dids/list",
  });
  // No casing fold. `WebvhDidRecord` in `vta-sdk` carries
  // `#[serde(rename_all = "camelCase")]`, so the agent emits `contextId` and
  // `serverId`; its `alias` attributes are deserialize-only and say nothing
  // about what it sends. Nothing is deployed, so "an agent that has not taken
  // the fold" names no peer that exists — and a fold kept past its cause reads
  // as a live constraint to whoever maintains this next.
  return (result.dids ?? []) as unknown as WebvhDidRecord[];
}

/** @deprecated Use {@link vtaListDids} with a channel from a `VtaSession`.
 *  List over REST — builds a one-shot {@link RestChannel}. */
export function vtaListDidsRest(opts: VtaListDidsOptions): Promise<WebvhDidRecord[]> {
  return vtaListDids(new RestChannel(opts), opts);
}
