# pnm-browser-plugin

Browser-side bridge between **WebAuthn passkeys** and **VTA-managed
DIDs**. Lets an operator prove control of a DID hosted in a remote
Verifiable Trust Agent by performing a passkey ceremony in the
browser — no DID private keys ever leave the VTA, and no long-lived
bearer token sits in browser storage. Speaks both REST and **full
DIDComm v2** to the VTA, including when the VTA is private-network
and only reachable via a mediator.

## Why

Passkeys solve local user authentication beautifully (synced
keychains, biometric unlock, phishing-resistant). DIDs solve global
identity (self-sovereign, portable, signable). Neither alone solves
"log into a third-party site as the controller of my VTA DID."

This project glues the two together: a passkey is enrolled as a
`verificationMethod` (purpose: `authentication`) in the DID document
the VTA publishes via WebVH. Any verifier that resolves the DID can
then validate a WebAuthn assertion against the embedded public key
without ever talking to the VTA — the DID document *is* the trust
anchor.

```
┌──────────────┐  WebAuthn        ┌────────────────┐
│   Browser    │ ───────────────▶ │  Authenticator │ (Touch ID,
│ (PWA / ext)  │ ◀─────────────── │   / Passkey    │  Windows Hello,
└──────┬───────┘   pubkey + sig   └────────────────┘  YubiKey, …)
       │
       │ enroll(passkey_pubkey)        verify(assertion)
       ▼                                       ▲
┌──────────────┐                       ┌───────┴────────┐
│      VTA     │ ── WebVH update ─────▶│ Public DID doc │
│ (remote)     │                       │ (resolvable by │
└──────────────┘                       │  any verifier) │
                                       └───────┬────────┘
```

## Architecture (layer cake)

```
┌─────────────────────────────────────────────────────────────────┐
│  PWA (Vite + React 19)            MV3 Extension (Vite + React)  │
│  packages/pwa                     packages/extension            │
└────────────────────────────┬────────────────────────────────────┘
                             │
┌────────────────────────────▼────────────────────────────────────┐
│  @openvtc/pnm-core                                                      │
│                                                                 │
│  WalletSession ─────────────────────────────────────┐           │
│     │                                               │           │
│     ├─ generateOrLoadHolderIdentity   (KVStore)     │           │
│     │     ├─ IndexedDBKVStore         (browser)     │           │
│     │     └─ InMemoryKVStore          (tests)       │           │
│     │                                               │           │
│     ├─ MediatorClient (coordinate-mediation/2.0)    │           │
│     │     ├─ requestMediation                       │           │
│     │     ├─ updateKeylist                          │           │
│     │     ├─ setLiveDelivery                        │           │
│     │     └─ acknowledgeMessages                    │           │
│     │                                               │           │
│     └─ DidcommVtaTransport (passkey-management/1.0) │           │
│            (implements VtaTransport)                │           │
│                                                     │           │
│  VtaClient  (REST, implements VtaTransport) ───────┘           │
│                                                                 │
│  DidcommMessageBridge interface ┐                               │
│     ├─ WebSocketDidcommBridge   │   multi-sender registry       │
│     │     ├─ RawDispatcher      │   (skid-based JWE peek)       │
│     │     └─ Pickup3Dispatcher  │   (live-mode unwrap)          │
│     └─ InMemoryDidcommBridge    │   (test simulator)            │
│                                 │                               │
│  webauthn/  did/  vta/  store/  didcomm/                        │
└────────────────────────────┬────────────────────────────────────┘
                             │
┌────────────────────────────▼────────────────────────────────────┐
│  @openvtc/vti-didcomm-js  (npm dependency)                      │
│     WebCrypto-backed DIDComm v2 primitives                      │
│     Identity { generate, fromSecretJwk, publicJwk, secretJwk }  │
│     packAuthcrypt / packAnoncrypt / wrapForward / unpack        │
│     packAnoncryptJson / packAuthcryptJson (preserves extras)    │
└─────────────────────────────────────────────────────────────────┘
```

Every layer has matching ownership:

- **`@openvtc/vti-didcomm-js`** owns crypto: HPKE-style authcrypt
  (ECDH-1PU + A256CBC-HS512), anoncrypt (ECDH-ES + A256CBC-HS512),
  Ed25519 signatures, Routing 2.0 forward envelopes. Pulled in as
  an npm dependency — no Rust toolchain required to build this
  workspace.
- **@openvtc/pnm-core** owns the wire protocols + transport abstraction.
  REST (`VtaClient`) and DIDComm (`DidcommVtaTransport`) implement
  the same `VtaTransport` interface; pick at boot.
