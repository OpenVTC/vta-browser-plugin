// Page-world provider — injected into the RP page by `content.ts` and
// exposed as `window.vtaWallet`. Runs in the page's own JS context, so it
// has NO access to `chrome.*`; it speaks to the content script purely via
// `window.postMessage` using the bridge protocol.

import type {
  ApproveDecisionParams,
  ApproveStepUpParams,
  ApproverIdentityParams,
  ApproverIdentityResult,
  ApproverStatementResult,
  AttestApproverParams,
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
  RoomsPageOp,
  DirectoryPageOp,
  PageEntryMark,
  PageMarkList,
  PageMarksView,
  PageVerifiedFieldsView,
  GitPageOp,
  PageGitLinkView,
  PageGitUnlinkView,
  PagePublishedCardView,
  PageRoomView,
  PageRoomInfoView,
  PageListingView,
  PageRecordView,
  RoomFilesPageMessage,
} from "./bridge-protocol.js";
import type { PageOfferView } from "./room-offers-policy.js";

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
  /** Sign in to the RP with `auth/challenge/0.1` then `auth/authenticate/0.3`,
   *  sent to `{baseUrl}/trust-tasks` and addressed to `rpDid`. Pass
   *  `sessionKey` (a `did:key` the page holds) to have the RP bind it to the
   *  session, so later calls can be signed without the wallet. Resolves with
   *  the RP-issued session tokens. Rejects if the user denies, the key is not
   *  a `did:key`, or the login fails.
   *
   *  @deprecated Legacy sign-in, kept working (sign-in contract C7). New pages
   *  should sign members in with a trigger link instead: show the
   *  `auth/oob` sign-in code as a QR code wrapped in a link to the same text
   *  (`@openvtc/rp-sdk/browser`'s `createSignIn`), and the wallet takes the
   *  click. Offer this method only behind an "Using an older wallet?" link. A
   *  removal date will be set later. */
  login(params: LoginParams): Promise<LoginResult>;
  /** Request a DIDComm login (authcrypt-sender auth via the RP's
   *  mediator). Same result shape as `login`.
   *
   *  @deprecated Legacy sign-in, kept working (sign-in contract C7). New pages
   *  should sign members in with a trigger link instead: show the
   *  `auth/oob` sign-in code as a QR code wrapped in a link to the same text
   *  (`@openvtc/rp-sdk/browser`'s `createSignIn`), and the wallet takes the
   *  click. Offer this method only behind an "Using an older wallet?" link. A
   *  removal date will be set later. */
  loginDidcomm(params: DidcommLoginParams): Promise<LoginResult>;
  /** Elevate an existing `aal1` session to `aal2` via VTA approval. Same
   *  result shape as `login`. Refused unless `rpDid` and `baseUrl` are the
   *  ones this origin's approved `login()` pinned. */
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
   *  binding) before calling. It must be the RP DID this origin is
   *  pinned to by an approved `login()`, `loginDidcomm()` or
   *  `proxyLogin()`; any other recipient, or an origin with no pin, is
   *  refused before any prompt.
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
   *  rest of the user's vault.
   *
   *  @deprecated Legacy sign-in, kept working (sign-in contract C7). New pages
   *  should sign members in with a trigger link instead: show the
   *  `auth/oob` sign-in code as a QR code wrapped in a link to the same text
   *  (`@openvtc/rp-sdk/browser`'s `createSignIn`), and the wallet takes the
   *  click. Offer this method only behind an "Using an older wallet?" link. A
   *  removal date will be set later. */
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
   *  vault/list/0.4. Each returned entry's `principalDid` is the DID the entry
   *  would act AS when used in a proxy-login call.
   *
   *  Not needed to *drive* a proxy login — `proxyLogin({})` resolves the entry
   *  itself. Reach for this only when the page has something to show about the
   *  user's other entries, and expect a consent prompt: enumerating a vault to
   *  the site it belongs to is a disclosure, not a lookup. */
  vaultList(params: VaultListParams): Promise<VaultListResultView>;
  /** The wallet's step-up approver `did:key` for `audience` — one per relying
   *  party, so communities cannot correlate the user by it. Signs nothing.
   *  `audience` must be the relying party this origin signed in to. */
  approverIdentity(params: ApproverIdentityParams): Promise<ApproverIdentityResult>;
  /** Answer an operation-bound step-up (`auth/step-up/approve-request/0.4`)
   *  with the approver for `audience`. The wallet refuses unless its approver
   *  is among `request.approvers` and `request.boundTo` is the digest of
   *  `operation`; it shows the reason, the operation and the community, takes
   *  a user-verification gesture, and returns a signed
   *  `auth/step-up/approver/attest/0.1` statement (`purpose: stepUp`). */
  approveStepUp(params: ApproveStepUpParams): Promise<ApproverStatementResult>;
  /** The approver's enrolment statement (attest/0.1, `purpose: enrol`) over the
   *  relying party's `challenge`, bound to `boundTo`, after a gesture. */
  attestApprover(params: AttestApproverParams): Promise<ApproverStatementResult>;
  /** Vouch for a VTC administrator's `task-consent/decision/0.2` with the
   *  approver for `audience` (attest/0.1, `purpose: decision`). The wallet
   *  recomputes `decision.payloadDigest` from `action` and refuses on a
   *  mismatch; it shows the action, the decision (approve/deny) and the
   *  community, takes a user-verification gesture, and returns the signed
   *  statement. The decision carrying it, signed `asDid` `subject` through
   *  `signTrustTask`, is then signed once without a second prompt. */
  approveDecision(params: ApproveDecisionParams): Promise<ApproverStatementResult>;
  /** Data rooms, for the community's own portal (VTI `data-rooms-files.md`
   *  §8.5). Every call names `hostDid` — the community whose portal this page
   *  is — and is refused unless this page's origin is that DID document's
   *  `SignInPortal`. A page sees only the rooms the member shared with it, in
   *  the wallet's own window; reads need nothing more, and every write is
   *  confirmed by the member. Nothing here returns a key, a presentation or a
   *  signed document. */
  rooms: VtaWalletRooms;
  /** The member's directory card, for the community's own portal
   *  (`vtc/directory/card/publish`). Refused unless this page's origin is the
   *  `SignInPortal` of `hostDid`'s DID document. The wallet reads the card as the
   *  member, shows them every value and that anyone can read it, and publishes
   *  only if they agree; the page gets where the card stands, never the card
   *  or a signature. */
  directory: VtaWalletDirectory;
  /** The member's forge accounts at the community, for its own portal
   *  (`git-ns/account/{link,unlink}`). Refused unless this page's origin is the
   *  `SignInPortal` of `hostDid`'s DID document. The wallet asks the member,
   *  signs as them, and for a link opens the forge's page and shows any code in
   *  its own window; the page gets the link's id to follow it, never the code. */
  git: VtaWalletGit;
}

