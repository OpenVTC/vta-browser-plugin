// `vta/services/*` 1.0 — which transports an agent runs, and how it stops
// running one without dropping what is in flight.
//
// Operator surface: enabling or disabling a transport changes how every client
// of that agent reaches it, so this is admin, not wallet. Reachable only as
// `@openvtc/pnm-core/admin`.
//
// **Disabling is a drain, not a switch.** `disable` takes a `drainTtlSecs` and
// the agent keeps serving what is already in flight until it lapses; a mediator
// under drain shows up in `drain/list` with a `drainsUntil`, and `drain/cancel`
// calls it off. A caller that treats `disable` as instantaneous will report an
// agent as off while it is still answering.

import type { Identity } from "../didcomm/index.js";
import type { TrustTaskSender } from "../vta/channel.js";
import type { RemoteDidcommEndpoint } from "../vta/didcomm.js";
import { buildTrustTask } from "../vta/trust-task.js";

import {
  TYPE_URI as SERVICES_LIST,
  RESPONSE_TYPE_URI as SERVICES_LIST_RESPONSE,
  type VTAServicesListResponsePayload,
  type ServiceState,
  type ServiceKind,
} from "@openvtc/trust-tasks/vta/services/list/1.0/payload";
import {
  TYPE_URI as SERVICES_GET,
  RESPONSE_TYPE_URI as SERVICES_GET_RESPONSE,
  type VTAServicesGetPayload,
  type VTAServicesGetResponsePayload,
} from "@openvtc/trust-tasks/vta/services/get/1.0/payload";
import {
  TYPE_URI as SERVICES_ENABLE,
  RESPONSE_TYPE_URI as SERVICES_ENABLE_RESPONSE,
  type VTAServicesEnablePayload,
  type VTAServicesEnableResponsePayload,
} from "@openvtc/trust-tasks/vta/services/enable/1.0/payload";
import {
  TYPE_URI as SERVICES_DISABLE,
  RESPONSE_TYPE_URI as SERVICES_DISABLE_RESPONSE,
  type VTAServicesDisablePayload,
  type VTAServicesDisableResponsePayload,
} from "@openvtc/trust-tasks/vta/services/disable/1.0/payload";
import {
  TYPE_URI as SERVICES_UPDATE,
  RESPONSE_TYPE_URI as SERVICES_UPDATE_RESPONSE,
  type VTAServicesUpdatePayload,
  type VTAServicesUpdateResponsePayload,
} from "@openvtc/trust-tasks/vta/services/update/1.0/payload";
import {
  TYPE_URI as SERVICES_ROLLBACK,
  RESPONSE_TYPE_URI as SERVICES_ROLLBACK_RESPONSE,
  type VTAServicesRollbackPayload,
  type VTAServicesRollbackResponsePayload,
} from "@openvtc/trust-tasks/vta/services/rollback/1.0/payload";
import {
  TYPE_URI as SERVICES_DRAIN_LIST,
  RESPONSE_TYPE_URI as SERVICES_DRAIN_LIST_RESPONSE,
  type VTAServicesDrainListResponsePayload,
} from "@openvtc/trust-tasks/vta/services/drain/list/1.0/payload";
import {
  TYPE_URI as SERVICES_DRAIN_CANCEL,
  RESPONSE_TYPE_URI as SERVICES_DRAIN_CANCEL_RESPONSE,
  type VTAServicesDrainCancelPayload,
  type VTAServicesDrainCancelResponsePayload,
} from "@openvtc/trust-tasks/vta/services/drain/cancel/1.0/payload";

export type { ServiceState, ServiceKind };

/** Every `vta/services/*` call is issued by an operator identity, to an agent. */
export interface ServicesCallerParams {
  /** Envelope `issuer`. Needs an admin role — the whole family is manage-gated. */
  holder: Identity;
  /** The agent — envelope `recipient`. */
  service: RemoteDidcommEndpoint;
}

/** Transport configuration. Which members apply depends on the `ServiceKind`. */
export type ServiceConfig = VTAServicesEnablePayload["config"];

