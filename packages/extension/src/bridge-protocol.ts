// Wire protocol for the RP-page ↔ wallet login bridge.
//
// Three execution contexts are involved:
//   1. page world      — the RP's own JS + our injected `provider.ts`
//      (`window.vtaWallet`). Talks to (2) via `window.postMessage`.
//   2. content world    — `content.ts` (isolated content script). Relays
//      between (1) and (3). Talks to (3) via `chrome.runtime.sendMessage`.
//   3. service worker  — `background.ts`. Runs the SIOPv2 login.
//
// page ↔ content messages are tagged with `source` so we ignore the
// page's unrelated `postMessage` traffic. Each request carries a `id`
// the provider uses to correlate the eventual response.

/** `source` on messages the injected provider posts toward the content script. */
export const INPAGE_SOURCE = "vta-wallet/inpage" as const;
/** `source` on messages the content script posts back toward the provider. */
export const CONTENT_SOURCE = "vta-wallet/content" as const;

/** RP-callable wallet methods. `login` = REST SIOPv2; `loginDidcomm` =
 *  DIDComm authcrypt-sender auth; `stepUpVta` = VTA-approval step-up;
 *  `apiGet` = authenticated GET proxied through the wallet (avoids the
 *  page's cross-origin CORS block). */
export type BridgeMethod =
  | "login"
  | "loginDidcomm"
  | "stepUpVta"
  | "apiGet"
  | "apiPost"
  | "mediatorStatus"
  | "walletDefaults"
  | "signTrustTask"
  | "proxyLogin"
  | "vaultList"
  | "requestTask";

/** Parameters for `window.vtaWallet.login(...)` (REST SIOPv2). */
export interface LoginParams {
  /** The RP's identifier (its server DID) — becomes the `id_token` `aud`. */
  rpDid: string;
  /** Base URL of the RP's auth API, e.g. `https://admin.webvh.storm.ws/api`.
   *  Supplied by the RP because the API host need not match the DID's
   *  domain (did:webvh domain ≠ admin host). */
  baseUrl: string;
}

/** Parameters for `window.vtaWallet.loginDidcomm(...)` (DIDComm transport). */
export interface DidcommLoginParams {
  /** The RP's control DID — authcrypt recipient + the DID the RP ACL-checks. */
  controlDid: string;
  /** The RP's mediator DID (from the control DID's DIDCommMessaging service). */
  mediatorDid: string;
}

/** Parameters for `window.vtaWallet.stepUpVta(...)` (VTA-approval step-up).
 *  Elevates an existing `aal1` session (its `accessToken`) to `aal2`. */
export interface StepUpVtaParams {
  /** Base URL of the RP's auth API (same one used for the base login). */
  baseUrl: string;
  /** The RP's DID — bound into the approval the VTA signs. */
  rpDid: string;
  /** The existing `aal1` session access token to elevate. */
  accessToken: string;
  /** The holder's VTA DID — approves the step-up over DIDComm. */
  vtaDid: string;
  /** The VTA's mediator DID (for the forward envelope). */
  vtaMediatorDid: string;
}

/** Parameters for `window.vtaWallet.apiGet(...)` — an authenticated GET the
 *  wallet performs on the page's behalf (it has host permissions, so it
 *  isn't subject to the page's cross-origin CORS restriction). */
export interface ApiGetParams {
  /** Base URL of the API (e.g. `https://admin.webvh.storm.ws/api`). */
  baseUrl: string;
  /** Path appended to `baseUrl`, e.g. `/auth/step-up/check`. */
  path: string;
  /** Bearer token sent in the `Authorization` header. */
  accessToken: string;
}

/** Result of `apiGet`/`apiPost` — the raw status + parsed/raw body. */
export interface ApiGetResult {
  status: number;
  body: unknown;
}

/** Parameters for `window.vtaWallet.apiPost(...)` — an authenticated POST the
 *  wallet performs on the page's behalf (not subject to the page's CORS). */
export interface ApiPostParams {
  baseUrl: string;
  path: string;
  accessToken: string;
  /** JSON request body. */
  body: unknown;
}

/** Per-mediator warm-session connection state, for status display. */
export type MediatorConnectionState = "connecting" | "live" | "closed";

/** Result of `window.vtaWallet.mediatorStatus()` — the wallet's current
 *  warm mediator sessions and their connection state. Lets a demo/RP show
 *  whether the DIDComm transport is already connected. */
export interface MediatorStatusResult {
  mediators: { mediatorDid: string; state: MediatorConnectionState }[];
}

/** Result of `window.vtaWallet.walletDefaults()` — operator-configured
 *  defaults a page can prefill (e.g. the step-up VTA). */
export interface WalletDefaultsResult {
  stepUpVtaDid?: string;
  stepUpVtaMediatorDid?: string;
}

/** Parameters for `window.vtaWallet.signTrustTask(...)`. */
export interface SignTrustTaskParams {
  /** The unsigned Trust-Task envelope. The wallet adds an `eddsa-jcs-2022`
   *  Data Integrity proof and returns the resulting envelope as
   *  `signedEnvelope`. The caller is responsible for setting `recipient`
   *  (audience binding) before calling.
   *
   *  Default signer is the wallet's holder DID. To sign as a different
   *  principal — typically after a `vault/proxy-login` session where the
   *  RP authenticated the session as a vault entry's `principalDid` —
   *  set `asDid` and ensure `envelope.issuer === asDid`. The wallet
   *  routes via `vault/sign-trust-task/0.1` so the long-term signing
   *  key never leaves the VTA, and the proof's `verificationMethod`
   *  matches the authenticated session DID at the RP. */
  envelope: Record<string, unknown>;
  /** Optional principal DID to sign as. When set, the wallet looks up
   *  a vault entry whose `principalDid === asDid` (must be a
   *  `did-self-issued` or `didcomm-peer` entry) and asks the VTA to
   *  sign via `vault/sign-trust-task/0.1`. When omitted, the wallet
   *  signs with the holder DID (the existing default). */
  asDid?: string;
}

/** Result of `window.vtaWallet.signTrustTask(...)`. */
export interface SignTrustTaskResult {
  /** The envelope with `proof` attached. */
  signedEnvelope: Record<string, unknown>;
  /** The wallet's holder DID — the `iss`-equivalent for the proof. The
   *  caller can use this to attribute the request (matches the JWT.sub for
   *  a wallet-authenticated session). */
  holderDid: string;
}

/** Result handed back to the RP page on a successful login. */
export interface LoginResult {
  accessToken: string;
  refreshToken: string;
  sessionId: string;
  /** The wallet holder DID — surfaced so the operator can ACL-grant it. */
  holderDid: string;
  /** Per-phase timings (ms) of the auth flow, for the demo to display. */
  timings?: { label: string; ms: number }[];
}

/** provider → content (page world → content world). */
export interface InpageRequest {
  source: typeof INPAGE_SOURCE;
  id: string;
  method: BridgeMethod;
  params:
    | LoginParams
    | DidcommLoginParams
    | StepUpVtaParams
    | ApiGetParams
    | ApiPostParams
    | ProxyLoginParams
    | VaultListParams;
}

/** content → provider (content world → page world). `result` is untyped
 *  wire data — each provider method casts to its own result type. */
export type ContentResponse =
  | { source: typeof CONTENT_SOURCE; id: string; ok: true; result: unknown }
  | { source: typeof CONTENT_SOURCE; id: string; ok: false; error: string };

