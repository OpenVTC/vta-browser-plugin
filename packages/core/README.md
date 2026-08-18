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
| **`@openvtc/pnm-core/vta`** | The VTA protocol: Trust-Task envelopes, REST/DIDComm/TSP channels, and the REST auth bootstrap. Mirrors the [`vta-sdk`](https://crates.io/crates/vta-sdk) Rust client's surface. |
| **`@openvtc/pnm-core/vault`** | Vault Trust Tasks — list, upsert, delete, release, proxy-login, sign. |
| **`@openvtc/pnm-core/admin`** | Agent administration: `acl/*` (grant, list, show, revoke, change-role), `keys/*` (create, list, show, rename, revoke, sign), `policy/*` (list, get, upsert, delete), session introspection (whoami, sessions, revoke), and context deletion. Operator surface — not in the root barrel, import it explicitly. |
| **`@openvtc/pnm-core/siop`** | SIOPv2 / OpenID4VP RP-side helpers. |
| **`@openvtc/pnm-core/provision`** | Sealed-bootstrap provisioning (`provision/integration`). |
| **`@openvtc/pnm-core/didcomm`** | DIDComm v2 packing, mediator routing, forward envelopes. |
| **`@openvtc/pnm-core/store`** | Key/value persistence (IndexedDB in a browser, in-memory elsewhere). |
| Plus | `/device`, `/inbound`, `/onboarding`, `/rp-login`, `/trust-tasks`, `/http`, `/util`. |

**Import the module you need, not the package.** Every module directory is a
published entry point, the package is marked `sideEffects: false`, and the
modules are layered so that lower ones never import higher ones — so
`import "@openvtc/pnm-core/vta"` gets you the VTA protocol without the
wallet's WebAuthn ceremonies or its IndexedDB store coming with it. Two tests
enforce this rather than trusting it (`tests/package.module-boundaries.mjs`,
`tests/package.entry-points.mjs`): one fails the build on a sideways or upward
import or a cycle, the other imports every advertised entry point in plain Node
so a stray browser global cannot reach npm.

The root [`src/index.ts`](https://github.com/OpenVTC/vta-browser-plugin/blob/main/packages/core/src/index.ts)
still re-exports everything, for callers who want it all in one import.

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

### Types come from the specification, not from a copy of it

The `admin/*` calls take their payload types, response types and task URIs from
[`@openvtc/trust-tasks`](https://www.npmjs.com/package/@openvtc/trust-tasks) —
generated from the same JSON Schemas the agent's own implementation is generated
from. This package supplies the call layer: envelope, dispatch, unwrap.

### Checked against the agent, not assumed

Every VTA call this library makes names a canonical Trust-Task URI, and
`task-surface.json` is a committed snapshot of the surface the agent actually
publishes (from `vta-sdk`). `tests/task-surface.mjs` holds the two of them
together:

- a URI this library names that the agent has never heard of — a typo, a
  rename, a task that moved — fails the build here rather than at a user;
- a task version the SDK has **deprecated** fails too, during the window where
  the agent still accepts it and everything appears to work;
- **coverage is a recorded number** (40 of 270 task families today), so a gap
  that grows or shrinks shows up in a diff someone reviews.

Refresh the snapshot against a local checkout:

```sh
npm run tasks:sync -- /path/to/vta-sdk
```


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
