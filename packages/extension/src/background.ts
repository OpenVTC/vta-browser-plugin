/// <reference types="chrome" />

// Service worker. Owns the wallet's holder identity, runs the REST SIOPv2
// login, and gates every login behind a user-consent prompt. The DIDComm
// login is delegated to an offscreen document (see `offscreen.ts`) because
// it needs dynamic `import()` + a DOM, which a service worker lacks.
//
// REST flow: content → RUNTIME_LOGIN → consent → loginViaSiop → tokens.
// DIDComm flow: content → RUNTIME_LOGIN_DIDCOMM → consent → offscreen doc.

import { generateOrLoadHolderIdentity, IndexedDBKVStore, loginViaSiop } from "@pnm/core";
import {
  OFFSCREEN_DIDCOMM_LOGIN,
  OFFSCREEN_TARGET,
  RUNTIME_CONSENT_RESULT,
  RUNTIME_LOGIN,
  RUNTIME_LOGIN_DIDCOMM,
  type OffscreenDidcommLoginRequest,
  type RuntimeConsentResult,
  type RuntimeLoginDidcommRequest,
  type RuntimeLoginRequest,
  type RuntimeLoginResponse,
} from "./bridge-protocol.js";

chrome.runtime.onInstalled.addListener(() => {
  console.info("[pnm] extension installed");
});

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

chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
  // Messages addressed to the offscreen document are not ours — let its
  // listener claim the channel and respond.
  if ((message as { target?: string })?.target === OFFSCREEN_TARGET) return false;

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

  if ((message as { type?: string })?.type === RUNTIME_CONSENT_RESULT) {
    const { consentId, approved } = message as RuntimeConsentResult;
    pendingConsents.get(consentId)?.(approved);
    return false;
  }

  return false;
});

export {};
