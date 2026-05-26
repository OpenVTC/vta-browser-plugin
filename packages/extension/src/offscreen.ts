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
  didcommKeyAgreementFromSigning,
  generateSigningIdentity,
  Identity,
  IndexedDBKVStore,
  loginViaDidcomm,
  markInboundHandled,
  type MediatorConnection,
  MediatorSessionBridge,
  parseConfirmRequest,
  requestVtaApproval,
  resolveKeyAgreement,
  resolveVtaServices,
  signingIdentityFromSecret,
  stepUpVtaFinish,
  stepUpVtaStart,
  signTrustTask,
  swapAclDidcomm,
  swapAclRest,
  vaultListRest,
  verifyDid,
} from "@pnm/core";
import { getWalletMediatorDid, loadHolder } from "./holder.js";
import { WebAuthnPrfSecretWrap } from "./webauthn-prf-wrap.js";
import {
  OFFSCREEN_DIDCOMM_LOGIN,
  OFFSCREEN_GET_STATUS,
  OFFSCREEN_LOCK_WALLET,
  OFFSCREEN_ONBOARD_CONNECT,
  OFFSCREEN_ONBOARD_PREPARE,
  OFFSCREEN_SIGN_TRUST_TASK,
  OFFSCREEN_START_INBOUND,
  OFFSCREEN_STEP_UP_VTA,
  OFFSCREEN_TARGET,
  OFFSCREEN_VAULT_LIST,
  OFFSCREEN_VERIFY_DID,
  RUNTIME_INBOUND_CONSENT,
  type OffscreenDidcommLoginRequest,
  type OffscreenOnboardPrepareRequest,
  type OffscreenSignTrustTaskRequest,
  type OffscreenStepUpVtaRequest,
  type OffscreenVaultListRequest,
  type OffscreenVerifyDidRequest,
  type OnboardConnectResult,
  type OnboardPrepareResult,
  type RuntimeLoginResponse,
  type SignTrustTaskResult,
  type VerifyRpDidResult,
} from "./bridge-protocol.js";

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  // Defence-in-depth sender check — same rationale as the
  // background listener (M4 from the May 2026 security review).
  // MV3 isolation enforces this at the manifest layer; this
  // re-check surfaces a useful warn if anything ever slips
  // past.
  if (sender.id !== chrome.runtime.id) {
    // eslint-disable-next-line no-console
    console.warn(
      `[offscreen] rejecting message from foreign sender id=${sender.id} url=${sender.url}`,
    );
    sendResponse({ ok: false, error: "foreign sender rejected" });
    return false;
  }

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
  if (msg.type === OFFSCREEN_GET_STATUS) {
    sendResponse({ mediators: statusSnapshot() });
    return false; // synchronous response
  }
  if (msg.type === OFFSCREEN_LOCK_WALLET) {
    WebAuthnPrfSecretWrap.lock();
    return false; // fire-and-forget
  }
  if (msg.type === OFFSCREEN_ONBOARD_PREPARE) {
    doOnboardPrepare((message as OffscreenOnboardPrepareRequest).vtaDid)
      .then((result) => sendResponse({ ok: true, result }))
      .catch((e: unknown) =>
        sendResponse({ ok: false, error: e instanceof Error ? e.message : String(e) }),
      );
    return true; // async sendResponse
  }
  if (msg.type === OFFSCREEN_ONBOARD_CONNECT) {
    doOnboardConnect()
      .then((result) => sendResponse({ ok: true, result }))
      .catch((e: unknown) =>
        sendResponse({ ok: false, error: e instanceof Error ? e.message : String(e) }),
      );
    return true; // async sendResponse
  }
  if (msg.type === OFFSCREEN_SIGN_TRUST_TASK) {
    doSignTrustTask((message as OffscreenSignTrustTaskRequest).params.envelope)
      .then((result) => sendResponse({ ok: true, result }))
      .catch((e: unknown) =>
        sendResponse({ ok: false, error: e instanceof Error ? e.message : String(e) }),
      );
    return true; // async sendResponse
  }
  if (msg.type === OFFSCREEN_VERIFY_DID) {
    doVerifyDid((message as OffscreenVerifyDidRequest).did)
      .then((result) => sendResponse({ ok: true, result }))
      .catch((e: unknown) =>
        sendResponse({ ok: false, error: e instanceof Error ? e.message : String(e) }),
      );
    return true; // async sendResponse
  }
  if (msg.type === OFFSCREEN_VAULT_LIST) {
    doVaultList(message as OffscreenVaultListRequest)
      .then((result) => sendResponse({ ok: true, result }))
      .catch((e: unknown) =>
        sendResponse({ ok: false, error: e instanceof Error ? e.message : String(e) }),
      );
    return true; // async sendResponse
  }
  return false;
});

