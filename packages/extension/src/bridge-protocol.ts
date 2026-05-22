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
 *  DIDComm authcrypt-sender auth via the RP's mediator. */
export type BridgeMethod = "login" | "loginDidcomm";

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
  params: LoginParams | DidcommLoginParams;
}

/** content → provider (content world → page world). */
export type ContentResponse =
  | { source: typeof CONTENT_SOURCE; id: string; ok: true; result: LoginResult }
  | { source: typeof CONTENT_SOURCE; id: string; ok: false; error: string };

// ─── content ↔ background (chrome.runtime messaging) ───

export const RUNTIME_LOGIN = "vta-wallet/login" as const;
export const RUNTIME_LOGIN_DIDCOMM = "vta-wallet/login-didcomm" as const;
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

/** background → content (sendResponse). */
export type RuntimeLoginResponse =
  | { ok: true; result: LoginResult }
  | { ok: false; error: string };

/** consent window → background: the user's approve/deny decision. */
export interface RuntimeConsentResult {
  type: typeof RUNTIME_CONSENT_RESULT;
  /** Correlates with the pending consent the background is awaiting. */
  consentId: string;
  approved: boolean;
}
