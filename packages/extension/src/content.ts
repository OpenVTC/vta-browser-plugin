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

// ─── 2. Relay provider → background → provider. ───
window.addEventListener("message", (event: MessageEvent) => {
  if (event.source !== window) return;
  const req = event.data as InpageRequest | undefined;
  if (!req || req.source !== INPAGE_SOURCE) return;

  void (async () => {
    let response: ContentResponse;
    try {
      const runtimeType =
        req.method === "loginDidcomm"
          ? RUNTIME_LOGIN_DIDCOMM
          : req.method === "stepUpVta"
            ? RUNTIME_STEP_UP_VTA
            : req.method === "apiGet"
              ? RUNTIME_API_GET
              : req.method === "apiPost"
                ? RUNTIME_API_POST
                : RUNTIME_LOGIN;
      const runtimeResponse = (await chrome.runtime.sendMessage({
        type: runtimeType,
        params: req.params,
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