/** `window.vtaWallet.git`. */
export interface VtaWalletGit {
  /** Begin linking the member's account on `forge`. Follow it with
   *  `git-ns/account/link-status` by the returned `linkId`. */
  linkAccount(p: { hostDid: string; forge: string; member?: string }): Promise<PageGitLinkView>;
  /** Unlink the member's account on `forge`; `accountId` is the account as the
   *  page last read it, so a re-link since is never removed. */
  unlinkAccount(p: { hostDid: string; forge: string; accountId?: string; member?: string }): Promise<PageGitUnlinkView>;
}

/** `window.vtaWallet.directory`. */
export interface VtaWalletDirectory {
  /** Publish the member's card beyond the community. `member` is the DID the
   *  page says is signed in: a hint among the wallet's identities there. */
  publishCard(p: { hostDid: string; member?: string }): Promise<PagePublishedCardView>;
  /** The member's own marks on this community's members — stars, petnames and
   *  their lists — from their own agent, never from the community. The first
   *  call from a community asks the member, once, whether its portal may show
   *  them; a refusal rejects. Read the directory as you would without them and
   *  apply them on the page. */
  marks(p: { hostDid: string; member?: string }): Promise<PageMarksView>;
  /** Change the member's marks on one entry: a star, a petname (or
   *  `removePetname`), the set of lists it is on. Resolves with the entry's
   *  marks now. */
  mark(p: {
    hostDid: string;
    member?: string;
    entryId: string;
    starred?: boolean;
    petname?: string;
    removePetname?: true;
    lists?: string[];
  }): Promise<PageEntryMark>;
  /** Create one of the member's lists (no `listId`), or rename or recolour one. */
  putList(p: { hostDid: string; member?: string; listId?: string; name?: string; colour?: string }): Promise<PageMarkList>;
  /** Delete one of the member's lists; contacts on it stay. */
  deleteList(p: { hostDid: string; member?: string; listId: string }): Promise<{ deleted: boolean }>;
  /** Fill the member's `credential`-sourced fields from a credential their
   *  agent holds. The wallet finds the credentials the fields accept, and the
   *  member picks one and sees every claim it discloses to the community; a
   *  refusal rejects. All the fields must read one credential type. Resolves
   *  with the verified values now on the card. */
  presentCredential(p: { hostDid: string; member?: string; fields: string[] }): Promise<PageVerifiedFieldsView>;
}

