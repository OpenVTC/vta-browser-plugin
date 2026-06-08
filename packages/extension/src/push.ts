/// <reference types="chrome" />

// Web Push subscription for the push wake-up binding
// (https://trusttasks.org/binding/push/0.1). The MV3 service worker subscribes
// to Web Push with the gateway's VAPID public key; the resulting subscription
// ({ endpoint, keys: { p256dh, auth } }) is registered with the gateway via
// `push/register` (see push-register.ts), which returns an opaque WakeHandle.
//
// When a trigger later fires `push/wake`, the gateway delivers a contentless
// Web Push and the `push` handler in background.ts wakes the worker. The real
// inbound flow (next slice) replaces that handler body with: wake → connect to
// mediator → pick up + decrypt the DIDComm confirm-request → consent prompt →
// signed response.

import { base64urlToBytes } from "@openvtc/pnm-core";
import { getSettings } from "./config.js";

// Fallback VAPID public key (the original feasibility-probe key) — used only
// when no gateway VAPID key is configured, so the bare subscribe path still
// works for a manual `npx web-push` probe. A real gateway wake requires the
// gateway's own VAPID public key (Settings → push gateway).
const FALLBACK_VAPID_PUBLIC_KEY =
  "BOp_ZH4GUVZ1aPNmBJl9rpQWTJyNQWLGAclN3d2VYJKxhyzYqYoKbOwwU98C9jaa1IiTjz-IasJFV74Yop0qUOQ";

/**
 * Subscribe the service worker to Web Push (idempotent) and return the
 * subscription. Subscribes with the configured gateway VAPID public key when
 * set, else the fallback probe key. Returns `null` on failure (logged) so
 * callers can skip registration without crashing the worker.
 */
export async function subscribeToPush(): Promise<PushSubscription | null> {
  try {
    const { pushGatewayVapidPublicKey } = await getSettings();
    const vapidKey = pushGatewayVapidPublicKey || FALLBACK_VAPID_PUBLIC_KEY;

    const reg = (self as unknown as { registration: ServiceWorkerRegistration }).registration;

    // `pushManager.subscribe` requires an *active* service worker. On a cold
    // start (install/update/first eval) the worker isn't active yet, so calling
    // it here throws `AbortError: … no active Service Worker`. Defer to the
    // `activate` event, which re-runs this once the worker is active.
    if (!reg.active) {
      console.info("[pnm push] service worker not active yet — deferring subscribe to activate");
      return null;
    }

    let sub = await reg.pushManager.getSubscription();

    // If an existing subscription was minted under a different application
    // server key (e.g. the fallback, before a gateway key was configured),
    // re-subscribe so the gateway can actually sign pushes to it.
    if (sub && !subscriptionMatchesKey(sub, vapidKey)) {
      await sub.unsubscribe();
      sub = null;
    }
    if (!sub) {
      sub = await reg.pushManager.subscribe({
        userVisibleOnly: true,
        applicationServerKey: base64urlToBytes(vapidKey) as BufferSource,
      });
    }
    console.info("[pnm push] subscription:\n" + JSON.stringify(sub.toJSON()));
    return sub;
  } catch (e) {
    console.error("[pnm push] subscribe failed:", e);
    return null;
  }
}

/** Whether an existing subscription was created with the given VAPID key.
 *  Compares the subscription's stored `applicationServerKey` bytes to the
 *  configured key; returns `true` (keep) when the comparison can't be made. */
function subscriptionMatchesKey(sub: PushSubscription, vapidKey: string): boolean {
  const optKey = sub.options?.applicationServerKey;
  if (!optKey) return true; // can't tell — don't churn the subscription
  const current = new Uint8Array(optKey as ArrayBuffer);
  const want = base64urlToBytes(vapidKey);
  if (current.length !== want.length) return false;
  for (let i = 0; i < current.length; i++) {
    if (current[i] !== want[i]) return false;
  }
  return true;
}