/** Wallet lifecycle event names broadcast from background → content
 *  script → page-world provider → dispatched as `vtawallet:<kind>`
 *  window events. RP pages opt in by listening; the wallet doesn't
 *  require any RP handler to function.
 *
 *  - `ready`     — content script just loaded (fresh page, or fresh
 *                  extension after a reload). RP can retry any
 *                  wallet calls that failed during the gap.
 *  - `unlocked`  — the operator just unlocked an encrypted wallet via
 *                  the popup. Pages that hit `WalletLockedError`
 *                  earlier can retry.
 *  - `locked`    — the operator clicked Lock or the wallet auto-
 *                  locked (browser restart). Pages should clear any
 *                  cached session expecting the wallet to sign.
 *  - `connectionchanged` — the active VTA changed (operator
 *                  switched VTAs, forgot a VTA, or onboarded a new
 *                  one). RP-pinned login state may now refer to a
 *                  different holder DID.
 *  - `disconnected` — the wallet is going away (extension reload /
 *                  uninstall). Surfaced as a best-effort signal from
 *                  the content script's `chrome.runtime.connect`
 *                  port `onDisconnect`. Not always observable. */
export type WalletEventKind =
  | "ready"
  | "unlocked"
  | "locked"
  | "connectionchanged"
  | "disconnected"
  /** A task the page proposed has been approved and a grant is ready — the page
   *  can re-submit at once instead of polling. `detail: { payloadDigest }`. */
  | "consentgranted";

/** content → provider broadcast. Re-dispatched by the provider as
 *  `window.dispatchEvent(new CustomEvent("vtawallet:" + kind, ...))`. */
export interface ContentBroadcast {
  source: typeof CONTENT_SOURCE;
  /** Distinguishes from `ContentResponse` (which has `id`). */
  kind: "event";
  event: WalletEventKind;
  /** Optional event payload — currently unused; reserved for future
   *  payloads like `{ vtaDid }` on connectionchanged. */
  detail?: Record<string, unknown>;
}

// ─── content ↔ background (chrome.runtime messaging) ───

/** background → content broadcast (not a request/response pair). The
 *  content script forwards to its page-world provider as a
 *  `ContentBroadcast` window message. */
export const RUNTIME_BROADCAST_EVENT = "vta-wallet/broadcast-event" as const;

export interface RuntimeBroadcastEvent {
  type: typeof RUNTIME_BROADCAST_EVENT;
  event: WalletEventKind;
  detail?: Record<string, unknown>;
}

/** offscreen → background: ask the background to broadcast a wallet event to
 *  pages. The inbound mediator listener lives in the offscreen document, which
 *  has no `chrome.tabs` access, so it delegates the page broadcast to the
 *  background (which owns [`broadcastWalletEvent`]). */
export const RUNTIME_EMIT_WALLET_EVENT = "vta-wallet/emit-wallet-event" as const;

export interface RuntimeEmitWalletEvent {
  type: typeof RUNTIME_EMIT_WALLET_EVENT;
  event: WalletEventKind;
  detail?: Record<string, unknown>;
}

export const RUNTIME_LOGIN = "vta-wallet/login" as const;
export const RUNTIME_LOGIN_DIDCOMM = "vta-wallet/login-didcomm" as const;
export const RUNTIME_STEP_UP_VTA = "vta-wallet/step-up-vta" as const;
export const RUNTIME_API_GET = "vta-wallet/api-get" as const;
export const RUNTIME_API_POST = "vta-wallet/api-post" as const;
export const RUNTIME_MEDIATOR_STATUS = "vta-wallet/mediator-status" as const;
export const RUNTIME_WALLET_DEFAULTS = "vta-wallet/wallet-defaults" as const;
export const RUNTIME_SIGN_TRUST_TASK = "vta-wallet/sign-trust-task" as const;
/** page → background: propose a Trust Task for the VTA to execute.
 *
 *  The generic relay. Unlike {@link RUNTIME_SIGN_TRUST_TASK}, the page supplies
 *  only a type URI and a payload — the device mints the envelope and stamps the
 *  attested origin, so the wallet never attests to a document the page wrote. */
export const RUNTIME_REQUEST_TASK = "vta-wallet/request-task" as const;

export const RUNTIME_CONSENT_RESULT = "vta-wallet/consent-result" as const;
/** offscreen → background: an inbound RP confirm request needs user consent. */
export const RUNTIME_INBOUND_CONSENT = "vta-wallet/inbound-consent" as const;
/** offscreen → background: an inbound, VTA-signed `task-consent/request` needs a
 *  human. Distinct from {@link RUNTIME_INBOUND_CONSENT} because the surface is
 *  different in kind: it renders executor-authored effects, it is never
 *  short-circuited by origin trust (the VTA is asking, not a site), and its
 *  approval is single-use so there is nothing to remember. */
export const RUNTIME_TASK_CONSENT = "vta-wallet/task-consent" as const;
/** confirm popup → background → offscreen: resolve + verify an RP DID so the
 *  consent prompt can render a verification badge. Reply via sendResponse is a
 *  [`VerifyDidResult`]. */
export const RUNTIME_VERIFY_RP_DID = "vta-wallet/verify-rp-did" as const;

/** popup → background → offscreen: flush the WebAuthn-PRF
 *  derived key cache. The next holder-load that needs the key
 *  re-prompts the operator for their authenticator. */
export const RUNTIME_LOCK_WALLET = "vta-wallet/lock-wallet" as const;

export interface RuntimeLockWalletRequest {
  type: typeof RUNTIME_LOCK_WALLET;
}

export interface RuntimeLockWalletResponse {
  ok: boolean;
  error?: string;
}

/** offscreen → background: prompt the user to approve an inbound RP confirm.
 *  Reply via `sendResponse` is `{ approved: boolean }`. */
export interface RuntimeInboundConsentRequest {
  type: typeof RUNTIME_INBOUND_CONSENT;
  /** The requesting RP's DID (authcrypt-authenticated). */
  rpDid: string;
  /** Human-readable action being confirmed (shown in the prompt). */
  action: string;
  /** Optional RP display name. */
  rpName?: string;
}

/** content → background: perform a REST SIOPv2 login for the calling page. */
export interface RuntimeLoginRequest {
  type: typeof RUNTIME_LOGIN;
  params: LoginParams;
  /** The RP page's origin — shown in the consent prompt, never trusted as auth. */
  origin: string;
}

/** content → background: perform a DIDComm login for the calling page. */
export interface RuntimeLoginDidcommRequest {
  type: typeof RUNTIME_LOGIN_DIDCOMM;
  params: DidcommLoginParams;
  origin: string;
}

/** content → background: perform a VTA-approval step-up for the calling page. */
export interface RuntimeStepUpVtaRequest {
  type: typeof RUNTIME_STEP_UP_VTA;
  params: StepUpVtaParams;
  origin: string;
}

/** content → background: an authenticated GET proxied through the wallet. */
export interface RuntimeApiGetRequest {
  type: typeof RUNTIME_API_GET;
  params: ApiGetParams;
  origin: string;
}

/** content → background: an authenticated POST proxied through the wallet. */
export interface RuntimeApiPostRequest {
  type: typeof RUNTIME_API_POST;
  params: ApiPostParams;
  origin: string;
}

/** content → background: query the wallet's warm mediator-session status. */
export interface RuntimeMediatorStatusRequest {
  type: typeof RUNTIME_MEDIATOR_STATUS;
}

/** background → content for `mediatorStatus` (sendResponse). */
export type RuntimeMediatorStatusResponse =
  | { ok: true; result: MediatorStatusResult }
  | { ok: false; error: string };

/** content → background: query operator-configured wallet defaults. */
export interface RuntimeWalletDefaultsRequest {
  type: typeof RUNTIME_WALLET_DEFAULTS;
}

/** background → content for `walletDefaults` (sendResponse). */
export type RuntimeWalletDefaultsResponse =
  | { ok: true; result: WalletDefaultsResult }
  | { ok: false; error: string };

/** content → background: sign a Trust-Task envelope with the holder did:peer. */
export interface RuntimeSignTrustTaskRequest {
  type: typeof RUNTIME_SIGN_TRUST_TASK;
  params: SignTrustTaskParams;
  origin: string;
}

export type RuntimeSignTrustTaskResponse =
  | { ok: true; result: SignTrustTaskResult }
  | { ok: false; error: string };

/** background → content (sendResponse). */
export type RuntimeLoginResponse =
  | { ok: true; result: LoginResult }
  | { ok: false; error: string };