// Vault — list. Resolves the VTA's keyAgreement, loads the holder identity
// (the X25519 leg of the did:peer is the authcrypt sender), and runs
// `vaultListRest` end-to-end against the VTA's REST + trust-task dispatcher.
async function doVaultList(req: OffscreenVaultListRequest) {
  const { identity: holder } = await loadHolder();
  const service = await resolveKeyAgreement(req.vtaDid);
  // The bridge protocol intentionally types filter loosely (string secretKind)
  // so it doesn't have to import @pnm/core's narrowed enums. Cast at this
  // wire boundary — the values that flow through are sanity-checked by the
  // canonical schema validator on the VTA side anyway.
  type VaultRestOpts = Parameters<typeof vaultListRest>[0];
  const opts: VaultRestOpts = req.filter
    ? {
        baseUrl: req.restBaseUrl,
        holder,
        service,
        filter: req.filter as NonNullable<VaultRestOpts["filter"]>,
      }
    : { baseUrl: req.restBaseUrl, holder, service };
  const response = await vaultListRest(opts);
  return {
    entries: response.entries,
    truncated: response.truncated,
  };
}

// Resolve + verify a DID for the consent prompt's verification badge. The
// core `verifyDid` never throws — it returns `{ resolved: false, error }` on
// failure — so this is a thin pass-through that just normalises the shape
// across the IPC boundary.
async function doVerifyDid(did: string): Promise<VerifyRpDidResult> {
  const v = await verifyDid(did);
  return {
    did: v.did,
    method: v.method,
    resolved: v.resolved,
    ...(v.domain ? { domain: v.domain } : {}),
    ...(v.error ? { error: v.error } : {}),
  };
}

// Sign a Trust-Task envelope with the wallet's holder did:peer #key-2. The
// caller (typically a Relying Party's web UI via window.vtaWallet.signTrustTask)
// has already populated everything it wants signed — id, type, payload,
// recipient (audience binding). The wallet adds the eddsa-jcs-2022 Data
// Integrity proof and returns the envelope. The RP server resolves the
// did:peer to verify.
async function doSignTrustTask(
  envelope: Record<string, unknown>,
): Promise<SignTrustTaskResult> {
  const { signing } = await loadHolder();
  // signTrustTask mutates in place and returns the same reference; clone
  // first so the caller's input is preserved across the IPC boundary
  // (chrome.runtime.sendMessage serializes — a defensive copy is cheap and
  // makes the contract clear).
  const signedEnvelope = await signTrustTask({
    envelope: { ...envelope },
    signing,
  });
  return { signedEnvelope, holderDid: signing.did };
}

// ─── Onboarding: ephemeral did:key → holder did:peer (swap-acl) ───
// PREPARE resolves the VTA's transports, mints an ephemeral did:key, and
// persists it (so it survives the popup round-trip while the operator grants
// it). CONNECT authenticates as that ephemeral over DIDComm and swaps its ACL
// entry onto the wallet's holder did:peer, then discards the ephemeral.

const ONBOARD_KEY = "onboard:pending";

interface PendingOnboard {
  ephemeralSecret: Uint8Array;
  vtaDid: string;
  mediatorDid?: string;
  restBaseUrl?: string;
}

