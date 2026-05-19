# pnm-browser-plugin

Browser-side bridge between **WebAuthn passkeys** and **VTA-managed
DIDs**. Lets an operator (or end user) prove control of a DID hosted
in a remote Verifiable Trust Agent by performing a passkey ceremony in
the browser — no DID private keys ever leave the VTA, and no
long-lived bearer token sits in browser storage.

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
                                       └────────────────┘
```

## Form factors

Two shells over one shared TypeScript core:

| Package | Role |
|---|---|
| `@pnm/core` | Wire types, WebAuthn ceremony helpers, COSE→Multikey conversion, DID `verificationMethod` builder, VTA REST + DIDComm client surfaces. Zero runtime dependencies on a framework. |
| `@pnm/didcomm-wasm` | wasm-bindgen wrapper over `affinidi-messaging-didcomm` (Rust crate, same version `vta-service` pins). Byte-compatible with the VTA. Vendored locally; expected to be replaced by an upstream npm package when `affinidi-tdk-rs` ships its own WASM build. |
| `@pnm/pwa` | Installable web app (Vite + React 19). Operator-facing wallet for connecting to a VTA and managing passkeys. |
| `@pnm/extension` | Manifest v3 browser extension. Same flows, plus future ability to intercept RP login pages and inject SIOPv2/OpenID4VP responses. |

## First milestone — enroll a passkey as a DID `verificationMethod`

1. Operator points the app at a running VTA and authenticates with an
   existing admin credential (the standard `pnm bootstrap connect`
   flow already produces one).
2. App triggers `navigator.credentials.create(...)`. The authenticator
   produces a credential whose public key is COSE-encoded.
3. App parses the COSE_Key, converts it to **W3C Multikey** form
   (multicodec `0x1200` for P-256 / ES256, `0xed01` for Ed25519,
   multibase-base58btc with the `z` prefix).
4. App POSTs `{ credential_id, multikey_pubkey, attestation_object }`
   to the VTA (`POST /did/verification-methods` — new endpoint, see
   [docs/passkey-did-binding.md](docs/passkey-did-binding.md) for the
   contract).
5. VTA appends a WebVH LogEntry adding the VM with `id =
   <did>#passkey-<sha256(credential_id)>` and purpose
   `authentication`.
6. From then on, any RP can verify a WebAuthn assertion against the
   VM by resolving the DID — no shared secret, no callback to the
   VTA.

## Status

Scaffold + core enrollment ceremony. The VTA-side endpoint is
documented in [docs/passkey-did-binding.md](docs/passkey-did-binding.md)
but not yet implemented in `vta-service`; the browser code targets
the documented contract and can be exercised against a mock today.

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
    ├── pwa/              @pnm/pwa
    └── extension/        @pnm/extension
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
