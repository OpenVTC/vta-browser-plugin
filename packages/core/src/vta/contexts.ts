// Contexts — the `vta/contexts/*` family, as dispatcher trust-tasks.
//
// The popup's AddEntryForm fetches the operator's accessible contexts (to
// populate the context picker) and can create a new context inline. Both run
// as canonical trust-tasks over a TrustTaskChannel/VtaSession, so they work on
// a DIDComm-only VTA as well as REST.
//
// **Every URI and the record shape come from `@openvtc/trust-tasks`.** They
// used to be hand-written here, alongside a hand-declared `ContextRecord` and a
// header claiming the wire was snake_case. None of that was true any more, and
// two of them were wrong in a way nothing would have caught: the hand-written
// record typed `did` and `description` as `string | null`, where the published
// schema makes them OPTIONAL — an agent omits them, so a caller testing
// `=== null` never matches, and TypeScript agrees with the caller. Taking the
// type from the binding means the schema is the only place that shape is
// stated.

import type { TaskParty, TrustTaskSender } from "./channel.js";
import { RestChannel, type RestChannelOptions } from "./rest-channel.js";
import { buildTrustTask } from "./trust-task.js";

import {
  TYPE_URI as TASK_CONTEXTS_LIST,
  RESPONSE_TYPE_URI as TASK_CONTEXTS_LIST_RESPONSE,
  type ContextRecord,
} from "@openvtc/trust-tasks/vta/contexts/list/1.0/payload";
import {
  TYPE_URI as TASK_CONTEXTS_CREATE,
  RESPONSE_TYPE_URI as TASK_CONTEXTS_CREATE_RESPONSE,
} from "@openvtc/trust-tasks/vta/contexts/create/1.0/payload";
import {
  TYPE_URI as TASK_CONTEXTS_GET,
  RESPONSE_TYPE_URI as TASK_CONTEXTS_GET_RESPONSE,
} from "@openvtc/trust-tasks/vta/contexts/get/1.0/payload";
import {
  TYPE_URI as TASK_CONTEXTS_UPDATE,
  RESPONSE_TYPE_URI as TASK_CONTEXTS_UPDATE_RESPONSE,
} from "@openvtc/trust-tasks/vta/contexts/update/1.0/payload";
import {
  TYPE_URI as TASK_CONTEXTS_UPDATE_DID,
  RESPONSE_TYPE_URI as TASK_CONTEXTS_UPDATE_DID_RESPONSE,
} from "@openvtc/trust-tasks/vta/contexts/update-did/1.0/payload";

/** One context record, as the registry declares it. Re-exported so callers
 *  need not know which task's binding it happens to live under. */
export type { ContextRecord };



/**
 * A context record as the agent sends it.
 *
 * This used to fold `base_path`/`created_at`/`updated_at` into the canonical
 * spelling, on the reasoning that the library "talks to agents it does not
 * control". That reasoning does not hold here and the fold was dead code:
 * nothing is deployed, the wallet has never been published, and `ContextRecord`
 * in `vta-sdk` carries `#[serde(rename_all = "camelCase")]` — so the agent
 * *emits* camelCase and has done since the casing change. Its `alias`
 * attributes are deserialize-only; they let it keep *accepting* the old
 * spelling, which says nothing about what it sends.
 *
 * A fold kept past its cause is worse than none: it reads as a live constraint,
 * and the next person maintaining this file has to work out whether some peer
 * still needs it. SPEC §4.10 names one spelling — match it with `===`.
 */
function asContextRecord(raw: Record<string, unknown>): ContextRecord {
  return raw as unknown as ContextRecord;
}

export interface ContextsListParams {
  /** Envelope `issuer` — the holder's DIDComm identity. Its DID must be in
   *  the VTA's ACL with any role (`contexts/list` is auth-gated, not
   *  admin-only; the VTA filters by `has_context_access`). */
  holder: TaskParty;
  /** The VTA — envelope `recipient`. */
  service: TaskParty;
}

/** List the contexts the holder can access.
 *
 *  Super-admins see every context; scoped admins / per-context roles see only
 *  their own. Runs over whatever transport the sender carries. */
export async function contextsList(
  sender: TrustTaskSender,
  params: ContextsListParams,
): Promise<ContextRecord[]> {
  const envelope = buildTrustTask(
    TASK_CONTEXTS_LIST,
    {},
    { issuer: params.holder.did, recipient: params.service.did },
  );
  const payload = await sender.send<{ contexts?: Record<string, unknown>[] }>(envelope, {
    expectedResponseType: TASK_CONTEXTS_LIST_RESPONSE,
    operationLabel: "contexts/list/1.0",
  });
  return (payload.contexts ?? []).map(asContextRecord);
}

export interface ContextsCreateParams {
  holder: TaskParty;
  service: TaskParty;
  /** Leaf segment when `parent` is set (full path = `<parent>/<id>`), else a
   *  top-level id. Must be unique; a conflict rejects. */
  id: string;
  /** Human-readable name; defaults to `id`. */
  name?: string;
  /** Optional free-form description. */
  description?: string;
  /** Parent context path to nest under; omit for a top-level context. */
  parent?: string;
}

/** Create a new context. **Super-admin only** (the VTA gates
 *  `contexts/create` on the admin role + a finer parent check). Returns the
 *  freshly-created record. */
