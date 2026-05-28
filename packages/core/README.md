# @openvtc/pnm-core

Browser-side bridge between **WebAuthn passkeys** and **VTA-managed
DIDs**. Lets a relying party prove the user controls a DID hosted in
a remote Verifiable Trust Agent (VTA) by performing a passkey
ceremony in the browser — no DID private keys ever leave the VTA,
and no long-lived bearer token sits in browser storage. Speaks both
REST and **full DIDComm v2** to the VTA, including when the VTA is
private-network and only reachable via a mediator.

This package is the shared TypeScript library that backs the
[Personal Network Manager browser
plugin](https://github.com/OpenVTC/vta-browser-plugin): both the
[PWA](https://github.com/OpenVTC/vta-browser-plugin/tree/main/packages/pwa)
and the
[Manifest v3 extension](https://github.com/OpenVTC/vta-browser-plugin/tree/main/packages/extension)
are thin shells over it. External consumers can use it directly to
build mobile companions, desktop wallets, or RP-side integrations
that need the same flows without the bundled UI.

## Install

```sh
npm install @openvtc/pnm-core
```

## What it gives you

| Sub-module | Surface |
|---|---|
| **`@openvtc/pnm-core/webauthn`** | Passkey enrol / login ceremonies, COSE-key extraction, DID `verificationMethod` builder, PRF-derived secret-wrap helpers. |
| **`@openvtc/pnm-core/did`** | Multikey ↔ JWK conversion, DID-URL parsing, did:webvh log resolution. |
| **`@openvtc/pnm-core/vta`** | Typed REST + DIDComm transports against a VTA daemon. Mirrors the [`vta-sdk`](https://crates.io/crates/vta-sdk) Rust client's surface. |
| Plus modules for | SIOPv2 / OpenID4VP RP-side helpers, sealed-bootstrap provisioning, vault proxy-login flows, Trust-Task envelope construction, indexed-DB key/value persistence. |

The package's [`src/index.ts`](https://github.com/OpenVTC/vta-browser-plugin/blob/main/packages/core/src/index.ts)
re-exports everything from a single entry; the slash-suffixed
sub-entries above are an optional convenience for callers who only
want a slice of the surface.

## Minimal example — passkey enrolment

```ts
import {
  beginEnrolment,
  finishEnrolment,
  type WebauthnEnrolmentChallenge,
} from "@openvtc/pnm-core";

// 1. Ask the VTA for an enrolment challenge for the named DID.
const challenge: WebauthnEnrolmentChallenge = await vtaClient.enrolBegin({
  did: "did:webvh:example.com:alice",
});

// 2. Run the WebAuthn create() ceremony in the browser.
const credential = await beginEnrolment(challenge);

// 3. Submit the assertion. The VTA verifies it, appends the COSE
//    public key as a `verificationMethod` on the WebVH log, and
//    publishes the new DID-document revision.
const result = await finishEnrolment(credential, challenge.session_id);
```

## Wire compatibility

This package is byte-compatible with:

- The Rust [`vta-sdk`](https://crates.io/crates/vta-sdk) — typed VTA client used by the `pnm` CLI and other server-side consumers.
- The Rust [`did-hosting-client`](https://github.com/affinidi/affinidi-webvh-service/tree/main/did-hosting-client) — typed WebVH hosting client.
- The TypeScript [`@openvtc/vti-didcomm-js`](https://www.npmjs.com/package/@openvtc/vti-didcomm-js) — DIDComm v2 framing helpers (a runtime dependency of this package).
- The TypeScript [`@openvtc/trust-tasks`](https://www.npmjs.com/package/@openvtc/trust-tasks) — generated payload types for the [Trust Tasks framework](https://trusttasks.org).

A change to the wire surface is made in [`dtgwg-trust-tasks-tf`](https://github.com/trustoverip/dtgwg-trust-tasks-tf)
first, regenerates the Rust + TS bindings, and only then lands in
this package — see the project's spec-first development discipline.

## Architecture

```
┌──────────────┐  WebAuthn        ┌────────────────┐
│   Browser    │ ───────────────▶ │  Authenticator │ (Touch ID,
│ (PWA / ext)  │ ◀─────────────── │   / Passkey    │  Windows Hello,
└──────┬───────┘   pubkey + sig   └────────────────┘  YubiKey, …)
       │
       │ enrol(passkey_pubkey)         verify(assertion)
       ▼                                       ▲
┌──────────────┐                       ┌───────┴────────┐
│      VTA     │ ── WebVH update ─────▶│ Public DID doc │
│   (remote)   │                       │ (resolvable by │
└──────────────┘                       │  any verifier) │
                                       └────────────────┘
```

A passkey is enrolled as a `verificationMethod` (purpose:
`authentication`) in the DID document the VTA publishes via WebVH.
Any verifier that resolves the DID can then validate a WebAuthn
assertion against the embedded public key without ever talking to
the VTA — the DID document *is* the trust anchor.

## Browser / runtime support

- Modern browsers with WebAuthn level 2 + WebCrypto (Chrome 108+,
  Safari 17+, Firefox 122+).
- Node 20+ for server-side use (the WebAuthn-specific entry points
  are no-ops in non-browser contexts; the DID / VTA / DIDComm
  transports work everywhere).

ESM-only — no CommonJS build.

## Versioning

Pre-1.0 (`0.x`) — breaking changes may land in minor bumps. The
internal contract this package depends on (`@openvtc/vti-didcomm-js`,
`@openvtc/trust-tasks`) follows the same cadence. Once the
underlying `SPEC.md` reaches 1.0 this package will follow.

## License

Apache-2.0. See [LICENSE](https://github.com/OpenVTC/vta-browser-plugin/blob/main/LICENSE)
at the repo root.

## Contributing

Source lives in
[`OpenVTC/vta-browser-plugin`](https://github.com/OpenVTC/vta-browser-plugin)
under `packages/core/`. See the
[root README](https://github.com/OpenVTC/vta-browser-plugin#readme)
for the workspace layout, development setup, and the smoke-test
harness.
