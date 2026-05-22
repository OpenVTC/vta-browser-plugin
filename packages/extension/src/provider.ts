// Page-world provider — injected into the RP page by `content.ts` and
// exposed as `window.vtaWallet`. Runs in the page's own JS context, so it
// has NO access to `chrome.*`; it speaks to the content script purely via
// `window.postMessage` using the bridge protocol.

import type { ContentResponse, LoginParams, LoginResult } from "./bridge-protocol.js";

// Bundled as a standalone page-world script, so it must be self-contained
// (no shared-chunk imports). Inline the protocol constants — keep in sync
// with `bridge-protocol.ts`.
const INPAGE_SOURCE = "vta-wallet/inpage";
const CONTENT_SOURCE = "vta-wallet/content";

interface VtaWallet {
  /** Request a SIOPv2 login. Resolves with the RP-issued session tokens,
   *  or rejects if the user denies or the login fails. */
  login(params: LoginParams): Promise<LoginResult>;
}

declare global {
  interface Window {
    vtaWallet?: VtaWallet;
  }
}

const pending = new Map<
  string,
  { resolve: (r: LoginResult) => void; reject: (e: Error) => void }
>();

window.addEventListener("message", (event: MessageEvent) => {
  // Only accept responses this same window posted to itself from the
  // content script. (The content script re-posts with `window.postMessage`,
  // so `event.source === window` and origin === our own.)
  if (event.source !== window) return;
  const data = event.data as ContentResponse | undefined;
  if (!data || data.source !== CONTENT_SOURCE) return;

  const entry = pending.get(data.id);
  if (!entry) return;
  pending.delete(data.id);
  if (data.ok) entry.resolve(data.result);
  else entry.reject(new Error(data.error));
});

function call(method: "login", params: LoginParams): Promise<LoginResult> {
  const id = crypto.randomUUID();
  return new Promise<LoginResult>((resolve, reject) => {
    pending.set(id, { resolve, reject });
    window.postMessage({ source: INPAGE_SOURCE, id, method, params }, window.origin);
  });
}

// Define the provider once. A second injection (e.g. SPA re-navigation that
// re-runs the content script) must not clobber an existing one.
if (!window.vtaWallet) {
  window.vtaWallet = {
    login: (params) => call("login", params),
  };
}
