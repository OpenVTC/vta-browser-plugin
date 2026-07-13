/// <reference types="chrome" />

// Content script (isolated world). Two jobs:
//   1. Inject the page-world provider (`provider.js`) so the RP page can
//      call `window.vtaWallet.login(...)`.
//   2. Relay each provider request to the background service worker and
//      post the response back into the page.

import type {
  ContentResponse,
  InpageRequest,
  RuntimeLoginResponse,
} from "./bridge-protocol.js";

// A content script is injected as a *classic* script and cannot `import`,
// so this file must bundle to a single self-contained chunk. We therefore
// inline the protocol string constants instead of importing their values.
// Keep these in sync with `bridge-protocol.ts`.
const INPAGE_SOURCE = "vta-wallet/inpage";
const CONTENT_SOURCE = "vta-wallet/content";
const RUNTIME_LOGIN = "vta-wallet/login";
const RUNTIME_LOGIN_DIDCOMM = "vta-wallet/login-didcomm";
const RUNTIME_STEP_UP_VTA = "vta-wallet/step-up-vta";
const RUNTIME_API_GET = "vta-wallet/api-get";
const RUNTIME_API_POST = "vta-wallet/api-post";
const RUNTIME_MEDIATOR_STATUS = "vta-wallet/mediator-status";
const RUNTIME_WALLET_DEFAULTS = "vta-wallet/wallet-defaults";
const RUNTIME_SIGN_TRUST_TASK = "vta-wallet/sign-trust-task";
const RUNTIME_VAULT_PROXY_LOGIN_PAGE = "vta-wallet/vault-proxy-login-page";
const RUNTIME_VAULT_LIST_PAGE = "vta-wallet/vault-list-page";
const RUNTIME_REQUEST_TASK = "vta-wallet/request-task";
const RUNTIME_BROADCAST_EVENT = "vta-wallet/broadcast-event";

// ─── 1. Inject the provider into the page world. ───
// The content script runs in an isolated world, so assigning
// `window.vtaWallet` here would not be visible to the RP's own JS. We load
// `provider.js` (a web_accessible_resource) as a page-world <script>.
function injectProvider(): void {
  const script = document.createElement("script");
  script.src = chrome.runtime.getURL("provider.js");
  script.type = "module";
  script.onload = () => script.remove();
  (document.head ?? document.documentElement).appendChild(script);
}
injectProvider();

// Page-facing provider method → runtime message type. Exhaustive by design: see
// the note at the call site about why an unknown method must not fall through.
const RUNTIME_TYPE_BY_METHOD: Record<string, string | undefined> = {
  login: RUNTIME_LOGIN,
  loginDidcomm: RUNTIME_LOGIN_DIDCOMM,
  stepUpVta: RUNTIME_STEP_UP_VTA,
  apiGet: RUNTIME_API_GET,
  apiPost: RUNTIME_API_POST,
  mediatorStatus: RUNTIME_MEDIATOR_STATUS,
  walletDefaults: RUNTIME_WALLET_DEFAULTS,
  signTrustTask: RUNTIME_SIGN_TRUST_TASK,
  proxyLogin: RUNTIME_VAULT_PROXY_LOGIN_PAGE,
  vaultList: RUNTIME_VAULT_LIST_PAGE,
  requestTask: RUNTIME_REQUEST_TASK,
};

// ─── 2. Relay provider → background → provider. ───
window.addEventListener("message", (event: MessageEvent) => {
  if (event.source !== window) return;
  const req = event.data as InpageRequest | undefined;
  if (!req || req.source !== INPAGE_SOURCE) return;

  void (async () => {
    let response: ContentResponse;
    try {
      // An explicit table, and an *unknown method is an error*.
      //
      // This used to be a ternary chain whose final arm was `RUNTIME_LOGIN`, so
      // any method name it did not recognise — a typo, a future method this
      // build predates, anything a page cared to invent — silently became a
      // login request. Failing closed on an unrecognised name costs nothing and
      // removes a whole class of surprise.
      const runtimeType = RUNTIME_TYPE_BY_METHOD[req.method];
      if (!runtimeType) {
        throw new Error(`unsupported method: ${String(req.method)}`);
      }
      const runtimeResponse = (await chrome.runtime.sendMessage({
        type: runtimeType,
        params: req.params,
        // The background overwrites this with the browser-attested
        // `sender.origin`. It is sent only as a diagnostic; nothing downstream
        // trusts it, and nothing here can make it trustworthy — a compromised
        // renderer is precisely what a content script is meant to survive.
        origin: window.location.origin,
      })) as RuntimeLoginResponse;

      response = runtimeResponse.ok
        ? { source: CONTENT_SOURCE, id: req.id, ok: true, result: runtimeResponse.result }
        : { source: CONTENT_SOURCE, id: req.id, ok: false, error: runtimeResponse.error };
    } catch (e) {
      response = {
        source: CONTENT_SOURCE,
        id: req.id,
        ok: false,
        error: e instanceof Error ? e.message : String(e),
      };
    }
    window.postMessage(response, window.origin);
  })();
});

// ─── 3. Forward background broadcasts (wallet lifecycle events) into
//        the page world. ───
// Background fires these on unlock / lock / connection change. Pages
// that listen for the corresponding `vtawallet:<kind>` window event can
// react — typically retry an operation that failed during the gap. RPs
// that don't listen aren't affected (the broadcasts are best-effort).
chrome.runtime.onMessage.addListener((message) => {
  const m = message as { type?: string; event?: string; detail?: unknown };
  if (m?.type !== RUNTIME_BROADCAST_EVENT || typeof m.event !== "string") return;
  window.postMessage(
    {
      source: CONTENT_SOURCE,
      kind: "event",
      event: m.event,
      ...(m.detail ? { detail: m.detail } : {}),
    },
    window.origin,
  );
});

// ─── 4. Emit `ready` on initial content-script load. ───
// Fires once per fresh content-script instance. On extension reload,
// the OLD content script in this tab is orphaned (`chrome.runtime`
// calls all fail with "Extension context invalidated"). The
// background's onInstalled handler reloads matching tabs to inject a
// new content script, which fires this event — so a page that
// listened can clear stale error state from the gap.
window.postMessage(
  { source: CONTENT_SOURCE, kind: "event", event: "ready" },
  window.origin,
);
