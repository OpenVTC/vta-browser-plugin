/// <reference types="chrome" />

// Service worker. Owns the wallet's holder identity, runs the REST SIOPv2
// login, and gates every login behind a user-consent prompt. The DIDComm
// login is delegated to an offscreen document (see `offscreen.ts`) because
// it needs dynamic `import()` + a DOM, which a service worker lacks.
//
// REST flow: content → RUNTIME_LOGIN → consent → offscreen REST login → tokens.
// DIDComm flow: content → RUNTIME_LOGIN_DIDCOMM → consent → offscreen doc.

import { IndexedDBKVStore, listPendingInbound } from "@openvtc/pnm-core";
import {
  parseActiveVtaDid,
  parseAllVtaDids,
  readActiveHolderDid,
  readActiveVtaDid,
  readAgentMediatorDids,
  readAllVtaDids,
} from "./active-vta.js";
import { checkOriginPin, pinOrigin } from "./origin-pin.js";
import { isOriginTrusted, trustOrigin } from "./trusted-sites.js";
import {
  forgetSiteIdentity,
  HOLDER_IDENTITY,
  prefersHolderIdentity,
  rememberHolderIdentity,
} from "./site-identity.js";
import {
  buildProfileEntry,
  decideSiteIdentity,
  matchProfileEntry,
  PROFILE_SECRET_KIND,
} from "./first-use-profile.js";
import {
  attestedOrigin,
  registerPushChannel,
  type TaskConsentRequestPayload,
} from "@openvtc/pnm-core";
import { subscribeToPush } from "./push.js";
import { WebAuthnPrfSecretWrap } from "./webauthn-prf-wrap.js";
import {
  OFFSCREEN_DIDCOMM_LOGIN,
  OFFSCREEN_GET_STATUS,
  OFFSCREEN_TRANSPORT_HEALTH,
  OFFSCREEN_RUN_DIAGNOSTICS,
  OFFSCREEN_CREATE_CONTEXT,
  OFFSCREEN_DERIVE_SIGNING_KEY_ID,
  OFFSCREEN_HOLDER_STATE,
  OFFSCREEN_LIST_CONTEXTS,
  OFFSCREEN_LIST_DIDS,
  OFFSCREEN_UNLOCK_PRF,
  OFFSCREEN_UNLOCK_APPROVER,
  OFFSCREEN_FORGET_HOLDER_RECORD,
  OFFSCREEN_REFRESH_VTA_TRANSPORTS,
  OFFSCREEN_REST_LOGIN,
  OFFSCREEN_SET_WAKE,
  OFFSCREEN_WALLET_LOCK_STATE,
  OFFSCREEN_APPROVER_STATE,
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
  RUNTIME_VAULT_DELETE,
  RUNTIME_VAULT_LIST,
  RUNTIME_VAULT_LIST_PAGE,
  RUNTIME_VAULT_PROXY_LOGIN,
  RUNTIME_VAULT_PROXY_LOGIN_PAGE,
  RUNTIME_WALLET_PROFILE,
  RUNTIME_VAULT_RELEASE,
  RUNTIME_VAULT_UPSERT,
  OFFSCREEN_LOCK_WALLET,
  RUNTIME_CONSENT_RESULT,
  RUNTIME_BROADCAST_EVENT,
  RUNTIME_LOCK_WALLET,
  RUNTIME_LOGIN,
  RUNTIME_LOGIN_DIDCOMM,
  RUNTIME_MEDIATOR_STATUS,
  RUNTIME_TRANSPORT_HEALTH,
  RUNTIME_RUN_DIAGNOSTICS,
  RUNTIME_EMIT_WALLET_EVENT,
  type WalletEventKind,
  RUNTIME_CREATE_CONTEXT,
  RUNTIME_DERIVE_SIGNING_KEY_ID,
  RUNTIME_HOLDER_STATE,
  RUNTIME_LIST_CONTEXTS,
  RUNTIME_LIST_DIDS,
  RUNTIME_FORGET_HOLDER_RECORD,
  RUNTIME_RESTART_INBOX,
  RUNTIME_REFRESH_VTA_TRANSPORTS,
  RUNTIME_UNLOCK_PRF,
  RUNTIME_UNLOCK_APPROVER,
  type RuntimeUnlockApproverRequest,
  type RuntimeUnlockApproverResponse,
  RUNTIME_WALLET_LOCK_STATE,
  RUNTIME_ONBOARD_CONNECT,
  RUNTIME_ONBOARD_PREPARE,
  PAGE_FACING_RUNTIME_TYPES,
  RUNTIME_REQUEST_TASK,
  RUNTIME_MANAGER_TASK,
  RUNTIME_SIGN_TRUST_TASK,
  RUNTIME_TASK_CONSENT,
  CONSENT_KEEPALIVE_PORT,
  RUNTIME_STEP_UP_CONSENT,
  RUNTIME_STEP_UP_VTA,
  RUNTIME_APPROVER_STATE,
  RUNTIME_RESOLVE_AGENT_NAME,
  RUNTIME_VERIFY_RP_DID,
  RUNTIME_WALLET_DEFAULTS,
  type MediatorStatusResult,
  type RuntimeTransportHealthResponse,
  type RuntimeRunDiagnosticsRequest,
  type RuntimeRunDiagnosticsResponse,
  type OffscreenDidcommLoginRequest,
  type OffscreenSetWakeResponse,
  type OffscreenStepUpVtaRequest,
  type RuntimeApiGetRequest,
  type RuntimeApiGetResponse,
  type RuntimeApiPostRequest,
  type RuntimeConsentResult,
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
  type RuntimeListDidsRequest,
  type RuntimeListDidsResponse,
  type RuntimeForgetHolderRecordRequest,
  type RuntimeForgetHolderRecordResponse,
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
  OFFSCREEN_REQUEST_TASK,
  type RuntimeRequestTaskRequest,
  type RuntimeRequestTaskResponse,
  type RuntimeManagerTaskRequest,
  type RuntimeManagerTaskResponse,
  type RuntimeSignTrustTaskRequest,
  type RuntimeSignTrustTaskResponse,
  type RuntimeStepUpConsentRequest,
  type RuntimeStepUpConsentResponse,
  type RuntimeStepUpVtaRequest,
  type RuntimeVaultDeleteRequest,
  type RuntimeVaultDeleteResponse,
  type RuntimeVaultListRequest,
  type RuntimeVaultListResponse,
  type RuntimeVaultListPageRequest,
  type RuntimeVaultProxyLoginPageRequest,
  type RuntimeVaultProxyLoginRequest,
  type RuntimeVaultProxyLoginResponse,
  type RuntimeVaultReleaseRequest,
  type RuntimeVaultReleaseResponse,
  type ProxyLoginParams,
  type RuntimeWalletProfileRequest,
  type RuntimeWalletProfileResponse,
  type RuntimeVaultUpsertRequest,
  type RuntimeVaultUpsertResponse,
  type RuntimeApproverStateResponse,
  type RuntimeResolveAgentNameRequest,
  type RuntimeResolveAgentNameResponse,
  type RuntimeVerifyRpDidRequest,
  type RuntimeVerifyRpDidResponse,
  type RuntimeWalletDefaultsResponse,
  type VerifyRpDidResult,
} from "./bridge-protocol.js";
import { clearLegacyInbox, getSettings, inboxFor, inboxToAdopt, setInbox, setSettings } from "./config.js";
import { providerMatches, syncProviderRegistration } from "./content-registration.js";
import {
  AGENT_NAME_UNREADABLE,
  AgentNameError,
  resolveAgentName,
} from "./agent-name.js";
import {
  HOST_PERMISSION_REQUIRED,
  displayHostFor,
  hasOriginPermission,
} from "./host-permissions.js";
import { ConsentReplayLedger, replayKey } from "./consent-replay.js";

/** Consent-gated requests awaiting their one exempt replay. In-memory by
 *  design: a service-worker restart loses it, and losing it costs one extra
 *  confirm rather than admitting anything. */
const consentReplays = new ConsentReplayLedger();

// Keep the provider registration in step with the grants.
//
// Three triggers, and all three are needed. `onStartup` covers a browser
// restart where the persisted registration and the grants may disagree. The
// permission events cover the live case — granting an origin in the popup has
// to start the provider there without a restart, and revoking has to stop it.
// The service worker also runs this on every cold start, because MV3 evicts
// it constantly and a missed event would otherwise persist until the next one.
chrome.permissions.onAdded.addListener(() => void syncProviderRegistration());
chrome.permissions.onRemoved.addListener(() => void syncProviderRegistration());
chrome.runtime.onStartup.addListener(() => {
  void syncProviderRegistration();
  void followAgentInbox();
});
void syncProviderRegistration().then((matches) => {
  console.info(
    matches.length > 0
      ? `[pnm] page provider registered for: ${matches.join(", ")}`
      : "[pnm] page provider registered for no sites — grant one to enable sign-in",
  );
});

chrome.runtime.onInstalled.addListener((details) => {
  console.info("[pnm] extension installed:", details.reason);
  void ensurePushWake();
  // An update is the other moment worth one DID-document read: it is when a
  // deployment's pieces tend to move together.
  void followAgentInbox();

  // Fresh install: open setup in a tab rather than leaving the user to find
  // it. The order of the steps there is load-bearing — the agent's address
  // comes first because its mediator is resolved from it — and a user who
  // starts from the toolbar popup instead has no way to know that. This is
  // also the only container the flow's native dialogs survive (crbug
  // 40721470). Install only: doing it on every update would hijack a tab
  // during the dev edit-reload loop.
  if (details.reason === "install") {
    void chrome.tabs.create({ url: chrome.runtime.getURL("options.html#setup") });
  }

  // Re-register the provider for whatever is granted. An update replaces the
  // extension's registrations, so without this the provider quietly stops
  // running everywhere until the next permission change.
  void syncProviderRegistration();
  // On update (the dev-iteration case the operator hits constantly:
  // edit the plugin → "Reload" in chrome://extensions), reload every
  // tab that the content script matches. Without this, the OLD content
  // script in those tabs is orphaned — its chrome.runtime.* calls all
  // fail with "Extension context invalidated" — and the operator has
  // to manually refresh each RP page. The reload re-injects a fresh
  // content script that's wired to the new background.
  //
  // Gated on `reason === "update"` (a `Reload` from chrome://extensions
  // surfaces as that). Fresh installs have no relevant tabs open. The
  // browser-startup case (`reason === "chrome_update"` or absent
  // onInstalled fire) leaves tabs alone.
  if (details.reason === "update") {
    void reloadContentScriptTabs();
  }
});

/** Origins the provider currently runs on.
 *
 *  Was read from `manifest.content_scripts`. That list no longer exists — the
 *  provider is registered dynamically for granted origins only
 *  (content-registration.ts) — and leaving the manifest lookup in place would
 *  have made both callers silently no-op: no tab reloads after an update, and
 *  no wallet events reaching any page. */
async function providerMatchPatterns(): Promise<string[]> {
  const all = await chrome.permissions.getAll();
  return providerMatches(all.origins ?? []);
}

/** Reload every tab the provider runs on. Called from `onInstalled` after an
 *  extension update so open RP pages pick up a fresh content script wired to
 *  the new background SW. */
async function reloadContentScriptTabs(): Promise<void> {
  const matches = await providerMatchPatterns();
  if (matches.length === 0) return;
  const tabs = await chrome.tabs.query({ url: matches });
  for (const tab of tabs) {
    if (tab.id === undefined) continue;
    try {
      await chrome.tabs.reload(tab.id);
    } catch (e) {
      console.warn("[pnm] tab reload failed:", tab.id, e);
    }
  }
}

