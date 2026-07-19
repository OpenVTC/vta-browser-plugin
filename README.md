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
5. **Open the Options page and set your mediator DID before doing
   anything else.** Right-click the toolbar icon → **Options** (or
   click the gear in the popup) and paste the DID of the mediator
   you intend to use. The wallet ships with a placeholder default
   pointing at a demo mediator — leaving it in place will work, but
   the mediator DID gets baked into your holder `did:peer` the
   first time you onboard a VTA, and changing it later re-mints a
   brand-new wallet identity that must be re-granted in every
   relying party's ACL. Set it once, up front.
6. Onboard your first VTA from the popup. Optionally fill in the
   **Default step-up VTA DID / mediator DID** fields in Options so
   subsequent step-up flows are pre-populated.

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

### Validating in a browser

```bash
npm run dev:pwa
# open http://localhost:5173/smokes → click "Run all"
```

All smokes should pass. The diagnostics page exercises every layer
of the stack including the WebSocket bridge's thid demuxer and the
full WalletSession boot.
