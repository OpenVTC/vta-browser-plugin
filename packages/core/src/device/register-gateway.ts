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
import { withFetchTimeout } from "../http/timeout-fetch.js";

// push/register/0.2 — the payload is field-identical to 0.1 (no enum values),
// so this is a pure version-string bump. The gateway accepts both 0.1 and 0.2
// and mirrors the request version into the `#response`.
import {
  TYPE_URI as TASK_PUSH_REGISTER,
  RESPONSE_TYPE_URI as TASK_PUSH_REGISTER_RESPONSE,
  type WebPush,
} from "@openvtc/trust-tasks/push/register/0.2/payload";

/** A device's platform push channel — tagged union over `platform`. Only the
 *  Web Push variant is wired today (self-hostable, no Apple/Google account). */
/** What this wallet registers: a Web Push subscription.
 *
 *  A deliberate NARROWING of the schema's `PushRegistration`, which is
 *  `Apns | Fcm | WebPush` — a browser extension cannot produce the other two.
 *  Taken as the generated `WebPush` variant rather than restated, so the
 *  narrowing is the only thing this line says: the members still come from the
 *  schema, and widening the union later does not silently leave this behind.
 */
export type PushRegistration = WebPush;


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
  const f = withFetchTimeout(opts.fetch);
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
  // Parse the body BEFORE deciding on status (R3.7). `/trust-tasks` is the
  // dispatcher endpoint, so a refusal — including a consent requirement —
  // arrives as a `trust-task-error` document at a non-2xx status. Throwing on
  // `!res.ok` first made the `isTrustTaskErrorType` branch below unreachable
  // for every rejected task and flattened the machine-readable code into an
  // opaque string that callers could only match on.
  let out: { type?: string; payload?: unknown } | undefined;
  let raw: string | undefined;
  try {
    raw = await res.text();
    out = JSON.parse(raw) as { type?: string; payload?: unknown };
  } catch {
    // Not JSON — there is no code to recover, so the status is all we have.
    throw new Error(
      `push/register: ${base}/trust-tasks failed (${res.status}): ${raw ?? "(no body)"}`,
    );
  }

  if (isTrustTaskErrorType(out?.type)) {
    const err = out?.payload as { code?: string; message?: string };
    throw new Error(`${err?.code ?? "unknown"}: ${err?.message ?? "(no message)"}`);
  }
  if (!res.ok) {
    throw new Error(`push/register: ${base}/trust-tasks failed (${res.status}): ${raw}`);
  }
  if (out?.type === TASK_PUSH_REGISTER_RESPONSE) {
    const handle = (out.payload as { wakeHandle?: WakeHandle })?.wakeHandle;
    if (!handle?.gateway || !handle?.handle) {
      throw new Error(`push/register: malformed response payload: ${JSON.stringify(out)}`);
    }
    return handle;
  }
  throw new Error(`push/register: unexpected response type ${out?.type ?? "(none)"}`);
}
