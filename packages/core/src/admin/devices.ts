// Device management — the operator half of the `device/*` Trust Tasks.
//
// What is enrolled with an agent, and how to take something away from it. The
// device-side half of the family (`device/register`, `device/heartbeat`,
// `device/set-wake`) belongs to whatever is *being* a device — for this wallet
// that is `../device/`, not here.
//
// **`deviceWipe` is the most destructive call in this package.** The
// specification requires `scope` and `reason` on it, and the schema refuses a
// request missing either: a wipe with no recorded reason is an audit gap. That
// is a deliberate obstacle, so this wrapper adds no default for either.

import type { Identity } from "../didcomm/index.js";
import type { TrustTaskSender } from "../vta/channel.js";
import type { RemoteDidcommEndpoint } from "../vta/didcomm.js";
import { buildTrustTask } from "../vta/trust-task.js";

import {
  TYPE_URI as DEVICE_LIST,
  RESPONSE_TYPE_URI as DEVICE_LIST_RESPONSE,
  type DeviceListPayload,
  type DeviceListResponsePayload,
  type DeviceBinding,
} from "@openvtc/trust-tasks/device/list/0.2/payload";
import {
  TYPE_URI as DEVICE_DISABLE,
  RESPONSE_TYPE_URI as DEVICE_DISABLE_RESPONSE,
  type DeviceDisablePayload,
  type DeviceDisableResponsePayload,
} from "@openvtc/trust-tasks/device/disable/0.1/payload";
import {
  TYPE_URI as DEVICE_WIPE,
  RESPONSE_TYPE_URI as DEVICE_WIPE_RESPONSE,
  type DeviceWipePayload,
  type DeviceWipeResponsePayload,
} from "@openvtc/trust-tasks/device/wipe/0.1/payload";

export type { DeviceBinding };

/** How much of a device's state the agent asks it to destroy. */
export type WipeScope = DeviceWipePayload["scope"];

export interface DeviceCallerParams {
  holder: Identity;
  service: RemoteDidcommEndpoint;
}

export interface DeviceListParams extends DeviceCallerParams {
  consumerKindFilter?: DeviceListPayload["consumerKindFilter"];
  formFactorFilter?: DeviceListPayload["formFactorFilter"];
  serviceKindFilter?: DeviceListPayload["serviceKindFilter"];
  capabilityFilter?: DeviceListPayload["capabilityFilter"];
  /** Include devices with `disabledAt` set. Default omits them. */
  includeDisabled?: boolean;
  /** Include devices that have been wiped. Default omits them. */
  includeWiped?: boolean;
  /** RFC 3339 — only devices seen since. */
  lastSeenSince?: string;
  pageSize?: number;
  cursor?: string;
}

export interface DeviceListResult {
  devices: DeviceBinding[];
  /** The agent stopped early — fetch the rest with `cursor`. */
  truncated: boolean;
  cursor?: string;
}

/**
 * List enrolled devices.
 *
 * Disabled and wiped devices are omitted unless asked for. A console showing
 * "your devices" should say which of the two lists it is showing, because the
 * difference is the whole point of `includeDisabled`: a device that was taken
 * away still exists, and hiding it hides the fact that it was.
 */
export async function deviceList(
  sender: TrustTaskSender,
  params: DeviceListParams,
): Promise<DeviceListResult> {
  const payload: DeviceListPayload = {
    ...(params.consumerKindFilter ? { consumerKindFilter: params.consumerKindFilter } : {}),
    ...(params.formFactorFilter ? { formFactorFilter: params.formFactorFilter } : {}),
    ...(params.serviceKindFilter ? { serviceKindFilter: params.serviceKindFilter } : {}),
    ...(params.capabilityFilter ? { capabilityFilter: params.capabilityFilter } : {}),
    // `!== undefined` throughout: `includeDisabled: false` is an explicit
    // "current devices only", not an absent filter.
    ...(params.includeDisabled !== undefined
      ? { includeDisabled: params.includeDisabled }
      : {}),
    ...(params.includeWiped !== undefined ? { includeWiped: params.includeWiped } : {}),
    ...(params.lastSeenSince ? { lastSeenSince: params.lastSeenSince } : {}),
    ...(params.pageSize !== undefined ? { pageSize: params.pageSize } : {}),
    ...(params.cursor ? { cursor: params.cursor } : {}),
  };
  const envelope = buildTrustTask(DEVICE_LIST, payload, {
    issuer: params.holder.did,
    recipient: params.service.did,
  });
  const res = await sender.send<DeviceListResponsePayload>(envelope, {
    expectedResponseType: DEVICE_LIST_RESPONSE,
    operationLabel: "device/list/0.2",
  });
  return {
    devices: res.devices ?? [],
    truncated: res.truncated ?? false,
    ...(res.cursor ? { cursor: res.cursor } : {}),
  };
}

export interface DeviceDisableParams extends DeviceCallerParams {
  deviceId: string;
  reason?: string;
}

/** Disable a device. The record is kept — this is a state, not a deletion, so
 *  what the device did before remains answerable. */
export async function deviceDisable(
  sender: TrustTaskSender,
  params: DeviceDisableParams,
): Promise<DeviceDisableResponsePayload> {
  const payload: DeviceDisablePayload = {
    deviceId: params.deviceId,
    ...(params.reason ? { reason: params.reason } : {}),
  };
  const envelope = buildTrustTask(DEVICE_DISABLE, payload, {
    issuer: params.holder.did,
    recipient: params.service.did,
  });
  return sender.send<DeviceDisableResponsePayload>(envelope, {
    expectedResponseType: DEVICE_DISABLE_RESPONSE,
    operationLabel: "device/disable/0.1",
  });
}

export interface DeviceWipeParams extends DeviceCallerParams {
  deviceId: string;
  /**
   * `cache` — transient state only; `cache-and-keys` — also the device's key
   * material; `full` — everything the device holds.
   */
  scope: WipeScope;
  /** Required by the specification. A wipe with no recorded reason is an audit
   *  gap, and the schema refuses one — so this parameter is not optional. */
  reason: string;
  /** RFC 3339. Defaults to the agent's own clock when omitted. */
  issuedAt?: string;
}

/** Remote-wipe a compromised or lost device. */
export async function deviceWipe(
  sender: TrustTaskSender,
  params: DeviceWipeParams,
): Promise<DeviceWipeResponsePayload> {
  const payload: DeviceWipePayload = {
    deviceId: params.deviceId,
    scope: params.scope,
    reason: params.reason,
    ...(params.issuedAt ? { issuedAt: params.issuedAt } : {}),
  };
  const envelope = buildTrustTask(DEVICE_WIPE, payload, {
    issuer: params.holder.did,
    recipient: params.service.did,
  });
  return sender.send<DeviceWipeResponsePayload>(envelope, {
    expectedResponseType: DEVICE_WIPE_RESPONSE,
    operationLabel: "device/wipe/0.1",
  });
}
