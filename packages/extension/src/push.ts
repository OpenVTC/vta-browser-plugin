/// <reference types="chrome" />

// Web Push probe (Slice 2 de-risk): can an MV3 extension service worker
// subscribe to Web Push and receive a `push` event? Subscribes with our
// VAPID public key and logs the resulting subscription so a sender (e.g.
// `npx web-push send-notification …` with the VAPID private key) can push to
// it. The `push` handler (registered in background.ts) logs the payload and
// shows a notification — Chrome's `userVisibleOnly: true` requires showing
// one per push.
//
// This is a feasibility probe. The real inbound flow (Slice 2) replaces the
// handler body with: wake → connect to mediator → pick up + decrypt the
// DIDComm confirm-request → consent prompt → signed response.

// VAPID application-server public key (the matching private key signs pushes).
const VAPID_PUBLIC_KEY =
  "BOp_ZH4GUVZ1aPNmBJl9rpQWTJyNQWLGAclN3d2VYJKxhyzYqYoKbOwwU98C9jaa1IiTjz-IasJFV74Yop0qUOQ";

function base64urlToBytes(s: string): Uint8Array {
  const pad = "=".repeat((4 - (s.length % 4)) % 4);
  const b64 = (s + pad).replace(/-/g, "+").replace(/_/g, "/");
  const bin = atob(b64);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

/** Subscribe the service worker to Web Push (idempotent) and log the
 *  subscription JSON so a sender can target it. */
export async function subscribeToPush(): Promise<void> {
  try {
    const reg = (self as unknown as { registration: ServiceWorkerRegistration }).registration;
    let sub = await reg.pushManager.getSubscription();
    if (!sub) {
      sub = await reg.pushManager.subscribe({
        userVisibleOnly: true,
        applicationServerKey: base64urlToBytes(VAPID_PUBLIC_KEY) as BufferSource,
      });
    }
    console.info("[pnm push] subscription:\n" + JSON.stringify(sub.toJSON()));
  } catch (e) {
    console.error("[pnm push] subscribe failed:", e);
  }
}
