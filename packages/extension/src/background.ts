/// <reference types="chrome" />

// Service worker. Owns the wallet's holder identity, runs the REST SIOPv2
// login, and gates every login behind a user-consent prompt. The DIDComm
// login is delegated to an offscreen document (see `offscreen.ts`) because
// it needs dynamic `import()` + a DOM, which a service worker lacks.
//
// REST flow: content → RUNTIME_LOGIN → consent → loginViaSiop → tokens.
// DIDComm flow: content → RUNTIME_LOGIN_DIDCOMM → consent → offscreen doc.

import { loginViaSiop } from "@pnm/core";
import { loadActiveHolder } from "./holder.js";
import { readActiveVtaDid } from "./active-vta.js";
import { checkOriginPin, pinOrigin } from "./origin-pin.js";
import { subscribeToPush } from "./push.js";
import { WebAuthnPrfSecretWrap } from "./webauthn-prf-wrap.js";
import {
  OFFSCREEN_DIDCOMM_LOGIN,
  OFFSCREEN_GET_STATUS,
  OFFSCREEN_CREATE_CONTEXT,
  OFFSCREEN_DERIVE_SIGNING_KEY_ID,
  OFFSCREEN_HOLDER_STATE,
  OFFSCREEN_LIST_CONTEXTS,
  OFFSCREEN_UNLOCK_PRF,
  OFFSCREEN_REFRESH_VTA_TRANSPORTS,
  OFFSCREEN_WALLET_LOCK_STATE,
  OFFSCREEN_ONBOARD_CONNECT,
  OFFSCREEN_ONBOARD_PREPARE,
  OFFSCREEN_SIGN_TRUST_TASK,
  OFFSCREEN_START_INBOUND,
  OFFSCREEN_STEP_UP_VTA,
  OFFSCREEN_TARGET,
  OFFSCREEN_VAULT_DELETE,
  OFFSCREEN_VAULT_LIST,
  OFFSCREEN_VAULT_PROXY_LOGIN,
  OFFSCREEN_VAULT_RELEASE,
  OFFSCREEN_VAULT_UPSERT,
  OFFSCREEN_VERIFY_DID,
  RUNTIME_API_GET,
  RUNTIME_API_POST,
  RUNTIME_INJECT_COOKIES,
  RUNTIME_VAULT_DELETE,
  RUNTIME_VAULT_LIST,
  RUNTIME_VAULT_LIST_PAGE,
  RUNTIME_VAULT_PROXY_LOGIN,
  RUNTIME_VAULT_PROXY_LOGIN_PAGE,
  RUNTIME_VAULT_RELEASE,
  RUNTIME_VAULT_UPSERT,
  OFFSCREEN_LOCK_WALLET,
  RUNTIME_CONSENT_RESULT,
  RUNTIME_INBOUND_CONSENT,
  RUNTIME_LOCK_WALLET,
  RUNTIME_LOGIN,
  RUNTIME_LOGIN_DIDCOMM,
  RUNTIME_MEDIATOR_STATUS,
  RUNTIME_CREATE_CONTEXT,
  RUNTIME_DERIVE_SIGNING_KEY_ID,
  RUNTIME_HOLDER_STATE,
  RUNTIME_LIST_CONTEXTS,
  RUNTIME_REFRESH_VTA_TRANSPORTS,
  RUNTIME_UNLOCK_PRF,
  RUNTIME_WALLET_LOCK_STATE,
  RUNTIME_ONBOARD_CONNECT,
  RUNTIME_ONBOARD_PREPARE,
  RUNTIME_SIGN_TRUST_TASK,
  RUNTIME_STEP_UP_VTA,
  RUNTIME_VERIFY_RP_DID,
  RUNTIME_WALLET_DEFAULTS,
  type MediatorStatusResult,
  type OffscreenDidcommLoginRequest,
  type OffscreenStepUpVtaRequest,
  type RuntimeApiGetRequest,
  type RuntimeApiGetResponse,
  type RuntimeApiPostRequest,
  type RuntimeConsentResult,
  type RuntimeInboundConsentRequest,
  type RuntimeLoginDidcommRequest,
  type RuntimeLoginRequest,
  type RuntimeLoginResponse,
  type RuntimeMediatorStatusResponse,
  type RuntimeCreateContextRequest,
  type RuntimeCreateContextResponse,
  type RuntimeDeriveSigningKeyIdRequest,
  type RuntimeDeriveSigningKeyIdResponse,
  type RuntimeHolderStateResponse,
  type RuntimeListContextsResponse,
  type RuntimeRefreshVtaTransportsRequest,
  type RuntimeRefreshVtaTransportsResponse,
  type RuntimeUnlockPrfRequest,
  type RuntimeUnlockPrfResponse,
  type RuntimeWalletLockStateRequest,
  type RuntimeWalletLockStateResponse,
  type RuntimeOnboardConnectResponse,
  type RuntimeOnboardConnectRequest,
  type RuntimeOnboardPrepareRequest,
  type RuntimeOnboardPrepareResponse,
  type RuntimeSignTrustTaskRequest,
  type RuntimeSignTrustTaskResponse,
  type RuntimeStepUpVtaRequest,
  type RuntimeVaultDeleteRequest,
  type RuntimeVaultDeleteResponse,
  type RuntimeVaultListRequest,
  type RuntimeVaultListResponse,
  type RuntimeInjectCookiesRequest,
  type RuntimeInjectCookiesResponse,
  type RuntimeVaultListPageRequest,
  type RuntimeVaultProxyLoginPageRequest,
  type RuntimeVaultProxyLoginRequest,
  type RuntimeVaultProxyLoginResponse,
  type RuntimeVaultReleaseRequest,
  type RuntimeVaultReleaseResponse,
  type RuntimeVaultUpsertRequest,
  type RuntimeVaultUpsertResponse,
  type RuntimeVerifyRpDidRequest,
  type RuntimeVerifyRpDidResponse,
  type RuntimeWalletDefaultsResponse,
  type VerifyRpDidResult,
} from "./bridge-protocol.js";
import { getSettings } from "./config.js";

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

