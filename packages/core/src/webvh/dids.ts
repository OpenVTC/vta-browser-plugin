// did:webvh lifecycle — `vta/webvh/dids/*`.
//
// **The counterparty is the agent, not the hosting service.** That is the whole
// distinction between this module and `did-hosting/`: there, the recipient is a
// webvh *hosting service* that publishes a document at a URL and serves its log,
// and the agent is merely one of its clients. Here the recipient is the agent
// itself, which holds the keys and signs the log entries. Only the agent can
// mint or update a DID it controls; the hosting service can only serve what it
// is given.
//
// A DID here is addressed by its full `did:webvh:...` string, not by a hosting
// mnemonic. `serverId` names a hosting registration the agent already holds;
// its absence means **serverless** — the caller serves the log itself, and the
// agent keeps no hosting registration for it.

import {
  TYPE_URI as DIDS_CREATE,
  RESPONSE_TYPE_URI as DIDS_CREATE_RESPONSE,
  type Payload as DidsCreatePayload,
  type Response as DidsCreateResponse,
  type WebvhPathMode,
} from "@openvtc/trust-tasks/vta/webvh/dids/create/1.0/payload";
import {
  TYPE_URI as DIDS_GET,
  RESPONSE_TYPE_URI as DIDS_GET_RESPONSE,
  type Payload as DidsGetPayload,
  type Response as DidsGetResponse,
  type WebvhDidRecord,
} from "@openvtc/trust-tasks/vta/webvh/dids/get/1.0/payload";
import {
  TYPE_URI as DIDS_LIST,
  RESPONSE_TYPE_URI as DIDS_LIST_RESPONSE,
  type Payload as DidsListPayload,
  type Response as DidsListResponse,
} from "@openvtc/trust-tasks/vta/webvh/dids/list/1.0/payload";
import {
  TYPE_URI as DIDS_UPDATE,
  RESPONSE_TYPE_URI as DIDS_UPDATE_RESPONSE,
  type Payload as DidsUpdatePayload,
  type Response as DidsUpdateResponse,
} from "@openvtc/trust-tasks/vta/webvh/dids/update/1.0/payload";
import {
  TYPE_URI as DIDS_DELETE,
  RESPONSE_TYPE_URI as DIDS_DELETE_RESPONSE,
  type Payload as DidsDeletePayload,
  type Response as DidsDeleteResponse,
} from "@openvtc/trust-tasks/vta/webvh/dids/delete/1.0/payload";
import {
  TYPE_URI as DIDS_ROTATE_KEYS,
  RESPONSE_TYPE_URI as DIDS_ROTATE_KEYS_RESPONSE,
  type Payload as DidsRotateKeysPayload,
  type Response as DidsRotateKeysResponse,
} from "@openvtc/trust-tasks/vta/webvh/dids/rotate-keys/1.0/payload";
import {
  TYPE_URI as DIDS_REGISTER_WITH_SERVER,
  RESPONSE_TYPE_URI as DIDS_REGISTER_WITH_SERVER_RESPONSE,
  type Payload as DidsRegisterWithServerPayload,
  type Response as DidsRegisterWithServerResponse,
} from "@openvtc/trust-tasks/vta/webvh/dids/register-with-server/1.0/payload";

import type { Identity } from "../didcomm/index.js";
import type { TrustTaskSender } from "../vta/channel.js";
import type { RemoteDidcommEndpoint } from "../vta/didcomm.js";
import { buildTrustTask } from "../vta/trust-task.js";

export type { WebvhDidRecord, WebvhPathMode };

/** Who is asking, and which agent is being asked. */
export interface WebvhCall {
  holder: Identity;
  service: RemoteDidcommEndpoint;
}

const send = <T>(
  sender: TrustTaskSender,
  call: WebvhCall,
  type: string,
  responseType: string,
  label: string,
  payload: unknown,
): Promise<T> =>
  sender.send<T>(
    buildTrustTask(type, payload as Record<string, unknown>, {
      issuer: call.holder.did,
      recipient: call.service.did,
    }),
    { expectedResponseType: responseType, operationLabel: label },
  );

export interface WebvhDidCreateParams extends WebvhCall {
  /** Context the DID belongs to. Deleting the context destroys the DID. */
  contextId: string;
  /** Hosting server to publish through. Absent = serverless. */
  serverId?: string;
  /** Where the log will be served, for the serverless case. */
  url?: string;
  /** How the path under the host is chosen. */
  pathMode?: WebvhPathMode;
  /** Allow the DID to move location later. Cannot be added afterwards. */
  portable?: boolean;
}

