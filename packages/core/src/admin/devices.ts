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

import type { TaskParty, TrustTaskSender } from "../vta/channel.js";
import { buildTrustTask } from "../vta/trust-task.js";
import { collectPages } from "../util/pages.js";

import {
  TYPE_URI as DEVICE_LIST,
  RESPONSE_TYPE_URI as DEVICE_LIST_RESPONSE,
  type DeviceListPayload,
  type DeviceListResponsePayload,
  type DeviceBinding,
} from "../specs/device/list/0.3/payload.js";
import {
  TYPE_URI as DEVICE_DISABLE,
  RESPONSE_TYPE_URI as DEVICE_DISABLE_RESPONSE,
  type DeviceDisablePayload,
  type DeviceDisableResponsePayload,
} from "../specs/device/disable/0.1/payload.js";
import {
  TYPE_URI as DEVICE_WIPE,
  RESPONSE_TYPE_URI as DEVICE_WIPE_RESPONSE,
  type DeviceWipePayload,
  type DeviceWipeResponsePayload,
} from "../specs/device/wipe/0.2/payload.js";

export type { DeviceBinding };

/** How much of a device's state the agent asks it to destroy. */
export type WipeScope = DeviceWipePayload["scope"];

export interface DeviceCallerParams {
  holder: TaskParty;
  service: TaskParty;
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
  /** The page size to ask for — never a cap on the result. */
  limit?: number;
}

export interface DeviceListResult {
  /** Every matching device: the listing is read to the end. */
  devices: DeviceBinding[];
}

/**
 * List enrolled devices.
 *
 * Disabled and wiped devices are omitted unless asked for. A console showing
 * "your devices" should say which of the two lists it is showing, because the
 * difference is the whole point of `includeDisabled`: a device that was taken
 * away still exists, and hiding it hides the fact that it was.
 *
 * `device/list/0.3` moved to the registry-wide paging convention (`limit` /
 * `cursor` in, `nextCursor` out) and dropped 0.2's `truncated`, so only an
 * absent `nextCursor` means the end. The cursor is followed through
 * `collectPages`: a device list shown in part is an enrolment nobody sees.
 */
export async function deviceList(
  sender: TrustTaskSender,
  params: DeviceListParams,
): Promise<DeviceListResult> {
  const devices = await collectPages("device/list", async (cursor) => {
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
      ...(params.limit !== undefined ? { limit: params.limit } : {}),
      ...(cursor ? { cursor } : {}),
    };
    const envelope = buildTrustTask(DEVICE_LIST, payload, {
      issuer: params.holder.did,
      recipient: params.service.did,
    });
    const res = await sender.send<DeviceListResponsePayload>(envelope, {
      expectedResponseType: DEVICE_LIST_RESPONSE,
      operationLabel: "device/list/0.3",
    });
    return { items: res.devices ?? [], nextCursor: res.nextCursor };
  });
  return { devices };
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
   * `cache` — transient state only; `cacheAndKeys` — also the device's key
   * material; `full` — everything the device holds.
   *
   * The middle value is the whole reason this call is on `0.2`: `0.1` spelled
   * it `cache-and-keys`, and the enum is closed, so the old spelling is not a
   * synonym the agent tolerates — it is a value outside the schema.
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
    operationLabel: "device/wipe/0.2",
  });
}