// Bring up the offscreen doc + its persistent inbound mediator session so the
// wallet can receive RP-initiated confirm requests. Idempotent (both
// ensureOffscreenDocument and the offscreen's startInbound no-op if already
// running), so it's safe to call on every worker spin-up.
async function startInboundListener(): Promise<void> {
  // No-op until at least one VTA has been onboarded — the inbound mediator
  // session authenticates AS the holder, and there's no holder yet on a
  // fresh install or after a wipe. The popup re-arms the listener via
  // a separate call after the first successful onboard.
  const activeVtaDid = await readActiveVtaDid();
  if (!activeVtaDid) return;
  await ensureOffscreenDocument();
  await chrome.runtime.sendMessage({
    target: OFFSCREEN_TARGET,
    type: OFFSCREEN_START_INBOUND,
    vtaDid: activeVtaDid,
  });
}
void startInboundListener();

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
  origin?: string;
  rpDid: string;
  holderDid?: string;
  /** When set, the prompt frames an RP-initiated action to confirm (inbound)
   *  rather than a login. */
  action?: string;
  /**
   * M5: when set, the previously-pinned rpDid for this origin
   * — the consent prompt shows a louder warning because the
   * site is now asking for a *different* RP identity. The
   * operator has to explicitly approve the swap.
   */
  changedFromRpDid?: string;
}): Promise<boolean> {
  const consentId = crypto.randomUUID();
  const url =
    chrome.runtime.getURL("confirm.html") +
    `?cid=${consentId}` +
    `&rpDid=${encodeURIComponent(args.rpDid)}` +
    (args.origin ? `&origin=${encodeURIComponent(args.origin)}` : "") +
    (args.holderDid ? `&holder=${encodeURIComponent(args.holderDid)}` : "") +
    (args.action ? `&action=${encodeURIComponent(args.action)}` : "") +
    (args.changedFromRpDid
      ? `&changedFrom=${encodeURIComponent(args.changedFromRpDid)}`
      : "");

  return new Promise<boolean>((resolve) => {
    let settled = false;
    const settle = (approved: boolean) => {
      if (settled) return;
      settled = true;
      pendingConsents.delete(consentId);
      resolve(approved);
    };
    pendingConsents.set(consentId, settle);

    chrome.windows.create({ url, type: "popup", width: 480, height: 560 }, (win) => {
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
  const { signing } = await loadActiveHolder();

  // M5: pin the rpDid against the requesting origin. First-sight
  // origins seed the pin on approval; subsequent origins asking
  // for a *different* rpDid get a louder consent prompt so the
  // operator can spot a redirect-to-attacker-RP attempt.
  const pin = req.origin
    ? await checkOriginPin(req.origin, req.params.rpDid)
    : { firstSeen: true, rpDidChanged: false, pinnedRpDid: undefined };

  const consent: Parameters<typeof requestConsent>[0] = {
    origin: req.origin,
    rpDid: req.params.rpDid,
    holderDid: signing.did,
  };
  if (pin.rpDidChanged && pin.pinnedRpDid) {
    consent.changedFromRpDid = pin.pinnedRpDid;
  }
  const approved = await requestConsent(consent);
  if (!approved) return { ok: false, error: "login denied by user" };

  if (req.origin) {
    await pinOrigin(req.origin, req.params.rpDid);
  }

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
  const { signing } = await loadActiveHolder();

  // M5: origin → controlDid pinning (analogous to the SIOP
  // login path; the DIDComm rpDid here is the RP's controlDid).
  const pin = req.origin
    ? await checkOriginPin(req.origin, req.params.controlDid)
    : { firstSeen: true, rpDidChanged: false, pinnedRpDid: undefined };

  const consent: Parameters<typeof requestConsent>[0] = {
    origin: req.origin,
    rpDid: req.params.controlDid,
    holderDid: signing.did,
  };
  if (pin.rpDidChanged && pin.pinnedRpDid) {
    consent.changedFromRpDid = pin.pinnedRpDid;
  }
  const approved = await requestConsent(consent);
  if (!approved) return { ok: false, error: "login denied by user" };

  if (req.origin) {
    await pinOrigin(req.origin, req.params.controlDid);
  }

  await ensureOffscreenDocument();
  const activeVtaDid = await readActiveVtaDid();
  if (!activeVtaDid) return { ok: false, error: "no active VTA connection — connect first" };
  const offscreenRequest: OffscreenDidcommLoginRequest = {
    target: OFFSCREEN_TARGET,
    type: OFFSCREEN_DIDCOMM_LOGIN,
    vtaDid: activeVtaDid,
    params: req.params,
  };
  return (await chrome.runtime.sendMessage(offscreenRequest)) as RuntimeLoginResponse;
}

async function handleStepUpVta(
  req: RuntimeStepUpVtaRequest,
): Promise<RuntimeLoginResponse> {
  // Load the holder here only to show its DID in the consent prompt; the
  // step-up orchestration (REST + DIDComm) runs in the offscreen document.
  const { signing } = await loadActiveHolder();

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

// Query the offscreen doc for its warm mediator-session status (for the
// demo's connection indicator). Brings the offscreen up if it isn't running
// so the very first poll reflects real state.
async function handleMediatorStatus(): Promise<RuntimeMediatorStatusResponse> {
  await ensureOffscreenDocument();
  const result = (await chrome.runtime.sendMessage({
    target: OFFSCREEN_TARGET,
    type: OFFSCREEN_GET_STATUS,
  })) as MediatorStatusResult;
  return { ok: true, result };
}

// Onboarding (popup-driven): both phases run in the offscreen doc (DID
// resolution + the mediator session need import()/DOM). The background just
// brings the offscreen up and relays.
async function handleOnboardPrepare(
  req: RuntimeOnboardPrepareRequest,
): Promise<RuntimeOnboardPrepareResponse> {
  await ensureOffscreenDocument();
  return (await chrome.runtime.sendMessage({
    target: OFFSCREEN_TARGET,
    type: OFFSCREEN_ONBOARD_PREPARE,
    vtaDid: req.vtaDid,
  })) as RuntimeOnboardPrepareResponse;
}

async function handleOnboardConnect(
  req: RuntimeOnboardConnectRequest,
): Promise<RuntimeOnboardConnectResponse> {
  await ensureOffscreenDocument();
  return (await chrome.runtime.sendMessage({
    target: OFFSCREEN_TARGET,
    type: OFFSCREEN_ONBOARD_CONNECT,
    // Both `context` and `createIfMissing` are optional — only forward
    // when the popup actually sent them, so the offscreen handler can
    // tell "not provided" from "provided as empty string".
    ...(req.context ? { context: req.context } : {}),
    ...(req.createIfMissing ? { createIfMissing: true } : {}),
  })) as RuntimeOnboardConnectResponse;
}

async function handleHolderState(): Promise<RuntimeHolderStateResponse> {
  await ensureOffscreenDocument();
  return (await chrome.runtime.sendMessage({
    target: OFFSCREEN_TARGET,
    type: OFFSCREEN_HOLDER_STATE,
  })) as RuntimeHolderStateResponse;
}

async function handleUnlockPrf(
  req: RuntimeUnlockPrfRequest,
): Promise<RuntimeUnlockPrfResponse> {
  await ensureOffscreenDocument();
  return (await chrome.runtime.sendMessage({
    target: OFFSCREEN_TARGET,
    type: OFFSCREEN_UNLOCK_PRF,
    prfOutputB64u: req.prfOutputB64u,
  })) as RuntimeUnlockPrfResponse;
}

async function handleWalletLockState(
  req: RuntimeWalletLockStateRequest,
): Promise<RuntimeWalletLockStateResponse> {
  await ensureOffscreenDocument();
  return (await chrome.runtime.sendMessage({
    target: OFFSCREEN_TARGET,
    type: OFFSCREEN_WALLET_LOCK_STATE,
    ...(req.vtaDid ? { vtaDid: req.vtaDid } : {}),
  })) as RuntimeWalletLockStateResponse;
}

async function handleRefreshVtaTransports(
  req: RuntimeRefreshVtaTransportsRequest,
): Promise<RuntimeRefreshVtaTransportsResponse> {
  await ensureOffscreenDocument();
  return (await chrome.runtime.sendMessage({
    target: OFFSCREEN_TARGET,
    type: OFFSCREEN_REFRESH_VTA_TRANSPORTS,
    vtaDid: req.vtaDid,
  })) as RuntimeRefreshVtaTransportsResponse;
}

async function handleListContexts(): Promise<RuntimeListContextsResponse> {
  const active = await readActiveConnection();
  if (!active.ok) return { ok: false, error: active.error };
  await ensureOffscreenDocument();
  return (await chrome.runtime.sendMessage({
    target: OFFSCREEN_TARGET,
    type: OFFSCREEN_LIST_CONTEXTS,
    vtaDid: active.conn.vtaDid,
    restBaseUrl: active.conn.restBaseUrl,
  })) as RuntimeListContextsResponse;
}

async function handleCreateContext(
  req: RuntimeCreateContextRequest,
): Promise<RuntimeCreateContextResponse> {
  const active = await readActiveConnection();
  if (!active.ok) return { ok: false, error: active.error };
  await ensureOffscreenDocument();
  return (await chrome.runtime.sendMessage({
    target: OFFSCREEN_TARGET,
    type: OFFSCREEN_CREATE_CONTEXT,
    vtaDid: active.conn.vtaDid,
    restBaseUrl: active.conn.restBaseUrl,
    id: req.id,
    ...(req.name ? { name: req.name } : {}),
    ...(req.description ? { description: req.description } : {}),
  })) as RuntimeCreateContextResponse;
}

async function handleDeriveSigningKeyId(
  req: RuntimeDeriveSigningKeyIdRequest,
): Promise<RuntimeDeriveSigningKeyIdResponse> {
  // No active-connection check — derivation runs purely on the DID
  // string + the wallet's DID resolver (network for did:webvh, local
  // for did:key / did:peer). The popup can call this even before
  // onboarding completes.
  await ensureOffscreenDocument();
  return (await chrome.runtime.sendMessage({
    target: OFFSCREEN_TARGET,
    type: OFFSCREEN_DERIVE_SIGNING_KEY_ID,
    did: req.did,
  })) as RuntimeDeriveSigningKeyIdResponse;
}

// Sign a Trust-Task envelope with the wallet's holder did:peer #key-2.
// Forward to the offscreen which loads the holder identity + calls the core
// `signTrustTask` helper. No additional consent prompt — the user already
// authorized this site at onboarding/login; per-signature prompts would be
// crippling for normal RP usage (every ACL operation, etc).
async function handleSignTrustTask(
  req: RuntimeSignTrustTaskRequest,
): Promise<RuntimeSignTrustTaskResponse> {
  await ensureOffscreenDocument();
  const activeVtaDid = await readActiveVtaDid();
  if (!activeVtaDid) {
    return { ok: false, error: "no active VTA connection — connect first" };
  }
  return (await chrome.runtime.sendMessage({
    target: OFFSCREEN_TARGET,
    type: OFFSCREEN_SIGN_TRUST_TASK,
    vtaDid: activeVtaDid,
    params: req.params,
  })) as RuntimeSignTrustTaskResponse;
}

// Operator-configured defaults a page may prefill (e.g. the step-up VTA).
async function handleWalletDefaults(): Promise<RuntimeWalletDefaultsResponse> {
  const s = await getSettings();
  return {
    ok: true,
    result: {
      ...(s.defaultStepUpVtaDid ? { stepUpVtaDid: s.defaultStepUpVtaDid } : {}),
      ...(s.defaultStepUpVtaMediatorDid
        ? { stepUpVtaMediatorDid: s.defaultStepUpVtaMediatorDid }
        : {}),
    },
  };
}

// Resolve + verify an RP DID on behalf of the consent prompt. The popup
// posts this after rendering and updates the verification badge with the
// result. Routed through the offscreen because did:webvh resolution needs
// dynamic import + DOM, which a service worker lacks.
async function handleVerifyRpDid(
  req: RuntimeVerifyRpDidRequest,
): Promise<RuntimeVerifyRpDidResponse> {
  await ensureOffscreenDocument();
  const reply = (await chrome.runtime.sendMessage({
    target: OFFSCREEN_TARGET,
    type: OFFSCREEN_VERIFY_DID,
    did: req.did,
  })) as { ok: true; result: VerifyRpDidResult } | { ok: false; error: string };
  if (reply.ok) return { ok: true, result: reply.result };
  return { ok: false, error: reply.error };
}

// Vault — list (M1). The popup asks for the current VTA's vault entries
// (metadata view only); we forward to the offscreen doc which loads the
// holder identity (DOM-bound WebAuthn-PRF unwrap), resolves the VTA's
// keyAgreement, and runs the auth + trust-task POST round-trip.
async function handleVaultList(req: RuntimeVaultListRequest): Promise<RuntimeVaultListResponse> {
  // Pull the active VTA's vtaDid + restBaseUrl from the popup's
  // persisted connection store. The popup writes the v3 multi-VTA
  // shape; background reads it via `readActiveConnection`.
  const active = await readActiveConnection();
  if (!active.ok) return { ok: false, error: active.error };

  await ensureOffscreenDocument();
  const reply = (await chrome.runtime.sendMessage({
    target: OFFSCREEN_TARGET,
    type: OFFSCREEN_VAULT_LIST,
    vtaDid: active.conn.vtaDid,
    restBaseUrl: active.conn.restBaseUrl,
    ...(req.filter ? { filter: req.filter } : {}),
  })) as RuntimeVaultListResponse;
  return reply;
}

// Vault — upsert / delete / release (M2A.5). All three share the
// active-connection lookup from RUNTIME_VAULT_LIST and forward to
// offscreen so the holder identity + DIDComm packing/unpacking happens
// where the X25519 private key lives.
type VaultActive = { vtaDid: string; restBaseUrl: string };

async function readActiveConnection(): Promise<
  | { ok: true; conn: VaultActive }
  | { ok: false; error: string }
> {
  const connection = await readActiveConnectionRaw();
  if (!connection) {
    return { ok: false, error: "no active VTA connection — connect first" };
  }
  if (!connection.restBaseUrl) {
    return {
      ok: false,
      error: "vault tasks require a REST-capable VTA (no #vta-rest service advertised)",
    };
  }
  return { ok: true, conn: { vtaDid: connection.vtaDid, restBaseUrl: connection.restBaseUrl } };
}

/** Read the popup's persisted connection state from chrome.storage and
 *  return the active VTA's Connection record, or `null` if there's no
 *  active VTA (fresh install, post-Disconnect, or storage hasn't
 *  migrated yet). Used by the helpers above + by paths that need the
 *  vtaDid even when REST isn't advertised (e.g. startInbound's
 *  DIDComm-only inbox).
 *
 *  Reads the v3 multi-VTA shape; v2's single-Connection shape is
 *  migrated by the popup's zustand-persist `migrate` callback on its
 *  first run after upgrade, so background doesn't need a separate
 *  fallback. */
async function readActiveConnectionRaw(): Promise<
  { vtaDid: string; restBaseUrl?: string; mediatorDid?: string } | null
> {
  const stored = await chrome.storage.local.get("pnm-connection/v3");
  const raw = stored["pnm-connection/v3"];
  if (typeof raw !== "string") return null;
  let parsed:
    | {
        state?: {
          connections?: {
            activeVtaDid?: string | null;
            vtas?: {
              [vtaDid: string]: {
                vtaDid: string;
                restBaseUrl?: string;
                mediatorDid?: string;
              };
            };
          };
        };
      }
    | undefined;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return null;
  }
  const connections = parsed?.state?.connections;
  if (!connections?.activeVtaDid) return null;
  const entry = connections.vtas?.[connections.activeVtaDid];
  if (!entry?.vtaDid) return null;
  return {
    vtaDid: entry.vtaDid,
    ...(entry.restBaseUrl ? { restBaseUrl: entry.restBaseUrl } : {}),
    ...(entry.mediatorDid ? { mediatorDid: entry.mediatorDid } : {}),
  };
}

async function handleVaultUpsert(
  req: RuntimeVaultUpsertRequest,
): Promise<RuntimeVaultUpsertResponse> {
  const c = await readActiveConnection();
  if (!c.ok) return { ok: false, error: c.error };
  await ensureOffscreenDocument();
  // Strip the runtime `type` tag — the OFFSCREEN_* envelope carries the
  // task type on its own.
  const { type: _t, ...body } = req;
  return (await chrome.runtime.sendMessage({
    target: OFFSCREEN_TARGET,
    type: OFFSCREEN_VAULT_UPSERT,
    vtaDid: c.conn.vtaDid,
    restBaseUrl: c.conn.restBaseUrl,
    body,
  })) as RuntimeVaultUpsertResponse;
}

async function handleVaultDelete(
  req: RuntimeVaultDeleteRequest,
): Promise<RuntimeVaultDeleteResponse> {
  const c = await readActiveConnection();
  if (!c.ok) return { ok: false, error: c.error };
  await ensureOffscreenDocument();
  const { type: _t, ...body } = req;
  return (await chrome.runtime.sendMessage({
    target: OFFSCREEN_TARGET,
    type: OFFSCREEN_VAULT_DELETE,
    vtaDid: c.conn.vtaDid,
    restBaseUrl: c.conn.restBaseUrl,
    body,
  })) as RuntimeVaultDeleteResponse;
}

async function handleVaultRelease(
  req: RuntimeVaultReleaseRequest,
): Promise<RuntimeVaultReleaseResponse> {
  const c = await readActiveConnection();
  if (!c.ok) return { ok: false, error: c.error };
  await ensureOffscreenDocument();
  const { type: _t, ...body } = req;
  return (await chrome.runtime.sendMessage({
    target: OFFSCREEN_TARGET,
    type: OFFSCREEN_VAULT_RELEASE,
    vtaDid: c.conn.vtaDid,
    restBaseUrl: c.conn.restBaseUrl,
    body,
  })) as RuntimeVaultReleaseResponse;
}

async function handleVaultProxyLogin(
  req: RuntimeVaultProxyLoginRequest,
): Promise<RuntimeVaultProxyLoginResponse> {
  const c = await readActiveConnection();
  if (!c.ok) return { ok: false, error: c.error };
  await ensureOffscreenDocument();
  const { type: _t, ...body } = req;
  return (await chrome.runtime.sendMessage({
    target: OFFSCREEN_TARGET,
    type: OFFSCREEN_VAULT_PROXY_LOGIN,
    vtaDid: c.conn.vtaDid,
    restBaseUrl: c.conn.restBaseUrl,
    body,
  })) as RuntimeVaultProxyLoginResponse;
}

// Page-world variant of vault/list. The RP page calls
// `window.vtaWallet.vaultList(...)` → content script relays as a
// `RUNTIME_VAULT_LIST_PAGE` envelope with `{ params, origin }`. We
// translate the page-side params subset (targetDid /
// targetOriginPrefix / secretKind) into the popup-style
// `RUNTIME_VAULT_LIST` filter and reuse the existing offscreen
// pipeline. Origin is captured but not yet enforced — same trust
// model as `vtaWallet.login()`; origin-pinned filtering lands with
// M3 policy.
async function handleVaultListPage(
  req: RuntimeVaultListPageRequest,
): Promise<RuntimeVaultListResponse> {
  return handleVaultList({
    type: RUNTIME_VAULT_LIST,
    filter: {
      ...(req.params.targetDid !== undefined ? { targetDid: req.params.targetDid } : {}),
      ...(req.params.targetOriginPrefix !== undefined
        ? { targetOriginPrefix: req.params.targetOriginPrefix }
        : {}),
      ...(req.params.secretKind !== undefined ? { secretKind: req.params.secretKind } : {}),
    },
  });
}

// Page-world variant of vault/proxy-login. The RP page calls
// `window.vtaWallet.proxyLogin(...)` → content script relays as a
// `RUNTIME_VAULT_PROXY_LOGIN_PAGE` envelope with `{ params, origin }`.
// We unwrap the params and reuse the same offscreen pipeline as the
// popup-initiated path.
//
// Origin gating: M2B.4 records `req.origin` for the upcoming consent
// prompt + origin-pinning checks but doesn't currently enforce any
// origin/entry match. That hardening lands alongside M3 policy
// (Rego-driven proxy-vs-fill decisions). For now the wallet's
// ProxyLogin capability + the per-entry context-scope check on the
// VTA side are the trust anchors.
async function handleVaultProxyLoginPage(
  req: RuntimeVaultProxyLoginPageRequest,
): Promise<RuntimeVaultProxyLoginResponse> {
  const c = await readActiveConnection();
  if (!c.ok) return { ok: false, error: c.error };
  await ensureOffscreenDocument();
  return (await chrome.runtime.sendMessage({
    target: OFFSCREEN_TARGET,
    type: OFFSCREEN_VAULT_PROXY_LOGIN,
    vtaDid: c.conn.vtaDid,
    restBaseUrl: c.conn.restBaseUrl,
    body: req.params,
  })) as RuntimeVaultProxyLoginResponse;
}

// Inject the cookies from a SessionBlob into the user's browser
// cookie jar for the bound origin. The host permission for the
// target origin must be granted in the manifest (or via
// chrome.permissions.request) — we don't request dynamically here.
//
// Per-cookie failures are tolerated: we log a warn and continue. The
// caller gets back the count of successful writes so the popup can
// surface a partial-success state.
async function handleInjectCookies(
  req: RuntimeInjectCookiesRequest,
): Promise<RuntimeInjectCookiesResponse> {
  if (!req.bindOrigin) {
    return { ok: false, error: "missing bindOrigin — cookies need a host to write under" };
  }
  let baseUrl: URL;
  try {
    baseUrl = new URL(req.bindOrigin);
  } catch {
    return { ok: false, error: `bindOrigin is not a URL: ${req.bindOrigin}` };
  }
  const cookies = req.cookies ?? [];
  let injected = 0;
  for (const c of cookies) {
    try {
      // Per the chrome.cookies API:
      //   - `url` is required and must match the cookie's resulting
      //     host+scheme. We use the bindOrigin + the cookie's path
      //     so chrome scopes the write correctly.
      //   - `domain`: omit for host-only cookies (the third party
      //     didn't set a Domain attribute), include otherwise. A
      //     leading dot is canonical for parent-domain cookies.
      //   - `secure`/`httpOnly`/`sameSite`/`expirationDate`: passed
      //     through when set. `expirationDate` is a Unix timestamp
      //     in SECONDS — we parse the cookie's Expires header (RFC
      //     1123 / 6265) and convert.
      const url = new URL(c.path ?? "/", baseUrl).toString();
      type SameSite = "no_restriction" | "lax" | "strict" | "unspecified";
      const sameSite: SameSite = (() => {
        switch (c.sameSite) {
          case "None":
            return "no_restriction";
          case "Lax":
            return "lax";
          case "Strict":
            return "strict";
          default:
            return "unspecified";
        }
      })();
      const details: chrome.cookies.SetDetails = {
        url,
        name: c.name,
        value: c.value,
        path: c.path ?? "/",
        sameSite,
      };
      // Only include domain when the cookie wasn't host-only. Chrome
      // computes the host from `url` when omitted; passing the bound
      // origin's bare host explicitly would mis-scope cookies the
      // third party intended to be host-only.
      if (c.domain && c.domain !== baseUrl.host) {
        details.domain = c.domain;
      }
      if (typeof c.secure === "boolean") details.secure = c.secure;
      if (typeof c.httpOnly === "boolean") details.httpOnly = c.httpOnly;
      if (c.expires) {
        const t = Date.parse(c.expires);
        if (Number.isFinite(t)) details.expirationDate = Math.floor(t / 1000);
      }
      await chrome.cookies.set(details);
      injected += 1;
    } catch (e) {
      // eslint-disable-next-line no-console
      console.warn(
        `[background] cookie.set failed for ${c.name}=${c.value.slice(0, 8)}…:`,
        e,
      );
    }
  }
  return {
    ok: true,
    result: {
      injected,
      total: cookies.length,
      bindOrigin: baseUrl.origin,
    },
  };
}

// Authenticated POST proxied through the wallet (host permission → no CORS).
async function handleApiPost(req: RuntimeApiPostRequest): Promise<RuntimeApiGetResponse> {
  const base = req.params.baseUrl.replace(/\/+$/, "");
  const res = await fetch(base + req.params.path, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      authorization: `Bearer ${req.params.accessToken}`,
    },
    body: JSON.stringify(req.params.body),
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

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  // Defence-in-depth: only accept messages from this extension's
  // own scripts (content scripts, offscreen document, popup,
  // confirm pages). MV3 isolation already prevents external
  // pages from calling `chrome.runtime.sendMessage(extensionId,
  // ...)` without a matching `externally_connectable` manifest
  // entry, but the explicit `sender.id` check is the belt to
  // the manifest's braces — and it surfaces a useful warn in
  // logs if a misconfigured external connection ever sneaks in.
  //
  // Closes M4 from the May 2026 security review.
  if (sender.id !== chrome.runtime.id) {
    // eslint-disable-next-line no-console
    console.warn(
      `[background] rejecting message from foreign sender id=${sender.id} url=${sender.url}`,
    );
    sendResponse({ ok: false, error: "foreign sender rejected" });
    return false;
  }

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

  if ((message as { type?: string })?.type === RUNTIME_API_POST) {
    handleApiPost(message as RuntimeApiPostRequest)
      .then(sendResponse)
      .catch((e: unknown) =>
        sendResponse({ ok: false, error: e instanceof Error ? e.message : String(e) }),
      );
    return true; // async sendResponse
  }

  if ((message as { type?: string })?.type === RUNTIME_MEDIATOR_STATUS) {
    handleMediatorStatus()
      .then(sendResponse)
      .catch((e: unknown) =>
        sendResponse({ ok: false, error: e instanceof Error ? e.message : String(e) }),
      );
    return true; // async sendResponse
  }

  if ((message as { type?: string })?.type === RUNTIME_ONBOARD_PREPARE) {
    handleOnboardPrepare(message as RuntimeOnboardPrepareRequest)
      .then(sendResponse)
      .catch((e: unknown) =>
        sendResponse({ ok: false, error: e instanceof Error ? e.message : String(e) }),
      );
    return true; // async sendResponse
  }

  if ((message as { type?: string })?.type === RUNTIME_ONBOARD_CONNECT) {
    handleOnboardConnect(message as RuntimeOnboardConnectRequest)
      .then(sendResponse)
      .catch((e: unknown) =>
        sendResponse({ ok: false, error: e instanceof Error ? e.message : String(e) }),
      );
    return true; // async sendResponse
  }

  if ((message as { type?: string })?.type === RUNTIME_HOLDER_STATE) {
    handleHolderState()
      .then(sendResponse)
      .catch((e: unknown) =>
        sendResponse({ ok: false, error: e instanceof Error ? e.message : String(e) }),
      );
    return true; // async sendResponse
  }

  if ((message as { type?: string })?.type === RUNTIME_UNLOCK_PRF) {
    handleUnlockPrf(message as RuntimeUnlockPrfRequest)
      .then(sendResponse)
      .catch((e: unknown) =>
        sendResponse({ ok: false, error: e instanceof Error ? e.message : String(e) }),
      );
    return true; // async sendResponse
  }

  if ((message as { type?: string })?.type === RUNTIME_REFRESH_VTA_TRANSPORTS) {
    handleRefreshVtaTransports(message as RuntimeRefreshVtaTransportsRequest)
      .then(sendResponse)
      .catch((e: unknown) =>
        sendResponse({ ok: false, error: e instanceof Error ? e.message : String(e) }),
      );
    return true; // async sendResponse
  }

  if ((message as { type?: string })?.type === RUNTIME_WALLET_LOCK_STATE) {
    handleWalletLockState(message as RuntimeWalletLockStateRequest)
      .then(sendResponse)
      .catch((e: unknown) =>
        sendResponse({ ok: false, error: e instanceof Error ? e.message : String(e) }),
      );
    return true; // async sendResponse
  }

  if ((message as { type?: string })?.type === RUNTIME_LIST_CONTEXTS) {
    handleListContexts()
      .then(sendResponse)
      .catch((e: unknown) =>
        sendResponse({ ok: false, error: e instanceof Error ? e.message : String(e) }),
      );
    return true; // async sendResponse
  }

  if ((message as { type?: string })?.type === RUNTIME_CREATE_CONTEXT) {
    handleCreateContext(message as RuntimeCreateContextRequest)
      .then(sendResponse)
      .catch((e: unknown) =>
        sendResponse({ ok: false, error: e instanceof Error ? e.message : String(e) }),
      );
    return true; // async sendResponse
  }

  if ((message as { type?: string })?.type === RUNTIME_DERIVE_SIGNING_KEY_ID) {
    handleDeriveSigningKeyId(message as RuntimeDeriveSigningKeyIdRequest)
      .then(sendResponse)
      .catch((e: unknown) =>
        sendResponse({ ok: false, error: e instanceof Error ? e.message : String(e) }),
      );
    return true; // async sendResponse
  }

  if ((message as { type?: string })?.type === RUNTIME_SIGN_TRUST_TASK) {
    handleSignTrustTask(message as RuntimeSignTrustTaskRequest)
      .then(sendResponse)
      .catch((e: unknown) =>
        sendResponse({ ok: false, error: e instanceof Error ? e.message : String(e) }),
      );
    return true; // async sendResponse
  }

  if ((message as { type?: string })?.type === RUNTIME_VAULT_LIST) {
    handleVaultList(message as RuntimeVaultListRequest)
      .then(sendResponse)
      .catch((e: unknown) =>
        sendResponse({ ok: false, error: e instanceof Error ? e.message : String(e) }),
      );
    return true; // async sendResponse
  }

  if ((message as { type?: string })?.type === RUNTIME_VAULT_UPSERT) {
    handleVaultUpsert(message as RuntimeVaultUpsertRequest)
      .then(sendResponse)
      .catch((e: unknown) =>
        sendResponse({ ok: false, error: e instanceof Error ? e.message : String(e) }),
      );
    return true;
  }

  if ((message as { type?: string })?.type === RUNTIME_VAULT_DELETE) {
    handleVaultDelete(message as RuntimeVaultDeleteRequest)
      .then(sendResponse)
      .catch((e: unknown) =>
        sendResponse({ ok: false, error: e instanceof Error ? e.message : String(e) }),
      );
    return true;
  }

  if ((message as { type?: string })?.type === RUNTIME_VAULT_RELEASE) {
    handleVaultRelease(message as RuntimeVaultReleaseRequest)
      .then(sendResponse)
      .catch((e: unknown) =>
        sendResponse({ ok: false, error: e instanceof Error ? e.message : String(e) }),
      );
    return true;
  }

  if ((message as { type?: string })?.type === RUNTIME_VAULT_PROXY_LOGIN) {
    handleVaultProxyLogin(message as RuntimeVaultProxyLoginRequest)
      .then(sendResponse)
      .catch((e: unknown) =>
        sendResponse({ ok: false, error: e instanceof Error ? e.message : String(e) }),
      );
    return true;
  }

  if ((message as { type?: string })?.type === RUNTIME_VAULT_PROXY_LOGIN_PAGE) {
    handleVaultProxyLoginPage(message as RuntimeVaultProxyLoginPageRequest)
      .then(sendResponse)
      .catch((e: unknown) =>
        sendResponse({ ok: false, error: e instanceof Error ? e.message : String(e) }),
      );
    return true;
  }

  if ((message as { type?: string })?.type === RUNTIME_VAULT_LIST_PAGE) {
    handleVaultListPage(message as RuntimeVaultListPageRequest)
      .then(sendResponse)
      .catch((e: unknown) =>
        sendResponse({ ok: false, error: e instanceof Error ? e.message : String(e) }),
      );
    return true;
  }

  if ((message as { type?: string })?.type === RUNTIME_INJECT_COOKIES) {
    handleInjectCookies(message as RuntimeInjectCookiesRequest)
      .then(sendResponse)
      .catch((e: unknown) =>
        sendResponse({ ok: false, error: e instanceof Error ? e.message : String(e) }),
      );
    return true;
  }

  if ((message as { type?: string })?.type === RUNTIME_LOCK_WALLET) {
    // SW-side lock — clears this context's key cache.
    WebAuthnPrfSecretWrap.lock();
    // Forward to the offscreen doc (if running) so its cache
    // is flushed too. The offscreen path is fire-and-forget;
    // a missing offscreen doc is fine (it'll mint a fresh
    // wrap context the next time it boots).
    chrome.runtime
      .sendMessage({ target: OFFSCREEN_TARGET, type: OFFSCREEN_LOCK_WALLET })
      .catch(() => {
        /* no offscreen doc — nothing to flush */
      });
    sendResponse({ ok: true });
    return false;
  }

  if ((message as { type?: string })?.type === RUNTIME_WALLET_DEFAULTS) {
    handleWalletDefaults()
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

  if ((message as { type?: string })?.type === RUNTIME_VERIFY_RP_DID) {
    handleVerifyRpDid(message as RuntimeVerifyRpDidRequest)
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

  // Offscreen asks us to prompt the user for an inbound RP confirm request.
  if ((message as { type?: string })?.type === RUNTIME_INBOUND_CONSENT) {
    const req = message as RuntimeInboundConsentRequest;
    requestConsent({ rpDid: req.rpDid, action: req.action })
      .then((approved) => sendResponse({ approved }))
      .catch(() => sendResponse({ approved: false }));
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
