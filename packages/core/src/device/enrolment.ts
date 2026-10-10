// Device enrolment and liveness — `device/register` and `device/heartbeat`.
//
// These are the *device's own* side of the family: a device tells an agent it
// exists, and keeps telling it. The operator's side — listing what is enrolled,
// disabling it, wiping it — lives in `admin/devices.ts`, because a wallet has
// no business shipping the ability to wipe somebody else's device.
//
// Both target 0.2. The 0.1 forms are deprecated in `vta-sdk` (the enum values
// moved to camelCase), and the conformance test refuses a deprecated target.

import type { Identity } from "../didcomm/index.js";
import type { TrustTaskSender } from "../vta/channel.js";
import type { RemoteDidcommEndpoint } from "../vta/didcomm.js";
import { buildTrustTask } from "../vta/trust-task.js";
import { TASK_REFUSAL_CONFLICT, TASK_REFUSAL_NOT_FOUND, taskRefusalReason } from "../vta/errors.js";

import {
  TYPE_URI as DEVICE_REGISTER,
  RESPONSE_TYPE_URI as DEVICE_REGISTER_RESPONSE,
  type DeviceRegisterResponsePayload,
  type DeviceBinding,
  type ConsumerKind,
  type DeviceAttestation,
  type KeyCustody,
} from "@openvtc/trust-tasks/device/register/0.2/payload";
import {
  TYPE_URI as DEVICE_HEARTBEAT,
  RESPONSE_TYPE_URI as DEVICE_HEARTBEAT_RESPONSE,
  type DeviceHeartbeatPayload,
  type DeviceHeartbeatResponsePayload,
  type QueuedOperation,
} from "@openvtc/trust-tasks/device/heartbeat/0.2/payload";

export type { DeviceBinding, ConsumerKind, DeviceAttestation, KeyCustody, QueuedOperation };

export interface DeviceEnrolmentParams {
  /** Envelope `issuer` — this device's DIDComm identity. */
  holder: Identity;
  /** The agent — envelope `recipient`. */
  service: RemoteDidcommEndpoint;
}

export interface DeviceRegisterParams extends DeviceEnrolmentParams {
  /** What kind of consumer this is — a companion (browser, mobile, desktop) or
   *  a service (mediator, AI agent, daemon). */
  consumerKind: ConsumerKind;
  /** Shown to the operator when they review their devices. Choose something a
   *  human can tell apart from their other devices, since this is all they will
   *  have to go on when deciding what to disable. */
  displayName: string;
  platform?: string;
  /**
   * Hardware attestation, when the platform can produce one.
   *
   * Its absence is not a failure — `kind: "none"` is a legitimate value and
   * most browsers cannot do better. What matters is that an agent's policy may
   * *require* one, so a device that could attest and did not may find itself
   * with less authority than it expected.
   */
  attestation?: DeviceAttestation;
  /** Whether the keys live in hardware or software, and which algorithms. */
  keyCustody?: KeyCustody;
  /** HPKE public key, for agents that seal wake payloads to the device. */
  hpkePublicKey?: string;
}

/** Enrol this device with an agent. Returns the binding the agent now holds. */
export async function registerDevice(
  sender: TrustTaskSender,
  params: DeviceRegisterParams,
): Promise<DeviceBinding> {
  const payload = {
    consumerKind: params.consumerKind,
    displayName: params.displayName,
    ...(params.platform ? { platform: params.platform } : {}),
    ...(params.attestation ? { attestation: params.attestation } : {}),
    ...(params.keyCustody ? { keyCustody: params.keyCustody } : {}),
    ...(params.hpkePublicKey ? { hpkePublicKey: params.hpkePublicKey } : {}),
  };
  const envelope = buildTrustTask(DEVICE_REGISTER, payload, {
    issuer: params.holder.did,
    recipient: params.service.did,
  });
  const res = await sender.send<DeviceRegisterResponsePayload>(envelope, {
    expectedResponseType: DEVICE_REGISTER_RESPONSE,
    operationLabel: "device/register/0.2",
  });
  return res.binding;
}

export interface DeviceHeartbeatParams extends DeviceEnrolmentParams {
  platform?: string;
  /** The vault sequence this device has caught up to, so the agent can tell
   *  whether it is behind. */
  vaultSeq?: number;
}

export interface DeviceHeartbeatResult {
  /** RFC 3339, the agent's clock. */
  serverTime: string;
  /**
   * Work the agent wants this device to do — **including `wipe`**.
   *
   * This is the mechanism by which a remote wipe actually reaches a device: it
   * is handed out on the next heartbeat. A client that ignores this array is a
   * client that cannot be wiped, so drain it rather than treating a heartbeat
   * as a liveness ping with a timestamp.
   */
  queuedOperations: QueuedOperation[];
  /** `upToDate`, or a hint that this device should sync. */
  syncHint?: DeviceHeartbeatResponsePayload["syncHint"];
}

/** Tell the agent this device is still here, and collect anything queued for it. */
export async function deviceHeartbeat(
  sender: TrustTaskSender,
  params: DeviceHeartbeatParams,
): Promise<DeviceHeartbeatResult> {
  const payload: DeviceHeartbeatPayload = {
    ...(params.platform ? { platform: params.platform } : {}),
    // `!== undefined`: sequence 0 is "I have caught up to nothing yet", which
    // is exactly what a fresh device should be able to say.
    ...(params.vaultSeq !== undefined ? { vaultSeq: params.vaultSeq } : {}),
  };
  const envelope = buildTrustTask(DEVICE_HEARTBEAT, payload, {
    issuer: params.holder.did,
    recipient: params.service.did,
  });
  const res = await sender.send<DeviceHeartbeatResponsePayload>(envelope, {
    expectedResponseType: DEVICE_HEARTBEAT_RESPONSE,
    operationLabel: "device/heartbeat/0.2",
  });
  return {
    serverTime: res.serverTime,
    queuedOperations: res.queuedOperations ?? [],
    ...(res.syncHint ? { syncHint: res.syncHint } : {}),
  };
}

// ── Enrolling early ─────────────────────────────────────────────────────────

/**
 * Make sure this device is registered with the agent, without disturbing a
 * registration it already has.
 *
 * Every wallet install (every browser profile, every phone) is a device of its
 * own: it authenticates as its own holder DID, which has its own ACL entry, so
 * registering here writes that entry's binding and nothing else. The agent
 * refuses a second `device/register` for a bound DID, so this asks first with
 * a `device/heartbeat`: a heartbeat that succeeds means the binding exists
 * (and refreshes `lastSeenAt`); `not_found` means it does not, and the device
 * registers. A `conflict` on the register is another call of this one winning
 * the race, which is the outcome wanted.
 *
 * Returns `"present"` when the device was already registered and
 * `"registered"` when this call registered it.
 */
export async function ensureDeviceRegistered(
  sender: TrustTaskSender,
  params: DeviceRegisterParams,
): Promise<"present" | "registered"> {
  try {
    await deviceHeartbeat(sender, {
      holder: params.holder,
      service: params.service,
      ...(params.platform ? { platform: params.platform } : {}),
    });
    return "present";
  } catch (err) {
    if (taskRefusalReason(err) !== TASK_REFUSAL_NOT_FOUND) throw err;
  }
  try {
    await registerDevice(sender, params);
    return "registered";
  } catch (err) {
    if (taskRefusalReason(err) === TASK_REFUSAL_CONFLICT) return "present";
    throw err;
  }
}
