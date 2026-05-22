/// <reference types="chrome" />

// Service worker. Owns the wallet's holder identity, runs the REST SIOPv2
// login, and gates every login behind a user-consent prompt. The DIDComm
// login is delegated to an offscreen document (see `offscreen.ts`) because
// it needs dynamic `import()` + a DOM, which a service worker lacks.
//
// REST flow: content → RUNTIME_LOGIN → consent → loginViaSiop → tokens.
// DIDComm flow: content → RUNTIME_LOGIN_DIDCOMM → consent → offscreen doc.

import { generateOrLoadHolderIdentity, IndexedDBKVStore, loginViaSiop } from "@pnm/core";
import { subscribeToPush } from "./push.js";
import {
  OFFSCREEN_DIDCOMM_LOGIN,
  OFFSCREEN_STEP_UP_VTA,
  OFFSCREEN_TARGET,
  RUNTIME_API_GET,
  RUNTIME_CONSENT_RESULT,
  RUNTIME_LOGIN,
  RUNTIME_LOGIN_DIDCOMM,
  RUNTIME_STEP_UP_VTA,
  type OffscreenDidcommLoginRequest,
  type OffscreenStepUpVtaRequest,
  type RuntimeApiGetRequest,
  type RuntimeApiGetResponse,
  type RuntimeConsentResult,
  type RuntimeLoginDidcommRequest,
  type RuntimeLoginRequest,
  type RuntimeLoginResponse,
  type RuntimeStepUpVtaRequest,
} from "./bridge-protocol.js";

chrome.runtime.onInstalled.addListener(() => {
  console.info("[pnm] extension installed");
  void subscribeToPush();
});

// Web Push probe (Slice 2 de-risk). Registered at top level so it's active
// when an inbound push wakes the worker. For now it just logs + notifies;
// the real handler will wake → mediator pickup → consent → respond.
self.addEventListener("push", (event) => {
  const pushEvent = event as PushEvent;
  let body = "";
  try {
    body = pushEvent.data ? pushEvent.data.text() : "";
  } catch {
    body = "(unreadable payload)";
  }
  console.info("[pnm push] push received:", body);
  const reg = (self as unknown as { registration: ServiceWorkerRegistration }).registration;
  pushEvent.waitUntil(reg.showNotification("VTA Wallet", { body: body || "Push received" }));
});

// Ensure a subscription exists whenever the worker spins up (not only on
// install — MV3 workers are ephemeral).
void subscribeToPush();

// ─── Offscreen document lifecycle ───
// One offscreen document per extension; create it lazily on first DIDComm
// login and reuse it thereafter.
let creatingOffscreen: Promise<void> | null = null;
async function ensureOffscreenDocument(): Promise<void> {
  if (await chrome.offscreen.hasDocument()) return;
  if (!creatingOffscreen) {
    creatingOffscreen = chrome.offscreen
      .createDocument({
        url: "offscreen.html",
        reasons: [chrome.offscreen.Reason.WORKERS],
        justification:
          "Run the DIDComm mediator session (WebSocket + did:webvh resolution) for wallet login.",
      })
      .finally(() => {
        creatingOffscreen = null;
      });
  }
  await creatingOffscreen;
}

// ─── Consent coordination ───
// A login request opens a consent popup and parks here until the popup
// reports the user's decision (or is closed, which counts as a denial).
const pendingConsents = new Map<string, (approved: boolean) => void>();

function requestConsent(args: {
  origin: string;
  rpDid: string;
  holderDid: string;
}): Promise<boolean> {
  const consentId = crypto.randomUUID();
  const url =
    chrome.runtime.getURL("confirm.html") +
    `?cid=${consentId}` +
    `&origin=${encodeURIComponent(args.origin)}` +
    `&rpDid=${encodeURIComponent(args.rpDid)}` +
    `&holder=${encodeURIComponent(args.holderDid)}`;

  return new Promise<boolean>((resolve) => {
    let settled = false;
    const settle = (approved: boolean) => {
      if (settled) return;
      settled = true;
      pendingConsents.delete(consentId);
      resolve(approved);
    };
    pendingConsents.set(consentId, settle);

    chrome.windows.create({ url, type: "popup", width: 400, height: 360 }, (win) => {
      const winId = win?.id;
      if (winId === undefined) return;
      // Closing the window without a decision is a denial.
      const onClosed = (closedId: number) => {
        if (closedId === winId) {
          chrome.windows.onRemoved.removeListener(onClosed);
          settle(false);
        }
      };
      chrome.windows.onRemoved.addListener(onClosed);
    });
  });
}