/** Broadcast a wallet-lifecycle event to every tab whose URL matches
 *  the content-script pattern. The content scripts forward to their
 *  page-world provider, which dispatches as a `vtawallet:<kind>`
 *  window event. Best-effort — `chrome.tabs.sendMessage` to a tab
 *  with no content-script listener throws and is swallowed. */
async function broadcastWalletEvent(
  event: WalletEventKind,
  detail?: Record<string, unknown>,
): Promise<void> {
  const matches = await providerMatchPatterns();
  if (matches.length === 0) return;
  const tabs = await chrome.tabs.query({ url: matches });
  const msg = {
    type: RUNTIME_BROADCAST_EVENT,
    event,
    ...(detail ? { detail } : {}),
  };
  for (const tab of tabs) {
    if (tab.id === undefined) continue;
    try {
      await chrome.tabs.sendMessage(tab.id, msg);
    } catch {
      // No content-script receiver in this tab — fine. Either the URL
      // matched but the script hasn't loaded yet, or it was a non-page
      // tab. Don't log; this is the common case.
    }
  }
}

// Web Push wake-up (binding https://trusttasks.org/binding/push/0.1).
// Registered at top level so it's active when an inbound push wakes the worker.
// A contentless wake is a doorbell: its job is to spin the offscreen doc back up
// and drain the mediator, not to carry content (see `handlePushWake`).
self.addEventListener("push", (event) => {
  const pushEvent = event as PushEvent;
  let body = "";
  try {
    body = pushEvent.data ? pushEvent.data.text() : "";
  } catch {
    body = "(unreadable payload)";
  }
  console.info("[pnm push] push received:", body);
  pushEvent.waitUntil(handlePushWake(body));
});

/** Handle a contentless wake (binding §2). The push payload is an *untrusted
 *  hint* — the authoritative messages come only from authenticated mediator
 *  pickup — so we don't act on `body`; we just use the wake to re-establish the
 *  inbound mediator sessions for every onboarded VTA. On (re)connect those
 *  sessions drain queued DIDComm Trust Tasks (e.g. an RP confirm-request) and
 *  the existing inbound handler runs the consent → signed-response flow.
 *
 *  This runs inside the push event's `waitUntil` so the service worker stays
 *  alive until the drain is kicked — unlike the fire-and-forget
 *  `startInboundListener()` on plain spin-up, which the browser may terminate
 *  before it completes. `userVisibleOnly: true` requires we show a notification
 *  per push; the wording is generic (no task content from the push). */
async function handlePushWake(body: string): Promise<void> {
  const reg = (self as unknown as { registration: ServiceWorkerRegistration }).registration;
  const notify = reg.showNotification("VTA Wallet", {
    body: body || "Checking for pending requests…",
  });
  try {
    await startInboundListener();
  } catch (e) {
    console.warn("[pnm push] wake-drain failed:", e);
  }
  await notify;
}

// Subscribe once the worker is *active*. On a cold start (install/update) the
// top-level call below runs before activation, when `pushManager.subscribe`
// throws "no active Service Worker"; the `activate` event is the first point the
// worker is active, so re-run there. (`clients.claim()` lets this worker control
// already-open pages immediately, so a freshly-installed SW doesn't sit idle.)
self.addEventListener("activate", (event) => {
  const e = event as ExtendableEvent;
  e.waitUntil(
    (async () => {
      try {
        await (self as unknown as { clients: Clients }).clients.claim();
      } catch {
        // best-effort
      }
      await ensurePushWake();
    })(),
  );
});

// Also attempt on every warm spin-up (MV3 workers are ephemeral; a wake/event
// re-evaluates this script with the worker already active, so no `activate`
// fires). `subscribeToPush` no-ops when the worker isn't active yet.
void ensurePushWake();

/**
 * Web Push wake-up wiring (binding https://trusttasks.org/binding/push/0.1).
 *
 *   1. Subscribe to Web Push (gateway VAPID key when configured).
 *   2. `push/register` the subscription with the gateway → opaque WakeHandle
 *      (plain unauthenticated fetch — `register` is open; the handle is useless
 *      until provisioned). Runs SW-side: no DIDComm needed.
 *   3. `device/set-wake` conveys the handle to the active VTA, relayed to the
 *      offscreen doc (set-wake authcrypts to the VTA; the holder identity only
 *      unwraps there).
 *
 * Best-effort and idempotent: no gateway configured → just subscribe; no active
 * VTA → register is skipped (logged). The contentless wake then lands in the
 * `push` handler above.
 */
async function ensurePushWake(): Promise<void> {
  const sub = await subscribeToPush();
  if (!sub) return;

  const { pushGatewayUrl } = await getSettings();
  if (!pushGatewayUrl) return; // push is opt-in until a gateway is configured

  const active = await readActiveConnection();
  if (!active.ok) {
    console.info(`[pnm push] subscribed; skipping gateway register — ${active.error}`);
    return;
  }

  const json = sub.toJSON();
  const p256dh = json.keys?.p256dh;
  const auth = json.keys?.auth;
  if (!json.endpoint || !p256dh || !auth) {
    console.warn("[pnm push] subscription is missing Web Push keys; cannot register");
    return;
  }

  try {
    const handle = await registerPushChannel({
      gatewayUrl: pushGatewayUrl,
      registration: {
        platform: "webpush",
        endpoint: json.endpoint,
        keys: { p256dh, auth },
      },
      controllerVtaDid: active.conn.vtaDid,
    });
    console.info("[pnm push] registered with gateway; handle:", JSON.stringify(handle));

    // Convey the handle to the VTA. Relayed to offscreen — set-wake authcrypts
    // to the VTA and the holder identity only unwraps there. Suggest the
    // device's mediator as a trigger (the VTA owns the final allowlist).
    const raw = await readActiveConnectionRaw();
    await ensureOffscreenDocument();
    const resp = (await chrome.runtime.sendMessage({
      target: OFFSCREEN_TARGET,
      type: OFFSCREEN_SET_WAKE,
      vtaDid: active.conn.vtaDid,
      restBaseUrl: active.conn.restBaseUrl,
      wakeHandle: handle,
      pushPlatform: "webpush",
      ...(raw?.mediatorDid ? { suggestedTriggers: [raw.mediatorDid] } : {}),
    })) as OffscreenSetWakeResponse;

    if (resp?.ok) {
      console.info(
        "[pnm push] device/set-wake ok — pushCapable:",
        resp.result?.pushCapable,
        "triggers:",
        resp.result?.triggerPolicy?.allowedTriggers ?? [],
      );
    } else {
      console.warn("[pnm push] device/set-wake failed:", resp?.error);
    }
  } catch (e) {
    console.warn("[pnm push] gateway register / set-wake failed:", e);
  }
}

// Bring up the offscreen doc + its persistent inbound mediator session so the
// wallet can receive RP-initiated confirm requests. Idempotent (both
// ensureOffscreenDocument and the offscreen's startInbound no-op if already
// running), so it's safe to call on every worker spin-up.
// Re-reconcile inbound listeners whenever the persisted connection
// store changes. The operator adding a new VTA, forgetting an
// existing one, or switching the active doesn't actually trigger the
// connection map keys to change for the switch case — but
// chrome.storage.onChanged fires on any value change. Comparing the
// previous and current vtaDid lists keeps us from spamming the
// offscreen on no-op changes (like the active-VTA flip).
let _lastInboundVtaDids: string[] = [];
let _lastActiveVtaDid: string | null = null;

/**
 * Give every onboarded agent an inbox, for wallets that predate the map.
 *
 * Two sources, both already on disk, so this costs no network and can run on
 * every worker spin-up:
 *
 *  - The **legacy single setting.** Before inboxes were per-agent there was
 *    one `mediatorDid` for the whole wallet. An `operator` one was a person's
 *    choice and is carried over to the ACTIVE agent — the one they were
 *    looking at when they typed it. Anything else is dropped rather than
 *    spread across every agent: it was most likely the removed hardcoded demo
 *    relay, which `setSettings` used to persist as though it had been chosen
 *    (it merged the *defaulted* settings and wrote them back, so any unrelated
 *    write — the passkey lock, the TSP toggle — froze the default into a value
 *    nobody picked).
 *  - The **persisted connection**, which carries each agent's advertised
 *    mediator from onboarding.
 *
 * `inboxToAdopt` decides per agent, so an operator pin is never overwritten
 * and an agent-sourced entry is not re-adopted on every boot.
 */
async function adoptMissingInboxes(vtaDids: readonly string[]): Promise<void> {
  const settings = await getSettings();
  const advertised = await readAgentMediatorDids();

  // One-time carry-over of the legacy wallet-wide setting.
  if (settings.mediatorDid || settings.mediatorDidSource) {
    const activeVtaDid = await readActiveVtaDid();
    if (settings.mediatorDidSource === "operator" && settings.mediatorDid && activeVtaDid) {
      await setInbox(activeVtaDid, { did: settings.mediatorDid, source: "operator" });
      console.info("[pnm inbound] carried the pinned relay over to", activeVtaDid);
    }
    // Clear the legacy keys either way, so this runs once.
    await clearLegacyInbox();
  }

  const current = await getSettings();
  for (const vtaDid of vtaDids) {
    const adopt = inboxToAdopt(inboxFor(current, vtaDid) ?? {}, advertised[vtaDid]);
    if (adopt) {
      await setInbox(vtaDid, { did: adopt, source: "agent" });
      console.info("[pnm inbound] inbox adopted from agent:", vtaDid, "→", adopt);
    } else if (!inboxFor(current, vtaDid) && !advertised[vtaDid]) {
      // Neither an inbox nor anything to adopt: said out loud, because the
      // alternative is an agent that silently cannot reach this wallet and a
      // boot that looks like it did its job. Refreshing that agent's
      // transports re-resolves its DID document and fills the connection in.
      console.warn(
        "[pnm inbound]",
        vtaDid,
        "has no inbox relay and advertises none to adopt — it cannot reach this wallet.",
      );
    }
  }
}

