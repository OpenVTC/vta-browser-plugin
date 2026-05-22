/// <reference types="chrome" />

// Offscreen document — runs the DIDComm login on behalf of the service
// worker. A real (hidden) document context, so dynamic `import()`, a DOM,
// WASM, and WebSocket all work here, unlike an MV3 service worker. The
// did:webvh resolver (didwebvh-ts) and the mediator session need exactly
// those, which is why this lives here rather than in `background.ts`.

import {
  connectMediatorSession,
  generateOrLoadHolderIdentity,
  IndexedDBKVStore,
  loginViaDidcomm,
  MediatorSessionBridge,
  requestVtaApproval,
  stepUpVtaFinish,
  stepUpVtaStart,
} from "@pnm/core";
import {
  OFFSCREEN_DIDCOMM_LOGIN,
  OFFSCREEN_STEP_UP_VTA,
  OFFSCREEN_TARGET,
  type OffscreenDidcommLoginRequest,
  type OffscreenStepUpVtaRequest,
  type RuntimeLoginResponse,
} from "./bridge-protocol.js";

chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
  const msg = message as { target?: string; type?: string };
  if (msg?.target !== OFFSCREEN_TARGET) return false; // not for us
  if (msg.type === OFFSCREEN_DIDCOMM_LOGIN) {
    doDidcommLogin(message as OffscreenDidcommLoginRequest)
      .then(sendResponse)
      .catch((e: unknown) =>
        sendResponse({ ok: false, error: e instanceof Error ? e.message : String(e) }),
      );
    return true; // async sendResponse
  }
  if (msg.type === OFFSCREEN_STEP_UP_VTA) {
    doStepUpVta(message as OffscreenStepUpVtaRequest)
      .then(sendResponse)
      .catch((e: unknown) =>
        sendResponse({ ok: false, error: e instanceof Error ? e.message : String(e) }),
      );
    return true; // async sendResponse
  }
  return false;
});

async function doDidcommLogin(
  req: OffscreenDidcommLoginRequest,
): Promise<RuntimeLoginResponse> {
  // Same IndexedDB-backed holder the popup/background use (shared extension
  // origin), so the DID is identical to the REST path.
  const { identity, signing } = await generateOrLoadHolderIdentity(new IndexedDBKVStore());

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

async function doStepUpVta(
  req: OffscreenStepUpVtaRequest,
): Promise<RuntimeLoginResponse> {
  // Same IndexedDB-backed holder the popup/background use, so the DID is
  // identical to the base-login path being elevated.
  const { identity, signing } = await generateOrLoadHolderIdentity(new IndexedDBKVStore());

  // 1. RP start (REST) → nonce.
  const nonce = await stepUpVtaStart(req.params.baseUrl, req.params.accessToken);

  // 2. VTA approve (DIDComm) → approval token.
  const conn = await connectMediatorSession({
    holder: identity,
    mediatorDid: req.params.vtaMediatorDid,
    vtaDid: req.params.vtaDid,
  });
  let approvalToken: string;
  try {
    const bridge = new MediatorSessionBridge(conn);
    approvalToken = await requestVtaApproval({
      bridge,
      holder: identity,
      service: conn.vta,
      mediator: conn.mediator,
      rpDid: req.params.rpDid,
      nonce,
    });
  } finally {
    conn.close();
  }

  // 3. RP finish (REST) → elevated session tokens.
  const tokens = await stepUpVtaFinish(
    req.params.baseUrl,
    req.params.accessToken,
    approvalToken,
  );
  return {
    ok: true,
    result: {
      accessToken: tokens.accessToken,
      refreshToken: tokens.refreshToken,
      sessionId: tokens.sessionId,
      holderDid: signing.did,
    },
  };
}
