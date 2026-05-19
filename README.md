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
│  @pnm/core                                                      │
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
│  @pnm/didcomm-wasm                                              │
│     wasm-bindgen wrapper over affinidi-messaging-didcomm 0.13   │
│     Identity { generate, fromSecretJwk, publicJwk, secretJwk }  │
│     packAuthcrypt / packAnoncrypt / wrapForward / unpack        │
│     packAnoncryptJson / packAuthcryptJson (preserves extras)    │
└─────────────────────────────────────────────────────────────────┘
```

Every layer has matching ownership:

- **WASM crate** owns crypto: HPKE-style authcrypt (ECDH-1PU +
  A256CBC-HS512), anoncrypt (ECDH-ES + A256CBC-HS512), Ed25519
  signatures, Routing 2.0 forward envelopes. Byte-compatible with
  the Rust VTA because both link the same `affinidi-messaging-didcomm`
  crate version.
- **@pnm/core** owns the wire protocols + transport abstraction.
  REST (`VtaClient`) and DIDComm (`DidcommVtaTransport`) implement
  the same `VtaTransport` interface; pick at boot.
- **Bridge implementations** own network I/O. `WebSocketDidcommBridge`
  is the production bridge (mediator over WSS, Pickup 3.0 live mode
  via `Pickup3Dispatcher`, concurrent thid demuxing).
  `InMemoryDidcommBridge` simulates both mediator and VTA for tests.
- **`WalletSession`** is the only thing the UI talks to. One call —
  `bootstrap()` — does identity load/mint, mediator enrollment (if
  needed), and constructs a ready `VtaTransport`.
- **PWA / extension** are thin shells over `@pnm/core`.

## Form factors

| Package | Role |
|---|---|
| `@pnm/core` | Wire types, WebAuthn ceremony helpers, COSE→Multikey conversion, DID `verificationMethod` builder, REST + DIDComm transports, mediator client, bridges, wallet orchestration. |
| `@pnm/didcomm-wasm` | wasm-bindgen wrapper over `affinidi-messaging-didcomm` (Rust crate, same version `vta-service` pins). Byte-compatible with the VTA. Vendored locally; expected to migrate to an upstream npm package when `affinidi-tdk-rs` ships its own WASM build. |
| `@pnm/pwa` | Installable web app (Vite + React 19). Operator-facing wallet for connecting to a VTA and managing passkeys. Has a `/smokes` diagnostic page that runs all eight smokes in-browser. |
| `@pnm/extension` | Manifest v3 browser extension. Same flows, plus future ability to intercept RP login pages and inject SIOPv2/OpenID4VP responses. |

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

## End-to-end validation

Eight smokes cover every link. Run from a browser at `/smokes` or
invoke directly via `@pnm/core`:

| Smoke | What it proves |
|---|---|
| `smokeAuthcryptRoundtrip` | WASM authcrypt + unpack round-trips intact |
| `smokeBuildDidcommEnrollChallenge` | Full forward+anoncrypt envelope assembly |
| `smokeDidcommVtaTransportRoundtrip` | DIDComm enrollment exchange via in-memory bridge |
| `smokeWsBridgeDemux` | Two concurrent requests resolved by `thid` despite reverse-order delivery |
| `smokeMediatorEnrollment` | mediate-request → grant → keylist-update |
| `smokePickupDispatch` | pickup/3.0/delivery unwrap returns inner JWEs |
| `smokeMediatorNotifications` | live-delivery-change + messages-received notifications |
| `smokeWalletBoot` | Full WalletSession bootstrap on first run + resume on second run |

All validated end-to-end via `wasm-pack build --target nodejs` +
direct Node execution of the compiled @pnm/core output.

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
    ├── core/             @pnm/core
    │   └── src/
    │       ├── webauthn/      passkey ceremony helpers, COSE→Multikey
    │       ├── did/           verificationMethod builder
    │       ├── didcomm/       TS wrappers around the WASM crypto
    │       ├── store/         KVStore + holder identity persistence
    │       └── vta/           transports, bridges, MediatorClient,
    │                          WalletSession, smokes
    ├── didcomm-wasm/     @pnm/didcomm-wasm (wasm-pack crate)
    ├── pwa/              @pnm/pwa (Vite + React 19)
    └── extension/        @pnm/extension (Manifest v3)
```

## Development

Prereqs: Node 20+, the Rust toolchain (1.94+), and
[`wasm-pack`](https://rustwasm.github.io/wasm-pack/installer/). The
WASM crate is rebuilt as part of `npm run build`, so the Rust
toolchain is needed for the full build but not for editing
TypeScript-only packages.

```bash
npm install
npm run build              # builds @pnm/didcomm-wasm (wasm-pack)
                           # then tsc -b + vite build across TS workspaces
npm run dev:pwa            # http://localhost:5173
npm run dev:extension      # load packages/extension/dist as unpacked
```

After editing `packages/didcomm-wasm/src/lib.rs` or bumping the
`affinidi-messaging-didcomm` dependency, run
`npm run build --workspace @pnm/didcomm-wasm` to regenerate the
WASM bundle.

### Validating in a browser

```bash
npm run dev:pwa
# open http://localhost:5173/smokes → click "Run all"
```

All eight smokes should pass. The WASM module loads ~190 KB
gzipped, and the diagnostics page exercises every layer of the
stack including the WebSocket bridge's thid demuxer and the full
WalletSession boot.
