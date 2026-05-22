/// <reference types="chrome" />

// Offscreen document — runs the DIDComm login on behalf of the service
// worker. A real (hidden) document context, so dynamic `import()`, a DOM,
// WASM, and WebSocket all work here, unlike an MV3 service worker. The
// did:webvh resolver (didwebvh-ts) and the mediator session need exactly
// those, which is why this lives here rather than in `background.ts`.

import {
  buildConfirmResponse,
  connectMediatorSession,
  createStopwatch,
  IndexedDBKVStore,
  loginViaDidcomm,
  markInboundHandled,
  type MediatorConnection,
  MediatorSessionBridge,
  parseConfirmRequest,
  requestVtaApproval,
  resolveKeyAgreement,
  stepUpVtaFinish,
  stepUpVtaStart,
} from "@pnm/core";
import { loadHolder, WALLET_MEDIATOR_DID } from "./holder.js";
import {
  OFFSCREEN_DIDCOMM_LOGIN,
  OFFSCREEN_START_INBOUND,
  OFFSCREEN_STEP_UP_VTA,
  OFFSCREEN_TARGET,
  RUNTIME_INBOUND_CONSENT,
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
  if (msg.type === OFFSCREEN_START_INBOUND) {
    void startInbound();
    return false; // fire-and-forget
  }
  return false;
});

// ─── Persistent inbound session (RP-initiated confirm requests) ───
// One long-lived mediator session listens for unsolicited inbound. Held at
// module scope so it (and its WebSocket) aren't GC'd while the offscreen doc
// lives. Best-effort keep-alive: the background re-issues START_INBOUND when
// it (re)spawns the offscreen doc.
let inboundConn: MediatorConnection | null = null;

async function startInbound(): Promise<void> {
  if (inboundConn) return; // already listening
  const { identity } = await loadHolder();
  const conn = await connectMediatorSession({
    holder: identity,
    mediatorDid: WALLET_MEDIATOR_DID,
    // No specific peer for inbound; the session resolves each sender on
    // demand. Seed with our own DID (harmless) to satisfy the API.
    vtaDid: identity.did,
  });
  inboundConn = conn;
  conn.onInbound((message) => {
    void handleInbound(conn, identity, message);
  });
  console.info("[pnm inbound] listening for confirm requests via", WALLET_MEDIATOR_DID);
}

async function handleInbound(
  conn: MediatorConnection,
  identity: Parameters<typeof buildConfirmResponse>[0]["holder"],
  message: Record<string, unknown>,
): Promise<void> {
  const parsed = parseConfirmRequest(message);
  if (!parsed) return; // not a confirm/1.0 — ignore other traffic

  // De-dup: the mediator replays un-acked messages on every reconnect, and
  // the MV3 worker respawns the offscreen session often. Skip a confirm we've
  // already handled so a replay doesn't pop a second consent prompt. Marked
  // before prompting so a replay during the consent window is also skipped.
  // Persisted (survives respawns — exactly when replays arrive).
  const messageId = typeof message.id === "string" ? message.id : undefined;
  if (messageId) {
    const isNew = await markInboundHandled(new IndexedDBKVStore(), messageId);
    if (!isNew) {
      console.info("[pnm inbound] skipping replayed confirm:", messageId);
      return;
    }
  }
  try {
    // Ask the background to prompt the user (consent UI is a background API).
    const consent = (await chrome.runtime.sendMessage({
      type: RUNTIME_INBOUND_CONSENT,
      rpDid: parsed.rpDid,
      action: parsed.request.action,
      ...(parsed.request.rpName ? { rpName: parsed.request.rpName } : {}),
    })) as { approved?: boolean } | undefined;
    const approved = consent?.approved === true;

    const rp = await resolveKeyAgreement(parsed.rpDid);
    const outer = await buildConfirmResponse({
      holder: identity,
      rp,
      mediator: conn.mediator,
      approved,
      challenge: parsed.request.challenge,
      thid: parsed.thid,
    });
    conn.send(outer);
    console.info("[pnm inbound] confirm responded:", approved ? "approved" : "denied");
  } catch (e) {
    console.error("[pnm inbound] confirm handling failed:", e);
  }
}

async function doDidcommLogin(
  req: OffscreenDidcommLoginRequest,
): Promise<RuntimeLoginResponse> {
  // Same IndexedDB-backed holder the popup/background use (shared extension
  // origin), so the DID is identical to the REST path.
  const sw = createStopwatch();
  const { identity, signing } = await loadHolder();
  sw.mark("load holder");

  const conn = await connectMediatorSession({
    holder: identity,
    mediatorDid: req.params.mediatorDid,
    vtaDid: req.params.controlDid,
  });
  sw.mark("mediator connect");
  try {
    const bridge = new MediatorSessionBridge(conn);
    const tokens = await loginViaDidcomm({
      bridge,
      holder: identity,
      service: conn.vta,
      mediator: conn.mediator,
    });
    sw.mark("authenticate (didcomm)");
    return {
      ok: true,
      result: {
        accessToken: tokens.accessToken,
        refreshToken: tokens.refreshToken,
        sessionId: tokens.sessionId,
        holderDid: signing.did,
        timings: sw.marks,
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
  const sw = createStopwatch();
  const { identity, signing } = await loadHolder();
  sw.mark("load holder");

  // 1. RP start (REST) → nonce.
  const nonce = await stepUpVtaStart(req.params.baseUrl, req.params.accessToken);
  sw.mark("rp start (nonce)");

  // 2. VTA approve (DIDComm) → approval token.
  const conn = await connectMediatorSession({
    holder: identity,
    mediatorDid: req.params.vtaMediatorDid,
    vtaDid: req.params.vtaDid,
  });
  sw.mark("mediator connect");
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
    sw.mark("vta approve");
  } finally {
    conn.close();
  }

  // 3. RP finish (REST) → elevated session tokens.
  const tokens = await stepUpVtaFinish(
    req.params.baseUrl,
    req.params.accessToken,
    approvalToken,
  );
  sw.mark("rp finish (elevate)");
  return {
    ok: true,
    result: {
      accessToken: tokens.accessToken,
      refreshToken: tokens.refreshToken,
      sessionId: tokens.sessionId,
      holderDid: signing.did,
      timings: sw.marks,
    },
  };
}