/** background → content for an `apiGet` (sendResponse). */
export type RuntimeApiGetResponse =
  | { ok: true; result: ApiGetResult }
  | { ok: false; error: string };

/** consent window → background: the user's approve/deny decision. */
export interface RuntimeConsentResult {
  type: typeof RUNTIME_CONSENT_RESULT;
  /** Correlates with the pending consent the background is awaiting. */
  consentId: string;
  approved: boolean;
  /** When approved with the "Remember this site" box ticked, the background
   *  persists a trust record so this origin's future calls skip the popup. */
  remember?: boolean;
  /** Approver surface only: the base64url PRF output from the per-decision
   *  biometric. It unwraps the approver key for exactly one signature, so the
   *  same-browser relay can sign the decision without a pre-unlocked session.
   *  Never sent for a denial, and never cached. */
  prfOutputB64u?: string;
}

/** confirm popup → background: resolve + verify an RP DID. */
export interface RuntimeVerifyRpDidRequest {
  type: typeof RUNTIME_VERIFY_RP_DID;
  did: string;
}

/** Result the popup renders as a verification badge. Mirrors the core
 *  `VerifyDidResult` shape but inlined here so the bridge protocol does not
 *  depend on `@openvtc/pnm-core` types directly. */
export interface VerifyRpDidResult {
  did: string;
  method: "webvh" | "peer" | "key" | "unknown";
  resolved: boolean;
  domain?: string;
  error?: string;
}

export type RuntimeVerifyRpDidResponse =
  | { ok: true; result: VerifyRpDidResult }
  | { ok: false; error: string };

// ─── Onboarding (popup → background → offscreen) ───
// Connect the wallet to a VTA via the ephemeral-did:key → swap-acl flow:
// PREPARE resolves the VTA's transports + mints an ephemeral did:key the
// operator grants; CONNECT authenticates as that ephemeral and swaps the ACL
// entry onto the wallet's holder did:peer.

export const RUNTIME_ONBOARD_PREPARE = "vta-wallet/onboard-prepare" as const;
export const RUNTIME_ONBOARD_CONNECT = "vta-wallet/onboard-connect" as const;
export const RUNTIME_HOLDER_STATE = "vta-wallet/holder-state" as const;

/** popup → background: resolve a VTA DID + mint the ephemeral to be granted. */
export interface RuntimeOnboardPrepareRequest {
  type: typeof RUNTIME_ONBOARD_PREPARE;
  vtaDid: string;
}

export interface OnboardPrepareResult {
  /** The ephemeral did:key the operator must grant. */
  ephemeralDid: string;
  /** The verbatim command the operator should run to grant it. */
  command: string;
  /** The VTA's mediator DID, if it advertises DIDComm. */
  mediatorDid?: string;
  /** The VTA's REST base URL, if it advertises REST. */
  restBaseUrl?: string;
}

export type RuntimeOnboardPrepareResponse =
  | { ok: true; result: OnboardPrepareResult }
  | { ok: false; error: string };

/** popup → background: finish onboarding — connect as the granted ephemeral,
 *  run the provision-integration flow, and adopt the VTA-minted DID as the
 *  wallet's v4 holder identity. */
export interface RuntimeOnboardConnectRequest {
  type: typeof RUNTIME_ONBOARD_CONNECT;
  /** Maintainer context override. **Optional** — when omitted (the
   *  default popup path: "Use VTA-derived context"), the wallet sends
   *  no `context` field on the wire and the VTA infers the target
   *  context from the relayer's ACL grant or its own contexts state.
   *  Operators with multi-context VTAs can override via the popup's
   *  "Specify context" toggle. */
  context?: string;
  /** When `true`, the wallet asks the VTA to provision the override
   *  context inline if it doesn't yet exist. Only meaningful when
   *  `context` is also set (auto-create against an inferred default
   *  doesn't make sense). Requires the ephemeral's grant to carry
   *  super-admin role; the popup hints this in its UI. */
  createIfMissing?: boolean;
}

export interface OnboardConnectResult {
  /** The wallet's holder DID the ACL entry was swapped onto. */
  holderDid: string;
  /** The role the new entry carries (inherited from the ephemeral grant). */
  role: string;
  /** `true` when the holder Ed25519 seed was persisted under PRF-derived
   *  AES-GCM (the new default for fresh installs). `false` when the
   *  wallet fell back to plaintext storage — either because the
   *  operator opted out via the settings page, or because the PRF
   *  wrap declined (no platform support / operator dismissed the
   *  authenticator prompt). The popup surfaces the distinction so an
   *  unexpected fallback doesn't go unnoticed. */
  secretEncrypted: boolean;
}

export type RuntimeOnboardConnectResponse =
  | { ok: true; result: OnboardConnectResult }
  | {
      ok: false;
      error: string;
      /** When the failure was a DIDComm problem-report from the VTA, the
       *  structured code (e.g. `provision/integration:context_required`).
       *  The popup branches on this to surface recovery UX — picker
       *  dialogs, retry hints — rather than just dumping the message. */
      code?: string;
      /** Problem-report `args` payload. Task-specific structure. For
       *  `context_required` this is the candidates list the operator
       *  picks from. */
      candidates?: string[];
    };

/** popup → background: inspect the wallet's persisted holder state.
 *
 *  Used by the popup on mount to decide which view to show — a v3 record
 *  (pre-M2C identity migration) needs to be flagged so the operator
 *  re-onboards rather than landing in a half-broken connected view. */
export interface RuntimeHolderStateRequest {
  type: typeof RUNTIME_HOLDER_STATE;
}

/** Mirror of `holderIdentityState` from @openvtc/pnm-core. For v4 records the
 *  `wrapAlgorithm` field tells the popup whether the holder secret is
 *  encrypted at rest — `"passthrough"` means plaintext, anything else
 *  (currently only `"webauthn-prf-aes-gcm"`) means the popup needs to
 *  run an unlock ceremony before offscreen ops can load the holder. */
export type HolderStateInfo =
  | { kind: "none" }
  | { kind: "v3"; did: string }
  | { kind: "v4"; did: string; vtaDid: string; wrapAlgorithm: string };

/** popup → background: pipe a freshly-derived PRF output to offscreen
 *  so the AES key lands in offscreen's `cachedKey` slot. After this,
 *  subsequent `loadHolder` calls in offscreen succeed without
 *  prompting the operator.
 *
 *  Architectural reason: `navigator.credentials.get` requires a
 *  visible, focused context with a live user gesture. The popup
 *  has both during the unlock-button click; offscreen is hidden,
 *  so credentials.get from there hangs forever. The popup runs the
 *  ceremony locally + relays the result via this bridge message. */
export const RUNTIME_UNLOCK_PRF = "vta-wallet/unlock-prf" as const;

export interface RuntimeUnlockPrfRequest {
  type: typeof RUNTIME_UNLOCK_PRF;
  /** Raw PRF output from the popup's `navigator.credentials.get`
   *  assertion, encoded as base64url-no-pad.
   *
   *  `chrome.runtime.sendMessage` serialises payloads as JSON, which
   *  turns a `Uint8Array` into `{ "0": n, "1": n, … }` on the
   *  receiving side — an `instanceof Uint8Array` check fails there.
   *  Encoding to base64url on the wire dodges the round-trip mangling
   *  and keeps the payload compact (~44 chars for the typical 32-byte
   *  PRF output). The offscreen handler decodes back to Uint8Array
   *  before feeding `WebAuthnPrfSecretWrap.seedCachedKeyFromPrfOutput`.
   *
   *  Sensitive — they're the AES key root for this session. See
   *  `WebAuthnPrfSecretWrap.seedCachedKeyFromPrfOutput` for the
   *  trust-boundary analysis. */
  prfOutputB64u: string;
}

export type RuntimeUnlockPrfResponse =
  | { ok: true }
  | { ok: false; error: string };