- **Bridge implementations** own network I/O. `WebSocketDidcommBridge`
  is the production bridge (mediator over WSS, Pickup 3.0 live mode
  via `Pickup3Dispatcher`, concurrent thid demuxing).
  `InMemoryDidcommBridge` simulates both mediator and VTA for tests.
- **`WalletSession`** is the only thing the UI talks to. One call —
  `bootstrap()` — does identity load/mint, mediator enrollment (if
  needed), and constructs a ready `VtaTransport`.
- **PWA / extension** are thin shells over `@openvtc/pnm-core`.

## Form factors

| Package | Role |
|---|---|
| `@openvtc/pnm-core` | Wire types, WebAuthn ceremony helpers, COSE→Multikey conversion, DID `verificationMethod` builder, REST + DIDComm transports, mediator client, bridges, wallet orchestration. |
| `@openvtc/pnm-pwa` | Installable web app (Vite + React 19). Operator-facing wallet for connecting to a VTA and managing passkeys. Has a `/smokes` diagnostic page that runs the in-browser smoke suite. |
| `@openvtc/pnm-extension` | Manifest v3 browser extension. Same flows, plus future ability to intercept RP login pages and inject SIOPv2/OpenID4VP responses. |

## First milestone — enroll a passkey as a DID `verificationMethod`

1. Operator points the app at a running VTA and authenticates with an
   existing admin credential (the standard `pnm bootstrap connect`
   flow already produces one) — *or* the wallet bootstraps over
   DIDComm via `WalletSession`.
2. App triggers `navigator.credentials.create(...)`. The authenticator
   produces a credential whose public key is COSE-encoded.
3. App parses the COSE_Key, converts it to **W3C Multikey** form
   (multicodec `0x1200` for P-256 / ES256, `0xed01` for Ed25519,
   multibase-base58btc with the `z` prefix).
4. App POSTs `{ credential_id, multikey_pubkey, attestation_object }`
   to the VTA (`POST /did/verification-methods/passkey` — new endpoint,
   see [docs/passkey-did-binding.md](docs/passkey-did-binding.md) for the
   contract).
5. VTA appends a WebVH LogEntry adding the VM with `id =
   <did>#passkey-<sha256(credential_id)>` and purpose
   `authentication`.
6. From then on, any RP can verify a WebAuthn assertion against the
   VM by resolving the DID — no shared secret, no callback to the
   VTA.

## DIDComm-only VTA support

When the VTA has `services rest disable`'d and is only reachable via
its DIDComm mediator, the wallet stack handles it transparently:

```ts
const session = new WalletSession({
  store: new IndexedDBKVStore(),
  mediator: {
    websocketUrl: "wss://mediator.example.com/ws",
    did: "did:key:zMediator…",
    keyAgreementKid: "did:key:zMediator…#key-agreement-1",
    keyAgreementPublicJwk: { kty: "OKP", crv: "X25519", x: "…" },
  },
  vta: {
    did: "did:webvh:vta.example.com:abc",
    keyAgreementKid: "did:webvh:…#key-agreement-1",
    keyAgreementPublicJwk: { kty: "OKP", crv: "X25519", x: "…" },
  },
});

await session.bootstrap();          // mint or load holder, enroll w/ mediator
await session.setLiveDelivery(true);// pickup/3.0 live-mode push
const challenge = await session
  .transport()
  .requestEnrollmentChallenge(holder.did);  // passkey-management/1.0
```

On first run: mints a did:key holder identity, registers with the
mediator (coordinate-mediation/2.0), persists state.

On subsequent runs: loads the holder identity, detects the existing
mediator relationship, skips re-enrollment.

All messages travel as:
- inner: `authcrypt(holder → VTA, passkey-management/1.0/...)`
- wrapped: `routing/2.0/forward` envelope addressed to the VTA
- outer: `anoncrypt(forward → mediator)`

The mediator delivers the inner JWE to the VTA. Replies travel back
via the wallet's mediator inbox, decrypted by `Pickup3Dispatcher`,
and demuxed by `thid` to the waiting Promise.

### Mediator CORS (browser requirement)

The wallet runs **in the browser**, so the mediator's WebSocket
(`wss://…/ws`) and REST (`/inbound`, `/authenticate`, …) endpoints must
allow the **origin the wallet page is served from** — either by echoing
that exact origin in `Access-Control-Allow-Origin`, or with `*`. This is
a mediator-side configuration; the wallet cannot work around it.

Symptom of a missing/incorrect CORS allow-list: the REST auth handshake
succeeds (or appears to), but opening the live-delivery socket fails with

```
mediator-transport: WebSocket failed to open (close code 1006)
```

A browser rejects a cross-origin WebSocket upgrade *before* the socket
opens, which surfaces as an abnormal **1006** close with no HTTP status —
indistinguishable, from the client side, from a refused upgrade or a
proxy that strips the `Upgrade` header. If REST auth works from the same
page but the WS gives 1006, **check the mediator's CORS allow-list for
your wallet origin first.**