async function doOnboardPrepare(vtaDid: string): Promise<OnboardPrepareResult> {
  const services = await resolveVtaServices(vtaDid);
  if (!services.didcomm && !services.rest) {
    throw new Error(`${vtaDid} advertises no #vta-didcomm or #vta-rest service`);
  }
  const eph = generateSigningIdentity();
  const store = new IndexedDBKVStore();
  const pending: PendingOnboard = {
    ephemeralSecret: eph.privateKey,
    vtaDid,
    ...(services.didcomm ? { mediatorDid: services.didcomm.mediatorDid } : {}),
    ...(services.rest ? { restBaseUrl: services.rest.baseUrl } : {}),
  };
  await store.put(ONBOARD_KEY, pending);
  return {
    ephemeralDid: eph.did,
    // `--expires 1h` so an abandoned onboarding (user prepares but never
    // connects) doesn't leave a permanent admin grant for the ephemeral
    // did:key. On successful connect, swap-acl deletes the row regardless
    // of expiry; if the user takes >1h between Prepare and Connect they
    // re-run Prepare to mint a fresh ephemeral. The acl_sweeper prunes
    // the expired row on its background pass.
    command: `pnm acl create --did ${eph.did} --role admin --expires 1h`,
    ...(services.didcomm ? { mediatorDid: services.didcomm.mediatorDid } : {}),
    ...(services.rest ? { restBaseUrl: services.rest.baseUrl } : {}),
  };
}

async function doOnboardConnect(): Promise<OnboardConnectResult> {
  const store = new IndexedDBKVStore();
  const pending = await store.get<PendingOnboard>(ONBOARD_KEY);
  if (!pending) throw new Error("no pending onboarding — prepare first");
  if (!pending.mediatorDid && !pending.restBaseUrl) {
    throw new Error("VTA advertises neither #vta-didcomm nor #vta-rest — cannot connect");
  }

  // Reconstruct the operator-granted ephemeral as an X25519 DIDComm identity
  // (the authcrypt sender = the "old" DID being rotated away from).
  const ephSigning = signingIdentityFromSecret(new Uint8Array(pending.ephemeralSecret));
  const ka = didcommKeyAgreementFromSigning(ephSigning);
  const ephemeral = Identity.fromSecretJwk({
    did: ephSigning.did,
    kid: ka.keyAgreementKid,
    jwk: ka.secretJwk,
  });

  // The holder did:peer #key-2 signs the VP-JWT — it's the "new" DID.
  const { signing } = await loadHolder();
  const service = await resolveKeyAgreement(pending.vtaDid);

  // Prefer DIDComm when advertised (the authcrypt envelope is the caller
  // authentication — one round-trip, no token). Fall back to REST.
  let entry;
  if (pending.mediatorDid) {
    const conn = await connectMediatorSession({
      holder: ephemeral,
      mediatorDid: pending.mediatorDid,
      vtaDid: pending.vtaDid,
    });
    try {
      const bridge = new MediatorSessionBridge(conn);
      entry = await swapAclDidcomm({
        bridge,
        ephemeral,
        holderSigning: signing,
        service,
        mediator: conn.mediator,
        vtaDid: pending.vtaDid,
      });
    } finally {
      conn.close();
    }
  } else {
    entry = await swapAclRest({
      baseUrl: pending.restBaseUrl!,
      ephemeral,
      holderSigning: signing,
      service,
      vtaDid: pending.vtaDid,
    });
  }

  await store.delete(ONBOARD_KEY);
  return { holderDid: entry.did, role: entry.role };
}

// ─── Warm mediator-session pool ───
// One authenticated, live-delivery session per mediator DID, reused for every
// operation against that mediator (DIDComm login, step-up, and the
// RP-initiated inbound `confirm` path). This eliminates the per-operation
// connect+auth+resolve+teardown that made DIDComm slower than REST — after the
// first connect, a round-trip is just pack → WS send → WS recv → unpack.
//
// Sessions are held at module scope so neither they nor their WebSockets are
// GC'd while the offscreen doc lives. The DID resolutions they perform
// (mediator + VTA) are cached in vti-didcomm-js, so even a cold reconnect is
// cheap on the second hit.
type MediatorState = "connecting" | "live" | "closed";
const warmPool = new Map<string, Promise<MediatorConnection>>();
const mediatorState = new Map<string, MediatorState>();
const INBOUND_RECONNECT_MS = 2_000;