/** popup → background: unlock the **approver** identity for a VTA and bring up
 *  its inbox session. Same popup-runs-WebAuthn / offscreen-holds-the-key split
 *  as `RUNTIME_UNLOCK_PRF`, but for the approver key (its own KEK domain) and
 *  scoped to one VTA. After this, the approver receives `task-consent/request`s
 *  addressed to its DID and can sign decisions. */
export const RUNTIME_UNLOCK_APPROVER = "vta-wallet/unlock-approver" as const;

export interface RuntimeUnlockApproverRequest {
  type: typeof RUNTIME_UNLOCK_APPROVER;
  /** base64url PRF output from the popup's assertion (see `prfOutputB64u`
   *  on `RuntimeUnlockPrfRequest` for the encoding/trust rationale). */
  prfOutputB64u: string;
  /** The VTA whose approver identity to unlock. */
  vtaDid: string;
}

export type RuntimeUnlockApproverResponse =
  | { ok: true; approverDid: string }
  | { ok: false; error: string };

/** popup → background: query whether the wallet is currently locked.
 *
 *  The "locked" state is only meaningful for v4 records wrapped under
 *  PRF; a passthrough record never needs an unlock. Response shape:
 *
 *    `encrypted: false` → wallet is plaintext; no unlock needed
 *    `encrypted: true, unlocked: false` → operator must run the
 *       unlock ceremony before ops will work
 *    `encrypted: true, unlocked: true` → cached key in offscreen,
 *       ops work
 *
 *  The popup uses this on mount to decide whether to render the
 *  UnlockView. */
export const RUNTIME_WALLET_LOCK_STATE = "vta-wallet/lock-state" as const;

export interface RuntimeWalletLockStateRequest {
  type: typeof RUNTIME_WALLET_LOCK_STATE;
  /** Which VTA's record to inspect. Optional — when absent, returns
   *  the aggregate ("any v4 record exists" mode), used by the popup
   *  before an active VTA is known. Multi-VTA: pass the active
   *  vtaDid so the UnlockView correctly fires when THE active
   *  record is PRF-wrapped. */
  vtaDid?: string;
}

export type RuntimeWalletLockStateResponse =
  | { ok: true; result: { encrypted: boolean; unlocked: boolean } }
  | { ok: false; error: string };

/** popup → background: re-resolve the VTA's currently-advertised
 *  transports (REST `#vta-rest` + DIDComm `#vta-didcomm`) by re-fetching
 *  the DID document.
 *
 *  Onboarding bakes `restBaseUrl` + `mediatorDid` into the persisted
 *  `connection` slot once at first connect. A VTA that later disables
 *  one transport (`pnm services rest disable` / `services didcomm
 *  disable`) leaves the plugin's cached endpoint stale — subsequent
 *  ops keep trying the dead path. The popup calls this on mount /
 *  connection-change so the cached transports stay aligned with what
 *  the VTA currently advertises.
 *
 *  Returns whichever of REST / DIDComm the document carries (possibly
 *  both, possibly one, possibly neither — in the last case the wallet
 *  surfaces a clear error rather than silently doing nothing). The
 *  popup compares against the persisted connection and updates the
 *  zustand slot when they drift. */
/** popup → background: delete the holder record for a specific VTA
 *  from IndexedDB. Companion to the connection store's `forgetVta`
 *  action: forgetVta removes the entry from the persisted connection
 *  map, but the v4 holder record (the encrypted Ed25519 seed + DID +
 *  vtaUrl) lives in IndexedDB, which the popup can't reach from the
 *  visible context — it's offscreen-owned. This bridge call routes
 *  the delete through. */
export const RUNTIME_FORGET_HOLDER_RECORD = "vta-wallet/forget-holder-record" as const;

export interface RuntimeForgetHolderRecordRequest {
  type: typeof RUNTIME_FORGET_HOLDER_RECORD;
  vtaDid: string;
}

export type RuntimeForgetHolderRecordResponse =
  | { ok: true }
  | { ok: false; error: string };

export const RUNTIME_REFRESH_VTA_TRANSPORTS = "vta-wallet/refresh-vta-transports" as const;

export interface RuntimeRefreshVtaTransportsRequest {
  type: typeof RUNTIME_REFRESH_VTA_TRANSPORTS;
  vtaDid: string;
}

export interface VtaTransportsView {
  /** REST base URL, present iff the VTA's DID doc carries a
   *  `#vta-rest` service entry. */
  restBaseUrl?: string;
  /** Mediator DID, present iff the VTA's DID doc carries a
   *  `#vta-didcomm` (or generic `DIDCommMessaging`) service entry. */
  mediatorDid?: string;
  /** Mediator DID, present iff the VTA's DID doc carries a `#tsp`
   *  (`TSPTransport`) service entry. */
  tspMediatorDid?: string;
}

export type RuntimeRefreshVtaTransportsResponse =
  | { ok: true; result: VtaTransportsView }
  | { ok: false; error: string };

/** popup → background: list the contexts the wallet's holder has
 *  access to at the connected VTA. Used by the AddEntryForm to
 *  populate the context dropdown with the real list (not just the
 *  contexts already seen on loaded vault entries). */
export const RUNTIME_LIST_CONTEXTS = "vta-wallet/list-contexts" as const;

export interface RuntimeListContextsRequest {
  type: typeof RUNTIME_LIST_CONTEXTS;
}

/** One context record as surfaced to the popup. Subset of
 *  `vta-sdk::protocols::context_management::CreateContextResultBody`
 *  — the popup only needs `id` + `name` to render the dropdown, so
 *  the bridge stays minimal. */
export interface ContextRecordView {
  id: string;
  name: string;
}

export type RuntimeListContextsResponse =
  | { ok: true; result: { contexts: ContextRecordView[] } }
  | { ok: false; error: string };

/** popup → background: create a new context at the connected VTA.
 *  Requires the wallet's holder to be a super-admin; context-admins
 *  surface as Forbidden. Used by AddEntryForm's "+ New context…"
 *  inline-create path. */
export const RUNTIME_CREATE_CONTEXT = "vta-wallet/create-context" as const;

export interface RuntimeCreateContextRequest {
  type: typeof RUNTIME_CREATE_CONTEXT;
  /** Context id — the short slug operators reference (e.g. `work`). */
  id: string;
  /** Human-readable name. Defaults to `id` if omitted. */
  name?: string;
  /** Optional free-form description. */
  description?: string;
}

export type RuntimeCreateContextResponse =
  | { ok: true; result: ContextRecordView }
  | { ok: false; error: string };

/** popup → background: list the webvh DIDs the connected VTA hosts in a
 *  context. Used by AddEntryForm's `did-self-issued` flow to populate the
 *  Persona-DID dropdown — these are the personas the VTA can mint a SIOP
 *  id_token AS (it holds their signing keys). */
export const RUNTIME_LIST_DIDS = "vta-wallet/list-dids" as const;

export interface RuntimeListDidsRequest {
  type: typeof RUNTIME_LIST_DIDS;
  /** Restrict to one context. Omit for every DID the holder can see. */
  contextId?: string;
}

/** One hosted DID as surfaced to the popup. Subset of
 *  `vta-sdk::webvh::WebvhDidRecord` — the dropdown only needs the DID
 *  and its context. */
export interface DidRecordView {
  did: string;
  contextId: string;
}

export type RuntimeListDidsResponse =
  | { ok: true; result: { dids: DidRecordView[] } }
  | { ok: false; error: string };

/** popup → background: resolve a DID and surface plausible signing
 *  verification-method ids. Used by AddEntryForm's `did-self-issued`
 *  flow to auto-fill `signingKeyId` from `principalDid`.
 *
 *  did:key is derived locally (lexical); did:peer / did:webvh / did:web
 *  resolve through the wallet's DID resolver. Multi-key DIDs return
 *  every candidate; the popup shows a picker when `candidates.length > 1`. */
export const RUNTIME_DERIVE_SIGNING_KEY_ID = "vta-wallet/derive-signing-key-id" as const;

export interface RuntimeDeriveSigningKeyIdRequest {
  type: typeof RUNTIME_DERIVE_SIGNING_KEY_ID;
  /** Principal DID to resolve. */
  did: string;
}