For a self-hosted `affinidi-messaging-mediator`, set the allowed origins
in its config (e.g. `cors_allow_origin`) to include your wallet's origin
(`http://localhost:5173` in dev, your extension/PWA origin in prod), or
`*` for a permissive dev setup. Restart the mediator after changing it.

## End-to-end validation

Six smokes cover the main DIDComm + wallet links. Run from a browser
at `/smokes` or invoke directly via `@openvtc/pnm-core`:

| Smoke | What it proves |
|---|---|
| `smokeAuthcryptRoundtrip` | authcrypt + unpack round-trips intact |
| `smokeBuildDidcommEnrollChallenge` | Full forward+anoncrypt envelope assembly |
| `smokeDidcommVtaTransportRoundtrip` | DIDComm enrollment exchange via in-memory bridge |
| `smokeMediatorEnrollment` | mediate-request → grant → keylist-update |
| `smokeMediatorNotifications` | live-delivery-change + messages-received notifications |
| `smokeWalletBoot` | Full WalletSession bootstrap on first run + resume on second run |

## Status

Scaffold + core enrollment ceremony + REST client + complete DIDComm
v2 stack (authcrypt, anoncrypt, forward, coordinate-mediation/2.0,
pickup/3.0 live mode) + WalletSession orchestrator.

The VTA-side endpoint is documented in
[docs/passkey-did-binding.md](docs/passkey-did-binding.md) but not
yet implemented in `vta-service`; the browser code targets the
documented contract and can be exercised against a mock today.

## Layout

```
pnm-browser-plugin/
├── package.json          (npm workspaces root)
├── tsconfig.base.json    (shared compiler options)
├── tsconfig.json         (solution-style references)
├── docs/
│   └── passkey-did-binding.md
└── packages/
    ├── core/             @openvtc/pnm-core
    │   └── src/
    │       ├── webauthn/      passkey ceremony helpers, COSE→Multikey
    │       ├── did/           verificationMethod builder
    │       ├── didcomm/       TS facade over @openvtc/vti-didcomm-js
    │       ├── store/         KVStore + holder identity persistence
    │       └── vta/           transports, bridges, MediatorClient,
    │                          WalletSession, smokes
    ├── pwa/              @openvtc/pnm-pwa (Vite + React 19)
    └── extension/        @openvtc/pnm-extension (Manifest v3)
```

## Development

Prereqs: Node 24+. No Rust toolchain needed — DIDComm crypto comes
from the `@openvtc/vti-didcomm-js` npm package.

```bash
npm install
npm run build              # tsc -b + vite build across TS workspaces
npm run dev:pwa            # http://localhost:5173
npm run dev:extension      # vite watch into packages/extension/dist
```

### Installing the extension into your browser

After `npm run build` (or while `npm run dev:extension` is running),
`packages/extension/dist/` contains a complete unpacked Manifest v3
extension. Side-load it like this:

**Chrome / Edge / Brave / Arc**

1. Open `chrome://extensions` (or `edge://extensions`,
   `brave://extensions`, `arc://extensions`).
2. Toggle **Developer mode** on (top-right).
3. Click **Load unpacked** and select
   `packages/extension/dist/` from this checkout.
4. Pin **VTA Wallet** to the toolbar (Chrome's puzzle-piece icon →
   pin) so it's one click away.
5. **Setup opens automatically on install.** Work through it top to
   bottom — the order matters. The agent's address comes first because
   its mediator is resolved from it; you're only asked for a mediator
   if the agent publishes none. The passkey lock and your inbox follow.
   You can reopen it any time at **Options → Setup**, or from the
   popup's **Open setup** button.

   The agent field takes either form: an agent name
   (`webvh.storm.ws/@glenn-vta`) or a full `did:webvh:…`. A name is
   resolved in three stages — HTTPS redirect to a DID, DID resolution,
   then the document must claim the name back via `alsoKnownAs`. The
   third stage is mandatory: a redirect alone proves nothing, since
   whoever controls a domain can point a name at somebody else's DID.
   The DID is what gets stored; names are re-claimable.

   Onboarding deliberately runs in a tab rather than the toolbar popup:
   Chrome tears the popup down whenever a native dialog takes focus
   (crbug 40721470), and this flow raises two — the host-permission
   grant and the passkey ceremony.
6. Optional extras — a separate approver identity, background wake-up,
   step-up defaults — live under **Advanced** and can wait.

**Firefox**

Not supported out of the box: Firefox's MV3 service-worker support
diverges from Chromium and the manifest would need adjusting. Not in
scope today.

**Reloading after a rebuild**

