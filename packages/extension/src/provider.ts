// Page-world provider — injected into the RP page by `content.ts` and
// exposed as `window.vtaWallet`. Runs in the page's own JS context, so it
// has NO access to `chrome.*`; it speaks to the content script purely via
// `window.postMessage` using the bridge protocol.

import type {
  BridgeMethod,
  RequestTaskParams,
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
  WalletProfileParams,
  WalletProfileResult,
} from "./bridge-protocol.js";

// Bundled as a standalone page-world script, so it must be self-contained
// (no shared-chunk imports). Inline the protocol constants — keep in sync
// with `bridge-protocol.ts`.
const INPAGE_SOURCE = "vta-wallet/inpage";
const CONTENT_SOURCE = "vta-wallet/content";

interface VtaWallet {
  /**
   * Propose a Trust Task for the user's agent to execute.
   *
   * The generic relay, and the successor to the per-action methods below. The
   * page supplies a type URI and a payload — **and nothing else**. The device
   * mints the envelope inside its own trust boundary and stamps the origin the
   * browser attested; the wallet never counter-signs a document the page wrote.
   *
   * Resolves with whatever the agent replied, **including a refusal**. A task the
   * agent's policy gates on human approval comes back as a `requireConsent`
   * rejection carrying the digest this page should display, so the user can match
   * it against the code on their approving device. That is a result to render,
   * not an error to swallow.
   */
  requestTask(params: RequestTaskParams): Promise<Record<string, unknown>>;
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
  /** Sign a Trust-Task envelope. Default signer is the wallet's holder
   *  did:key — adds an `eddsa-jcs-2022` Data Integrity proof and returns
   *  the resulting envelope. The caller sets `recipient` (audience
   *  binding) before calling.
   *
   *  To sign as a vault entry's principal DID (after a
   *  `vault/proxy-login` session where the RP authenticated the session
   *  as that DID), pass `asDid` and ensure `envelope.issuer === asDid`.
   *  The wallet routes via `vault/sign-trust-task/0.1` so the long-term
   *  signing key never leaves the VTA. */
  signTrustTask(params: SignTrustTaskParams): Promise<SignTrustTaskResult>;
  /** VTA-proxied login (vault/proxy-login/0.2). The VTA mints a session
   *  credential (SIOP id_token for did-self-issued entries) on the
   *  holder's behalf and returns it in a SessionBlob. The long-term
   *  signing key never leaves the VTA. The caller threads its
   *  `nonce` (typically the RP's `/auth/challenge` value) so the
   *  resulting id_token passes the RP's nonce verification.
   *
   *  **Omit `entryId`.** The wallet resolves the entry from this page's origin,
   *  and on a first visit asks the user which identity to sign in as and
   *  remembers the answer. Naming an entry means first calling `vaultList()`
   *  to learn one, which costs a second consent prompt and shows this site the
   *  rest of the user's vault. */
  proxyLogin(params: ProxyLoginParams): Promise<VaultProxyLoginResultView>;
  /** Which persona this site knows the user as, resolving or binding one.
   *
   *  Mints nothing and issues no session — it answers a question. On a site
   *  with no persona bound the user is asked to pick one and it is remembered;
   *  after that this is a lookup.
   *
   *  For an RP whose `/auth/challenge` is bound to the persona DID, this is the
   *  first call: the DID it returns is what the challenge is requested for, and
   *  the `entryId` goes straight into `proxyLogin` so the wallet does not
   *  repeat the lookup.
   *
   *      const { did, entryId } = await wallet.walletProfile({ target });
   *      const { challenge } = await postChallenge(did);
   *      await wallet.proxyLogin({ entryId, nonce: challenge, target });
   *
   *  `bound: true` means the persona was just created, so the relying party has
   *  never seen it and may refuse the sign-in until it is on its access list. */
  walletProfile(params: WalletProfileParams): Promise<WalletProfileResult>;
  /** Enumerate vault entries (metadata only, no secret material) via
   *  vault/list/0.1. Each returned entry's `principalDid` is the DID the entry
   *  would act AS when used in a proxy-login call.
   *
   *  Not needed to *drive* a proxy login — `proxyLogin({})` resolves the entry
   *  itself. Reach for this only when the page has something to show about the
   *  user's other entries, and expect a consent prompt: enumerating a vault to
   *  the site it belongs to is a disclosure, not a lookup. */
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

// `BridgeMethod`, not a copy of it. This used to inline the same union, and the
// copy silently went stale the moment a method was added — the union grew, this
// did not, and the new method failed to typecheck at its own call site with an
// error naming every method *but* the one being added.
function call<T>(
  method: BridgeMethod,
  params:
    | LoginParams
    | DidcommLoginParams
    | StepUpVtaParams
    | ApiGetParams
    | ApiPostParams
    | SignTrustTaskParams
    | ProxyLoginParams
    | WalletProfileParams
    | VaultListParams
    | RequestTaskParams
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
    walletProfile: (params) => call<WalletProfileResult>("walletProfile", params),
    vaultList: (params) => call<VaultListResultView>("vaultList", params),
    requestTask: (params) => call<Record<string, unknown>>("requestTask", params),
  };
}