// The wallet's inbox mediator DID is configurable; cache it once so the
// per-session "is this our inbox mediator?" check stays synchronous in the
// onClose closure.
let _walletMediatorDid: string | undefined;
async function walletMediatorDid(): Promise<string> {
  if (!_walletMediatorDid) _walletMediatorDid = await getWalletMediatorDid();
  return _walletMediatorDid;
}

/** Snapshot of every known mediator's connection state, for the demo UI. */
function statusSnapshot(): { mediatorDid: string; state: MediatorState }[] {
  return [...mediatorState.entries()].map(([mediatorDid, state]) => ({ mediatorDid, state }));
}

/** Get (or lazily open) the warm session for a mediator. Reuses a live
 *  session; transparently reconnects one that has dropped. */
async function getWarmSession(mediatorDid: string): Promise<MediatorConnection> {
  const existing = warmPool.get(mediatorDid);
  if (existing) {
    const conn = await existing.catch(() => null);
    if (conn && conn.isOpen) return conn;
    warmPool.delete(mediatorDid); // stale/closed — fall through to reconnect
  }

  mediatorState.set(mediatorDid, "connecting");
  const pending = createWarmSession(mediatorDid).then(
    (conn) => {
      mediatorState.set(mediatorDid, "live");
      return conn;
    },
    (err) => {
      mediatorState.set(mediatorDid, "closed");
      warmPool.delete(mediatorDid);
      throw err;
    },
  );
  warmPool.set(mediatorDid, pending);
  return pending;
}

async function createWarmSession(mediatorDid: string): Promise<MediatorConnection> {
  const { identity } = await loadHolder();
  const isInbox = mediatorDid === (await walletMediatorDid());
  const conn = await connectMediatorSession({
    holder: identity,
    mediatorDid,
    // No fixed peer for a shared session; the session resolves each reply's
    // sender on demand. Seed with our own DID (harmless) to satisfy the API;
    // each operation resolves its real VTA target separately (cached).
    vtaDid: identity.did,
    onClose: () => {
      warmPool.delete(mediatorDid);
      mediatorState.set(mediatorDid, "closed");
      // Keep the inbound path alive: re-arm the wallet's inbox mediator.
      if (isInbox) setTimeout(() => void startInbound(), INBOUND_RECONNECT_MS);
    },
  });
  // Attach the inbound confirm handler whenever this is the wallet's inbox
  // mediator — regardless of which operation first opened the session.
  if (isInbox) {
    conn.onInbound((message) => void handleInbound(conn, identity, message));
  }
  return conn;
}

/** Ensure the warm session to the wallet's inbox mediator is live so
 *  RP-initiated confirm requests are received. Idempotent. */
async function startInbound(): Promise<void> {
  try {
    const mediatorDid = await walletMediatorDid();
    await getWarmSession(mediatorDid);
    console.info("[pnm inbound] listening for confirm requests via", mediatorDid);
  } catch (e) {
    console.error("[pnm inbound] failed to start inbound session:", e);
  }
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

  // Reuse the warm session (instant if already live); resolve the VTA target
  // separately (cached). No per-op connect/teardown.
  const conn = await getWarmSession(req.params.mediatorDid);
  sw.mark("warm session");
  const service = await resolveKeyAgreement(req.params.controlDid);
  sw.mark("resolve vta");

  const bridge = new MediatorSessionBridge(conn);
  const tokens = await loginViaDidcomm({
    bridge,
    holder: identity,
    service,
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

  // 2. VTA approve (DIDComm) → approval token. Reuse the warm session.
  const conn = await getWarmSession(req.params.vtaMediatorDid);
  sw.mark("warm session");
  const service = await resolveKeyAgreement(req.params.vtaDid);
  sw.mark("resolve vta");
  const bridge = new MediatorSessionBridge(conn);
  const approvalToken = await requestVtaApproval({
    bridge,
    holder: identity,
    service,
    mediator: conn.mediator,
    rpDid: req.params.rpDid,
    nonce,
  });
  sw.mark("vta approve");

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