`npm run dev:extension` rebuilds into `dist/` on change, but Chrome
does not auto-pick up the new bundle for a side-loaded extension.
After each rebuild, click the reload icon on the **VTA Wallet** card
in `chrome://extensions`.

**Debugging**

`chrome://extensions` → **VTA Wallet** → **service worker** opens
DevTools for the background script. The popup, options page, and
offscreen document each have their own DevTools — right-click →
Inspect on the popup, or use the **Inspect views** links on the
extension card.

### Permissions model

The extension requests **no host permissions at install time** and declares
**no static content scripts**. The manifest carries `optional_host_permissions`
only, and the page provider is registered at runtime for granted origins
(`src/content-registration.ts`) — so the install prompt no longer asks to read
and change your data on all websites.

A grant therefore means three things at once: the wallet may talk to that host,
may write its cookies, and `window.vtaWallet` exists on its pages. Turning a
site off in **Sites** stops all three.

The wallet asks for one origin at a time, at the moment it needs it:

- **Connecting to a VTA** — the host is read out of the `did:webvh` before any
  request is made, and Chrome prompts on the Prepare click. Needed because
  vta-service applies an origin-allowlist CORS layer.
- **Signing in to a bound origin** — the "Sign in to …" button on a ready
  session prompts for that site, then writes the SessionBlob's cookies.
- **Visiting a site for the first time** — the popup shows "Enable on
  <site>". Until then the site cannot see the wallet at all, so its sign-in
  button does nothing; enabling registers the provider and reloads the page.
  Cookies are never written automatically, and never for a domain that does
  not domain-match the bound origin (`src/cookie-scope.ts`).

Resolving DIDs needs no grant: the did:webvh hosting service serves public
resolution with `Access-Control-Allow-Origin: *`. A did:webvh host behind a
restrictive CORS policy is the known gap — it surfaces in the consent prompt
as an unresolved DID, which fails closed.

### Cookie injection is for legacy relying parties only

The normal sign-in path writes no cookies: a SIOPv2 sign-in returns a signed
`id_token` the site verifies itself, and a DIDComm login never touches the jar.
`chrome.cookies.set` serves exactly one case — a relying party that is an
ordinary web app with a server-side session and no notion of DIDs.

That boundary is enforced, not just intended (`src/cookie-scope.ts`): the write
happens only on an explicit click, only for an origin the user granted at that
moment, only over HTTPS (bar loopback), and only for cookies whose domain
RFC 6265 domain-matches the bound origin. Nothing is ever read from the jar.

Keep the boundary sharp when changing this code — see
[docs/web-store-review.md](docs/web-store-review.md). "The wallet writes cookies
for sites you signed in to through a legacy password form" is a claim a
reviewer can check; "the wallet can write cookies" is not.

### Packaging for the Chrome Web Store

```bash
npm run package --workspace @openvtc/pnm-extension
# → packages/extension/release/vta-wallet-<version>.zip
```

The zip holds the *contents* of `dist/` (manifest at the archive root,
as the Store requires). CI builds and validates it on every run and
uploads it as the `vta-wallet-extension` artifact, so a submission is
never the first time the packaging path runs.

**Version.** `packages/extension/package.json` is the single source of
truth; `packages/extension/manifest.json` is a template and carries no
`version` field. The build injects it and rejects anything the Store
would reject — npm prerelease spellings like `0.3.0-rc.1` are not valid
Chrome versions. Bump the package version before each upload: the Store
refuses a version that is not greater than the last one it accepted.

**Extension ID.** `chrome.runtime.id` is load-bearing — `src/holder.ts`
uses it as the WebAuthn PRF rpId, so if it changes, every
passkey-wrapped secret becomes unopenable and any
`chrome-extension://<id>` allowlist (VTA CORS) breaks. It is pinned by
`extension-key.txt`, whose public key the build injects into `dist/`'s
manifest as `key`.

The Store zip deliberately omits `key`: the Store issues its own key on
the first upload of a new item and rejects a package that carries one.
So the local ID matches the published one only after cutover — once the
item exists in the Developer Dashboard, replace `extension-key.txt`
with the dashboard's **Package → View public key** value and delete
`extension-key.pem`. Confirm the result:

```bash
npm run generate:key --workspace @openvtc/pnm-extension -- --show
# prints the derived ID; it must equal the dashboard's Item ID
```

Until then the pinned key is a locally generated one (`npm run
generate:key`), which holds the ID still across machines and checkouts
but is *not* the published ID. Cutover re-keys every dev passkey once.

### Validating in a browser

```bash
npm run dev:pwa
# open http://localhost:5173/smokes → click "Run all"
```

All smokes should pass. The diagnostics page exercises every layer
of the stack including the WebSocket bridge's thid demuxer and the
full WalletSession boot.