async function startInboundListener(): Promise<void> {
  // Multi-VTA: ship the full list of onboarded VTAs. The offscreen
  // reconciles — one warm inbox session per holder identity. Empty
  // list closes any stale listeners (post-wipe / no-VTA state) but is
  // otherwise a no-op.
  const vtaDids = (await readAllVtaDids()).sort();
  _lastInboundVtaDids = vtaDids;

  await adoptMissingInboxes(vtaDids);

  // Seed _lastActiveVtaDid too — otherwise the first chrome.storage
  // onChanged callback would see _lastActiveVtaDid=null and emit a
  // spurious connectionchanged.
  _lastActiveVtaDid = await readActiveVtaDid();
  await ensureOffscreenDocument();
  await chrome.runtime.sendMessage({
    target: OFFSCREEN_TARGET,
    type: OFFSCREEN_START_INBOUND,
    vtaDids,
  });
}
void startInboundListener();
chrome.storage.onChanged.addListener((changes, areaName) => {
  if (areaName !== "local") return;
  const change = changes["pnm-connection/v3"];
  if (!change) return;
  const next = parseAllVtaDids(change.newValue).sort();
  const nextActive = parseActiveVtaDid(change.newValue);
  const sameList =
    next.length === _lastInboundVtaDids.length &&
    next.every((v, i) => v === _lastInboundVtaDids[i]);
  const sameActive = nextActive === _lastActiveVtaDid;

  // Broadcast on EITHER list change (add/forget VTA) or active-VTA
  // switch — RP pages that pinned login state to a particular holder
  // DID need to know when the active changed, even if the set of
  // onboarded VTAs didn't. Reconcile is only needed on list changes.
  if (!sameActive) {
    _lastActiveVtaDid = nextActive;
    void broadcastWalletEvent("connectionchanged");
  }
  if (sameList) return;
  _lastInboundVtaDids = next;
  if (sameActive) {
    // List changed but active didn't — still fire connectionchanged
    // so RPs see e.g. a Forget of a non-active VTA.
    void broadcastWalletEvent("connectionchanged");
  }
  void (async () => {
    await ensureOffscreenDocument();
    await chrome.runtime.sendMessage({
      target: OFFSCREEN_TARGET,
      type: OFFSCREEN_START_INBOUND,
      vtaDids: next,
    });
  })();
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

// A port is the only reliable way for the offscreen document to reach this
// worker. `chrome.runtime.sendMessage` from an offscreen document does not
// dependably START a terminated MV3 service worker: the send resolves nowhere,
// nothing is thrown, and the caller's await hangs forever. That is exactly how
// a consent request went missing — arriving, verifying, de-duplicating, being
// acked to the mediator, and then vanishing with no prompt and no error, while
// the identical message dispatched by hand from the console (with the worker
// already awake) prompted correctly.
//
// `chrome.runtime.connect` does start the worker, and an open port keeps it
// alive for the connection's lifetime — which also covers the second half of
// the problem: `requestTaskConsent` awaits a human decision that can take
// minutes, far past the ~30s idle teardown, with the resolver held in memory.
//
// The listener body is deliberately empty. Accepting the connection is the
// entire purpose; there is no protocol here.
// ─── Pending-approval surface ───
//
// A prompt window that must appear at an arbitrary moment is the least reliable
// thing this extension can attempt: it needs a live service worker, a live
// offscreen document, and a promise chain spanning both, on a runtime that is
// free to kill either. Every failure we chased came from that.
//
// A badge does not. It is derived from durable state, so it is correct after
// any teardown, and it gives the user a way IN rather than depending on a
// window finding its way OUT. The window remains the fast path; this is the
// floor beneath it.
//
// Read from the same durable record the inbound path writes before it acks the
// mediator (`pending.ts`), so the badge cannot claim a request the recipient
// never durably held — nor miss one it did.
async function refreshPendingBadge(): Promise<void> {
  try {
    const pending = await listPendingInbound(new IndexedDBKVStore());
    const waiting = pending.filter((p: { isApprover: boolean }) => p.isApprover).length;
    await chrome.action.setBadgeText({ text: waiting > 0 ? String(waiting) : "" });
    if (waiting > 0) {
      await chrome.action.setBadgeBackgroundColor({ color: "#8B1A1A" });
    }
  } catch (err) {
    // Never let a cosmetic surface break a wake path.
    console.warn("[pnm consent] could not refresh the pending badge:", err);
  }
}

// Every wake is a chance to be correct: startup, a consent port opening, a push
// doorbell. Idempotent and cheap, so running it often costs nothing and means
// no single missed call leaves the badge lying.
void refreshPendingBadge();

chrome.runtime.onConnect.addListener((port) => {
  if (port.name !== CONSENT_KEEPALIVE_PORT) return;
  // A consent port opening means a request was just durably recorded; a
  // disconnect means the interaction ended. Both change the count.
  void refreshPendingBadge();
  port.onDisconnect.addListener(() => {
    void refreshPendingBadge();
    // Nothing to clean up — the port exists only to hold the worker awake.
  });
});

// ─── Consent coordination ───
// A login request opens a consent popup and parks here until the popup
// reports the user's decision (or is closed, which counts as a denial).
const pendingConsents = new Map<
  string,
  (approved: boolean, remember: boolean, prfOutputB64u?: string, selectedDid?: string) => void
>();

/**
 * Size a consent popup as wide as the display sensibly allows.
 *
 * These are `type: "popup"` windows, not the action popup, so the ~800px cap
 * does not apply — the only real limit is the screen. An MV3 service worker has
 * no `screen`/`window`, so the focused browser window's own bounds stand in for
 * the display; if even that is unavailable we fall back to the old 480px, which
 * is narrow but never wrong.
 *
 * Width is not cosmetic here: the destructive task sheet asks the operator to
 * eyeball a change diff and match a digest, and a prompt that wraps or clips the
 * thing being compared is a prompt that encourages approving without reading
 * (R7.2).
 */
async function consentWindowBounds(
  height: number,
): Promise<{ width: number; height: number; left?: number; top?: number }> {
  const MIN_WIDTH = 480;
  // Past this, diff/digest lines stop getting easier to scan and start getting
  // harder — the eye loses the line it is on.
  const MAX_WIDTH = 1100;
  // Keep the popup clear of the screen edges and of the OS window chrome.
  const MARGIN = 48;

  try {
    const focused = await chrome.windows.getLastFocused();
    const availWidth = focused?.width;
    const availHeight = focused?.height;
    if (!availWidth || !availHeight) return { width: MIN_WIDTH, height };

    const width = Math.max(MIN_WIDTH, Math.min(MAX_WIDTH, availWidth - MARGIN * 2));
    // Never taller than the window we measured against, or the decision buttons
    // land off-screen — an unreachable Deny button is a broken security control.
    const h = Math.max(360, Math.min(height, availHeight - MARGIN));
    const left = Math.round((focused.left ?? 0) + (availWidth - width) / 2);
    const top = Math.round((focused.top ?? 0) + Math.max(0, (availHeight - h) / 2));
    return { width, height: h, left, top };
  } catch {
    return { width: MIN_WIDTH, height };
  }
}

async function requestConsent(args: {
  origin?: string;
  /** Suppress the "remember this site" checkbox.
   *
   *  Set it whenever a grant would be meaningless or dangerous — a per-action
   *  authorization (`requestTask`, `signTrustTask`) has nothing to remember, and
   *  a checkbox that silently discards its own tick is a checkbox that lies. */
  noRemember?: boolean;
  /** Optional — login / step-up always set it, but page-initiated actions
   *  such as `vaultList()` may have no specific RP to show. When absent the
   *  popup omits the relying-party card and shows only the origin + action. */
  rpDid?: string;
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
  /** Frames the prompt as a session step-up rather than a sign-in. */
  stepUp?: boolean;
  /** VERIFIED RP-authored reason to render (plain text, already length-capped
   *  and control-stripped by the caller). Only ever set from the step-up path,
   *  where it comes from inside the signed approve-request — never pass a
   *  page-supplied string here. */
  reason?: string;
  /** Render the first-use persona picker: this origin has no vault entry yet,
   *  so the prompt asks which identity the site should know the user as and
   *  returns the answer in `selectedDid`. */
  chooseProfile?: boolean;
  /** Offer the wallet's own identity as one of the answers, returned as
   *  {@link HOLDER_IDENTITY}. Only `login()` sets it — the proxy paths mint
   *  through a vault entry, and the holder is not one. */
  allowHolder?: boolean;
}): Promise<{ approved: boolean; remember: boolean; selectedDid?: string }> {
  const consentId = crypto.randomUUID();
  const url =
    chrome.runtime.getURL("confirm.html") +
    `?cid=${consentId}` +
    (args.rpDid ? `&rpDid=${encodeURIComponent(args.rpDid)}` : "") +
    (args.origin ? `&origin=${encodeURIComponent(args.origin)}` : "") +
    (args.holderDid ? `&holder=${encodeURIComponent(args.holderDid)}` : "") +
    (args.action ? `&action=${encodeURIComponent(args.action)}` : "") +
    (args.noRemember ? `&noRemember=1` : "") +
    (args.stepUp ? `&stepUp=1` : "") +
    (args.chooseProfile ? `&chooseProfile=1` : "") +
    (args.allowHolder ? `&allowHolder=1` : "") +
    (args.reason ? `&reason=${encodeURIComponent(args.reason)}` : "") +
    (args.changedFromRpDid
      ? `&changedFrom=${encodeURIComponent(args.changedFromRpDid)}`
      : "");

  // The reason card and the persona picker each need room, or the decision
  // buttons slide off-screen — and an Approve the operator has to scroll to
  // find is one they approve without reading what is above it.
  const bounds = await consentWindowBounds(args.reason ? 660 : args.chooseProfile ? 680 : 560);

  return new Promise<{ approved: boolean; remember: boolean; selectedDid?: string }>((resolve) => {
    let settled = false;
    const settle = (approved: boolean, remember: boolean, selectedDid?: string) => {
      if (settled) return;
      settled = true;
      pendingConsents.delete(consentId);
      resolve({ approved, remember, ...(selectedDid ? { selectedDid } : {}) });
    };
    pendingConsents.set(consentId, (approved, remember, _prf, selectedDid) =>
      settle(approved, remember, selectedDid),
    );

    chrome.windows.create({ url, type: "popup", ...bounds }, (win) => {
      const winId = win?.id;
      if (winId === undefined) {
        // The window could not be opened. This used to `return` without
        // settling, leaving the promise pending forever: the caller's `await`
        // never resolved, no decision was ever produced, and nothing was logged
        // in any context. From the outside that is indistinguishable from a
        // request that never arrived — which is exactly how it presented, after
        // the message had already been verified, de-duplicated, and acked to
        // the mediator (so its queued copy was gone too).
        //
        // Settle as a DENIAL, never assent. A prompt the user never saw must
        // not become an approval, and the rest of this file is built on
        // "silence is not agreement".
        //
        // `lastError` is read inside the callback because that is the only
        // place it exists; leaving it unread also emits an "unchecked
        // runtime.lastError" warning that buries the real reason.
        const why = chrome.runtime.lastError?.message ?? "no window was created";
        console.error(
          "[pnm consent] could not open the consent window — treating as a denial:",
          why,
        );
        settle(false, false);
        return;
      }
      // A window id proves creation succeeded; it does NOT prove the window is
      // visible. `consentWindowBounds` derives left/top from
      // `chrome.windows.getLastFocused()`, so a minimised window, a second
      // display, or an undocked DevTools window can place the prompt somewhere
      // the user never looks — and that is indistinguishable from no prompt at
      // all, which is precisely the ambiguity that made the silent hang above
      // so hard to find. Log where it went so "I see no popup" is answerable.
      console.info(
        "[pnm consent] consent window opened",
        "id=", winId,
        "bounds=", JSON.stringify(bounds),
      );
      // Closing the window without a decision is a denial.
      const onClosed = (closedId: number) => {
        if (closedId === winId) {
          chrome.windows.onRemoved.removeListener(onClosed);
          settle(false, false);
        }
      };
      chrome.windows.onRemoved.addListener(onClosed);
    });
  });
}

// ── Task-execution consent ───────────────────────────────────────────────────

/** Session-scoped store for the request the consent sheet is about to render.
 *  Too large for a query string (the effects list is the whole point), and it
 *  must not outlive the browser session. */
const TASK_CONSENT_PREFIX = "task-consent:";

/**
 * Raise the task-consent sheet for a request the offscreen has already
 * **verified** came from this device's own VTA.
 *
 * Deliberately NOT routed through `gatedConsent`. That function short-circuits
 * on origin trust, and origin trust is the wrong question here twice over: the
 * asker is the user's VTA rather than a site, and the approval authorizes one
 * specific payload rather than a standing relationship. A "remember this site"
 * tick made against a `vaultList()` prompt must never silently approve a DID
 * deactivation — **origin trust is not capability trust.**
 */
async function requestTaskConsent(
  request: TaskConsentRequestPayload,
  approver = false,
): Promise<{ approved: boolean; prfOutputB64u?: string }> {
  const consentId = crypto.randomUUID();
  await chrome.storage.session.set({ [`${TASK_CONSENT_PREFIX}${consentId}`]: request });

  // `approver=1` tells the popup this is the biometric-gated approver surface:
  // Approve must run a fresh, payload-bound WebAuthn gesture before it returns.
  const url =
    `${chrome.runtime.getURL("confirm.html")}?cid=${consentId}&kind=task` +
    (approver ? "&approver=1" : "");

  // A destructive task asks the user to match a digest, which needs room.
  const destructive = request.sideEffects === "destructive";
  const bounds = await consentWindowBounds(destructive ? 680 : 620);

  return new Promise<{ approved: boolean; prfOutputB64u?: string }>((resolve) => {
    let settled = false;
    const settle = (approved: boolean, prfOutputB64u?: string) => {
      if (settled) return;
      settled = true;
      pendingConsents.delete(consentId);
      void chrome.storage.session.remove(`${TASK_CONSENT_PREFIX}${consentId}`);
      resolve({ approved, ...(prfOutputB64u ? { prfOutputB64u } : {}) });
    };
    pendingConsents.set(consentId, (approved: boolean, _remember: boolean, prfOutputB64u?: string) =>
      settle(approved, prfOutputB64u),
    );

    chrome.windows.create({ url, type: "popup", ...bounds }, (win) => {
      const winId = win?.id;
      if (winId === undefined) {
        // The window could not be opened. This used to `return` without
        // settling, leaving the promise pending forever: the caller's `await`
        // never resolved, no decision was ever produced, and nothing was logged
        // in any context. From the outside that is indistinguishable from a
        // request that never arrived — which is exactly how it presented, after
        // the message had already been verified, de-duplicated, and acked to
        // the mediator (so its queued copy was gone too).
        //
        // Settle as a DENIAL, never assent. A prompt the user never saw must
        // not become an approval, and the rest of this file is built on
        // "silence is not agreement".
        //
        // `lastError` is read inside the callback because that is the only
        // place it exists; leaving it unread also emits an "unchecked
        // runtime.lastError" warning that buries the real reason.
        const why = chrome.runtime.lastError?.message ?? "no window was created";
        console.error(
          "[pnm consent] could not open the consent window — treating as a denial:",
          why,
        );
        settle(false);
        return;
      }
      // A window id proves creation succeeded; it does NOT prove the window is
      // visible. `consentWindowBounds` derives left/top from
      // `chrome.windows.getLastFocused()`, so a minimised window, a second
      // display, or an undocked DevTools window can place the prompt somewhere
      // the user never looks — and that is indistinguishable from no prompt at
      // all, which is precisely the ambiguity that made the silent hang above
      // so hard to find. Log where it went so "I see no popup" is answerable.
      console.info(
        "[pnm consent] consent window opened",
        "id=", winId,
        "bounds=", JSON.stringify(bounds),
      );
      // Closing the window without deciding is a denial. Never assent: silence
      // is not agreement, and a task-consent prompt that timed out into an
      // approval would be the single worst bug in this system.
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

/**
 * Consent with per-origin trust short-circuit. Trusted origins (the user
 * ticked "Remember this site") skip the popup entirely; otherwise the popup
 * is shown and, if approved with "remember", the origin is persisted as
 * trusted. Returns the plain boolean the callers expect.
 */
async function gatedConsent(args: {
  origin?: string;
  rpDid?: string;
  holderDid?: string;
  action?: string;
  changedFromRpDid?: string;
  stepUp?: boolean;
  reason?: string;
}): Promise<boolean> {
  // A pinned-RP *change* must always re-prompt, even for a trusted site —
  // it's exactly the redirect-to-attacker-RP case the louder warning exists
  // for, so trust doesn't get to silence it.
  if (args.origin && !args.changedFromRpDid && (await isOriginTrusted(args.origin))) {
    return true;
  }
  const { approved, remember } = await requestConsent(args);
  if (approved && remember && args.origin) {
    await trustOrigin(args.origin, args.rpDid);
  }
  return approved;
}

async function handleLogin(req: RuntimeLoginRequest): Promise<RuntimeLoginResponse> {
  // Display-only DID lookup — see handleLoginDidcomm for the
  // background-vs-offscreen scope rationale.
  const holderDid = await readActiveHolderDid();
  if (!holderDid) return { ok: false, error: "no active VTA connection — connect first" };

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
    holderDid,
  };
  if (pin.rpDidChanged && pin.pinnedRpDid) {
    consent.changedFromRpDid = pin.pinnedRpDid;
  }
  const approved = await gatedConsent(consent);
  if (!approved) return { ok: false, error: "login denied by user" };

  if (req.origin) {
    await pinOrigin(req.origin, req.params.rpDid);
  }

  // Which identity signs in. A per-site persona when this origin has one, the
  // wallet's own when the operator chose it, and otherwise ask — see
  // `resolveLoginIdentity`.
  const identity = await resolveLoginIdentity(req.origin, req.params.rpDid, holderDid);
  if (!identity.ok) return { ok: false, error: identity.error };

  // Forward the actual SIOPv2 round-trip to offscreen — the holder's
  // signing key only lives unwrapped there (the PRF AES cache is
  // offscreen-module-scoped). Calling `loginViaSiop` from background
  // worked on plaintext wallets but threw `WalletLockedError` on
  // encrypted ones even when offscreen was unlocked.
  await ensureOffscreenDocument();
  const active = await readActiveConnection();
  if (!active.ok) return { ok: false, error: active.error };
  const activeVtaDid = active.conn.vtaDid;
  const conn = active.conn;
  const result = (await chrome.runtime.sendMessage({
    target: OFFSCREEN_TARGET,
    type: OFFSCREEN_REST_LOGIN,
    vtaDid: activeVtaDid,
    params: req.params,
    ...(identity.entryId ? { entryId: identity.entryId } : {}),
    ...(conn?.restBaseUrl ? { restBaseUrl: conn.restBaseUrl } : {}),
  })) as RuntimeLoginResponse;

  if (!result.ok && identity.bound) {
    return {
      ok: false,
      error:
        `${result.error} — this was the first sign-in as ${identity.did}. ` +
        `If ${req.origin ?? "the site"} refused it, that identity needs to be on its access list.`,
    };
  }
  return result;
}

/**
 * Which identity a `login()` at this origin signs in as.
 *
 * Three outcomes, and the third is the one that changed: a per-site persona
 * (minted by the VTA, which holds its key), the wallet's own holder identity,
 * or — when neither has been decided for this origin — a prompt that asks.
 *
 * `login()` used to have no third case. It signed as the holder DID for every
 * site, unconditionally and silently, while the wallet's own explainer told the
 * operator that "each site gets its own identity". Making the persona the
 * default closes that gap; keeping the holder as an *offered* answer is what
 * stops the change breaking every RP ACL that was enrolled before personas
 * existed (see `site-identity.ts`).
 */
async function resolveLoginIdentity(
  origin: string | undefined,
  rpDid: string,
  holderDid: string,
): Promise<
  { ok: true; entryId?: string; did: string; bound: boolean } | { ok: false; error: string }
> {
  // No attested origin means no site to bind a persona to. The wallet's own
  // identity is the only honest answer, and it is what this path already did.
  if (!origin) return { ok: true, did: holderDid, bound: false };

  const listed = await handleVaultList({
    type: RUNTIME_VAULT_LIST,
    filter: { secretKind: PROFILE_SECRET_KIND, targetOriginPrefix: origin },
  });
  if (!listed.ok) return { ok: false, error: listed.error };

  const decision = decideSiteIdentity(
    listed.result.entries,
    origin,
    await prefersHolderIdentity(origin),
  );

  if (decision.kind === "holder") return { ok: true, did: holderDid, bound: false };
  if (decision.kind === "persona") {
    const did = await principalDidFor(origin, decision.entryId);
    if (!did.ok) return { ok: false, error: did.error };
    return { ok: true, entryId: decision.entryId, did: did.did, bound: false };
  }

  // `requestConsent`, not `gatedConsent` — a remembered origin consented to
  // being signed in as an identity already chosen, never to one being chosen
  // for it. Same reasoning as the proxy-login path.
  const chosen = await requestConsent({
    origin,
    rpDid,
    holderDid,
    chooseProfile: true,
    allowHolder: true,
  });
  if (!chosen.approved || !chosen.selectedDid) {
    return { ok: false, error: "login denied by user" };
  }
  if (chosen.remember) await trustOrigin(origin, rpDid);

  if (chosen.selectedDid === HOLDER_IDENTITY) {
    await rememberHolderIdentity(origin);
    return { ok: true, did: holderDid, bound: false };
  }

  const bound = await bindProfileEntry(origin, chosen.selectedDid, rpDid);
  if (!bound.ok) return { ok: false, error: bound.error };
  // A persona now answers for this origin, so a holder record left behind would
  // be a second answer that never wins but is read on every sign-in.
  await forgetSiteIdentity(origin);
  return { ok: true, entryId: bound.entryId, did: chosen.selectedDid, bound: true };
}

async function handleLoginDidcomm(
  req: RuntimeLoginDidcommRequest,
): Promise<RuntimeLoginResponse> {
  // Read the holder DID directly from the persisted connection — no
  // decryption needed for a display-only value. Background SW lives
  // in a separate module scope from offscreen and has no PRF AES
  // cache, so calling `loadActiveHolder` here would throw
  // `WalletLockedError` on an encrypted wallet even when offscreen
  // is unlocked.
  const holderDid = await readActiveHolderDid();
  if (!holderDid) return { ok: false, error: "no active VTA connection — connect first" };

  // M5: origin → controlDid pinning (analogous to the SIOP
  // login path; the DIDComm rpDid here is the RP's controlDid).
  const pin = req.origin
    ? await checkOriginPin(req.origin, req.params.controlDid)
    : { firstSeen: true, rpDidChanged: false, pinnedRpDid: undefined };

  const consent: Parameters<typeof requestConsent>[0] = {
    origin: req.origin,
    rpDid: req.params.controlDid,
    holderDid,
  };
  if (pin.rpDidChanged && pin.pinnedRpDid) {
    consent.changedFromRpDid = pin.pinnedRpDid;
  }
  const approved = await gatedConsent(consent);
  if (!approved) return { ok: false, error: "login denied by user" };

  if (req.origin) {
    await pinOrigin(req.origin, req.params.controlDid);
  }

  // Same question as the REST path, same answer: a per-site persona signs the
  // auth documents when this origin has one. The transport stays the wallet's
  // own — the RP reads the caller off the document's proof, not off who
  // delivered it.
  const identity = await resolveLoginIdentity(req.origin, req.params.controlDid, holderDid);
  if (!identity.ok) return { ok: false, error: identity.error };

  await ensureOffscreenDocument();
  const active = await readActiveConnection();
  if (!active.ok) return { ok: false, error: active.error };
  const offscreenRequest: OffscreenDidcommLoginRequest = {
    target: OFFSCREEN_TARGET,
    type: OFFSCREEN_DIDCOMM_LOGIN,
    vtaDid: active.conn.vtaDid,
    params: req.params,
    ...(identity.entryId ? { entryId: identity.entryId } : {}),
    ...(active.conn.restBaseUrl ? { restBaseUrl: active.conn.restBaseUrl } : {}),
  };
  const result = (await chrome.runtime.sendMessage(offscreenRequest)) as RuntimeLoginResponse;

  if (!result.ok && identity.bound) {
    return {
      ok: false,
      error:
        `${result.error} — this was the first sign-in as ${identity.did}. ` +
        `If ${req.origin ?? "the site"} refused it, that identity needs to be on its access list.`,
    };
  }
  return result;
}

async function handleStepUpVta(
  req: RuntimeStepUpVtaRequest,
): Promise<RuntimeLoginResponse> {
  // Fast-fail without spinning up the offscreen document. Display-only DID
  // lookup — see handleLoginDidcomm for the background-vs-offscreen rationale.
  const holderDid = await readActiveHolderDid();
  if (!holderDid) return { ok: false, error: "no active VTA connection — connect first" };

  // NO consent prompt here. The step-up prompt fires mid-flow instead: the
  // offscreen fetches the RP `start` response, verifies the signed
  // approve-request (proof + enrolled-executor signer + issuer == rpDid), and
  // only then asks back via RUNTIME_STEP_UP_CONSENT — so the prompt can show
  // the human the VERIFIED `reason` from inside the signature. Prompting
  // before the fetch (the old shape) showed origin/rpDid only and left the
  // signed reason unread, which defeated the point of signing it (the spec's
  // rule is verify-BEFORE-surfacing, not verify-instead-of-surfacing).
  // Nothing is signed or sent unless that prompt approves.
  await ensureOffscreenDocument();
  const offscreenRequest: OffscreenStepUpVtaRequest = {
    target: OFFSCREEN_TARGET,
    type: OFFSCREEN_STEP_UP_VTA,
    params: req.params,
    origin: req.origin,
  };
  return (await chrome.runtime.sendMessage(offscreenRequest)) as RuntimeLoginResponse;
}

/** Longest RP-authored reason the consent prompt will carry. Anything past
 *  this is truncated with an ellipsis — the prompt is a decision surface, not
 *  a document viewer, and an unbounded string in a query param is asking for
 *  trouble. */
const MAX_STEP_UP_REASON_CHARS = 500;

/**
 * The offscreen's mid-flow step-up consent ask (RUNTIME_STEP_UP_CONSENT).
 * Reached only after the approve-request verified, so the `reason` shown here
 * is attributable to the proven issuer. Still routed through `gatedConsent`:
 * an origin the user ticked "remember this site" for keeps skipping the
 * prompt, exactly as the pre-#103 step-up prompt did — the reorder changes
 * *when* the prompt fires and *what it shows*, not who sees one.
 */
async function handleStepUpConsent(
  req: RuntimeStepUpConsentRequest,
): Promise<RuntimeStepUpConsentResponse> {
  // Untrusted-but-attributed prose: cap the length and strip control
  // characters (bidi overrides, escapes) that could visually reorder or hide
  // parts of what the human reads. React already renders it as plain text —
  // this guards the *legibility* of the string, not just its inertness.
  const cleaned = req.reason
    ?.replace(
      // eslint-disable-next-line no-control-regex -- stripping controls is the point
      /[\u0000-\u0008\u000B-\u001F\u007F\u200E\u200F\u202A-\u202E\u2066-\u2069]/g,
      "",
    )
    .trim();
  const reason =
    cleaned && cleaned.length > MAX_STEP_UP_REASON_CHARS
      ? `${cleaned.slice(0, MAX_STEP_UP_REASON_CHARS)}…`
      : cleaned;
  const approved = await gatedConsent({
    origin: req.origin,
    rpDid: req.rpDid,
    holderDid: req.holderDid,
    stepUp: true,
    ...(reason ? { reason } : {}),
  });
  return { approved };
}

// Page-facing authenticated fetches must never hang the requesting page against
// a blackholed / wedged VTA: bound every one with an abort timeout (R1.2). A
// stalled VTA then surfaces as a clean `{ ok: false, error }` (via the message
// dispatcher's `.catch`) instead of an `await` that never resolves — which also
// pins the MV3 worker awake and stacks further requests behind it.
const PROXY_FETCH_TIMEOUT_MS = 20_000;

/** Thrown when an egress point needs a host grant the user hasn't made.
 *  Carries the origin so the UI can name it in the prompt, and a stable
 *  `code` so callers match on it rather than on the message (R3.7). */
export class HostPermissionError extends Error {
  readonly code = HOST_PERMISSION_REQUIRED;
  constructor(readonly origin: string) {
    super(
      `access to ${displayHostFor(origin)} has not been granted — ` +
        `approve it in the wallet popup and retry`,
    );
    this.name = "HostPermissionError";
  }
}

async function proxyFetch(url: string, init: RequestInit): Promise<Response> {
  // Host grants are per-origin and requested just-in-time from a UI context
  // (host-permissions.ts). A service worker cannot prompt, so an ungranted
  // origin fails fast with a code the popup knows how to act on — rather
  // than as an opaque CORS failure 20 seconds later.
  if (!(await hasOriginPermission(url))) {
    throw new HostPermissionError(url);
  }
  try {
    return await fetch(url, {
      ...init,
      signal: AbortSignal.timeout(PROXY_FETCH_TIMEOUT_MS),
    });
  } catch (e) {
    if (e instanceof DOMException && e.name === "TimeoutError") {
      throw new Error(
        `request to ${url} timed out after ${PROXY_FETCH_TIMEOUT_MS / 1000}s ` +
          `(VTA unreachable or not responding)`,
      );
    }
    throw e;
  }
}

// An authenticated GET the wallet runs on a page's behalf. The service
// worker has host permissions, so this isn't subject to the page's
// cross-origin CORS restriction. Read-only, so no consent prompt.
async function handleApiGet(req: RuntimeApiGetRequest): Promise<RuntimeApiGetResponse> {
  const base = req.params.baseUrl.replace(/\/+$/, "");
  const res = await proxyFetch(base + req.params.path, {
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

// What the last session build observed per transport, for the wallet's own UI
// (Setup / Network panes). Unlike `handleMediatorStatus` this is not page
// facing — see the note on `RUNTIME_TRANSPORT_HEALTH`.
//
// Does NOT bring the offscreen document up. An observation only exists
// because a session was built, so starting the document to ask would always
// answer "nothing observed" while making the wallet do work; a wallet that
// has done nothing yet should simply say so.
async function handleTransportHealth(): Promise<RuntimeTransportHealthResponse> {
  try {
    const res = (await chrome.runtime.sendMessage({
      target: OFFSCREEN_TARGET,
      type: OFFSCREEN_TRANSPORT_HEALTH,
    })) as RuntimeTransportHealthResponse | undefined;
    return res ?? { ok: true, result: { byVta: {}, sessions: [] } };
  } catch {
    // No offscreen document listening yet — nothing has been observed.
    return { ok: true, result: { byVta: {}, sessions: [] } };
  }
}

// The connection self-test. Unlike `handleTransportHealth` this DOES bring the
// offscreen document up: the user asked for the checks to run, and running
// them is the point — there is no useful answer to give from the worker, which
// has neither the DID resolver nor the wallet's origin-governed fetch.
async function handleRunDiagnostics(
  req: RuntimeRunDiagnosticsRequest,
): Promise<RuntimeRunDiagnosticsResponse> {
  await ensureOffscreenDocument();
  return (await chrome.runtime.sendMessage({
    target: OFFSCREEN_TARGET,
    type: OFFSCREEN_RUN_DIAGNOSTICS,
    vtaDid: req.vtaDid,
  })) as RuntimeRunDiagnosticsResponse;
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
    ...(req.mediatorDid ? { mediatorDid: req.mediatorDid } : {}),
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
  const res = (await chrome.runtime.sendMessage({
    target: OFFSCREEN_TARGET,
    type: OFFSCREEN_UNLOCK_PRF,
    prfOutputB64u: req.prfOutputB64u,
  })) as RuntimeUnlockPrfResponse;
  // Re-arm any inbound listeners that failed during the locked-state
  // startup path. `startInbound`'s loadHolder call throws
  // WalletLockedError when the cache is empty; the catch just logs
  // and moves on, leaving the listener missing. Now that the cache is
  // warm we can retry — `startInboundListener` reconciles, opening
  // missing sessions without touching existing ones.
  if (res.ok) {
    void startInboundListener();
    // RP pages that hit `WalletLockedError` on an earlier request can
    // now retry — broadcast so they know the gap is over without
    // having to refresh the page.
    void broadcastWalletEvent("unlocked");
  }
  return res;
}

async function handleUnlockApprover(
  req: RuntimeUnlockApproverRequest,
): Promise<RuntimeUnlockApproverResponse> {
  await ensureOffscreenDocument();
  return (await chrome.runtime.sendMessage({
    target: OFFSCREEN_TARGET,
    type: OFFSCREEN_UNLOCK_APPROVER,
    prfOutputB64u: req.prfOutputB64u,
    vtaDid: req.vtaDid,
  })) as RuntimeUnlockApproverResponse;
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

/**
 * Follow each agent that has moved its relay.
 *
 * Distinct from the adopt-when-blank pass in `startInboundListener`, and for a
 * reason that only shows up when you ask how inbound actually arrives: **a v4
 * holder is a `did:key`, which carries no service endpoint, and the wallet
 * publishes its inbox to nobody.** There is no discovery path. So an executor
 * pushing to this wallet can only hand the message to a mediator it already
 * knows — its own — and the wallet hears it only if it is listening there. An
 * inbox is not an address the wallet owns; it is "wherever that agent's relay
 * is", and an agent pinned to yesterday's mediator goes dark while every check
 * still reports green.
 *
 * So an `agent`-sourced inbox FOLLOWS its agent's DID document. An
 * `operator`-sourced one never moves: someone running more than one relay
 * chose it, and that override is the whole reason provenance exists.
 *
 * Run on browser startup and on update, not per worker spin-up. MV3 respawns
 * the worker on almost any event, and a DID-document fetch per agent on each
 * would be a lot of network for a value that changes when someone redeploys a
 * mediator. The adopt-when-blank pass still runs every spin-up — it reads the
 * persisted connection and costs nothing.
 */
async function followAgentInbox(): Promise<void> {
  const vtaDids = await readAllVtaDids();
  if (vtaDids.length === 0) return;
  const settings = await getSettings();
  let moved = false;

  for (const vtaDid of vtaDids) {
    const held = inboxFor(settings, vtaDid);
    if (held?.source === "operator") continue; // pinned, deliberately

    let live: string | undefined;
    try {
      const resp = await handleRefreshVtaTransports({
        type: RUNTIME_REFRESH_VTA_TRANSPORTS,
        vtaDid,
      });
      if (!resp.ok) throw new Error(resp.error);
      live = resp.result.mediatorDid;
    } catch (e) {
      // A DID document we could not read says nothing about where the relay
      // is, so it must not be read as "it moved to nowhere". Keep what we have
      // — and keep going: one unreachable agent must not stop the others being
      // checked.
      console.warn("[pnm inbound] could not re-resolve the relay for", vtaDid, e);
      continue;
    }

    if (!live) {
      console.warn(
        "[pnm inbound]",
        vtaDid,
        "advertises no DIDComm relay — nothing can be pushed to this wallet through it.",
      );
      continue;
    }
    if (live === held?.did) continue;

    await setInbox(vtaDid, { did: live, source: "agent" });
    moved = true;
    console.info("[pnm inbound]", vtaDid, "moved its relay:", held?.did ?? "(none)", "→", live);
  }

  // One reconcile after the sweep, not one per agent: each call re-reads the
  // whole map and reopens what is missing, so doing it inside the loop would
  // repeat that work for every agent that moved.
  if (moved) await startInboundListener();
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

async function handleForgetHolderRecord(
  req: RuntimeForgetHolderRecordRequest,
): Promise<RuntimeForgetHolderRecordResponse> {
  await ensureOffscreenDocument();
  return (await chrome.runtime.sendMessage({
    target: OFFSCREEN_TARGET,
    type: OFFSCREEN_FORGET_HOLDER_RECORD,
    vtaDid: req.vtaDid,
  })) as RuntimeForgetHolderRecordResponse;
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

async function handleListDids(req: RuntimeListDidsRequest): Promise<RuntimeListDidsResponse> {
  const active = await readActiveConnection();
  if (!active.ok) return { ok: false, error: active.error };
  await ensureOffscreenDocument();
  return (await chrome.runtime.sendMessage({
    target: OFFSCREEN_TARGET,
    type: OFFSCREEN_LIST_DIDS,
    vtaDid: active.conn.vtaDid,
    restBaseUrl: active.conn.restBaseUrl,
    ...(req.contextId ? { contextId: req.contextId } : {}),
  })) as RuntimeListDidsResponse;
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

/**
 * The generic page → VTA task relay.
 *
 * The page proposes a type URI and a payload. That is all it proposes: the
 * envelope is minted in the offscreen, inside the device's trust boundary, and
 * stamped with the browser-attested origin. The wallet never counter-signs a
 * document the page wrote.
 *
 * ## Why this prompts every time, and offers no "remember"
 *
 * `gatedConsent` would be the obvious choice, and it is the wrong one. It
 * short-circuits on origin trust — and origin trust is not capability trust.
 *
 * Under a per-method surface, a "remember this site" tick meant "this site may
 * call `vaultList()` and `proxyLogin()`", because those were the only things it
 * could call. Under a *generic* relay it would mean "this site may ask my agent
 * to do anything at all", and a tick made once on a `vaultList()` prompt would
 * silently authorize a DID deactivation a year later. The set of things the
 * grant covers grew, without the user ever being asked about the new members.
 *
 * The VTA's policy engine is the real authority here, and when its `requireConsent`
 * fires, the approver gets a properly informed prompt showing what the task will
 * actually do. But `config.policy.enforcement` is **opt-in and defaults to off** —
 * so on a default deployment this prompt is the only thing standing between an
 * arbitrary page and an arbitrary task. It does not get to be skippable.
 *
 * The right long-term answer is scoped grants — `(origin, subject, typeGlob,
 * expiry)`, rememberable only for tasks the VTA classifies `sideEffects: none`.
 * Until those exist, ask.
 */
/** `https://trusttasks.org/spec/webvh/dids/update/1.0` → `webvh/dids/update`.
 *  A readable short label for prompt copy; falls back to the full URI. */
function taskLabel(typeUri: string): string {
  const m = /\/spec\/(.+)\/[\d.]+$/.exec(typeUri);
  return m?.[1] ?? typeUri;
}

async function handleRequestTask(
  req: RuntimeRequestTaskRequest,
): Promise<RuntimeRequestTaskResponse> {
  const active = await readActiveConnection();
  if (!active.ok) return { ok: false, error: active.error };

  // Worker-mode gate: the user consents to their agent *sending this request to
  // the VTA*, not to the change itself — that is the approver's job, on a
  // visibly different surface. The copy says "send … to your VTA" so it can't be
  // mistaken for the approval step, and the WORKER banner on the confirm popup
  // reinforces it. Kept un-skippable on purpose: with policy enforcement off this
  // is the only thing between an arbitrary page and an arbitrary task.
  //
  // The one exemption is the replay that *completes* a consent ceremony: same
  // origin, same params, already refused once with `consentRequired`, and a
  // matching grant since relayed. The human approved that exact payload here and
  // then again on the approving device — see `consent-replay.ts` for why asking
  // a third time costs more than it buys.
  const key = replayKey(req.origin, req.params);
  if (!consentReplays.consumeIfArmed(key)) {
    const approved = await requestConsent({
      origin: req.origin,
      action: `send a "${taskLabel(req.params.type)}" request to your VTA`,
      noRemember: true,
    });
    if (!approved.approved) return { ok: false, error: "user denied the request" };
  }

  await ensureOffscreenDocument();
  const res = (await chrome.runtime.sendMessage({
    target: OFFSCREEN_TARGET,
    type: OFFSCREEN_REQUEST_TASK,
    vtaDid: active.conn.vtaDid,
    restBaseUrl: active.conn.restBaseUrl,
    origin: req.origin,
    params: req.params,
  })) as RuntimeRequestTaskResponse;

  // A consent refusal is the only thing that arms a replay, and it carries the
  // VTA's own salted digest — the same value its `task-consent/granted` notice
  // will quote. Taking it from the wire rather than recomputing it is what keeps
  // a second implementation of that hash from existing here to drift.
  if (res.ok && res.result?.kind === "consentRequired") {
    const digest = res.result.payloadDigest;
    if (typeof digest === "string" && digest) consentReplays.recordConsentRequired(key, digest);
  }
  return res;
}

/**
 * True when this message came from one of the extension's own pages.
 *
 * `sender.id === chrome.runtime.id` — already checked for every message — does
 * NOT answer this: a content script is our script, injected into someone else's
 * page, and passes it. `sender.url` is set by the browser from the context the
 * message actually left, so an extension page reads
 * `chrome-extension://<id>/manager.html` while a content script reads the page
 * it is running in. That is the whole distinction, and it is not forgeable from
 * page content.
 *
 * Used to gate the management console's relay, which — unlike the page-facing
 * one — does not stop to ask a human before each task.
 */
function isExtensionPageSender(sender: chrome.runtime.MessageSender): boolean {
  const base = chrome.runtime.getURL("");
  return typeof sender.url === "string" && sender.url.startsWith(base);
}

/**
 * Run one administration task proposed by the management console.
 *
 * ## Why this does not prompt, when `handleRequestTask` always does
 *
 * That prompt exists because an arbitrary web page is proposing an arbitrary
 * task, and under a generic relay a remembered grant would mean "this site may
 * ask my agent to do anything at all". Neither half is true here: the caller is
 * an extension page the operator opened themselves, and there is no origin to
 * remember or to be wrong about. Prompting per call would also make the surface
 * unusable — a console reads a dozen lists to draw one screen, and a human who
 * clicks through twelve identical dialogs to see a page is not consenting to
 * anything, they are dismissing an obstacle.
 *
 * What still stands between the console and a destructive change: the agent's
 * own policy engine, which answers `requireConsent` as a `consentRequired`
 * outcome that the console renders as an approval ceremony rather than an
 * error; the agent's ACL, which is the only authority that decides whether this
 * caller may act at all; and the console's own preview-then-confirm on every
 * irreversible action, which shows the agent's account of what would be
 * destroyed rather than a generic "are you sure".
 *
 * The origin stamped into the task is this extension's own. That is the honest
 * answer — the console really is the caller — and it is what the agent's audit
 * trail will record.
 */
async function handleManagerTask(
  req: RuntimeManagerTaskRequest,
): Promise<RuntimeManagerTaskResponse> {
  const active = await readActiveConnection();
  if (!active.ok) return { ok: false, error: active.error };

  await ensureOffscreenDocument();
  // No `origin`. There is no proposing page — the operator is acting directly,
  // the same position a CLI is in — and `requestTask` is explicit that a caller
  // with no attested origin should omit it rather than invent one. Inventing
  // this extension's own put an `ext` member on every payload, which some agent
  // payload structs reject outright.
  return (await chrome.runtime.sendMessage({
    target: OFFSCREEN_TARGET,
    type: OFFSCREEN_REQUEST_TASK,
    vtaDid: active.conn.vtaDid,
    restBaseUrl: active.conn.restBaseUrl,
    params: req.params,
  })) as RuntimeManagerTaskResponse;
}

// Sign a Trust-Task envelope with the wallet's holder did:peer #key-2.
// Forward to the offscreen which loads the holder identity + calls the core
// `signTrustTask` helper.
//
// This is the most powerful method on the page-facing surface: it signs an
// *arbitrary* envelope with the holder key. It used to prompt for nothing and
// ignore the origin it was handed, on the reasoning that per-signature prompts
// would be crippling for normal RP usage (every ACL operation, etc.).
//
// The ergonomic point stands, but "don't prompt a site the user has connected"
// is not the same as "don't prompt anyone" — and as written, *any* page could
// ask for a signature over anything, which under a generic task relay is a
// straight bypass of the VTA's policy engine: why go through a gate that can
// require consent when you can ask the wallet to sign whatever you like?
//
// So: gate on the origin, which is now the browser-attested one. A site the user
// has already connected short-circuits inside `gatedConsent` and sees no prompt,
// preserving the ergonomics. Any other origin is asked, and is told which task
// type it is being asked to sign.
async function handleSignTrustTask(
  req: RuntimeSignTrustTaskRequest,
): Promise<RuntimeSignTrustTaskResponse> {
  const typeUri = (req.params.envelope as { type?: unknown } | undefined)?.type;
  const label = typeof typeUri === "string" ? typeUri : "an unidentified Trust Task";
  // `requestConsent`, NOT `gatedConsent`.
  //
  // `gatedConsent` short-circuits for a remembered origin and prompts for
  // nothing — which is fine for a login, whose "remember this site" grant means
  // "let this site log me in". It is not fine here. This method signs an
  // *arbitrary* envelope with the holder key, so a remember-grant that silenced
  // it would mean "let this site sign anything, forever" — a tick made once on a
  // login prompt authorizing a DID deactivation a year later.
  //
  // Origin trust is not capability trust. There is no envelope worth signing
  // unprompted, so this always asks, and offers no "remember".
  const approved = await requestConsent({
    origin: req.origin,
    ...(req.params.asDid ? { holderDid: req.params.asDid } : {}),
    action: `Sign ${label}`,
    noRemember: true,
  });
  if (!approved.approved) return { ok: false, error: "user denied signing" };

  await ensureOffscreenDocument();
  // Always include the active connection's restBaseUrl — the offscreen
  // only uses it on the `asDid` branch (which needs to call
  // `vault/sign-trust-task/0.1` against the VTA). On the holder-signed
  // path the restBaseUrl is harmless overhead.
  const active = await readActiveConnection();
  if (!active.ok) return { ok: false, error: active.error };
  return (await chrome.runtime.sendMessage({
    target: OFFSCREEN_TARGET,
    type: OFFSCREEN_SIGN_TRUST_TASK,
    vtaDid: active.conn.vtaDid,
    restBaseUrl: active.conn.restBaseUrl,
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

// Does the active VTA have an approver identity, and is its inbox open?
async function handleApproverState(): Promise<RuntimeApproverStateResponse> {
  const vtaDid = await readActiveVtaDid();
  // No active VTA means no approver to speak of — not an error, just nothing.
  if (!vtaDid) return { ok: true, result: { minted: false, running: false } };
  await ensureOffscreenDocument();
  return (await chrome.runtime.sendMessage({
    target: OFFSCREEN_TARGET,
    type: OFFSCREEN_APPROVER_STATE,
    vtaDid,
  })) as RuntimeApproverStateResponse;
}

/** How much of a stage-1 body to keep. The DID sits in the first line of a
 *  did:webvh log; anything larger than this is not an answer we understand,
 *  and reading it all would be an unbounded read of somebody else's server. */
const AGENT_NAME_BODY_LIMIT = 256 * 1024;

/** Stage 1 of agent-name resolution, in browser shape.
 *
 *  `Accept` lists JSON first and `text/html` last: a name server that content-
 *  negotiates properly answers a machine with JSON, while one that only knows
 *  "is this a browser?" — the webvh hosting service asks exactly that — sees
 *  `text/html` in the list and answers with an ordinary same-origin redirect to
 *  the DID's log. Both forms are readable here; the bare `did:` Location that
 *  neither header would shake loose is not.
 */
async function fetchAgentName(url: string): Promise<{
  status: number;
  url: string;
  body?: string;
}> {
  const shown = url.replace(/^https?:\/\//, "");
  let res: Response;
  try {
    // R1.2: every outbound fetch gets a timeout, applied where fetch is used
    // rather than left to the caller.
    res = await fetch(url, {
      method: "GET",
      headers: { Accept: "application/json, application/did+json;q=0.9, text/html;q=0.8" },
      redirect: "follow",
      signal: AbortSignal.timeout(15_000),
    });
  } catch (e) {
    // A `TypeError` here is indistinguishable between "host unreachable" and
    // "Chrome refused the did: redirect", so the message covers both and names
    // the way out — pasting the DID always works.
    throw new AgentNameError(
      AGENT_NAME_UNREADABLE,
      `Could not read ${shown}: ${e instanceof Error ? e.message : String(e)}. ` +
        `Either the name's server is unreachable, or it answered with a bare ` +
        `did: redirect, which a browser is not allowed to read — paste the full ` +
        `did:… instead.`,
    );
  }

  // Defence in depth: `redirect: "follow"` above should make this unreachable,
  // but an opaque redirect is a status-0 response with no headers and no body,
  // and silently reporting that as "HTTP 0, no DID" would blame the server.
  if (res.type === "opaqueredirect") {
    throw new AgentNameError(
      AGENT_NAME_UNREADABLE,
      `${shown} answered with a redirect the browser will not expose. ` +
        `Paste the full did:… instead.`,
    );
  }

  const body = await readCapped(res, AGENT_NAME_BODY_LIMIT);
  return { status: res.status, url: res.url || url, ...(body ? { body } : {}) };
}

/** Read at most `limit` characters, then hang up.
 *
 *  R1.2's foreign-fetch profile: this is a URL an outside party controls, so
 *  the cap has to be enforced *while* reading. `text()` then `slice()` would
 *  have downloaded the whole thing first, which is the same unbounded read
 *  wearing a cap. `content-length` is no substitute either — a server that
 *  omits it is exactly the one worth defending against. */
async function readCapped(res: Response, limit: number): Promise<string> {
  const reader = res.body?.getReader();
  // No body stream (a 304, or a stubbed Response in a test) — nothing to cap.
  if (!reader) return (await res.text()).slice(0, limit);
  const decoder = new TextDecoder();
  let out = "";
  try {
    while (out.length < limit) {
      const { done, value } = await reader.read();
      if (done) break;
      out += decoder.decode(value, { stream: true });
    }
  } finally {
    // Cancel rather than drain: an over-long body is one we have stopped
    // reading, and leaving the stream open holds the connection.
    await reader.cancel().catch(() => {});
  }
  return out.slice(0, limit);
}

/**
 * Turn an agent name into the DID it names.
 *
 * Runs here rather than in the popup because stage 1 is a cross-origin request
 * that needs the host permission, and because the DID it produces is fed
 * straight into DID resolution.
 *
 * **The redirect is followed, deliberately.** `redirect: "manual"` looks like
 * the right call — the `Location` header is the reference implementation's
 * answer — but a browser never gets to see that header: a manual redirect is
 * delivered as an opaque-redirect response with status 0 and no headers, and
 * when the target is a `did:` URI Chrome refuses the request outright down in
 * the network stack (`net::ERR_UNSAFE_REDIRECT`), which is where the raw
 * "Failed to fetch" this replaces came from. So we send a browser-shaped
 * `Accept`, let fetch follow whatever the server offers a browser, and read
 * the DID out of where it landed. See the long note in `agent-name.ts`.
 */
async function handleResolveAgentName(
  req: RuntimeResolveAgentNameRequest,
): Promise<RuntimeResolveAgentNameResponse> {
  try {
    const { did, name } = await resolveAgentName(req.name, {
      fetchName: fetchAgentName,
      resolveDid: async (did) => {
        const reply = await handleVerifyRpDid({ type: RUNTIME_VERIFY_RP_DID, did });
        if (!reply.ok) return { resolved: false, error: reply.error };
        return {
          resolved: reply.result.resolved,
          ...(reply.result.alsoKnownAs ? { alsoKnownAs: reply.result.alsoKnownAs } : {}),
          ...(reply.result.error ? { error: reply.result.error } : {}),
        };
      },
    });
    return { ok: true, result: { did, name: name.canonical } };
  } catch (e) {
    if (e instanceof AgentNameError) {
      return { ok: false, error: e.message, code: e.code };
    }
    throw e;
  }
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
// `restBaseUrl` is `""` for a DIDComm-only VTA (no #vta-rest advertised). The
// offscreen `getVtaSession` treats an empty base URL as "no REST" and resolves
// the transport (DIDComm) from the VTA's advertised services.
type VaultActive = { vtaDid: string; restBaseUrl: string };

async function readActiveConnection(): Promise<
  | { ok: true; conn: VaultActive }
  | { ok: false; error: string }
> {
  const connection = await readActiveConnectionRaw();
  if (!connection) {
    return { ok: false, error: "no active VTA connection — connect first" };
  }
  // A usable transport is REST *or* DIDComm — vault/context/dids tasks run over
  // whichever the VTA advertises, and the offscreen VtaSession prefers DIDComm.
  // (Previously this required #vta-rest, which wrongly blocked DIDComm-only VTAs.)
  if (!connection.restBaseUrl && !connection.mediatorDid) {
    return {
      ok: false,
      error: "active VTA advertises no usable transport (#vta-rest or #vta-didcomm)",
    };
  }
  return { ok: true, conn: { vtaDid: connection.vtaDid, restBaseUrl: connection.restBaseUrl ?? "" } };
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
// pipeline. Because the provider is injected into every page
// (`<all_urls>`), enumerating vault entries is gated behind an explicit
// user-consent prompt that names the requesting origin — otherwise any
// site could silently read the user's vault contents.
async function handleVaultListPage(
  req: RuntimeVaultListPageRequest,
): Promise<RuntimeVaultListResponse> {
  const approved = await gatedConsent({
    origin: req.origin,
    action: "See your wallet's vault entries",
    ...(req.params.targetDid ? { rpDid: req.params.targetDid } : {}),
  });
  if (!approved) return { ok: false, error: "vault list denied by user" };

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
  // `<all_urls>` injection means any page can invoke this. Minting a SIOP
  // id_token and signing in on the user's behalf is a privileged action,
  // so require explicit consent naming the requesting origin + target RP.
  const target = req.params.target as { kind?: string; did?: string } | undefined;
  const targetDid = target?.kind === "did" ? target.did : undefined;

  // Resolve the entry BEFORE prompting. Which prompt to raise depends on
  // whether this site already has a persona bound, and a page that calls this
  // with no VTA connected should fail without raising one at all.
  const resolved = await resolveProfileEntry(req.origin, req.params.entryId);
  if (!resolved.ok) return { ok: false, error: resolved.error };

  if (resolved.entryId) {
    const approved = await gatedConsent({
      origin: req.origin,
      action: "Sign in via your VTA (proxied SIOP)",
      ...(targetDid ? { rpDid: targetDid } : {}),
    });
    if (!approved) return { ok: false, error: "proxy-login denied by user" };
    return dispatchProxyLogin({ ...req.params, entryId: resolved.entryId });
  }

  // First sign-in at this site: nothing is bound yet, so the prompt also asks
  // which persona to use and we bind the answer.
  //
  // `requestConsent`, NOT `gatedConsent`. The trusted-origin short-circuit is
  // wrong here for the same reason it is wrong for task consent: a "remember
  // this site" tick made against an earlier sign-in meant "you may log me in as
  // the identity I already chose for you". It cannot mean "you may choose a new
  // identity for me and bind it silently" — that decision has never been put to
  // the operator, and binding a persona is the one thing this whole prompt
  // exists to ask about.
  const decision = await requestConsent({
    origin: req.origin,
    action: "Sign in via your VTA (proxied SIOP)",
    chooseProfile: true,
    ...(targetDid ? { rpDid: targetDid } : {}),
  });
  if (!decision.approved || !decision.selectedDid) {
    // An approval with no persona is not an approval of anything — the surface
    // cannot produce one (Approve is disabled until a persona is picked), so
    // this is either a denial or a malformed reply. Both deny.
    return { ok: false, error: "proxy-login denied by user" };
  }

  const bound = await bindProfileEntry(req.origin, decision.selectedDid, targetDid);
  if (!bound.ok) return { ok: false, error: bound.error };

  if (decision.remember) await trustOrigin(req.origin, targetDid);

  const result = await dispatchProxyLogin({ ...req.params, entryId: bound.entryId });
  if (!result.ok) {
    // The likeliest cause of a failure on the very first sign-in is the one
    // thing this wallet cannot fix: the relying party has never heard of this
    // persona. Say so, and name the DID — the prompt said this might happen,
    // and this is where the operator finds out it did. The entry is kept: it is
    // correct, and deleting it would make the retry-after-enrolment path ask
    // them to choose an identity all over again.
    return {
      ok: false,
      error:
        `${result.error} — this was the first sign-in as ${decision.selectedDid}. ` +
        `If ${req.origin} refused it, that identity needs to be on the site's access list.`,
    };
  }
  return result;
}

/**
 * Which persona this site knows the user as — resolve, or bind one.
 *
 * Split out of the sign-in because an RP whose `/auth/challenge` is bound to
 * the persona DID needs that DID *before* it can ask for a nonce, and so cannot
 * reach it through `proxyLogin` at all. The route it had was `vaultList()`,
 * which discloses every entry to answer a question about one.
 *
 * ## Two prompts on a first sign-in, and why that is the right number
 *
 * A page that binds and then signs in raises the picker here and the sign-in
 * consent in `handleVaultProxyLoginPage` — two decisions the first time, one
 * every time after. Folding the second into the first would mean this call,
 * which mints nothing and issues no session, silently pre-authorizing one that
 * does. First contact with a site is the place to ask twice; every later
 * sign-in is a single prompt, and the operator can still tick "remember".
 *
 * Nothing is minted here, and no session is issued. The result is a DID the
 * site is about to be told anyway, and the id of the entry holding it.
 */
async function handleWalletProfile(
  req: RuntimeWalletProfileRequest,
): Promise<RuntimeWalletProfileResponse> {
  const target = req.params.target as { kind?: string; did?: string } | undefined;
  const targetDid = target?.kind === "did" ? target.did : undefined;

  const resolved = await resolveProfileEntry(req.origin);
  if (!resolved.ok) return { ok: false, error: resolved.error };

  if (resolved.entryId) {
    // Already bound. No prompt: this discloses one DID, to the site that DID
    // exists for, which is about to receive it inside an id_token anyway. A
    // prompt here would be asking the operator to re-approve a decision they
    // already made, which is how prompts stop being read.
    const did = await principalDidFor(req.origin, resolved.entryId);
    if (!did.ok) return { ok: false, error: did.error };
    return { ok: true, result: { did: did.did, entryId: resolved.entryId, bound: false } };
  }

  // `requestConsent`, not `gatedConsent` — see handleVaultProxyLoginPage. A
  // remembered origin has consented to being signed in as an identity already
  // chosen, never to a new one being chosen for it.
  const decision = await requestConsent({
    origin: req.origin,
    action: "Choose the identity this site knows you as",
    chooseProfile: true,
    ...(targetDid ? { rpDid: targetDid } : {}),
  });
  if (!decision.approved || !decision.selectedDid) {
    return { ok: false, error: "identity selection denied by user" };
  }

  const bound = await bindProfileEntry(req.origin, decision.selectedDid, targetDid);
  if (!bound.ok) return { ok: false, error: bound.error };
  if (decision.remember) await trustOrigin(req.origin, targetDid);

  return {
    ok: true,
    result: { did: decision.selectedDid, entryId: bound.entryId, bound: true },
  };
}

/**
 * The persona DID an already-bound entry acts as.
 *
 * `principalDid` is maintainer-derived, so it is read back from the VTA rather
 * than reconstructed here: the wallet seals the secret and never sees it again,
 * and an entry whose secret was rotated at the VTA would otherwise report a DID
 * it no longer signs as.
 */
async function principalDidFor(
  origin: string,
  entryId: string,
): Promise<{ ok: true; did: string } | { ok: false; error: string }> {
  const listed = await handleVaultList({
    type: RUNTIME_VAULT_LIST,
    filter: { secretKind: PROFILE_SECRET_KIND, targetOriginPrefix: origin },
  });
  if (!listed.ok) return { ok: false, error: listed.error };
  const entry = listed.result.entries.find((e) => e.id === entryId);
  if (!entry?.principalDid) {
    // An entry with no principalDid cannot mint an id_token, so returning it
    // would hand the page a DID-shaped hole that fails at `/auth/challenge`
    // with nothing pointing back here.
    return { ok: false, error: `vault entry ${entryId} names no persona DID` };
  }
  return { ok: true, did: entry.principalDid };
}

/** Send a resolved proxy-login to the offscreen document, where the holder
 *  identity and the DIDComm unpacking live. */
async function dispatchProxyLogin(
  params: ProxyLoginParams & { entryId: string },
): Promise<RuntimeVaultProxyLoginResponse> {
  const c = await readActiveConnection();
  if (!c.ok) return { ok: false, error: c.error };
  await ensureOffscreenDocument();
  return (await chrome.runtime.sendMessage({
    target: OFFSCREEN_TARGET,
    type: OFFSCREEN_VAULT_PROXY_LOGIN,
    vtaDid: c.conn.vtaDid,
    restBaseUrl: c.conn.restBaseUrl,
    body: params,
  })) as RuntimeVaultProxyLoginResponse;
}

/**
 * Which vault entry a page-initiated proxy login should use.
 *
 * `suppliedEntryId` is honoured as-is — that is the pre-existing contract, and
 * an id the page holds came either from `vaultList()` (which had its own
 * consent prompt) or from `walletProfile()` (which handed back this site's own
 * entry). Otherwise the entry comes from the origin the *browser* attested,
 * never from anything the page said about itself.
 *
 * `entryId: undefined` with `ok: true` means "this site has no persona yet",
 * which is a first-use prompt, not an error.
 */
async function resolveProfileEntry(
  origin: string,
  suppliedEntryId?: string,
): Promise<{ ok: true; entryId?: string } | { ok: false; error: string }> {
  if (suppliedEntryId) return { ok: true, entryId: suppliedEntryId };

  const listed = await handleVaultList({
    type: RUNTIME_VAULT_LIST,
    // `targetOriginPrefix` narrows the set the VTA sends back; it does NOT
    // decide the answer. A prefix is not an origin — `https://example.com` is a
    // prefix of `https://example.com.evil.test` — so `matchProfileEntry` does
    // the actual match locally, with `===`, on the attested origin.
    filter: { secretKind: PROFILE_SECRET_KIND, targetOriginPrefix: origin },
  });
  if (!listed.ok) return { ok: false, error: listed.error };

  const match = matchProfileEntry(listed.result.entries, origin);
  return { ok: true, ...(match ? { entryId: match.id } : {}) };
}

/**
 * Bind the persona the operator picked to `origin`, as a vault entry.
 *
 * The prompt returns a DID string and nothing else. Everything the entry needs
 * beyond it — the context, the signing key — is re-derived here from the
 * agent's own answers, so a DID that is not one the agent hosts cannot be
 * bound no matter what the consent window sent back.
 */
async function bindProfileEntry(
  origin: string,
  did: string,
  rpDid: string | undefined,
): Promise<{ ok: true; entryId: string } | { ok: false; error: string }> {
  const dids = await handleListDids({ type: RUNTIME_LIST_DIDS });
  if (!dids.ok) return { ok: false, error: dids.error };
  const record = dids.result.dids.find((d) => d.did === did);
  if (!record) {
    return { ok: false, error: `${did} is not an identity this agent hosts` };
  }

  const derived = await handleDeriveSigningKeyId({ type: RUNTIME_DERIVE_SIGNING_KEY_ID, did });
  if (!derived.ok) return { ok: false, error: derived.error };
  if (derived.result.error) return { ok: false, error: derived.result.error };
  const candidates = derived.result.candidates;
  if (candidates.length !== 1) {
    // Zero: nothing in the document can sign, and an entry naming a key that
    // does not exist fails later, opaquely, at the VTA. More than one: which
    // key signs the id_token is a real choice with no default, and picking one
    // here would be the wallet guessing. Both send the operator to the vault
    // panel, which has the key picker this prompt deliberately does not.
    return {
      ok: false,
      error:
        candidates.length === 0
          ? `no signing key could be derived from ${did}`
          : `${did} has ${candidates.length} possible signing keys — bind it from the wallet's vault panel, which lets you choose one`,
    };
  }

  const upserted = await handleVaultUpsert({
    type: RUNTIME_VAULT_UPSERT,
    ...buildProfileEntry({
      origin,
      did,
      contextId: record.contextId,
      signingKeyId: candidates[0]!,
      ...(rpDid ? { rpDid } : {}),
    }),
  });
  if (!upserted.ok) return { ok: false, error: upserted.error };
  return { ok: true, entryId: upserted.result.entry.id };
}

// Authenticated POST proxied through the wallet (host permission → no CORS).
async function handleApiPost(req: RuntimeApiPostRequest): Promise<RuntimeApiGetResponse> {
  const base = req.params.baseUrl.replace(/\/+$/, "");
  const res = await proxyFetch(base + req.params.path, {
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


// ── Origin provenance helpers ────────────────────────────────────────────────

/**
 * Message types a *web page* can originate, via the content-script relay.
 *
 * For these — and only these — the origin is a security decision, so it must be
 * the browser's, not the body's. Extension-internal traffic (popup, options,
 * confirm window, offscreen) carries no page origin and is not listed.
 */
const PAGE_FACING_TYPES: ReadonlySet<string> = new Set(PAGE_FACING_RUNTIME_TYPES);


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

  // ── Origin provenance ──────────────────────────────────────────────────
  //
  // Every origin decision below — `isOriginTrusted`, `trustOrigin`,
  // `checkOriginPin`, `pinOrigin`, and what the consent prompt displays — used
  // to read `req.origin`, a field the *content script placed in the message
  // body*. The `sender.id` check above proves the message came from this
  // extension; it says nothing about which page it came from. Every content
  // script (the manifest injects into `<all_urls>`), the popup, the options
  // page, the confirm window and the offscreen document all pass it.
  //
  // So the body's `origin` was a claim, and `isOriginTrusted` honoured claims:
  // asserting `origin: "https://bank.example"` was enough to be handed a silent
  // bypass for a site the user had previously ticked "remember" on.
  //
  // `sender.origin` is supplied by the browser and cannot be forged by page
  // content. Take it, and overwrite whatever the body claimed — a page-facing
  // message with no tab behind it is an extension context impersonating a page
  // relay, and there is no legitimate caller for that.
  const msgType = (message as { type?: string })?.type;
  if (msgType && PAGE_FACING_TYPES.has(msgType)) {
    const attested = attestedOrigin(sender);
    if (!attested) {
      // eslint-disable-next-line no-console
      console.warn(
        `[background] rejecting page-facing ${msgType} with no browser-attested origin`,
      );
      sendResponse({ ok: false, error: "no attested origin" });
      return false;
    }
    (message as { origin?: string }).origin = attested;
  }

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

  if ((message as { type?: string })?.type === RUNTIME_RUN_DIAGNOSTICS) {
    handleRunDiagnostics(message as RuntimeRunDiagnosticsRequest)
      .then(sendResponse)
      .catch((e: unknown) =>
        sendResponse({ ok: false, error: e instanceof Error ? e.message : String(e) }),
      );
    return true; // async sendResponse
  }

  if ((message as { type?: string })?.type === RUNTIME_TRANSPORT_HEALTH) {
    handleTransportHealth()
      .then(sendResponse)
      .catch((e: unknown) =>
        sendResponse({ ok: false, error: e instanceof Error ? e.message : String(e) }),
      );
    return true; // async sendResponse
  }

  // The offscreen inbound listener can't reach `chrome.tabs`, so it asks us to
  // broadcast a wallet event to pages (e.g. `consentgranted`). Fire-and-forget.
  if ((message as { type?: string })?.type === RUNTIME_EMIT_WALLET_EVENT) {
    const m = message as { event: WalletEventKind; detail?: Record<string, unknown> };
    // A grant landed for a payload the approver signed off. Arm its one exempt
    // replay before the page is told, so the re-submit this event triggers does
    // not race the ledger. Only the offscreen inbound path emits this, and only
    // for a notice it accepted from an enrolled VTA.
    if (m.event === "consentgranted") {
      const digest = m.detail?.payloadDigest;
      if (typeof digest === "string" && digest) consentReplays.recordGranted(digest);
    }
    void broadcastWalletEvent(m.event, m.detail);
    return false;
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

  if ((message as { type?: string })?.type === RUNTIME_UNLOCK_APPROVER) {
    handleUnlockApprover(message as RuntimeUnlockApproverRequest)
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

  if ((message as { type?: string })?.type === RUNTIME_FORGET_HOLDER_RECORD) {
    handleForgetHolderRecord(message as RuntimeForgetHolderRecordRequest)
      .then(sendResponse)
      .catch((e: unknown) =>
        sendResponse({ ok: false, error: e instanceof Error ? e.message : String(e) }),
      );
    return true; // async sendResponse
  }

  if ((message as { type?: string })?.type === RUNTIME_RESTART_INBOX) {
    startInboundListener()
      .then(() => sendResponse({ ok: true }))
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

  if ((message as { type?: string })?.type === RUNTIME_LIST_DIDS) {
    handleListDids(message as RuntimeListDidsRequest)
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

  if ((message as { type?: string })?.type === RUNTIME_TASK_CONSENT) {
    const m = message as { request: TaskConsentRequestPayload; approver?: boolean };
    requestTaskConsent(m.request, m.approver === true)
      .then(sendResponse)
      .catch(() => sendResponse({ approved: false }));
    return true; // async sendResponse
  }

  if ((message as { type?: string })?.type === RUNTIME_STEP_UP_CONSENT) {
    handleStepUpConsent(message as RuntimeStepUpConsentRequest)
      .then(sendResponse)
      // Any failure to raise or resolve the prompt is a denial — silence is
      // not agreement, here as everywhere else in this file.
      .catch(() => sendResponse({ approved: false } satisfies RuntimeStepUpConsentResponse));
    return true; // async sendResponse
  }

  if ((message as { type?: string })?.type === RUNTIME_MANAGER_TASK) {
    // Extension pages only. A content script carries our extension id but not
    // our URL, and this relay does not stop to ask a human — so the gate is the
    // whole security boundary for the console's authority.
    if (!isExtensionPageSender(sender)) {
      // eslint-disable-next-line no-console
      console.warn(
        `[background] rejecting ${RUNTIME_MANAGER_TASK} from non-extension sender url=${sender.url}`,
      );
      sendResponse({ ok: false, error: "manager surface is not page-reachable" });
      return false;
    }
    handleManagerTask(message as RuntimeManagerTaskRequest)
      .then(sendResponse)
      .catch((e: unknown) =>
        sendResponse({ ok: false, error: e instanceof Error ? e.message : String(e) }),
      );
    return true; // async sendResponse
  }

  if ((message as { type?: string })?.type === RUNTIME_REQUEST_TASK) {
    handleRequestTask(message as RuntimeRequestTaskRequest)
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

  if ((message as { type?: string })?.type === RUNTIME_WALLET_PROFILE) {
    handleWalletProfile(message as RuntimeWalletProfileRequest)
      .then(sendResponse)
      .catch((e: unknown) =>
        sendResponse({ ok: false, error: e instanceof Error ? e.message : String(e) }),
      );
    return true; // async sendResponse
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
    // Tell open RP pages the wallet just went locked — any cached
    // session expecting the wallet to sign should be cleared.
    void broadcastWalletEvent("locked");
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

  if ((message as { type?: string })?.type === RUNTIME_APPROVER_STATE) {
    handleApproverState()
      .then(sendResponse)
      .catch((e: unknown) =>
        sendResponse({ ok: false, error: e instanceof Error ? e.message : String(e) }),
      );
    return true; // async sendResponse
  }

  if ((message as { type?: string })?.type === RUNTIME_RESOLVE_AGENT_NAME) {
    handleResolveAgentName(message as RuntimeResolveAgentNameRequest)
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

  if ((message as { type?: string })?.type === RUNTIME_CONSENT_RESULT) {
    const { consentId, approved, remember, prfOutputB64u, selectedDid } =
      message as RuntimeConsentResult;
    pendingConsents.get(consentId)?.(approved, !!remember, prfOutputB64u, selectedDid);
    return false;
  }

  return false;
});

export {};