/** Progress of a file transfer, for a progress bar. */
export interface RoomTransferProgress {
  stage: string;
  done?: number;
  total?: number;
}

export interface VtaWalletRooms {
  /** The rooms the member has shared with this page. Never prompts. */
  list(params: { hostDid: string }): Promise<{ rooms: PageRoomView[] }>;
  /** Ask the member which of their rooms to share with this page; resolves with
   *  every room shared. `suggest` pre-ticks one the page links to; `member`
   *  is who the page says is signed in, which picks among the identities the
   *  wallet holds for this community and never adds one. */
  choose(params: { hostDid: string; suggest?: string; member?: string }): Promise<{
    rooms: PageRoomView[];
    refused: { roomId: string; reason: string }[];
  }>;
  /** Stop using a room here. The member can also revoke it in the wallet. */
  forget(params: { hostDid: string; roomId: string }): Promise<{ forgotten: boolean }>;
  /** The room's tier, epoch, limits and usage, and who the member is in it. */
  info(params: { hostDid: string; roomId: string }): Promise<PageRoomInfoView>;
  /** The room's records: metadata, never bodies. */
  browse(params: { hostDid: string; roomId: string; prefix?: string; sinceVersion?: number }): Promise<PageListingView>;
  /** One record, verified. */
  read(params: { hostDid: string; roomId: string; key: string }): Promise<PageRecordView>;
  /** Every room this community has offered the identities the member uses here,
   *  and where each stands — `offered`, `joined`, `unfinished` (accepted
   *  somewhere, here or elsewhere, and not finished), `needsReadmission`,
   *  `removed` — as the member's other surfaces show it too: the community's
   *  record beside the member's agent's keys. Label, tier, actions and dates —
   *  never an offer's credentials. Never prompts. `needsOrigin` when the member has not yet let the wallet reach
   *  the community (they allow it from the wallet's console, or when sharing a
   *  room here). */
  offers(params: { hostDid: string }): Promise<{ offers: PageOfferView[]; needsOrigin?: string }>;
  /** Ask the member to accept one offer, or finish one accepted anywhere and not
   *  joined. The wallet shows its own window naming the community, the room and
   *  the identity it joins as; the member decides there. `member` picks among the identities offered the room. To use the
   *  room here afterwards, share it (`choose`, with `suggest: roomId`). */
  acceptOffer(params: { hostDid: string; roomId: string; member?: string }): Promise<{
    roomId: string;
    member: string;
    visibility: string;
    joined: boolean;
    epoch?: number;
    resumed: boolean;
  }>;
  /** Write a note as the member, after they confirm it. */
  putNote(params: {
    hostDid: string;
    roomId: string;
    title: string;
    body?: string;
    description?: string;
    tags?: string[];
  }): Promise<{ key: string; version: number }>;
  /** A record's file, once the whole of it has verified against its author's digest. */
  getFile(params: {
    hostDid: string;
    roomId: string;
    key: string;
    onProgress?: (p: RoomTransferProgress) => void;
  }): Promise<{
    file: { name: string; mediaType?: string; size: number };
    author: string;
    version: number;
    title?: string;
    description?: string;
    tags?: string[];
    blob: Blob;
  }>;
  /** Encrypt and add a file as the member, after they confirm it. */
  putFile(params: {
    hostDid: string;
    roomId: string;
    file: Blob;
    name: string;
    title?: string;
    description?: string;
    tags?: string[];
    onProgress?: (p: RoomTransferProgress) => void;
  }): Promise<{ key: string; version: number; size: number }>;
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

