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
export type BridgeMethod = "login" | "loginDidcomm" | "stepUpVta" | "apiGet";

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

/** Result of `apiGet` — the raw status + parsed/raw body. */
export interface ApiGetResult {
  status: number;
  body: unknown;
}

/** Result handed back to the RP page on a successful login. */
export interface LoginResult {
  accessToken: string;
  refreshToken: string;
  sessionId: string;
  /** The wallet holder's `did:key` — surfaced so the operator can ACL-grant it. */
  holderDid: string;
}

/** provider → content (page world → content world). */
export interface InpageRequest {
  source: typeof INPAGE_SOURCE;
  id: string;
  method: BridgeMethod;
  params: LoginParams | DidcommLoginParams | StepUpVtaParams | ApiGetParams;
}

/** content → provider (content world → page world). `result` is untyped
 *  wire data — each provider method casts to its own result type. */
export type ContentResponse =
  | { source: typeof CONTENT_SOURCE; id: string; ok: true; result: unknown }
  | { source: typeof CONTENT_SOURCE; id: string; ok: false; error: string };

// ─── content ↔ background (chrome.runtime messaging) ───

export const RUNTIME_LOGIN = "vta-wallet/login" as const;
export const RUNTIME_LOGIN_DIDCOMM = "vta-wallet/login-didcomm" as const;
export const RUNTIME_STEP_UP_VTA = "vta-wallet/step-up-vta" as const;
export const RUNTIME_API_GET = "vta-wallet/api-get" as const;
export const RUNTIME_CONSENT_RESULT = "vta-wallet/consent-result" as const;

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
}

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

/** background → offscreen: run a DIDComm login. Reply is a
 *  [`RuntimeLoginResponse`] via `sendResponse`. */
export interface OffscreenDidcommLoginRequest {
  target: typeof OFFSCREEN_TARGET;
  type: typeof OFFSCREEN_DIDCOMM_LOGIN;
  params: DidcommLoginParams;
}

/** background → offscreen: run a VTA-approval step-up. Reply is a
 *  [`RuntimeLoginResponse`] via `sendResponse`. */
export interface OffscreenStepUpVtaRequest {
  target: typeof OFFSCREEN_TARGET;
  type: typeof OFFSCREEN_STEP_UP_VTA;
  params: StepUpVtaParams;
}
