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
import type { RemoteDidcommEndpoint } from "../vta/didcomm.js";
import { getVtaBearer, makeReauth, postTrustTask, type VtaAuthInputs } from "../vault/transport.js";

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

export interface DeviceSetWakeOptions {
  /** VTA REST base URL. */
  baseUrl: string;
  /** The wallet's holder DIDComm identity (authcrypt sender). */
  holder: Identity;
  /** The VTA's keyAgreement endpoint (from `resolveKeyAgreement`). */
  service: RemoteDidcommEndpoint;
  /** The handle to set. Omit to CLEAR the wake channel. */
  wakeHandle?: WakeHandle;
  /** Advisory platform hint (device/list visibility only — VTA never sees the token). */
  pushPlatform?: "apns" | "fcm" | "webpush";
  /** Advisory trigger DIDs (e.g. the device's mediator). The VTA owns the
   *  allowlist and MAY ignore these. */
  suggestedTriggers?: string[];
  fetch?: typeof fetch;
}

/**
 * Convey (or clear) the device's wake handle at the connected VTA. Idempotent;
 * re-issue on token rotation. Returns the VTA's effective trigger policy.
 */
export async function setDeviceWake(
  opts: DeviceSetWakeOptions,
): Promise<DeviceSetWakeResponse> {
  const auth: VtaAuthInputs = {
    baseUrl: opts.baseUrl,
    holder: opts.holder,
    service: opts.service,
    ...(opts.fetch ? { fetch: opts.fetch } : {}),
  };
  const bearer = await getVtaBearer(auth);

  const payload = {
    ...(opts.wakeHandle ? { wakeHandle: opts.wakeHandle } : {}),
    ...(opts.pushPlatform ? { pushPlatform: opts.pushPlatform } : {}),
    ...(opts.suggestedTriggers ? { suggestedTriggers: opts.suggestedTriggers } : {}),
  };

  return postTrustTask<DeviceSetWakeResponse>({
    baseUrl: opts.baseUrl,
    bearer,
    envelope: {
      type: TASK_DEVICE_SET_WAKE,
      payload,
      issuer: opts.holder.did,
      recipient: opts.service.did,
    },
    expectedResponseType: TASK_DEVICE_SET_WAKE_RESPONSE,
    operationLabel: "device/set-wake/0.2",
    reauth: makeReauth(auth),
    ...(opts.fetch ? { fetch: opts.fetch } : {}),
  });
}