  if ("kind" in data && (data as { kind?: unknown }).kind === "roomFile") {
    const frame = data as unknown as { id: string; msg: RoomFilesPageMessage | { kind: "closed" } };
    transfers.get(frame.id)?.(frame.msg);
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
    | ApproverIdentityParams
    | ApproveStepUpParams
    | AttestApproverParams
    | ApproveDecisionParams
    | RoomsPageOp
    | DirectoryPageOp
    | GitPageOp
    | Record<string, never>,
): Promise<T> {
  const id = crypto.randomUUID();
  return new Promise<T>((resolve, reject) => {
    pending.set(id, { resolve: (r) => resolve(r as T), reject });
    window.postMessage({ source: INPAGE_SOURCE, id, method, params }, window.origin);
  });
}

/** Say once per page, in the developer console, that a legacy sign-in method
 *  was used. The call itself is unchanged (sign-in contract C7). */
const warnedLegacy = new Set<string>();
function legacy<T>(method: "login" | "loginDidcomm" | "proxyLogin", run: () => Promise<T>): Promise<T> {
  if (!warnedLegacy.has(method)) {
    warnedLegacy.add(method);
    console.warn(
      `[vtaWallet] ${method}() is deprecated legacy sign-in. Use wallet sign-in with a trigger link ` +
        `(a clickable auth/oob sign-in code); keep ${method}() behind an "Using an older wallet?" link.`,
    );
  }
  return run();
}

// ── Room-file transfers ──────────────────────────────────────────────────────
//
// One id per transfer; the content script opens one port per id. Bytes cross
// as base64url, in slices, because the extension's ports carry JSON.

const transfers = new Map<string, (msg: RoomFilesPageMessage | { kind: "closed" }) => void>();
const SLICE_BYTES = 256 * 1024;

function toB64u(bytes: Uint8Array): string {
  let s = "";
  for (let i = 0; i < bytes.length; i += 0x8000) s += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  return btoa(s).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}
function fromB64u(text: string): Uint8Array {
  const pad = text.length % 4 === 0 ? "" : "=".repeat(4 - (text.length % 4));
  const bin = atob(text.replace(/-/g, "+").replace(/_/g, "/") + pad);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

function postFrame(id: string, msg: unknown): void {
  window.postMessage({ source: INPAGE_SOURCE, kind: "roomFile", id, msg }, window.origin);
}

function getRoomFile(params: Parameters<VtaWalletRooms["getFile"]>[0]): ReturnType<VtaWalletRooms["getFile"]> {
  const id = crypto.randomUUID();
  const { onProgress, ...open } = params;
  return new Promise((resolve, reject) => {
    const parts: Uint8Array[] = [];
    let meta: Extract<RoomFilesPageMessage, { kind: "got" }> | undefined;
    transfers.set(id, (msg) => {
      switch (msg.kind) {
        case "progress":
          onProgress?.({ stage: msg.stage, ...(msg.done !== undefined ? { done: msg.done } : {}), ...(msg.total !== undefined ? { total: msg.total } : {}) });
          return;
        case "got":
          meta = msg;
          return;
        case "data":
          parts.push(fromB64u(msg.data));
          return;
        case "done": {
          transfers.delete(id);
          postFrame(id, { kind: "cancel" });
          if (!meta) return reject(new Error("the wallet finished a download it never described"));
          const { kind: _kind, ...rest } = meta;
          void _kind;
          const type = meta.file.mediaType ?? "application/octet-stream";
          resolve({ ...rest, blob: new Blob(parts as BlobPart[], { type }) });
          return;
        }
        case "failed":
          transfers.delete(id);
          reject(new Error(msg.error));
          return;
        case "closed":
          transfers.delete(id);
          reject(new Error("the wallet stopped the download"));
          return;
        default:
          return;
      }
    });
    postFrame(id, { kind: "get", hostDid: open.hostDid, roomId: open.roomId, key: open.key });
  });
}

function putRoomFile(params: Parameters<VtaWalletRooms["putFile"]>[0]): ReturnType<VtaWalletRooms["putFile"]> {
  const id = crypto.randomUUID();
  const { onProgress, file, ...meta } = params;
  return new Promise((resolve, reject) => {
    transfers.set(id, (msg) => {
      switch (msg.kind) {
        case "progress":
          onProgress?.({ stage: msg.stage, ...(msg.done !== undefined ? { done: msg.done } : {}), ...(msg.total !== undefined ? { total: msg.total } : {}) });
          return;
        case "ready":
          // The member confirmed: send the bytes, in order, then end.
          void (async () => {
            for (let at = 0; at < file.size; at += SLICE_BYTES) {
              const slice = new Uint8Array(await file.slice(at, at + SLICE_BYTES).arrayBuffer());
              postFrame(id, { kind: "data", data: toB64u(slice) });
            }
            postFrame(id, { kind: "end" });
          })().catch((e: unknown) => {
            transfers.delete(id);
            postFrame(id, { kind: "cancel" });
            reject(e instanceof Error ? e : new Error(String(e)));
          });
          return;
        case "put":
          transfers.delete(id);
          postFrame(id, { kind: "cancel" });
          resolve({ key: msg.key, version: msg.version, size: msg.size });
          return;
        case "failed":
          transfers.delete(id);
          reject(new Error(msg.error));
          return;
        case "closed":
          transfers.delete(id);
          reject(new Error("the wallet stopped the upload"));
          return;
        default:
          return;
      }
    });
    postFrame(id, {
      kind: "put",
      hostDid: meta.hostDid,
      roomId: meta.roomId,
      name: meta.name,
      size: file.size,
      ...(file.type ? { mediaType: file.type } : {}),
      ...(meta.title !== undefined ? { title: meta.title } : {}),
      ...(meta.description !== undefined ? { description: meta.description } : {}),
      ...(meta.tags !== undefined ? { tags: meta.tags } : {}),
    });
  });
}

// Define the provider once. A second injection (e.g. SPA re-navigation that
// re-runs the content script) must not clobber an existing one.
if (!window.vtaWallet) {
  window.vtaWallet = {
    login: (params) => legacy("login", () => call<LoginResult>("login", params)),
    loginDidcomm: (params) => legacy("loginDidcomm", () => call<LoginResult>("loginDidcomm", params)),
    stepUpVta: (params) => call<LoginResult>("stepUpVta", params),
    apiGet: (params) => call<ApiGetResult>("apiGet", params),
    apiPost: (params) => call<ApiGetResult>("apiPost", params),
    mediatorStatus: () => call<MediatorStatusResult>("mediatorStatus", {}),
    walletDefaults: () => call<WalletDefaultsResult>("walletDefaults", {}),
    signTrustTask: (params) => call<SignTrustTaskResult>("signTrustTask", params),
    proxyLogin: (params) => legacy("proxyLogin", () => call<VaultProxyLoginResultView>("proxyLogin", params)),
    walletProfile: (params) => call<WalletProfileResult>("walletProfile", params),
    vaultList: (params) => call<VaultListResultView>("vaultList", params),
    requestTask: (params) => call<Record<string, unknown>>("requestTask", params),
    approverIdentity: (params) => call<ApproverIdentityResult>("approverIdentity", params),
    approveStepUp: (params) => call<ApproverStatementResult>("approveStepUp", params),
    attestApprover: (params) => call<ApproverStatementResult>("attestApprover", params),
    approveDecision: (params) => call<ApproverStatementResult>("approveDecision", params),
    rooms: {
      list: (p) => call("rooms", { op: "list", hostDid: p.hostDid }),
      choose: (p) =>
        call("rooms", {
          op: "choose",
          hostDid: p.hostDid,
          ...(p.suggest !== undefined ? { suggest: p.suggest } : {}),
          ...(p.member !== undefined ? { member: p.member } : {}),
        }),
      forget: (p) => call("rooms", { op: "forget", hostDid: p.hostDid, roomId: p.roomId }),
      info: (p) => call("rooms", { op: "info", hostDid: p.hostDid, roomId: p.roomId }),
      browse: (p) => call("rooms", { ...p, op: "browse" }),
      read: (p) => call("rooms", { op: "read", hostDid: p.hostDid, roomId: p.roomId, key: p.key }),
      putNote: (p) => call("rooms", { ...p, op: "putNote" }),
      offers: (p) => call("rooms", { op: "offers", hostDid: p.hostDid }),
      acceptOffer: (p) =>
        call("rooms", {
          op: "acceptOffer",
          hostDid: p.hostDid,
          roomId: p.roomId,
          ...(p.member !== undefined ? { member: p.member } : {}),
        }),
      getFile: getRoomFile,
      putFile: putRoomFile,
    },
    directory: {
      publishCard: (p) =>
        call<PagePublishedCardView>("directory", {
          op: "publishCard",
          hostDid: p.hostDid,
          ...(p.member !== undefined ? { member: p.member } : {}),
        }),
      marks: (p) =>
        call<PageMarksView>("directory", {
          op: "marks",
          hostDid: p.hostDid,
          ...(p.member !== undefined ? { member: p.member } : {}),
        }),
      // Only the members the channel takes: anything else the page adds is
      // dropped here, and refused by the background if it got through.
      mark: (p) =>
        call<PageEntryMark>("directory", {
          op: "mark",
          hostDid: p.hostDid,
          entryId: p.entryId,
          ...(p.member !== undefined ? { member: p.member } : {}),
          ...(p.starred !== undefined ? { starred: p.starred } : {}),
          ...(p.petname !== undefined ? { petname: p.petname } : {}),
          ...(p.removePetname ? { removePetname: true as const } : {}),
          ...(p.lists !== undefined ? { lists: [...p.lists] } : {}),
        }),
      putList: (p) =>
        call<PageMarkList>("directory", {
          op: "putList",
          hostDid: p.hostDid,
          ...(p.member !== undefined ? { member: p.member } : {}),
          ...(p.listId !== undefined ? { listId: p.listId } : {}),
          ...(p.name !== undefined ? { name: p.name } : {}),
          ...(p.colour !== undefined ? { colour: p.colour } : {}),
        }),
      deleteList: (p) =>
        call<{ deleted: boolean }>("directory", {
          op: "deleteList",
          hostDid: p.hostDid,
          listId: p.listId,
          ...(p.member !== undefined ? { member: p.member } : {}),
        }),
      presentCredential: (p) =>
        call<PageVerifiedFieldsView>("directory", {
          op: "presentCredential",
          hostDid: p.hostDid,
          fields: Array.isArray(p.fields) ? [...p.fields] : p.fields,
          ...(p.member !== undefined ? { member: p.member } : {}),
        }),
    },
    git: {
      linkAccount: (p) =>
        call<PageGitLinkView>("git", {
          op: "linkAccount",
          hostDid: p.hostDid,
          forge: p.forge,
          ...(p.member !== undefined ? { member: p.member } : {}),
        }),
      unlinkAccount: (p) =>
        call<PageGitUnlinkView>("git", {
          op: "unlinkAccount",
          hostDid: p.hostDid,
          forge: p.forge,
          ...(p.accountId !== undefined ? { accountId: p.accountId } : {}),
          ...(p.member !== undefined ? { member: p.member } : {}),
        }),
    },
  };
}
