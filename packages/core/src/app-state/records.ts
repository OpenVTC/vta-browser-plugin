// `vta/app-state/*` 1.0 — durable, context-scoped key/value state held by the
// agent rather than by this device.
//
// The wallet already has a `KVStore` (`../store`), and this is deliberately not
// that. `KVStore` is *this browser profile's* state: it dies with the profile,
// is invisible to a phone or a second laptop signed in as the same holder, and
// an MV3 worker teardown is the only durability event it has to survive.
// App-state lives at the agent, is scoped to a VTA context, and is therefore
// the only place a wallet can keep something that has to be true on every
// device the holder uses. Choosing wrongly is not a performance question: state
// that belongs here and goes in `KVStore` silently stops existing when the user
// opens the wallet somewhere else.
//
// **Every record is addressed by `(contextId, namespace, key)`, and `contextId`
// is the isolation boundary** — not a filter, and not a convenience. Two
// contexts holding the same namespace and key hold two unrelated records.

import type { Identity } from "../didcomm/index.js";
import type { TrustTaskSender } from "../vta/channel.js";
import type { RemoteDidcommEndpoint } from "../vta/didcomm.js";
import { buildTrustTask } from "../vta/trust-task.js";

import {
  TYPE_URI as APP_STATE_PUT,
  RESPONSE_TYPE_URI as APP_STATE_PUT_RESPONSE,
  type VTAApplicationStatePutPayload,
  type VTAApplicationStatePutResponsePayload,
} from "@openvtc/trust-tasks/vta/app-state/put/1.0/payload";
import {
  TYPE_URI as APP_STATE_GET,
  RESPONSE_TYPE_URI as APP_STATE_GET_RESPONSE,
  type VTAApplicationStateGetPayload,
  type VTAApplicationStateGetResponsePayload,
  type AppStateRecord,
} from "@openvtc/trust-tasks/vta/app-state/get/1.0/payload";
import {
  TYPE_URI as APP_STATE_GET_MANY,
  RESPONSE_TYPE_URI as APP_STATE_GET_MANY_RESPONSE,
  type VTAApplicationStateGetManyPayload,
  type VTAApplicationStateGetManyResponsePayload,
} from "@openvtc/trust-tasks/vta/app-state/get-many/1.0/payload";
import {
  TYPE_URI as APP_STATE_PUT_MANY,
  RESPONSE_TYPE_URI as APP_STATE_PUT_MANY_RESPONSE,
  type VTAApplicationStatePutManyPayload,
  type VTAApplicationStatePutManyResponsePayload,
} from "@openvtc/trust-tasks/vta/app-state/put-many/1.0/payload";
import {
  TYPE_URI as APP_STATE_LIST,
  RESPONSE_TYPE_URI as APP_STATE_LIST_RESPONSE,
  type VTAApplicationStateListPayload,
  type VTAApplicationStateListResponsePayload,
} from "@openvtc/trust-tasks/vta/app-state/list/1.0/payload";
import {
  TYPE_URI as APP_STATE_DELETE,
  RESPONSE_TYPE_URI as APP_STATE_DELETE_RESPONSE,
  type VTAApplicationStateDeletePayload,
  type VTAApplicationStateDeleteResponsePayload,
} from "@openvtc/trust-tasks/vta/app-state/delete/1.0/payload";

export type { AppStateRecord };

/** Every `vta/app-state/*` call is issued by an identity, to an agent. */
export interface AppStateCallerParams {
  /** Envelope `issuer` — the caller's DIDComm identity. */
  holder: Identity;
  /** The agent — envelope `recipient`. */
  service: RemoteDidcommEndpoint;
  /** The VTA context the record is scoped to. The isolation boundary: the same
   *  `(namespace, key)` in another context is a different record. */
  contextId: string;
}

/** Address of a single record within a context. */
export interface AppStateAddress {
  namespace: string;
  key: string;
}

async function call<Req, Res>(
  sender: TrustTaskSender,
  caller: AppStateCallerParams,
  type: string,
  responseType: string,
  label: string,
  payload: Req,
): Promise<Res> {
  const envelope = buildTrustTask(type, payload, {
    issuer: caller.holder.did,
    recipient: caller.service.did,
  });
  return sender.send<Res>(envelope, {
    expectedResponseType: responseType,
    operationLabel: label,
  });
}