export async function contextsCreate(
  sender: TrustTaskSender,
  params: ContextsCreateParams,
): Promise<ContextRecord> {
  const envelope = buildTrustTask(
    TASK_CONTEXTS_CREATE,
    {
      id: params.id,
      name: params.name ?? params.id,
      ...(params.description ? { description: params.description } : {}),
      ...(params.parent ? { parent: params.parent } : {}),
    },
    { issuer: params.holder.did, recipient: params.service.did },
  );
  const created = await sender.send<Record<string, unknown>>(envelope, {
    expectedResponseType: TASK_CONTEXTS_CREATE_RESPONSE,
    operationLabel: "contexts/create/1.0",
  });
  return asContextRecord(created);
}

/** @deprecated REST-transport options. Kept for existing call sites; prefer
 *  {@link contextsList} with a channel from a `VtaSession`.
 *
 *  `holder` and `service` come from {@link RestChannelOptions}, not from
 *  {@link ContextsListParams}: composing the envelope needs only the two DIDs, but this
 *  wrapper also *builds the channel*, and a channel signs and encrypts. The
 *  narrower pair is what the wire actually requires here. */
export interface VtaListContextsOptions
  extends Omit<ContextsListParams, "holder" | "service">,
    RestChannelOptions {}

/** @deprecated Use {@link contextsList} with a channel from a `VtaSession`.
 *  List over REST — builds a one-shot {@link RestChannel} (dispatches
 *  `contexts/list/1.0` over `/trust-tasks`, NOT the bespoke `/contexts`). */
export interface ContextsGetParams {
  holder: TaskParty;
  service: TaskParty;
  /** Context id — the full path for a nested context. */
  id: string;
}

/**
 * Read one context.
 *
 * The distinction from {@link contextsList} matters when the answer is
 * "nothing": list filters to what the caller may reach and returns an empty
 * array, which is indistinguishable from an agent holding none. This answers
 * `notFound` for an id that is absent, so it is the call to make when you need
 * to tell "no access" from "does not exist".
 */
export async function contextsGet(
  sender: TrustTaskSender,
  params: ContextsGetParams,
): Promise<ContextRecord> {
  const envelope = buildTrustTask(
    TASK_CONTEXTS_GET,
    { id: params.id },
    { issuer: params.holder.did, recipient: params.service.did },
  );
  const payload = await sender.send<Record<string, unknown>>(envelope, {
    expectedResponseType: TASK_CONTEXTS_GET_RESPONSE,
    operationLabel: "vta/contexts/get/1.0",
  });
  return asContextRecord(payload);
}

export interface ContextsUpdateParams {
  holder: TaskParty;
  service: TaskParty;
  /** Context to update. The id itself cannot be changed. */
  id: string;
  /** New human-readable name. Omit to leave unchanged. */
  name?: string;
  /** New description. Omit to leave unchanged. */
  description?: string;
  /**
   * Replacement policy.
   *
   * Sent whole, not merged: the agent stores what it is given, so a partial
   * object silently drops the constraints it omits. Read the current policy
   * first and send it back with your edit applied.
   */
  policy?: Record<string, unknown>;
}

/** Update a context's metadata or policy. */
export async function contextsUpdate(
  sender: TrustTaskSender,
  params: ContextsUpdateParams,
): Promise<ContextRecord> {
  const envelope = buildTrustTask(
    TASK_CONTEXTS_UPDATE,
    {
      id: params.id,
      ...(params.name !== undefined ? { name: params.name } : {}),
      ...(params.description !== undefined ? { description: params.description } : {}),
      ...(params.policy !== undefined ? { policy: params.policy } : {}),
    },
    { issuer: params.holder.did, recipient: params.service.did },
  );
  const payload = await sender.send<Record<string, unknown>>(envelope, {
    expectedResponseType: TASK_CONTEXTS_UPDATE_RESPONSE,
    operationLabel: "vta/contexts/update/1.0",
  });
  return asContextRecord(payload);
}

export interface ContextsUpdateDidParams {
  holder: TaskParty;
  service: TaskParty;
  /** Context whose DID is being set. */
  id: string;
  /** The DID to associate with this context. */
  did: string;
}

/** Set the DID a context acts as. */
export async function contextsUpdateDid(
  sender: TrustTaskSender,
  params: ContextsUpdateDidParams,
): Promise<ContextRecord> {
  const envelope = buildTrustTask(
    TASK_CONTEXTS_UPDATE_DID,
    { id: params.id, did: params.did },
    { issuer: params.holder.did, recipient: params.service.did },
  );
  const payload = await sender.send<Record<string, unknown>>(envelope, {
    expectedResponseType: TASK_CONTEXTS_UPDATE_DID_RESPONSE,
    operationLabel: "vta/contexts/update-did/1.0",
  });
  return asContextRecord(payload);
}

export function vtaListContexts(opts: VtaListContextsOptions): Promise<ContextRecord[]> {
  return contextsList(new RestChannel(opts), opts);
}

/** @deprecated REST-transport options. Kept for existing call sites; prefer
 *  {@link contextsCreate} with a channel from a `VtaSession`.
 *
 *  `holder` and `service` come from {@link RestChannelOptions}, not from
 *  {@link ContextsCreateParams}: composing the envelope needs only the two DIDs, but this
 *  wrapper also *builds the channel*, and a channel signs and encrypts. The
 *  narrower pair is what the wire actually requires here. */
export interface VtaCreateContextOptions
  extends Omit<ContextsCreateParams, "holder" | "service">,
    RestChannelOptions {}

/** @deprecated Use {@link contextsCreate} with a channel from a `VtaSession`.
 *  Create over REST — builds a one-shot {@link RestChannel}. */
export function vtaCreateContext(opts: VtaCreateContextOptions): Promise<ContextRecord> {
  return contextsCreate(new RestChannel(opts), opts);
}
