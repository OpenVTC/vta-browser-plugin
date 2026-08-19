// Agent names — `vta/webvh/agent-name/*`.
//
// An agent name is a human-memorable `domain/@name` that resolves to a DID.
// Binding one edits the DID document's `alsoKnownAs` and republishes the signed
// log, and **that claim is the sole authorisation for the hosting server's
// `/@name` redirect**. The host refuses a binding whose document does not claim
// it, which is why every verb here goes through the agent rather than talking
// to the host directly: only the agent can sign the document that grants it.
//
// A name is therefore never derived from anything — not from the DID, not from
// a label. It is only ever what `alsoKnownAs` says.

import {
  TYPE_URI as NAME_SET,
  RESPONSE_TYPE_URI as NAME_SET_RESPONSE,
  type Payload as NameSetPayload,
  type Response as NameSetResponse,
} from "@openvtc/trust-tasks/vta/webvh/agent-name/set/1.0/payload";
import {
  TYPE_URI as NAME_REMOVE,
  RESPONSE_TYPE_URI as NAME_REMOVE_RESPONSE,
  type Payload as NameRemovePayload,
  type Response as NameRemoveResponse,
} from "@openvtc/trust-tasks/vta/webvh/agent-name/remove/1.0/payload";
import {
  TYPE_URI as NAME_LIST,
  RESPONSE_TYPE_URI as NAME_LIST_RESPONSE,
  type Payload as NameListPayload,
  type Response as NameListResponse,
  type AgentNameEntry,
} from "@openvtc/trust-tasks/vta/webvh/agent-name/list/1.0/payload";
import {
  TYPE_URI as NAME_CHECK,
  RESPONSE_TYPE_URI as NAME_CHECK_RESPONSE,
  type Payload as NameCheckPayload,
  type Response as NameCheckResponse,
} from "@openvtc/trust-tasks/vta/webvh/agent-name/check/1.0/payload";
import {
  TYPE_URI as NAME_ENABLE,
  RESPONSE_TYPE_URI as NAME_ENABLE_RESPONSE,
  type Payload as NameEnablePayload,
  type Response as NameEnableResponse,
} from "@openvtc/trust-tasks/vta/webvh/agent-name/enable/1.0/payload";
import {
  TYPE_URI as NAME_DISABLE,
  RESPONSE_TYPE_URI as NAME_DISABLE_RESPONSE,
  type Payload as NameDisablePayload,
  type Response as NameDisableResponse,
} from "@openvtc/trust-tasks/vta/webvh/agent-name/disable/1.0/payload";

import type { TrustTaskSender } from "../vta/channel.js";
import { buildTrustTask } from "../vta/trust-task.js";
import type { WebvhCall } from "./dids.js";

export type { AgentNameEntry };

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

/**
 * Bind a name to a DID, adding `https://{domain}/@{name}` to the document's
 * `alsoKnownAs` and republishing.
 *
 * A success here means the claim is live in the signed document — the hosting
 * server refuses a binding whose document does not carry it.
 */
export async function agentNameSet(
  sender: TrustTaskSender,
  params: WebvhCall & NameSetPayload,
): Promise<NameSetResponse> {
  const { holder, service, ...payload } = params;
  return send(sender, { holder, service }, NAME_SET, NAME_SET_RESPONSE,
    "vta/webvh/agent-name/set/1.0", payload);
}

/** Remove a name binding, dropping the `alsoKnownAs` claim and republishing. */
export async function agentNameRemove(
  sender: TrustTaskSender,
  params: WebvhCall & NameRemovePayload,
): Promise<NameRemoveResponse> {
  const { holder, service, ...payload } = params;
  return send(sender, { holder, service }, NAME_REMOVE, NAME_REMOVE_RESPONSE,
    "vta/webvh/agent-name/remove/1.0", payload);
}

/** List this agent's name bindings. */
export async function agentNameList(
  sender: TrustTaskSender,
  params: WebvhCall & NameListPayload,
): Promise<NameListResponse> {
  const { holder, service, ...payload } = params;
  return send(sender, { holder, service }, NAME_LIST, NAME_LIST_RESPONSE,
    "vta/webvh/agent-name/list/1.0", payload);
}

/**
 * Ask whether a name is available on a domain.
 *
 * An availability answer is a point-in-time observation, not a reservation:
 * nothing stops another agent claiming the name between the check and the set.
 */
export async function agentNameCheck(
  sender: TrustTaskSender,
  params: WebvhCall & NameCheckPayload,
): Promise<NameCheckResponse> {
  const { holder, service, ...payload } = params;
  return send(sender, { holder, service }, NAME_CHECK, NAME_CHECK_RESPONSE,
    "vta/webvh/agent-name/check/1.0", payload);
}

/** Re-enable a disabled name binding. */
export async function agentNameEnable(
  sender: TrustTaskSender,
  params: WebvhCall & NameEnablePayload,
): Promise<NameEnableResponse> {
  const { holder, service, ...payload } = params;
  return send(sender, { holder, service }, NAME_ENABLE, NAME_ENABLE_RESPONSE,
    "vta/webvh/agent-name/enable/1.0", payload);
}

/**
 * Disable a name binding without removing it.
 *
 * The binding is retained so it can be re-enabled, and the name stays claimed
 * — this is not a way to release a name for someone else.
 */
export async function agentNameDisable(
  sender: TrustTaskSender,
  params: WebvhCall & NameDisablePayload,
): Promise<NameDisableResponse> {
  const { holder, service, ...payload } = params;
  return send(sender, { holder, service }, NAME_DISABLE, NAME_DISABLE_RESPONSE,
    "vta/webvh/agent-name/disable/1.0", payload);
}