export interface AppStatePutParams extends AppStateCallerParams, AppStateAddress {
  /**
   * The complete new value, replacing whatever the record held.
   *
   * **Present-and-`null` is not the same as omitted.** A present `null` stores
   * the JSON literal null; omitting `value` means "no whole-value write", which
   * is only meaningful alongside `mergePatch`. Mutually exclusive with it.
   */
  value?: VTAApplicationStatePutPayload["value"];
  /**
   * An RFC 7386 JSON Merge Patch applied to the record's current value.
   * Requires a live record at the address. Mutually exclusive with `value`.
   *
   * Worth preferring for concurrent writers: two instances editing different
   * members of one record stop colliding entirely, rather than serialising
   * behind `expectedVersion`.
   *
   * **RFC 7386's sharp edge is load-bearing here.** A member set to `null` in
   * a patch DELETES that member, and there is no way to set a member to the
   * JSON literal null through a patch at all. A writer that needs a literal
   * null must send a whole `value`.
   */
  mergePatch?: VTAApplicationStatePutPayload["mergePatch"];
  /**
   * Optional precondition. Omit for a last-writer-wins upsert; pass the
   * `version` a prior read returned to make the write conditional; pass `0` to
   * create only — which is the one way to express "only if it does not exist
   * yet", since an upsert cannot say it.
   */
  expectedVersion?: VTAApplicationStatePutPayload["expectedVersion"];
}

/**
 * Write one record.
 *
 * Answers `created`, so a caller can tell an insert from an update without a
 * prior read — which is the read that makes the check racy in the first place.
 */
export async function appStatePut(
  sender: TrustTaskSender,
  params: AppStatePutParams,
): Promise<VTAApplicationStatePutResponsePayload> {
  // `!== undefined` on all three: `value: null` is a real write, and
  // `expectedVersion: 0` means create-only. Both are falsy, and a truthiness
  // guard drops exactly the two that carry the most meaning.
  const payload: VTAApplicationStatePutPayload = {
    contextId: params.contextId,
    namespace: params.namespace,
    key: params.key,
    ...(params.value !== undefined ? { value: params.value } : {}),
    ...(params.mergePatch !== undefined ? { mergePatch: params.mergePatch } : {}),
    ...(params.expectedVersion !== undefined
      ? { expectedVersion: params.expectedVersion }
      : {}),
  };
  return call(sender, params, APP_STATE_PUT, APP_STATE_PUT_RESPONSE,
    "vta/app-state/put/1.0", payload);
}

export interface AppStateGetParams extends AppStateCallerParams, AppStateAddress {
  /** Return a tombstone rather than nothing when the record is deleted. Read
   *  `record.deleted` — a tombstone is a record, not an absence. */
  includeDeleted?: boolean;
}

/** Read one record. */
export async function appStateGet(
  sender: TrustTaskSender,
  params: AppStateGetParams,
): Promise<AppStateRecord> {
  const payload: VTAApplicationStateGetPayload = {
    contextId: params.contextId,
    namespace: params.namespace,
    key: params.key,
    ...(params.includeDeleted !== undefined
      ? { includeDeleted: params.includeDeleted }
      : {}),
  };
  const res = await call<
    VTAApplicationStateGetPayload,
    VTAApplicationStateGetResponsePayload
  >(sender, params, APP_STATE_GET, APP_STATE_GET_RESPONSE,
    "vta/app-state/get/1.0", payload);
  return res.record;
}

export interface AppStateGetManyParams extends AppStateCallerParams {
  namespace: string;
  /** At least one key — the schema requires a non-empty list, and a batch read
   *  of nothing is a mistake worth catching before it reaches the agent. */
  keys: [string, ...string[]];
  includeDeleted?: boolean;
}

/**
 * Read several records from one namespace.
 *
 * **`missing` is part of the answer, not an error.** A key that has no record
 * comes back there rather than as a gap in `records`, so a caller can tell "not
 * stored" from "not returned". `deferred` is a third state again: keys the
 * agent declined to answer in this response, which are neither present nor
 * known-absent, and re-reading them is the only way to find out which.
 */
export async function appStateGetMany(
  sender: TrustTaskSender,
  params: AppStateGetManyParams,
): Promise<VTAApplicationStateGetManyResponsePayload> {
  const payload: VTAApplicationStateGetManyPayload = {
    contextId: params.contextId,
    namespace: params.namespace,
    keys: params.keys,
    ...(params.includeDeleted !== undefined
      ? { includeDeleted: params.includeDeleted }
      : {}),
  };
  return call(sender, params, APP_STATE_GET_MANY, APP_STATE_GET_MANY_RESPONSE,
    "vta/app-state/get-many/1.0", payload);
}

