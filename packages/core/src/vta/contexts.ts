// Contexts — list + create, as dispatcher trust-tasks.
//
// The popup's AddEntryForm fetches the operator's accessible contexts (to
// populate the context picker) and can create a new context inline. Both run
// as canonical trust-tasks over a TrustTaskChannel/VtaSession, so they work on
// a DIDComm-only VTA as well as REST.
//
//   list   → https://trusttasks.org/spec/vta/contexts/list/1.0    (payload {})
//   create → https://trusttasks.org/spec/vta/contexts/create/1.0  (super-admin)
//
// Wire shapes mirror `vta-sdk::protocols::context_management::{list,create}`:
// snake_case fields, `CreateContextResultBody` as the record. The VTA also
// exposes a bespoke `GET/POST /contexts` REST route (now deprecated) — the
// trust-task dispatcher form is the canonical one.

import type { Identity } from "../didcomm/index.js";
import type { TrustTaskSender } from "./channel.js";
import type { RemoteDidcommEndpoint } from "./didcomm.js";
import { RestChannel } from "./rest-channel.js";
import { buildTrustTask } from "./trust-task.js";
import type { VtaAuthInputs } from "../vault/transport.js";

const TASK_CONTEXTS_LIST = "https://trusttasks.org/spec/vta/contexts/list/1.0";
const TASK_CONTEXTS_LIST_RESPONSE = `${TASK_CONTEXTS_LIST}#response`;
const TASK_CONTEXTS_CREATE = "https://trusttasks.org/spec/vta/contexts/create/1.0";
const TASK_CONTEXTS_CREATE_RESPONSE = `${TASK_CONTEXTS_CREATE}#response`;

/** One context record — mirrors `CreateContextResultBody` (the shape returned
 *  by both list and create). snake_case on the wire. */
export interface ContextRecord {
  id: string;
  name: string;
  did: string | null;
  description: string | null;
  /** Parent context id, or absent for a top-level context. */
  parent?: string;
  base_path: string;
  created_at: string;
  updated_at: string;
}

export interface ContextsListParams {
  /** Envelope `issuer` — the holder's DIDComm identity. Its DID must be in
   *  the VTA's ACL with any role (`contexts/list` is auth-gated, not
   *  admin-only; the VTA filters by `has_context_access`). */
  holder: Identity;
  /** The VTA — envelope `recipient`. */
  service: RemoteDidcommEndpoint;
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
  const payload = await sender.send<{ contexts?: ContextRecord[] }>(envelope, {
    expectedResponseType: TASK_CONTEXTS_LIST_RESPONSE,
    operationLabel: "contexts/list/1.0",
  });
  return payload.contexts ?? [];
}

export interface ContextsCreateParams {
  holder: Identity;
  service: RemoteDidcommEndpoint;
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
  return sender.send<ContextRecord>(envelope, {
    expectedResponseType: TASK_CONTEXTS_CREATE_RESPONSE,
    operationLabel: "contexts/create/1.0",
  });
}

/** @deprecated REST-transport options. Kept for existing call sites; prefer
 *  {@link contextsList} with a channel from a `VtaSession`. */
export interface VtaListContextsOptions extends ContextsListParams, VtaAuthInputs {}

/** @deprecated Use {@link contextsList} with a channel from a `VtaSession`.
 *  List over REST — builds a one-shot {@link RestChannel} (dispatches
 *  `contexts/list/1.0` over `/api/trust-tasks`, NOT the bespoke `/contexts`). */
export function vtaListContexts(opts: VtaListContextsOptions): Promise<ContextRecord[]> {
  return contextsList(new RestChannel(opts), opts);
}

/** @deprecated REST-transport options. Kept for existing call sites; prefer
 *  {@link contextsCreate} with a channel from a `VtaSession`. */
export interface VtaCreateContextOptions extends ContextsCreateParams, VtaAuthInputs {}

/** @deprecated Use {@link contextsCreate} with a channel from a `VtaSession`.
 *  Create over REST — builds a one-shot {@link RestChannel}. */
export function vtaCreateContext(opts: VtaCreateContextOptions): Promise<ContextRecord> {
  return contextsCreate(new RestChannel(opts), opts);
}
