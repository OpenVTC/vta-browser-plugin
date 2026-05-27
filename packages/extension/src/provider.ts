// Page-world provider — injected into the RP page by `content.ts` and
// exposed as `window.vtaWallet`. Runs in the page's own JS context, so it
// has NO access to `chrome.*`; it speaks to the content script purely via
// `window.postMessage` using the bridge protocol.

import type {
  ApiGetParams,
  ApiGetResult,
  ApiPostParams,
  ContentResponse,
  DidcommLoginParams,
  LoginParams,
  LoginResult,
  MediatorStatusResult,
  ProxyLoginParams,
  SignTrustTaskParams,
  SignTrustTaskResult,
  StepUpVtaParams,
  VaultListParams,
  VaultListResultView,
  VaultProxyLoginResultView,
  WalletDefaultsResult,
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
  /** Perform an authenticated POST via the wallet (not subject to CORS). */
  apiPost(params: ApiPostParams): Promise<ApiGetResult>;
  /** Query the wallet's warm mediator-session status (connection indicator). */
  mediatorStatus(): Promise<MediatorStatusResult>;
  /** Query operator-configured wallet defaults (e.g. step-up VTA) to prefill. */
  walletDefaults(): Promise<WalletDefaultsResult>;
  /** Sign a Trust-Task envelope with the wallet's holder did:peer #key-2.
   *  Adds an eddsa-jcs-2022 Data Integrity proof and returns the resulting
   *  envelope. The caller sets `recipient` (audience binding) before calling. */
  signTrustTask(params: SignTrustTaskParams): Promise<SignTrustTaskResult>;
  /** VTA-proxied login (vault/proxy-login/0.1). The VTA mints a session
   *  credential (SIOP id_token for did-self-issued entries) on the
   *  holder's behalf and returns it in a SessionBlob. The long-term
   *  signing key never leaves the VTA. The caller threads its
   *  `nonce` (typically the RP's `/auth/challenge` value) so the
   *  resulting id_token passes the RP's nonce verification. */
  proxyLogin(params: ProxyLoginParams): Promise<VaultProxyLoginResultView>;
  /** Enumerate vault entries (metadata only, no secret material) via
   *  vault/list/0.1. Typical use from an RP page: filter by
   *  `targetDid` and `secretKind: "did-self-issued"` to discover
   *  proxy-login candidates pinned to the RP. Each returned entry's
   *  `principalDid` is the DID the entry would act AS when used in a
   *  proxy-login call. */
  vaultList(params: VaultListParams): Promise<VaultListResultView>;
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
  const data = event.data as
    | ContentResponse
    | { source: typeof CONTENT_SOURCE; kind: "event"; event: string; detail?: unknown }
    | undefined;
  if (!data || data.source !== CONTENT_SOURCE) return;

  // Broadcast events (`{ kind: "event", event: "ready" | "unlocked" | … }`)
  // are re-dispatched on `window` so RPs can listen via
  // `window.addEventListener("vtawallet:unlocked", …)`. No promise to
  // resolve — it's a lifecycle signal, not a request/response.
  if ("kind" in data && data.kind === "event") {
    window.dispatchEvent(
      new CustomEvent(`vtawallet:${data.event}`, { detail: data.detail }),
    );
    return;
  }

  // Otherwise it's a request/response — fulfil the pending promise.
  if (!("id" in data)) return;
  const entry = pending.get(data.id);
  if (!entry) return;
  pending.delete(data.id);
  if (data.ok) entry.resolve(data.result);
  else entry.reject(new Error(data.error));
});

function call<T>(
  method:
    | "login"
    | "loginDidcomm"
    | "stepUpVta"
    | "apiGet"
    | "apiPost"
    | "mediatorStatus"
    | "walletDefaults"
    | "signTrustTask"
    | "proxyLogin"
    | "vaultList",
  params:
    | LoginParams
    | DidcommLoginParams
    | StepUpVtaParams
    | ApiGetParams
    | ApiPostParams
    | SignTrustTaskParams
    | ProxyLoginParams
    | VaultListParams
    | Record<string, never>,
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
    apiPost: (params) => call<ApiGetResult>("apiPost", params),
    mediatorStatus: () => call<MediatorStatusResult>("mediatorStatus", {}),
    walletDefaults: () => call<WalletDefaultsResult>("walletDefaults", {}),
    signTrustTask: (params) => call<SignTrustTaskResult>("signTrustTask", params),
    proxyLogin: (params) => call<VaultProxyLoginResultView>("proxyLogin", params),
    vaultList: (params) => call<VaultListResultView>("vaultList", params),
  };
}