export interface AppStatePutManyParams extends AppStateCallerParams {
  namespace: string;
  /**
   * `atomic` — every write lands or none does. `independent` (the agent's
   * default) — each write is judged on its own, and a per-write failure leaves
   * the rest applied.
   *
   * The response echoes the `mode` the agent actually used. Read it: asking
   * for `atomic` and receiving `independent` means the batch may be half
   * applied, and nothing else in the answer says so.
   */
  mode?: "independent" | "atomic";
  /** At least one write; the schema requires it. */
  writes: VTAApplicationStatePutManyPayload["writes"];
}

/** Write several records to one namespace. */
export async function appStatePutMany(
  sender: TrustTaskSender,
  params: AppStatePutManyParams,
): Promise<VTAApplicationStatePutManyResponsePayload> {
  const payload: VTAApplicationStatePutManyPayload = {
    contextId: params.contextId,
    namespace: params.namespace,
    writes: params.writes,
    ...(params.mode !== undefined ? { mode: params.mode } : {}),
  };
  return call(sender, params, APP_STATE_PUT_MANY, APP_STATE_PUT_MANY_RESPONSE,
    "vta/app-state/put-many/1.0", payload);
}

export interface AppStateListParams extends AppStateCallerParams {
  /** Restrict to one namespace. Omitted lists every namespace in the context. */
  namespace?: string;
  /** Key prefix within the namespace. */
  prefix?: string;
  /**
   * Return only records at a version above this — the incremental-sync door.
   *
   * Pair it with the response's `highWatermark`: pass back what the last page
   * reported and the agent returns only what has changed since, rather than
   * the whole namespace every time.
   */
  sinceVersion?: number;
  /** Include each record's `value`. Off by default — listing metadata is
   *  cheap, and a namespace of large values is not. */
  includeValues?: boolean;
  /** Include tombstones, which is what makes a delete syncable to a peer that
   *  was offline when it happened. Bounded by the response's
   *  `tombstoneRetentionSeconds`: a device away for longer than that cannot
   *  learn of the delete this way and must re-sync from scratch. */
  includeDeleted?: boolean;
  pageSize?: number;
  cursor?: string;
}

/** List records in a context, optionally scoped and incremental. */
export async function appStateList(
  sender: TrustTaskSender,
  params: AppStateListParams,
): Promise<VTAApplicationStateListResponsePayload> {
  const payload: VTAApplicationStateListPayload = {
    contextId: params.contextId,
    ...(params.namespace !== undefined ? { namespace: params.namespace } : {}),
    ...(params.prefix !== undefined ? { prefix: params.prefix } : {}),
    ...(params.sinceVersion !== undefined ? { sinceVersion: params.sinceVersion } : {}),
    ...(params.includeValues !== undefined
      ? { includeValues: params.includeValues }
      : {}),
    ...(params.includeDeleted !== undefined
      ? { includeDeleted: params.includeDeleted }
      : {}),
    ...(params.pageSize !== undefined ? { pageSize: params.pageSize } : {}),
    ...(params.cursor !== undefined ? { cursor: params.cursor } : {}),
  };
  return call(sender, params, APP_STATE_LIST, APP_STATE_LIST_RESPONSE,
    "vta/app-state/list/1.0", payload);
}

export interface AppStateDeleteParams extends AppStateCallerParams, AppStateAddress {
  /** Optional precondition — the `version` a prior read returned. Omit for an
   *  unconditional delete. */
  expectedVersion?: VTAApplicationStateDeletePayload["expectedVersion"];
}

/**
 * Delete one record.
 *
 * `existed: false` is a successful outcome, not a failure: the address holds
 * nothing, which is what the caller asked for. Branch on it only if the
 * difference matters to you.
 */
export async function appStateDelete(
  sender: TrustTaskSender,
  params: AppStateDeleteParams,
): Promise<VTAApplicationStateDeleteResponsePayload> {
  const payload: VTAApplicationStateDeletePayload = {
    contextId: params.contextId,
    namespace: params.namespace,
    key: params.key,
    ...(params.expectedVersion !== undefined
      ? { expectedVersion: params.expectedVersion }
      : {}),
  };
  return call(sender, params, APP_STATE_DELETE, APP_STATE_DELETE_RESPONSE,
    "vta/app-state/delete/1.0", payload);
}