async function handleLogin(req: RuntimeLoginRequest): Promise<RuntimeLoginResponse> {
  const { signing } = await generateOrLoadHolderIdentity(new IndexedDBKVStore());

  const approved = await requestConsent({
    origin: req.origin,
    rpDid: req.params.rpDid,
    holderDid: signing.did,
  });
  if (!approved) return { ok: false, error: "login denied by user" };

  const tokens = await loginViaSiop({
    baseUrl: req.params.baseUrl,
    rpDid: req.params.rpDid,
    signing,
  });
  return { ok: true, result: { ...tokens, holderDid: signing.did } };
}

async function handleLoginDidcomm(
  req: RuntimeLoginDidcommRequest,
): Promise<RuntimeLoginResponse> {
  // Load the holder here only to show its DID in the consent prompt; the
  // actual DIDComm login runs in the offscreen document (same IndexedDB
  // holder). did:key derivation is window-free, so this is safe in the SW.
  const { signing } = await generateOrLoadHolderIdentity(new IndexedDBKVStore());

  const approved = await requestConsent({
    origin: req.origin,
    rpDid: req.params.controlDid,
    holderDid: signing.did,
  });
  if (!approved) return { ok: false, error: "login denied by user" };

  await ensureOffscreenDocument();
  const offscreenRequest: OffscreenDidcommLoginRequest = {
    target: OFFSCREEN_TARGET,
    type: OFFSCREEN_DIDCOMM_LOGIN,
    params: req.params,
  };
  return (await chrome.runtime.sendMessage(offscreenRequest)) as RuntimeLoginResponse;
}

async function handleStepUpVta(
  req: RuntimeStepUpVtaRequest,
): Promise<RuntimeLoginResponse> {
  // Load the holder here only to show its DID in the consent prompt; the
  // step-up orchestration (REST + DIDComm) runs in the offscreen document.
  const { signing } = await generateOrLoadHolderIdentity(new IndexedDBKVStore());

  const approved = await requestConsent({
    origin: req.origin,
    rpDid: req.params.rpDid,
    holderDid: signing.did,
  });
  if (!approved) return { ok: false, error: "step-up denied by user" };

  await ensureOffscreenDocument();
  const offscreenRequest: OffscreenStepUpVtaRequest = {
    target: OFFSCREEN_TARGET,
    type: OFFSCREEN_STEP_UP_VTA,
    params: req.params,
  };
  return (await chrome.runtime.sendMessage(offscreenRequest)) as RuntimeLoginResponse;
}

// An authenticated GET the wallet runs on a page's behalf. The service
// worker has host permissions, so this isn't subject to the page's
// cross-origin CORS restriction. Read-only, so no consent prompt.
async function handleApiGet(req: RuntimeApiGetRequest): Promise<RuntimeApiGetResponse> {
  const base = req.params.baseUrl.replace(/\/+$/, "");
  const res = await fetch(base + req.params.path, {
    headers: { authorization: `Bearer ${req.params.accessToken}` },
  });
  const text = await res.text();
  let body: unknown;
  try {
    body = JSON.parse(text);
  } catch {
    body = text;
  }
  return { ok: true, result: { status: res.status, body } };
}

chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
  // Messages addressed to the offscreen document are not ours — let its
  // listener claim the channel and respond.
  if ((message as { target?: string })?.target === OFFSCREEN_TARGET) return false;

  if ((message as { type?: string })?.type === RUNTIME_API_GET) {
    handleApiGet(message as RuntimeApiGetRequest)
      .then(sendResponse)
      .catch((e: unknown) =>
        sendResponse({ ok: false, error: e instanceof Error ? e.message : String(e) }),
      );
    return true; // async sendResponse
  }

  if ((message as { type?: string })?.type === RUNTIME_LOGIN) {
    handleLogin(message as RuntimeLoginRequest)
      .then(sendResponse)
      .catch((e: unknown) =>
        sendResponse({ ok: false, error: e instanceof Error ? e.message : String(e) }),
      );
    return true; // async sendResponse
  }

  if ((message as { type?: string })?.type === RUNTIME_LOGIN_DIDCOMM) {
    handleLoginDidcomm(message as RuntimeLoginDidcommRequest)
      .then(sendResponse)
      .catch((e: unknown) =>
        sendResponse({ ok: false, error: e instanceof Error ? e.message : String(e) }),
      );
    return true; // async sendResponse
  }

  if ((message as { type?: string })?.type === RUNTIME_STEP_UP_VTA) {
    handleStepUpVta(message as RuntimeStepUpVtaRequest)
      .then(sendResponse)
      .catch((e: unknown) =>
        sendResponse({ ok: false, error: e instanceof Error ? e.message : String(e) }),
      );
    return true; // async sendResponse
  }

  if ((message as { type?: string })?.type === RUNTIME_CONSENT_RESULT) {
    const { consentId, approved } = message as RuntimeConsentResult;
    pendingConsents.get(consentId)?.(approved);
    return false;
  }

  return false;
});

export {};
