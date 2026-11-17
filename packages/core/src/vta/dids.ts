// What every identity an agent holds is, whatever its DID method:
// `vta/dids/{list,get,methods/list}/0.1`.
//
// These replaced asking each method's family in turn. `vta/webvh/dids/list`
// and `vta/webs/dids/list` (both retired) each answered for their own method
// only, and every caller asked only the methods it knew about — so an agent
// whose identities were all did:webs had none, by every surface in this
// wallet. The answer is one `DidSummary` per identity, any method, any level,
// with what only its method has under `methodDetails` (a consumer ignores a
// member it does not recognise: a method is added by a profile, not a schema
// change). What an identity *does* — create, update, rotate, its log or key
// event log, delete — stays with its method's own tasks.
//
// Typed on `TaskParty` (a DID, nothing more): only `.did` is ever read, so the
// console, which holds no key material, can call these too.

import { collectPages } from "../util/pages.js";

import type { TaskParty, TrustTaskSender } from "./channel.js";
import { buildTrustTask } from "./trust-task.js";

import {
  TYPE_URI as DIDS_LIST,
  RESPONSE_TYPE_URI as DIDS_LIST_RESPONSE,
  type Payload as DidsListPayload,
  type Response as DidsListResponse,
  type DidSummary,
  type DidClass,
} from "../specs/vta/dids/list/0.1/payload.js";
import {
  TYPE_URI as DIDS_GET,
  RESPONSE_TYPE_URI as DIDS_GET_RESPONSE,
  type Response as DidsGetResponse,
} from "../specs/vta/dids/get/0.1/payload.js";
import {
  TYPE_URI as DIDS_METHODS_LIST,
  RESPONSE_TYPE_URI as DIDS_METHODS_LIST_RESPONSE,
  type Response as DidMethodsResponse,
  type MethodInfo,
} from "../specs/vta/dids/methods/list/0.1/payload.js";

export type { DidSummary, DidClass, MethodInfo };

/** Who is asking, and which agent. */
export interface DidsCall {
  holder: TaskParty;
  service: TaskParty;
}

/** What a listing is narrowed to. Every filter narrows; absent means any. */
export interface DidsListParams extends DidsCall {
  contextId?: string | undefined;
  /** Method profile names: `webvh`, `scid:vh`, `webs`, `key`. */
  methods?: string[] | undefined;
  serverId?: string | undefined;
  didClass?: DidClass | undefined;
  includeDeactivated?: boolean | undefined;
}

/**
 * Every identity the caller may see, of every method, read to the end of its
 * cursor (`collectPages`): a short page is not the end, only an absent
 * `nextCursor` is.
 */
export async function didsList(
  sender: TrustTaskSender,
  params: DidsListParams,
): Promise<DidSummary[]> {
  return collectPages("DIDs", async (cursor) => {
    const payload: DidsListPayload = {
      ...(params.contextId ? { contextId: params.contextId } : {}),
      // The generated type spells the schema's 1–16 bound as tuples; the
      // agent checks the bound against the schema itself.
      ...(params.methods?.length
        ? { methods: params.methods as NonNullable<DidsListPayload["methods"]> }
        : {}),
      ...(params.serverId ? { serverId: params.serverId } : {}),
      ...(params.didClass ? { class: params.didClass } : {}),
      ...(params.includeDeactivated ? { includeDeactivated: true } : {}),
      ...(cursor ? { cursor } : {}),
    };
    const r = await sender.send<DidsListResponse>(
      buildTrustTask(DIDS_LIST, payload as Record<string, unknown>, {
        issuer: params.holder.did,
        recipient: params.service.did,
      }),
      { expectedResponseType: DIDS_LIST_RESPONSE, operationLabel: "vta/dids/list" },
    );
    return { items: r.dids, nextCursor: r.nextCursor };
  });
}

/**
 * One identity's summary. The agent answers `vta/dids/get:notFound` alike for
 * one it does not hold and one the caller may not see, and that refusal
 * propagates as the channel's error.
 */
export async function didsGet(
  sender: TrustTaskSender,
  params: DidsCall & { did: string },
): Promise<DidSummary> {
  const r = await sender.send<DidsGetResponse>(
    buildTrustTask(
      DIDS_GET,
      { did: params.did },
      { issuer: params.holder.did, recipient: params.service.did },
    ),
    { expectedResponseType: DIDS_GET_RESPONSE, operationLabel: "vta/dids/get" },
  );
  return r.did;
}

/**
 * The DID methods the agent holds, lists and will create now, and the tasks
 * that serve each — what a surface reads to decide what to offer for an
 * identity, rather than the DID string's prefix.
 */
export async function didMethodsList(
  sender: TrustTaskSender,
  params: DidsCall,
): Promise<MethodInfo[]> {
  const r = await sender.send<DidMethodsResponse>(
    buildTrustTask(
      DIDS_METHODS_LIST,
      {},
      { issuer: params.holder.did, recipient: params.service.did },
    ),
    { expectedResponseType: DIDS_METHODS_LIST_RESPONSE, operationLabel: "vta/dids/methods/list" },
  );
  return r.methods;
}
