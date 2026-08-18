// `push/wake/0.2` — ask a gateway to wake a device.
//
// The sender here is whoever holds the device's `WakeHandle` and wants its
// attention: normally the controller agent, not the device. It lives in this
// module because it completes the push story the rest of the module tells
// (`registerPushChannel` mints the handle, `setDeviceWake` conveys it to the
// agent, this spends it) — but a wallet is the *subject* of a wake, not the
// sender, and has no reason to call it.
//
// The response is the part worth handling. `tokenUnregistered` means the
// platform has dropped this subscription: the handle is dead, and a caller that
// treats it as a transient failure will retry forever against a device that can
// never answer. Re-registration is the only cure.

import type { Identity } from "../didcomm/index.js";
import type { TrustTaskSender } from "../vta/channel.js";
import type { RemoteDidcommEndpoint } from "../vta/didcomm.js";
import { buildTrustTask } from "../vta/trust-task.js";

import {
  TYPE_URI as PUSH_WAKE,
  RESPONSE_TYPE_URI as PUSH_WAKE_RESPONSE,
  type PushWakePayload,
  type PushWakeResponsePayload,
} from "@openvtc/trust-tasks/push/wake/0.2/payload";

export interface PushWakeParams {
  /** Envelope `issuer` — the caller's identity. */
  holder: Identity;
  /** The push gateway — envelope `recipient`. */
  service: RemoteDidcommEndpoint;
  /** The opaque handle the gateway issued at registration. */
  handle: string;
  /** Mediator the woken device should collect from. */
  mediator?: string;
  /** How many messages are waiting. */
  count?: number;
  /**
   * `interactive` — a human is waiting on this; `background` — it can be
   * batched. Platforms ration the interactive tier, so spending it on work
   * nobody is watching is how a device stops being wakeable when it matters.
   */
  urgency?: PushWakePayload["urgency"];
}

/**
 * Wake a device through its gateway.
 *
 * Check the returned `status`: `delivered` is a handoff to the platform (not a
 * guarantee the device woke), and `tokenUnregistered` means the handle is dead
 * and must be replaced, not retried.
 */
export async function pushWake(
  sender: TrustTaskSender,
  params: PushWakeParams,
): Promise<PushWakeResponsePayload> {
  const payload: PushWakePayload = {
    handle: params.handle,
    v: 1,
    ...(params.mediator ? { mediator: params.mediator } : {}),
    ...(params.count !== undefined ? { count: params.count } : {}),
    ...(params.urgency ? { urgency: params.urgency } : {}),
  };
  const envelope = buildTrustTask(PUSH_WAKE, payload, {
    issuer: params.holder.did,
    recipient: params.service.did,
  });
  return sender.send<PushWakeResponsePayload>(envelope, {
    expectedResponseType: PUSH_WAKE_RESPONSE,
    operationLabel: "push/wake/0.2",
  });
}
