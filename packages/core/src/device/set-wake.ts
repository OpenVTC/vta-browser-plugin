// Device — set-wake (push wake-up binding, https://trusttasks.org/binding/push/0.1).
//
// Conveys to the connected VTA the opaque `WakeHandle` the device obtained
// from a push gateway (via `push/register`), so the VTA can own the trigger
// allowlist and provision the gateway. Carries NO platform push token — only
// the handle. Present `wakeHandle` sets/replaces the wake channel; absent
// clears it (the device becomes non-wakeable).
//
// Posts a `https://trusttasks.org/spec/device/set-wake/0.2` envelope to the
// VTA's trust-task dispatcher (`POST /api/trust-tasks`) using the same
// authcrypt → bearer primitive as the vault/* ops (`getVtaBearer`). The 0.2
// payload is field- and value-identical to 0.1 (no enum fields), so this is a
// pure minor-version bump; the VTA dual-accepts it via its 0.2 edge transform.

import type { Identity } from "../didcomm/index.js";
import type { TrustTaskSender } from "../vta/channel.js";
import type { RemoteDidcommEndpoint } from "../vta/didcomm.js";
import { RestChannel } from "../vta/rest-channel.js";
import { buildTrustTask } from "../vta/trust-task.js";
import type { VtaAuthInputs } from "../vault/transport.js";

const TASK_DEVICE_SET_WAKE = "https://trusttasks.org/spec/device/set-wake/0.2";
const TASK_DEVICE_SET_WAKE_RESPONSE =
  "https://trusttasks.org/spec/device/set-wake/0.2#response";

/** The opaque gateway-issued handle — gateway address + handle, no token. */
export interface WakeHandle {
  /** Gateway that issued + acts on this handle (DID or https URL). */
  gateway: string;
  /** Opaque gateway-issued channel identifier (reveals no token). */
  handle: string;
}

/** The VTA's effective allowlist, as provisioned to the gateway. */
export interface WakeTriggerPolicy {
  allowedTriggers: string[];
}

export interface DeviceSetWakeResponse {
  /** Whether the device now has a usable wake channel. */
  pushCapable: boolean;
  /** The effective allowlist the VTA computed + provisioned (absent on clear). */
  triggerPolicy?: WakeTriggerPolicy;
}

export interface DeviceSetWakeParams {
  /** The wallet's holder DIDComm identity (envelope `issuer`). */
  holder: Identity;
  /** The VTA's keyAgreement endpoint (envelope `recipient`). */
  service: RemoteDidcommEndpoint;
  /** The handle to set. Omit to CLEAR the wake channel. */
  wakeHandle?: WakeHandle;
  /** Advisory platform hint (device/list visibility only — VTA never sees the token). */
  pushPlatform?: "apns" | "fcm" | "webpush";
  /** Advisory trigger DIDs (e.g. the device's mediator). The VTA owns the
   *  allowlist and MAY ignore these. */
  suggestedTriggers?: string[];
}

/** @deprecated REST-transport options. Kept for existing call sites; prefer
 *  {@link setDeviceWake} with a channel from a `VtaSession`. */
export interface DeviceSetWakeOptions extends DeviceSetWakeParams, VtaAuthInputs {}

/**
 * Convey (or clear) the device's wake handle at the connected VTA. Idempotent;
 * re-issue on token rotation. Returns the VTA's effective trigger policy.
 */
export async function setDeviceWake(
  channel: TrustTaskSender,
  params: DeviceSetWakeParams,
): Promise<DeviceSetWakeResponse> {
  const envelope = buildTrustTask(
    TASK_DEVICE_SET_WAKE,
    {
      ...(params.wakeHandle ? { wakeHandle: params.wakeHandle } : {}),
      ...(params.pushPlatform ? { pushPlatform: params.pushPlatform } : {}),
      ...(params.suggestedTriggers ? { suggestedTriggers: params.suggestedTriggers } : {}),
    },
    { issuer: params.holder.did, recipient: params.service.did },
  );
  return channel.send<DeviceSetWakeResponse>(envelope, {
    expectedResponseType: TASK_DEVICE_SET_WAKE_RESPONSE,
    operationLabel: "device/set-wake/0.2",
  });
}

/** @deprecated Use {@link setDeviceWake} with a channel from a `VtaSession`.
 *  Set-wake over REST — builds a one-shot {@link RestChannel}. */
export function setDeviceWakeRest(opts: DeviceSetWakeOptions): Promise<DeviceSetWakeResponse> {
  return setDeviceWake(new RestChannel(opts), opts);
}
