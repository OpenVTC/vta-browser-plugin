// Page-world provider — injected into the RP page by `content.ts` and
// exposed as `window.vtaWallet`. Runs in the page's own JS context, so it
// has NO access to `chrome.*`; it speaks to the content script purely via
// `window.postMessage` using the bridge protocol.

import type {
  ApiGetParams,
  ApiGetResult,
  ContentResponse,
  DidcommLoginParams,
  LoginParams,
  LoginResult,
  StepUpVtaParams,
} from "./bridge-protocol.js";

// Bundled as a standalone page-world script, so it must be self-contained
// (no shared-chunk imports). Inline the protocol constants — keep in sync
// with `bridge-protocol.ts`.
const INPAGE_SOURCE = "vta-wallet/inpage";
const CONTENT_SOURCE = "vta-wallet/content";

interface VtaWallet {
  /** Request a REST SIOPv2 login. Resolves with the RP-issued session
   *  tokens, or rejects if the user denies or the login fails. */
  login(params: LoginParams): Promise<LoginResult>;
  /** Request a DIDComm login (authcrypt-sender auth via the RP's
   *  mediator). Same result shape as `login`. */
  loginDidcomm(params: DidcommLoginParams): Promise<LoginResult>;
  /** Elevate an existing `aal1` session to `aal2` via VTA approval over
   *  DIDComm. Same result shape as `login`. */
  stepUpVta(params: StepUpVtaParams): Promise<LoginResult>;
  /** Perform an authenticated GET via the wallet (not subject to the
   *  page's cross-origin CORS). Returns the status + parsed body. */
  apiGet(params: ApiGetParams): Promise<ApiGetResult>;
}

declare global {
  interface Window {
    vtaWallet?: VtaWallet;
  }
}

const pending = new Map<
  string,
  { resolve: (r: unknown) => void; reject: (e: Error) => void }
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

function call<T>(
  method: "login" | "loginDidcomm" | "stepUpVta" | "apiGet",
  params: LoginParams | DidcommLoginParams | StepUpVtaParams | ApiGetParams,
): Promise<T> {
  const id = crypto.randomUUID();
  return new Promise<T>((resolve, reject) => {
    pending.set(id, { resolve: (r) => resolve(r as T), reject });
    window.postMessage({ source: INPAGE_SOURCE, id, method, params }, window.origin);
  });
}

// Define the provider once. A second injection (e.g. SPA re-navigation that
// re-runs the content script) must not clobber an existing one.
if (!window.vtaWallet) {
  window.vtaWallet = {
    login: (params) => call<LoginResult>("login", params),
    loginDidcomm: (params) => call<LoginResult>("loginDidcomm", params),
    stepUpVta: (params) => call<LoginResult>("stepUpVta", params),
    apiGet: (params) => call<ApiGetResult>("apiGet", params),
  };
}