export type RuntimeDeriveSigningKeyIdResponse =
  | {
      ok: true;
      result: {
        did: string;
        /** Empty when resolution failed — `error` carries the reason. */
        candidates: string[];
        error?: string;
      };
    }
  | { ok: false; error: string };

export type RuntimeHolderStateResponse =
  | { ok: true; result: HolderStateInfo }
  | { ok: false; error: string };

// ─── Vault (popup → background → offscreen) ───
// M1 read-only surface: enumerate the connected VTA's vault entries (metadata
// only — no secret material). Authenticates via the same /auth/challenge +
// authcrypt /auth/ flow the onboarding swap uses, then POSTs the canonical
// vault/list/0.1 Trust Task envelope to the VTA dispatcher.

export const RUNTIME_VAULT_LIST = "vta-wallet/vault-list" as const;

export interface RuntimeVaultListRequest {
  type: typeof RUNTIME_VAULT_LIST;
  /** AND-combined filters; omit fields to broaden the result set. */
  filter?: VaultListFilter;
}

/** Metadata view of a vault entry. Mirrors `@openvtc/pnm-core`'s `VaultEntry` type;
 *  duplicated here to avoid pulling the core package into the bridge protocol
 *  declarations (it's transport metadata, not behaviour). */
export interface VaultEntryView {
  id: string;
  contextId: string;
  targets: Array<
    | { kind: "webOrigin"; origin: string }
    | { kind: "did"; did: string }
    | { kind: "iosApp"; bundleId: string; teamId?: string }
    | { kind: "androidApp"; packageName: string; sha256CertFingerprints: string[] }
  >;
  label: string;
  secretKind: string;
  tags?: string[];
  notes?: string;
  favicon?: string;
  expiresAt?: string;
  breachedAt?: string;
  passwordChangedAt?: string;
  createdAt: string;
  updatedAt: string;
  lastUsedAt?: string;
  version: number;
  /** Cached DID the entry acts AS for DID-shaped flows. Mirrors the
   *  `did` field of `did-self-issued` / `didcomm-peer` secrets;
   *  absent for kinds without a DID concept. Maintainer-derived. */
  principalDid?: string;
}

export interface VaultListFilter {
  contextId?: string;
  targetOriginPrefix?: string;
  targetDid?: string;
  targetIosBundleId?: string;
  targetAndroidPackage?: string;
  secretKind?: string;
  tag?: string;
  usedSince?: string;
  neverUsed?: boolean;
  expiresBefore?: string;
  breached?: boolean;
  pageSize?: number;
}

export interface VaultListResultView {
  entries: VaultEntryView[];
  truncated: boolean;
}

export type RuntimeVaultListResponse =
  | { ok: true; result: VaultListResultView }
  | { ok: false; error: string };

// ─── Vault write surface (M2A.5) — upsert, delete, release ───
//
// Same active-connection lookup as RUNTIME_VAULT_LIST. The popup
// constructs the request shape; the offscreen handler resolves the VTA's
// keyAgreement + loads the holder identity (the secret-sealing primitives
// need the holder's private X25519, which lives only in offscreen).

export const RUNTIME_VAULT_UPSERT = "vta-wallet/vault-upsert" as const;
export const RUNTIME_VAULT_DELETE = "vta-wallet/vault-delete" as const;
export const RUNTIME_VAULT_RELEASE = "vta-wallet/vault-release" as const;
/** popup → background: vault/proxy-login/0.1. The VTA logs into the
 *  entry's bound third party on the holder's behalf and returns a
 *  short-lived SessionBlob (cookies / headers); the long-term secret
 *  never leaves the VTA. */
export const RUNTIME_VAULT_PROXY_LOGIN = "vta-wallet/vault-proxy-login" as const;
/** content-script (relayed from page world) → background: same op as
 *  the popup's `RUNTIME_VAULT_PROXY_LOGIN`, but the request arrives
 *  wrapped in `{ params }` per the page-bridge convention. The
 *  background unwraps and reuses the popup's offscreen pipeline. The
 *  page-initiated entry-point exists so an RP page can call
 *  `window.vtaWallet.proxyLogin(...)` directly for VTA-proxied SIOP
 *  flows (M2B.4). */
export const RUNTIME_VAULT_PROXY_LOGIN_PAGE =
  "vta-wallet/vault-proxy-login-page" as const;
/** content-script (relayed from page world) → background: enumerate
 *  vault entries via `vault/list/0.1`. Same op as the popup's
 *  `RUNTIME_VAULT_LIST`, but the request arrives wrapped in
 *  `{ params }` per the page-bridge convention. M2B.4 surfaces this
 *  to RP pages so they can discover did-self-issued entries pinned to
 *  their DID before driving a proxy-login. No client-side origin
 *  pinning is enforced today — same trust model as the existing
 *  `window.vtaWallet.login()`; origin-pinned filtering lands with M3
 *  policy. */
export const RUNTIME_VAULT_LIST_PAGE = "vta-wallet/vault-list-page" as const;
/** popup → background: inject the cookies from a SessionBlob into the
 *  user's browser cookie jar for the bound origin (M2B.5). Used after
 *  a successful Password POST proxy-login — the wallet has a list of
 *  cookies the third party set in response to the credentialed POST,
 *  and they get written into Chrome's cookie store for the bound
 *  origin so the user can navigate there and be logged in. */
export const RUNTIME_INJECT_COOKIES = "vta-wallet/inject-cookies" as const;

/** Loose secret shape over the bridge — keeps the protocol decoupled
 *  from @openvtc/pnm-core's narrowed enum. Matches the canonical
 *  vault/_shared/0.1/vault-secret discriminator (`kind: password |
 *  passkey | oauth-tokens | bearer-token | custom | ...`); the
 *  offscreen handler casts to @openvtc/pnm-core's VaultSecret at the @openvtc/pnm-core
 *  boundary. */
export interface VaultSecretView {
  kind: string;
  username?: string;
  password?: string;
  /** Optional driver config on Password-kind entries — instructs the
   *  VTA to POST these credentials at a specific URL during
   *  vault/proxy-login/0.1. Mirrors `vault/_shared/0.1/vault-secret#/$defs/PasswordLoginConfig`.
   *  When absent, proxy-login returns `not_proxyable` and the
   *  consumer falls back to vault/release. */
  loginConfig?: {
    loginUrl: string;
    format?: "json" | "formUrlencoded";
    usernameField?: string;
    passwordField?: string;
    totpField?: string;
    extraFields?: Record<string, string>;
    successStatus?: number[];
  };
  credentialId?: string;
  privateKey?: string;
  algorithm?: string;
  rpId?: string;
  userHandle?: string;
  /** did-self-issued / didcomm-peer: the persona DID the entry will
   *  act AS during SIOPv2 / DIDComm flows. */
  did?: string;
  /** Variant of `did` for `didcomm-peer` entries. */
  peerDid?: string;
  /** did-self-issued / didcomm-peer: id of the key the VTA uses to
   *  sign the resulting id_token / DIDComm message. Must reference a
   *  key the VTA can resolve via its keystore (typically
   *  `<did>#key-0`). */
  signingKeyId?: string;
  provider?: string;
  refreshToken?: string;
  accessToken?: string;
  accessTokenExpiresAt?: string;
  scopes?: string[];
  token?: string;
  headerName?: string;
  headerPrefix?: string;
  fields?: Array<{ name: string; value: string; hidden?: boolean; kind?: string }>;
  secureNotes?: string;
}

export interface RuntimeVaultUpsertRequest {
  type: typeof RUNTIME_VAULT_UPSERT;
  id?: string;
  expectedVersion?: number;
  contextId: string;
  targets: VaultEntryView["targets"];
  label: string;
  secretKind: string;
  tags?: string[];
  notes?: string;
  favicon?: string;
  selectors?: string[];
  customFieldNames?: string[];
  expiresAt?: string;
  secret?: VaultSecretView;
  clearFields?: Array<
    "notes" | "favicon" | "expiresAt" | "tags" | "selectors" | "customFieldNames"
  >;
}

