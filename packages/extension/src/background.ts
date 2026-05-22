/// <reference types="chrome" />

// Service worker. Owns the wallet's holder identity and runs the SIOPv2
// login on behalf of an RP page, gated by an explicit user-consent prompt.
//
// Flow: content script → RUNTIME_LOGIN → (consent window) → loginViaSiop →
// tokens back to the content script → page.

import {
  connectMediatorSession,
  generateOrLoadHolderIdentity,
  IndexedDBKVStore,
  loginViaDidcomm,
  loginViaSiop,
  MediatorSessionBridge,
} from "@pnm/core";
import {
  RUNTIME_CONSENT_RESULT,
  RUNTIME_LOGIN,
  RUNTIME_LOGIN_DIDCOMM,
  type RuntimeConsentResult,
  type RuntimeLoginDidcommRequest,
  type RuntimeLoginRequest,
  type RuntimeLoginResponse,
} from "./bridge-protocol.js";

chrome.runtime.onInstalled.addListener(() => {
  console.info("[pnm] extension installed");
});

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
  const { identity, signing } = await generateOrLoadHolderIdentity(new IndexedDBKVStore());

  const approved = await requestConsent({
    origin: req.origin,
    rpDid: req.params.controlDid,
    holderDid: signing.did,
  });
  if (!approved) return { ok: false, error: "login denied by user" };

  const conn = await connectMediatorSession({
    holder: identity,
    mediatorDid: req.params.mediatorDid,
    vtaDid: req.params.controlDid,
  });
  try {
    const bridge = new MediatorSessionBridge(conn);
    const tokens = await loginViaDidcomm({
      bridge,
      holder: identity,
      service: conn.vta,
      mediator: conn.mediator,
    });
    return {
      ok: true,
      result: {
        accessToken: tokens.accessToken,
        refreshToken: tokens.refreshToken,
        sessionId: tokens.sessionId,
        holderDid: signing.did,
      },
    };
  } finally {
    conn.close();
  }
}

chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
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