async function call<Req, Res>(
  sender: TrustTaskSender,
  caller: ServicesCallerParams,
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

/** Every transport the agent knows about, enabled or not. */
export async function servicesList(
  sender: TrustTaskSender,
  params: ServicesCallerParams,
): Promise<ServiceState[]> {
  const res = await call<Record<string, never>, VTAServicesListResponsePayload>(
    sender, params, SERVICES_LIST, SERVICES_LIST_RESPONSE,
    "vta/services/list/1.0", {});
  return res.services ?? [];
}

export interface ServiceGetParams extends ServicesCallerParams {
  kind: ServiceKind;
}

/**
 * One transport's state.
 *
 * **Read `drainsUntil`, not just `enabled`.** A transport being drained is
 * still serving: `enabled` has already gone false while in-flight work
 * finishes, so the two together are the state, and `enabled` alone reads as
 * "stopped" during the window where it has not.
 */
export async function serviceGet(
  sender: TrustTaskSender,
  params: ServiceGetParams,
): Promise<ServiceState> {
  const payload: VTAServicesGetPayload = { service: params.kind };
  const res = await call<VTAServicesGetPayload, VTAServicesGetResponsePayload>(
    sender, params, SERVICES_GET, SERVICES_GET_RESPONSE,
    "vta/services/get/1.0", payload);
  return res.state;
}

export interface ServiceEnableParams extends ServicesCallerParams {
  kind: ServiceKind;
  config: ServiceConfig;
}

/**
 * Turn a transport on.
 *
 * `config.force` skips whatever precondition the agent would otherwise check
 * (typically a mediator handshake). It exists for recovering an agent whose
 * peer is down; using it routinely means enabling a transport that has never
 * been shown to work, and the failure surfaces at a client rather than here.
 */
export async function serviceEnable(
  sender: TrustTaskSender,
  params: ServiceEnableParams,
): Promise<VTAServicesEnableResponsePayload["result"]> {
  const payload: VTAServicesEnablePayload = {
    service: params.kind,
    config: params.config,
  };
  const res = await call<VTAServicesEnablePayload, VTAServicesEnableResponsePayload>(
    sender, params, SERVICES_ENABLE, SERVICES_ENABLE_RESPONSE,
    "vta/services/enable/1.0", payload);
  return res.result;
}

export interface ServiceDisableParams extends ServicesCallerParams {
  kind: ServiceKind;
  /**
   * How long the agent keeps serving in-flight work before the transport
   * really stops.
   *
   * Omitted takes the agent's default, which is **not** zero. This is the
   * member that makes `disable` a drain rather than a switch: until it lapses
   * the transport still answers, and `drainsUntil` on the service state says
   * when it will not. Pass `0` only if dropping in-flight work is the intent.
   */
  drainTtlSecs?: number;
}

/** Begin draining a transport. See {@link ServiceDisableParams.drainTtlSecs}. */
export async function serviceDisable(
  sender: TrustTaskSender,
  params: ServiceDisableParams,
): Promise<VTAServicesDisableResponsePayload["result"]> {
  const payload: VTAServicesDisablePayload = {
    service: params.kind,
    // `!== undefined`: `0` is "drop in-flight work now", not "unspecified".
    ...(params.drainTtlSecs !== undefined
      ? { drainTtlSecs: params.drainTtlSecs }
      : {}),
  };
  const res = await call<VTAServicesDisablePayload, VTAServicesDisableResponsePayload>(
    sender, params, SERVICES_DISABLE, SERVICES_DISABLE_RESPONSE,
    "vta/services/disable/1.0", payload);
  return res.result;
}

export interface ServiceUpdateParams extends ServicesCallerParams {
  kind: ServiceKind;
  /** Replacement configuration, applied wholesale rather than merged. */
  config: ServiceConfig;
}

/**
 * Reconfigure a running transport.
 *
 * The config replaces rather than merges, so send the full intended shape. If
 * it does not take, {@link serviceRollback} restores the previous one — which
 * is the only reason changing a live transport's mediator is survivable.
 */
export async function serviceUpdate(
  sender: TrustTaskSender,
  params: ServiceUpdateParams,
): Promise<VTAServicesUpdateResponsePayload["result"]> {
  const payload: VTAServicesUpdatePayload = {
    service: params.kind,
    config: params.config,
  };
  const res = await call<VTAServicesUpdatePayload, VTAServicesUpdateResponsePayload>(
    sender, params, SERVICES_UPDATE, SERVICES_UPDATE_RESPONSE,
    "vta/services/update/1.0", payload);
  return res.result;
}

export interface ServiceRollbackParams extends ServicesCallerParams {
  kind: ServiceKind;
}

/** Restore the configuration in force before the last {@link serviceUpdate}. */
export async function serviceRollback(
  sender: TrustTaskSender,
  params: ServiceRollbackParams,
): Promise<VTAServicesRollbackResponsePayload["result"]> {
  const payload: VTAServicesRollbackPayload = { service: params.kind };
  const res = await call<VTAServicesRollbackPayload, VTAServicesRollbackResponsePayload>(
    sender, params, SERVICES_ROLLBACK, SERVICES_ROLLBACK_RESPONSE,
    "vta/services/rollback/1.0", payload);
  return res.result;
}

/**
 * Mediators currently draining, each with the instant its drain lapses.
 *
 * The answer to "is it safe to take that mediator down yet" — which no
 * `services/get` tells you, because a drain is per mediator and a transport may
 * hold several.
 */
export async function serviceDrainList(
  sender: TrustTaskSender,
  params: ServicesCallerParams,
): Promise<VTAServicesDrainListResponsePayload["entries"]> {
  const res = await call<Record<string, never>, VTAServicesDrainListResponsePayload>(
    sender, params, SERVICES_DRAIN_LIST, SERVICES_DRAIN_LIST_RESPONSE,
    "vta/services/drain/list/1.0", {});
  return res.entries ?? [];
}

export interface ServiceDrainCancelParams extends ServicesCallerParams {
  /** The mediator whose drain to call off. */
  mediatorDid: string;
}

/** Call off a drain, returning the mediator to ordinary service. */
export async function serviceDrainCancel(
  sender: TrustTaskSender,
  params: ServiceDrainCancelParams,
): Promise<VTAServicesDrainCancelResponsePayload> {
  const payload: VTAServicesDrainCancelPayload = { mediatorDid: params.mediatorDid };
  return call(sender, params, SERVICES_DRAIN_CANCEL, SERVICES_DRAIN_CANCEL_RESPONSE,
    "vta/services/drain/cancel/1.0", payload);
}