export interface VaultUpsertResultView {
  entry: VaultEntryView;
  created: boolean;
}

export type RuntimeVaultUpsertResponse =
  | { ok: true; result: VaultUpsertResultView }
  | { ok: false; error: string };

export interface RuntimeVaultDeleteRequest {
  type: typeof RUNTIME_VAULT_DELETE;
  id: string;
  expectedVersion?: number;
  reason?: string;
}

export interface VaultDeleteResultView {
  id: string;
  deletedAt: string;
  graceUntil: string;
}

export type RuntimeVaultDeleteResponse =
  | { ok: true; result: VaultDeleteResultView }
  | { ok: false; error: string };

export interface RuntimeVaultReleaseRequest {
  type: typeof RUNTIME_VAULT_RELEASE;
  entryId: string;
  ttlSecondsHint?: number;
}

export interface VaultReleaseResultView {
  /** Cleartext secret bytes. Caller MUST schedule a wipe at `ttlSeconds`
   *  after receipt — popup typically uses a setTimeout. */
  secret: VaultSecretView;
  secretKind: string;
  ttlSeconds: number;
}

export type RuntimeVaultReleaseResponse =
  | { ok: true; result: VaultReleaseResultView }
  | { ok: false; error: string };

/** Loose SessionBlob shape over the bridge — keeps the protocol
 *  decoupled from @openvtc/pnm-core's narrowed types. Mirrors the canonical
 *  `vault/_shared/0.1/session-blob` schema. The offscreen handler
 *  casts to @openvtc/pnm-core's `SessionBlob` at the boundary. */
export interface SessionBlobView {
  sessionId: string;
  /** RFC 3339. Popup MUST schedule a wipe at this instant. */
  expiresAt: string;
  cookies?: Array<{
    name: string;
    value: string;
    domain: string;
    path: string;
    expires?: string;
    secure?: boolean;
    httpOnly?: boolean;
    sameSite?: "Strict" | "Lax" | "None";
  }>;
  headers?: Array<{ name: string; value: string }>;
  localStorage?: Array<{ key: string; value: string }>;
  sessionStorage?: Array<{ key: string; value: string }>;
  bindOrigin?: string;
  refreshHint?: "maintainerOnly" | "on401" | "beforeExpiry";
}

export interface RuntimeVaultProxyLoginRequest {
  type: typeof RUNTIME_VAULT_PROXY_LOGIN;
  entryId: string;
  /** When the entry has multiple targets, names which one to log in
   *  against. Same loose shape as `VaultEntryView["targets"][number]`. */
  target?: VaultEntryView["targets"][number];
  /** Caller-supplied nonce — embedded verbatim by the maintainer as the
   *  SIOP id_token's `nonce` claim. The canonical use is threading the
   *  RP's `/auth/challenge` so the id_token passes the RP's nonce check.
   *  Bounded `[1, 512]` chars server-side; longer values fail
   *  validation. */
  nonce?: string;
  /** Caller-supplied TTL ceiling in seconds; capped server-side. */
  ttlSecondsHint?: number;
}

export interface VaultProxyLoginResultView {
  sessionBlob: SessionBlobView;
  sessionId: string;
  expiresAt: string;
}

export type RuntimeVaultProxyLoginResponse =
  | { ok: true; result: VaultProxyLoginResultView }
  | { ok: false; error: string };

/** Params shape the page-world provider posts to the content script
 *  for `window.vtaWallet.proxyLogin(...)`. Mirrors the popup's
 *  request body — the content script + background unwrap `params`
 *  and reuse the same offscreen pipeline. */
export interface ProxyLoginParams {
  entryId: string;
  target?: VaultEntryView["targets"][number];
  /** Caller-supplied nonce — typically the value the RP returned
   *  from its `/auth/challenge` endpoint, which the page threads
   *  through so the resulting SIOP id_token's `nonce` claim matches
   *  the RP's expected value. */
  nonce?: string;
  ttlSecondsHint?: number;
}

export interface RuntimeVaultProxyLoginPageRequest {
  type: typeof RUNTIME_VAULT_PROXY_LOGIN_PAGE;
  params: ProxyLoginParams;
  /** The origin of the page that initiated the call — captured by the
   *  content script via `window.location.origin`. The background uses
   *  this for future consent-prompt + origin-pinning checks; M2B.4
   *  records it but doesn't gate on it yet (hardening lands in M3
   *  policy alongside the rest of the policy-driven gates). */
  origin: string;
}

/** Page-world params for `window.vtaWallet.vaultList(...)`. A subset
 *  of the popup's `VaultListFilter` — the page typically wants
 *  entries pinned to a specific DID or origin. */
export interface VaultListParams {
  /** Filter to entries with at least one DID target matching. The
   *  M2B.4 demo's typical usage: a page representing
   *  `did:webvh:<rp>` asks for entries pinned to it. */
  targetDid?: string;
  /** Filter to entries with at least one web-origin target whose URI
   *  starts with this prefix. */
  targetOriginPrefix?: string;
  /** Filter to a specific secret kind (e.g. `"didSelfIssued"`). */
  secretKind?: string;
}

export interface RuntimeVaultListPageRequest {
  type: typeof RUNTIME_VAULT_LIST_PAGE;
  params: VaultListParams;
  origin: string;
}

export interface RuntimeInjectCookiesRequest {
  type: typeof RUNTIME_INJECT_COOKIES;
  /** Bound origin from the SessionBlob — used to derive the URL each
   *  cookie is written under. Per RFC 6265 §5.3, `chrome.cookies.set`
   *  requires a URL parameter so it can scope the cookie to a real
   *  host + scheme; the bound origin gives us both. */
  bindOrigin: string;
  /** Cookies harvested from the third-party login response. Shape
   *  mirrors the SessionBlob's CookieJarEntry view from
   *  `vault/_shared/0.1/session-blob`. */
  cookies: SessionBlobView["cookies"];
}

export interface InjectCookiesResultView {
  /** Number of cookies actually written to the cookie jar. May be
   *  less than the input length if some failed (e.g. malformed
   *  domain). Failures get warn-logged at the background. */
  injected: number;
  /** Number of cookies the maintainer asked us to inject. */
  total: number;
  /** The URL `chrome.cookies.set` was invoked with — useful for the
   *  popup's "Open site" link after injection. */
  bindOrigin: string;
}

export type RuntimeInjectCookiesResponse =
  | { ok: true; result: InjectCookiesResultView }
  | { ok: false; error: string };

// ─── background ↔ offscreen document ───
//
// The DIDComm login runs in an offscreen document, not the service worker:
// it resolves `did:webvh` DIDs (didwebvh-ts) and opens a mediator session,
// which need dynamic `import()` and a DOM — both forbidden in an MV3 service
// worker. Messages are tagged `target: "offscreen"` so the background's own
// runtime listener ignores them.

export const OFFSCREEN_TARGET = "offscreen" as const;
export const OFFSCREEN_DIDCOMM_LOGIN = "offscreen/didcomm-login" as const;
export const OFFSCREEN_STEP_UP_VTA = "offscreen/step-up-vta" as const;
/** background → offscreen: flush the WebAuthn-PRF derived key
 *  cache in the offscreen JS context. Fire-and-forget. */
export const OFFSCREEN_LOCK_WALLET = "offscreen/lock-wallet" as const;
/** background → offscreen: open the persistent inbound mediator session that
 *  listens for RP-initiated confirm requests. Fire-and-forget. */
export const OFFSCREEN_START_INBOUND = "offscreen/start-inbound" as const;
/** background → offscreen: report the warm mediator-session status. Reply is
 *  a [`MediatorStatusResult`] via `sendResponse`. */
export const OFFSCREEN_GET_STATUS = "offscreen/get-status" as const;
/** background → offscreen: resolve a VTA + mint the ephemeral to be granted. */
export const OFFSCREEN_ONBOARD_PREPARE = "offscreen/onboard-prepare" as const;
/** background → offscreen: connect as the granted ephemeral and run the
 *  provision-integration round-trip; on success the VTA-minted DID is
 *  persisted as the wallet's v4 holder identity. */