/**
 * Mint a did:webvh.
 *
 * The agent generates the keys, writes the log's first entry and either hands
 * it to a hosting server or returns it for the caller to serve. `portable`
 * decides once and for all whether the DID may ever move: a non-portable DID's
 * identity is derived from where it is served, so relocating it would make it a
 * different DID.
 */
export async function webvhDidCreate(
  sender: TrustTaskSender,
  params: WebvhDidCreateParams,
): Promise<DidsCreateResponse> {
  const { holder, service, ...rest } = params;
  const payload: DidsCreatePayload = {
    contextId: rest.contextId,
    ...(rest.serverId ? { serverId: rest.serverId } : {}),
    ...(rest.url ? { url: rest.url } : {}),
    ...(rest.pathMode ? { pathMode: rest.pathMode } : {}),
    ...(rest.portable !== undefined ? { portable: rest.portable } : {}),
  };
  return send(sender, { holder, service }, DIDS_CREATE, DIDS_CREATE_RESPONSE,
    "vta/webvh/dids/create/1.0", payload);
}

export interface WebvhDidGetParams extends WebvhCall {
  did: string;
  /**
   * Ask for the log as well as the record.
   *
   * Worth knowing what its absence means: the log is omitted because it was not
   * requested, **never** because the DID has no history. A consumer auditing a
   * DID wants it — the log is the only thing a verifier can check the current
   * document against — but it is the DID's whole history and can be large.
   */
  includeLog?: boolean;
}

/** Read one DID's record, optionally with its log. */
export async function webvhDidGet(
  sender: TrustTaskSender,
  params: WebvhDidGetParams,
): Promise<DidsGetResponse> {
  const payload: DidsGetPayload = {
    did: params.did,
    ...(params.includeLog !== undefined ? { includeLog: params.includeLog } : {}),
  };
  return send(sender, params, DIDS_GET, DIDS_GET_RESPONSE,
    "vta/webvh/dids/get/1.0", payload);
}

export interface WebvhDidListParams extends WebvhCall {
  /** Only DIDs in this context. */
  contextId?: string;
  /** Only DIDs published through this hosting server. */
  serverId?: string;
}

/** List the agent's webvh DIDs, optionally filtered. */
export async function webvhDidList(
  sender: TrustTaskSender,
  params: WebvhDidListParams,
): Promise<DidsListResponse> {
  const payload: DidsListPayload = {
    ...(params.contextId ? { contextId: params.contextId } : {}),
    ...(params.serverId ? { serverId: params.serverId } : {}),
  };
  return send(sender, params, DIDS_LIST, DIDS_LIST_RESPONSE,
    "vta/webvh/dids/list/1.0", payload);
}

/** Update a webvh DID document and republish its log. */
export async function webvhDidUpdate(
  sender: TrustTaskSender,
  params: WebvhCall & DidsUpdatePayload,
): Promise<DidsUpdateResponse> {
  const { holder, service, ...payload } = params;
  return send(sender, { holder, service }, DIDS_UPDATE, DIDS_UPDATE_RESPONSE,
    "vta/webvh/dids/update/1.0", payload);
}

/** Delete a webvh DID. */
export async function webvhDidDelete(
  sender: TrustTaskSender,
  params: WebvhCall & DidsDeletePayload,
): Promise<DidsDeleteResponse> {
  const { holder, service, ...payload } = params;
  return send(sender, { holder, service }, DIDS_DELETE, DIDS_DELETE_RESPONSE,
    "vta/webvh/dids/delete/1.0", payload);
}

/**
 * Rotate every verificationMethod's keys on a webvh DID.
 *
 * The authorisation and pre-rotation keys rotate as a consequence of the
 * resulting document update, not as a separate step.
 */
export async function webvhDidRotateKeys(
  sender: TrustTaskSender,
  params: WebvhCall & DidsRotateKeysPayload,
): Promise<DidsRotateKeysResponse> {
  const { holder, service, ...payload } = params;
  return send(sender, { holder, service }, DIDS_ROTATE_KEYS, DIDS_ROTATE_KEYS_RESPONSE,
    "vta/webvh/dids/rotate-keys/1.0", payload);
}

/** Register an existing DID with a hosting server the agent already holds. */
export async function webvhDidRegisterWithServer(
  sender: TrustTaskSender,
  params: WebvhCall & DidsRegisterWithServerPayload,
): Promise<DidsRegisterWithServerResponse> {
  const { holder, service, ...payload } = params;
  return send(sender, { holder, service }, DIDS_REGISTER_WITH_SERVER,
    DIDS_REGISTER_WITH_SERVER_RESPONSE,
    "vta/webvh/dids/register-with-server/1.0", payload);
}
