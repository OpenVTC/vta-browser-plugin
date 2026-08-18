// Agent memory — `vta/memory/*`.
//
// A per-context key/value store the agent keeps for itself. Every call is
// scoped to a `contextId`, and unlike most of this module that parameter is
// **required**: memory has no global namespace, so there is no such thing as
// "the agent's memory" without saying whose context.
//
// `memoryList` returns keys, not values. Reading a value back is `memoryPut`'s
// counterpart only in the sense that both name a key — the list is deliberately
// a directory, so enumerating memory does not spill its contents.

import type { Identity } from "../didcomm/index.js";
import type { TrustTaskSender } from "../vta/channel.js";
import type { RemoteDidcommEndpoint } from "../vta/didcomm.js";
import { buildTrustTask } from "../vta/trust-task.js";

import {
  TYPE_URI as MEMORY_PUT,
  RESPONSE_TYPE_URI as MEMORY_PUT_RESPONSE,
  type VTAMemoryPutPayload,
  type VTAMemoryPutResponsePayload,
} from "@openvtc/trust-tasks/vta/memory/put/0.1/payload";
import {
  TYPE_URI as MEMORY_LIST,
  RESPONSE_TYPE_URI as MEMORY_LIST_RESPONSE,
  type VTAMemoryListPayload,
  type VTAMemoryListResponsePayload,
} from "@openvtc/trust-tasks/vta/memory/list/0.1/payload";
import {
  TYPE_URI as MEMORY_DELETE,
  RESPONSE_TYPE_URI as MEMORY_DELETE_RESPONSE,
  type VTAMemoryDeletePayload,
  type VTAMemoryDeleteResponsePayload,
} from "@openvtc/trust-tasks/vta/memory/delete/0.1/payload";

export interface MemoryCallerParams {
  holder: Identity;
  service: RemoteDidcommEndpoint;
  /** Required — memory has no global namespace. */
  contextId: string;
}

export interface MemoryPutParams extends MemoryCallerParams {
  key: string;
  value: string;
}

/** Write a value. Replaces whatever the key held. */
export async function memoryPut(
  sender: TrustTaskSender,
  params: MemoryPutParams,
): Promise<VTAMemoryPutResponsePayload> {
  const payload: VTAMemoryPutPayload = {
    contextId: params.contextId,
    key: params.key,
    value: params.value,
  };
  const envelope = buildTrustTask(MEMORY_PUT, payload, {
    issuer: params.holder.did,
    recipient: params.service.did,
  });
  return sender.send<VTAMemoryPutResponsePayload>(envelope, {
    expectedResponseType: MEMORY_PUT_RESPONSE,
    operationLabel: "vta/memory/put/0.1",
  });
}

/** List the keys held in a context. Values are not returned. */
export async function memoryList(
  sender: TrustTaskSender,
  params: MemoryCallerParams,
): Promise<VTAMemoryListResponsePayload["items"]> {
  const payload: VTAMemoryListPayload = { contextId: params.contextId };
  const envelope = buildTrustTask(MEMORY_LIST, payload, {
    issuer: params.holder.did,
    recipient: params.service.did,
  });
  const res = await sender.send<VTAMemoryListResponsePayload>(envelope, {
    expectedResponseType: MEMORY_LIST_RESPONSE,
    operationLabel: "vta/memory/list/0.1",
  });
  return res.items ?? [];
}

export interface MemoryDeleteParams extends MemoryCallerParams {
  key: string;
}

/** Delete a key. */
export async function memoryDelete(
  sender: TrustTaskSender,
  params: MemoryDeleteParams,
): Promise<VTAMemoryDeleteResponsePayload> {
  const payload: VTAMemoryDeletePayload = {
    contextId: params.contextId,
    key: params.key,
  };
  const envelope = buildTrustTask(MEMORY_DELETE, payload, {
    issuer: params.holder.did,
    recipient: params.service.did,
  });
  return sender.send<VTAMemoryDeleteResponsePayload>(envelope, {
    expectedResponseType: MEMORY_DELETE_RESPONSE,
    operationLabel: "vta/memory/delete/0.1",
  });
}