export const OFFSCREEN_ONBOARD_CONNECT = "offscreen/onboard-connect" as const;
/** background → offscreen: inspect the wallet's persisted holder state.
 *  Returns `{ kind: "none" | "v3" | "v4", ... }`. Used by the popup on
 *  mount to detect a pre-M2C v3 record and prompt re-onboarding. */
export const OFFSCREEN_HOLDER_STATE = "offscreen/holder-state" as const;
/** background → offscreen: seed the in-memory AES cache from a
 *  popup-derived PRF output. Body: `{ prfOutput: Uint8Array }`. */
export const OFFSCREEN_UNLOCK_PRF = "offscreen/unlock-prf" as const;

export interface OffscreenUnlockPrfRequest {
  target: typeof OFFSCREEN_TARGET;
  type: typeof OFFSCREEN_UNLOCK_PRF;
  /** Mirror of `RuntimeUnlockPrfRequest.prfOutputB64u` — base64url-
   *  no-pad of the PRF output bytes. See that field's docblock for
   *  why this goes over the wire as a string rather than a
   *  `Uint8Array`. */
  prfOutputB64u: string;
}

/** background → offscreen: unlock the approver identity for `vtaDid` from a
 *  popup-derived PRF output and start its inbox session. */
export const OFFSCREEN_UNLOCK_APPROVER = "offscreen/unlock-approver" as const;

export interface OffscreenUnlockApproverRequest {
  target: typeof OFFSCREEN_TARGET;
  type: typeof OFFSCREEN_UNLOCK_APPROVER;
  /** base64url-no-pad of the PRF output bytes (see `OffscreenUnlockPrfRequest`). */
  prfOutputB64u: string;
  vtaDid: string;
}

/** background → offscreen: delete a per-VTA holder record from
 *  IndexedDB. Mirrors `RUNTIME_FORGET_HOLDER_RECORD`. */
export const OFFSCREEN_FORGET_HOLDER_RECORD = "offscreen/forget-holder-record" as const;

export interface OffscreenForgetHolderRecordRequest {
  target: typeof OFFSCREEN_TARGET;
  type: typeof OFFSCREEN_FORGET_HOLDER_RECORD;
  vtaDid: string;
}

/** background → offscreen: query the cached-key + holder shape so
 *  the popup can decide between OnboardView / UnlockView /
 *  ConnectedView. */
export const OFFSCREEN_WALLET_LOCK_STATE = "offscreen/lock-state" as const;
/** background → offscreen: re-resolve the VTA's DID document and
 *  return its currently-advertised transports. Mirrors the
 *  `RUNTIME_REFRESH_VTA_TRANSPORTS` popup-facing message. */
export const OFFSCREEN_REFRESH_VTA_TRANSPORTS = "offscreen/refresh-vta-transports" as const;

export interface OffscreenRefreshVtaTransportsRequest {
  target: typeof OFFSCREEN_TARGET;
  type: typeof OFFSCREEN_REFRESH_VTA_TRANSPORTS;
  vtaDid: string;
}
/** background → offscreen: list contexts visible to the holder. */
export const OFFSCREEN_LIST_CONTEXTS = "offscreen/list-contexts" as const;
/** background → offscreen: list the VTA's hosted webvh DIDs, optionally
 *  scoped to one context. Backs the Persona-DID dropdown. */
export const OFFSCREEN_LIST_DIDS = "offscreen/list-dids" as const;
/** background → offscreen: create a new context (super-admin only). */
export const OFFSCREEN_CREATE_CONTEXT = "offscreen/create-context" as const;
/** background → offscreen: derive signing-key id candidates from a DID.
 *  Local for did:key; resolves over the network for did:web/did:webvh. */
export const OFFSCREEN_DERIVE_SIGNING_KEY_ID = "offscreen/derive-signing-key-id" as const;

export interface OffscreenCreateContextRequest {
  target: typeof OFFSCREEN_TARGET;
  type: typeof OFFSCREEN_CREATE_CONTEXT;
  id: string;
  name?: string;
  description?: string;
}

export interface OffscreenDeriveSigningKeyIdRequest {
  target: typeof OFFSCREEN_TARGET;
  type: typeof OFFSCREEN_DERIVE_SIGNING_KEY_ID;
  did: string;
}
/** background → offscreen: convey a push WakeHandle to the active VTA via
 *  `device/set-wake/0.1`. The handle was obtained from the gateway by the
 *  service worker (`push/register`); set-wake needs the holder identity +
 *  authcrypt, which only exist in offscreen. Reply is an
 *  `OffscreenSetWakeResponse` via sendResponse. */
export const OFFSCREEN_SET_WAKE = "offscreen/set-wake" as const;

export interface OffscreenSetWakeRequest {
  target: typeof OFFSCREEN_TARGET;
  type: typeof OFFSCREEN_SET_WAKE;
  vtaDid: string;
  restBaseUrl: string;
  /** The opaque gateway-issued handle to convey. Omit to clear the channel. */
  wakeHandle?: { gateway: string; handle: string };
  /** Advisory platform hint (device/list visibility only). */
  pushPlatform?: "apns" | "fcm" | "webpush";
  /** Advisory trigger DIDs (e.g. the device's mediator); the VTA owns the policy. */
  suggestedTriggers?: string[];
}

export interface OffscreenSetWakeResponse {
  ok: boolean;
  error?: string;
  result?: { pushCapable: boolean; triggerPolicy?: { allowedTriggers: string[] } };
}

/** background → offscreen: sign a Trust-Task envelope with the holder did:peer.
 *  Reply is a [`SignTrustTaskResult`] (or `{error}`) via sendResponse. */
export const OFFSCREEN_SIGN_TRUST_TASK = "offscreen/sign-trust-task" as const;
/** background → offscreen: resolve + verify a DID (used by the consent
 *  prompt's verification badge). Reply is a [`VerifyRpDidResult`] via
 *  sendResponse. */
export const OFFSCREEN_VERIFY_DID = "offscreen/verify-did" as const;
/** background → offscreen: enumerate the connected VTA's vault entries.
 *  Loads the holder identity in offscreen (has DOM for WebAuthn-PRF unwrap),
 *  authenticates over REST + DIDComm-authcrypt, posts the canonical
 *  vault/list/0.1 envelope. Reply is a `RuntimeVaultListResponse`'s payload
 *  via sendResponse. */
export const OFFSCREEN_VAULT_LIST = "offscreen/vault-list" as const;
export const OFFSCREEN_REQUEST_TASK = "offscreen/request-task" as const;

export interface OffscreenVaultListRequest {
  target: typeof OFFSCREEN_TARGET;
  type: typeof OFFSCREEN_VAULT_LIST;
  vtaDid: string;
  restBaseUrl: string;
  filter?: VaultListFilter;
}

/** background → offscreen: vault/upsert/0.1. Holder X25519 lives in
 *  offscreen, so the authcrypt sealing of the secret happens there. */
export const OFFSCREEN_VAULT_UPSERT = "offscreen/vault-upsert" as const;

export interface OffscreenVaultUpsertRequest {
  target: typeof OFFSCREEN_TARGET;
  type: typeof OFFSCREEN_VAULT_UPSERT;
  vtaDid: string;
  restBaseUrl: string;
  /** Same shape as RuntimeVaultUpsertRequest minus the `type` tag. */
  body: Omit<RuntimeVaultUpsertRequest, "type">;
}

/** background → offscreen: vault/delete/0.1. */
export const OFFSCREEN_VAULT_DELETE = "offscreen/vault-delete" as const;

export interface OffscreenVaultDeleteRequest {
  target: typeof OFFSCREEN_TARGET;
  type: typeof OFFSCREEN_VAULT_DELETE;
  vtaDid: string;
  restBaseUrl: string;
  body: Omit<RuntimeVaultDeleteRequest, "type">;
}

