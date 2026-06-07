// Device — push/register (push wake-up binding, https://trusttasks.org/binding/push/0.1).
//
// A device registers its platform push channel (here: a Web Push subscription)
// with a push GATEWAY and names the controller VTA permitted to provision its
// trigger allowlist. The gateway holds the raw token and returns an opaque
// `WakeHandle` in exchange.
//
// Transport: `push/register` is UNAUTHENTICATED over HTTPS (binding §"register"
// — the handle is opaque and useless until the controller VTA provisions a
// trigger), so this is a plain `POST {gateway}/trust-tasks` of the canonical
// Trust Task document. No DIDComm, no bearer — it runs fine in an MV3 service
// worker (which can't do DIDComm). The handle is then conveyed to the VTA via
// `device/set-wake`.

import type { WakeHandle } from "./set-wake.js";
import { isTrustTaskErrorType } from "../vta/protocol.js";

// push/register/0.2 — the payload is field-identical to 0.1 (no enum values),
// so this is a pure version-string bump. The gateway accepts both 0.1 and 0.2
// and mirrors the request version into the `#response`.
const TASK_PUSH_REGISTER = "https://trusttasks.org/spec/push/register/0.2";
const TASK_PUSH_REGISTER_RESPONSE =
  "https://trusttasks.org/spec/push/register/0.2#response";

/** A device's platform push channel — tagged union over `platform`. Only the
 *  Web Push variant is wired today (self-hostable, no Apple/Google account). */
export type PushRegistration = {
  platform: "webpush";
  /** RFC 8030 Web Push subscription endpoint. */
  endpoint: string;
  /** RFC 8291 encryption keys. */
  keys: { p256dh: string; auth: string };
};

export interface RegisterPushChannelOptions {
  /** Push gateway base URL (the HTTPS transport — `POST {gatewayUrl}/trust-tasks`). */
  gatewayUrl: string;
  /** The platform push channel to register. */
  registration: PushRegistration;
  /** The DID of the VTA permitted to provision this handle's allowlist. */
  controllerVtaDid: string;
  fetch?: typeof fetch;
}

/**
 * Register a push channel with the gateway and return the opaque `WakeHandle`.
 * The raw token stays at the gateway. Convey the returned handle to the VTA
 * via {@link setDeviceWake}.
 */
export async function registerPushChannel(
  opts: RegisterPushChannelOptions,
): Promise<WakeHandle> {
  const f = opts.fetch ?? fetch.bind(globalThis);
  const base = opts.gatewayUrl.replace(/\/+$/, "");

  const doc = {
    id: globalThis.crypto.randomUUID(),
    type: TASK_PUSH_REGISTER,
    issuedAt: new Date().toISOString(),
    payload: {
      registration: opts.registration,
      controllerVtaDid: opts.controllerVtaDid,
    },
  };

  const res = await f(`${base}/trust-tasks`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(doc),
  });
  if (!res.ok) {
    throw new Error(
      `push/register: ${base}/trust-tasks failed (${res.status}): ${await res.text()}`,
    );
  }

  const out = (await res.json()) as { type?: string; payload?: unknown };
  if (out.type === TASK_PUSH_REGISTER_RESPONSE) {
    const handle = (out.payload as { wakeHandle?: WakeHandle })?.wakeHandle;
    if (!handle?.gateway || !handle?.handle) {
      throw new Error(`push/register: malformed response payload: ${JSON.stringify(out)}`);
    }
    return handle;
  }
  if (isTrustTaskErrorType(out.type)) {
    const err = out.payload as { code?: string; message?: string };
    throw new Error(`${err?.code ?? "unknown"}: ${err?.message ?? "(no message)"}`);
  }
  throw new Error(`push/register: unexpected response type ${out.type ?? "(none)"}`);
}