/** background → offscreen: vault/release/0.1. Offscreen unpacks the
 *  authcrypt JWE the VTA returns (the holder's private X25519 is the
 *  only key that can). */
export const OFFSCREEN_VAULT_RELEASE = "offscreen/vault-release" as const;

export interface OffscreenVaultReleaseRequest {
  target: typeof OFFSCREEN_TARGET;
  type: typeof OFFSCREEN_VAULT_RELEASE;
  vtaDid: string;
  restBaseUrl: string;
  body: Omit<RuntimeVaultReleaseRequest, "type">;
}

/** background → offscreen: vault/proxy-login/0.1. Same shape as
 *  vault/release — offscreen owns the holder's private X25519 so the
 *  authcrypt unpack happens there; the cleartext SessionBlob flows
 *  back over the bridge in the response. */
export const OFFSCREEN_VAULT_PROXY_LOGIN = "offscreen/vault-proxy-login" as const;

export interface OffscreenVaultProxyLoginRequest {
  target: typeof OFFSCREEN_TARGET;
  type: typeof OFFSCREEN_VAULT_PROXY_LOGIN;
  vtaDid: string;
  restBaseUrl: string;
  body: Omit<RuntimeVaultProxyLoginRequest, "type">;
}

export interface OffscreenSignTrustTaskRequest {
  target: typeof OFFSCREEN_TARGET;
  type: typeof OFFSCREEN_SIGN_TRUST_TASK;
  /** Which VTA's holder identity to sign with — multi-VTA: every VTA
   *  has its own holder DID; the RP-driven `window.vtaWallet.
   *  signTrustTask` doesn't know about this, so background fills it
   *  in from the active connection before forwarding. */
  vtaDid: string;
  /** REST base URL of the active VTA — needed when `params.asDid` is
   *  set so the offscreen can issue `vault/sign-trust-task/0.1` against
   *  the VTA. Optional in shape because the holder-signing path
   *  (when `asDid` is absent) doesn't touch the VTA. */
  restBaseUrl?: string;
  params: SignTrustTaskParams;
}

export interface OffscreenVerifyDidRequest {
  target: typeof OFFSCREEN_TARGET;
  type: typeof OFFSCREEN_VERIFY_DID;
  did: string;
}

export interface OffscreenStartInboundRequest {
  target: typeof OFFSCREEN_TARGET;
  type: typeof OFFSCREEN_START_INBOUND;
  /** Which VTAs' holders should be listening on the wallet's inbox
   *  mediator. The offscreen reconciles: opens missing inbound
   *  sessions for VTAs in this list, closes existing sessions for
   *  VTAs no longer present (operator forgot them). Empty list closes
   *  all inbound listeners — used on fresh-wipe / no-VTA state. */
  vtaDids: string[];
}

export interface OffscreenGetStatusRequest {
  target: typeof OFFSCREEN_TARGET;
  type: typeof OFFSCREEN_GET_STATUS;
}

export interface OffscreenOnboardPrepareRequest {
  target: typeof OFFSCREEN_TARGET;
  type: typeof OFFSCREEN_ONBOARD_PREPARE;
  vtaDid: string;
}

export interface OffscreenOnboardConnectRequest {
  target: typeof OFFSCREEN_TARGET;
  type: typeof OFFSCREEN_ONBOARD_CONNECT;
  /** Mirrors `RuntimeOnboardConnectRequest.context` — optional override.
   *  Omit to let the VTA infer the target context. */
  context?: string;
  /** Mirrors `RuntimeOnboardConnectRequest.createIfMissing`. */
  createIfMissing?: boolean;
}

/** background → offscreen: run a DIDComm login. Reply is a
 *  [`RuntimeLoginResponse`] via `sendResponse`. */
export interface OffscreenDidcommLoginRequest {
  target: typeof OFFSCREEN_TARGET;
  type: typeof OFFSCREEN_DIDCOMM_LOGIN;
  /** Which VTA's holder identity to authenticate as. Multi-VTA: the
   *  RP-page-facing `window.vtaWallet.loginDidcomm` doesn't know about
   *  the wallet's onboarded VTAs, so background fills this from the
   *  active connection before forwarding. */
  vtaDid: string;
  params: DidcommLoginParams;
}

/** background → offscreen: run a REST SIOPv2 login. The actual
 *  `issueIdToken` signing must happen here in offscreen — that's
 *  where the unwrapped holder secret lives (PRF AES cache is per-
 *  module-scope). Background's prior approach of loading the
 *  holder + calling `loginViaSiop` directly hung on encrypted
 *  wallets because background has no access to the cache. */
export const OFFSCREEN_REST_LOGIN = "offscreen/rest-login" as const;

export interface OffscreenRestLoginRequest {
  target: typeof OFFSCREEN_TARGET;
  type: typeof OFFSCREEN_REST_LOGIN;
  /** Which VTA's holder identity to sign as. Multi-VTA: background
   *  fills this from the active connection before forwarding. */
  vtaDid: string;
  params: LoginParams;
}

/** background → offscreen: run a VTA-approval step-up. Reply is a
 *  [`RuntimeLoginResponse`] via `sendResponse`. */
export interface OffscreenStepUpVtaRequest {
  target: typeof OFFSCREEN_TARGET;
  type: typeof OFFSCREEN_STEP_UP_VTA;
  params: StepUpVtaParams;
}


/** What a page may propose. Two members, and no more: the RP proposes; it never
 *  authorizes, and it never supplies anything that carries authority. */
export interface RequestTaskParams {
  /** Type URI of the task. */
  type: string;
  /** Proposed payload. The VTA validates it against the task's closed schema. */
  payload: Record<string, unknown>;
}

/** Whatever the VTA replied — including a rejection.
 *
 *  A `requireConsent` reject is not an error: it carries the VTA-signed consent
 *  requests an approver must see, and the digest the page must display for the
 *  cross-device match. Surfacing it as a thrown error would discard the informed-
 *  consent flow at the last hop, so it is returned as a result. */
export type RequestTaskResult = Record<string, unknown>;

export interface RuntimeRequestTaskRequest {
  type: typeof RUNTIME_REQUEST_TASK;
  params: RequestTaskParams;
  origin: string;
}

export type RuntimeRequestTaskResponse =
  | { ok: true; result: RequestTaskResult }
  | { ok: false; error: string };

export interface OffscreenRequestTaskRequest {
  target: typeof OFFSCREEN_TARGET;
  type: typeof OFFSCREEN_REQUEST_TASK;
  vtaDid: string;
  restBaseUrl: string;
  origin: string;
  params: RequestTaskParams;
}

/**
 * Every runtime message type a *web page* can originate through the content
 * script — the exact set whose origin must be the browser's, not the message
 * body's (see `attestedOrigin`).
 *
 * This is the source of truth. `background.ts` builds its `PAGE_FACING_TYPES`
 * from this array, so a new page-facing method added here is origin-checked
 * automatically. The failure this prevents is the one that shipped: `requestTask`
 * was added and *not* added to the origin set, so the one method whose origin
 * ends up inside a signed consent digest was reading it from the page.
 *
 * The content script's own dispatch table (`content.ts`) cannot import this — it
 * bundles as a classic script — so it duplicates the method list by hand. Keep
 * the two in step; the `page_facing_types_cover_the_content_dispatch_table`
 * assertion in `background.ts` fails if a type here has no home.
 */
export const PAGE_FACING_RUNTIME_TYPES = [
  RUNTIME_LOGIN,
  RUNTIME_LOGIN_DIDCOMM,
  RUNTIME_STEP_UP_VTA,
  RUNTIME_API_GET,
  RUNTIME_API_POST,
  RUNTIME_MEDIATOR_STATUS,
  RUNTIME_WALLET_DEFAULTS,
  RUNTIME_SIGN_TRUST_TASK,
  RUNTIME_VAULT_PROXY_LOGIN_PAGE,
  RUNTIME_VAULT_LIST_PAGE,
  RUNTIME_REQUEST_TASK,
] as const;

