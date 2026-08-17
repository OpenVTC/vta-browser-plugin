# Changelog

All notable changes to `@openvtc/pnm-core` are documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this package adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).
For history before this file, see `git log` on `packages/core`.

## [Unreleased]

## [0.4.0] - 2026-08-17

### Changed

- **The sealed-bundle path no longer needs `crypto.subtle`, and no longer
  carries its own HPKE.** `provision/hpke.ts` used `@hpke/core` +
  `@hpke/chacha20poly1305` directly; it now calls `openBase` from
  `@openvtc/vti-tsp-js/hpke`, the ecosystem's single RFC 9180 implementation
  (pure TypeScript on `@noble`).

  The repo previously held two independent implementations of the same suite —
  base mode here, auth mode in tsp-js — which is the duplication the stack
  guide's **R4.1** warns about. There is now one key schedule.

  `hpkeOpen` keeps its exact signature, validation and error strings; the
  sealed-bundle wire format is unchanged. This is transparent to callers.

### Removed

- **`@hpke/core` and `@hpke/chacha20poly1305` are no longer runtime
  dependencies.** They are retained as dev-dependencies, where they now seal
  the fixtures that hold the new implementation byte-identical to the one it
  replaced.

  This matters for React Native hosts: `@openvtc/pnm-core` no longer drags a
  WebCrypto-dependent HPKE into the install. **It is not yet `crypto.subtle`-free**
  — WebAuthn, the PRF vault wrap, DID verification methods and trust-task
  canonicalisation all still use it. This removes HPKE from that list, not the
  rest.

### Security

- `hpkeOpen` — the VTA sealed-bundle decryption path — **had no direct test
  coverage** before this release. `tests/provision.hpke-open.mjs` adds seven
  cases in which the *sealing* side is hpke-js, deliberately the other
  implementation: a round-trip against our own seal would pass even if both
  directions drifted together. It covers the pinned `vta-sealed-transfer/v1`
  info binding, the chunk-header AAD binding, wrong-recipient, ciphertext and
  AAD tampering, and length validation.

### Fixed

- **Every VTA rejection was decoded as a success** (`vta/protocol.ts`).
  `isTrustTaskErrorType` enumerated `trust-task-error/0.1` and `/0.2`;
  `trust-tasks-rs` has emitted `/0.3` since its 0.3 release (it carries the
  §8.2 `inResponseTo` member, which `0.2`'s `additionalProperties: false`
  payload schema cannot). An unrecognised error document is not treated as an
  error — `parseTrustTaskReply` returns its payload as the operation's *result* —
  so a refused task reported success to the calling page. A `webvh/dids/update`
  the VTA refused rendered "your agent signed and published the update"; nothing
  was published.

  A `requireConsent` refusal travels as the same error document, so the
  consent ceremony was affected the same way: `requestTask` resolved as
  `accepted` instead of `consentRequired`, the cross-device match code never
  rendered, and no approver was ever asked. This is the more serious half — the
  failure is silent on both the requesting and the approving side.

  The predicate now matches the framework slug at any `0.x` minor (per SPEC.md
  §5.2 forward-minor compatibility), so a later minor cannot break it again.
  A major bump is still excluded: `1.x` is where the payload shape may change.
  Covers all four consumers — the REST channel, `parseTrustTaskReply`, the
  approver's decision-outcome reader and push-gateway registration — which
  already routed through this one predicate.

### Migration

Requires `@openvtc/vti-tsp-js` **≥ 0.2.0** — the dependency range moved from
`*` to `^0.2.0`. `*` expressed no floor, so it was satisfied by the old
`0.1.0`, which has no `./hpke` export; a consumer whose lockfile pinned
`0.1.0` would have installed this release against it and failed to resolve the
import. Nothing else in the public API changed.

## [0.3.0] - 2026-08-09

### Added

- **`digestMultibase` decoding, and the approver match code derived from the
  digest bytes** (`trust-tasks/digest.ts`). Trust Tasks 0.4 moved
  `payloadDigest` to the shared `DigestMultibase` type — a multibase-encoded
  multihash — and landed it **errata-style, in place** on
  `task-consent/{request,decision,granted}/0.1`. The type URI did not move, so
  no version check can detect the change; the encoding is the only signal.
  `matchCodeFromDigest` multibase-decodes, strips the `0x12 0x20` sha2-256
  multihash prefix and renders the first bytes as hex, matching
  `vta_mobile_core::consent::match_code_from_digest` character-for-character
  (OpenVTC/verifiable-trust-infrastructure#911). Because the digest is still
  SHA-256, this reproduces exactly the six characters the approver screen showed
  when the wire carried bare hex — the migration is invisible to the human.

  Slicing the *encoded* string would not have been: every SHA-256
  `digestMultibase` begins with a constant `zQm` (the base58btc marker plus the
  multihash prefix), so a six-character slice carries ~17.6 bits where the
  approver believes they are comparing ~35, while still looking like six random
  characters. A bare hex digest — the pre-0.4 wire form — is now refused rather
  than rendered, so a version-skewed request fails on the surface that would
  otherwise show a code for a decision the executor could never match.

### Fixed

- **VTA DIDComm auth → canonical Trust-Task type.** The authcrypt-auth
  primitive behind `vault/list`, `vault` transport, `contexts`, and
  onboarding `swap` posted the legacy `affinidi.com/atm/1.0/authenticate`
  message type to the VTA's `/auth/`. The VTA dropped that alias (it accepts
  only `auth/authenticate/0.1` now), so those calls would fail with
  `unexpected message type`. Switched the `VTA_AUTHENTICATE` constant in all
  four call sites to the canonical
  `https://trusttasks.org/spec/auth/authenticate/0.1` (the authcrypt body is
  unchanged). The SIOP REST login path was already canonical.

- **Consent-gated tasks now open the approval flow instead of dying silently.**
  `consentRequiredFrom` (behind `requestTask`) matched `auth:consent_required`
  against the trust-task-error's top-level `code`, but the VTA emits the
  standard `taskFailed` code and carries the reason in the error *details*. The
  check never matched, so every consent-gated task surfaced as a generic error
  and the cross-device approval UI never opened. Now keys on the machine-readable
  `details.reason`, with a fallback to the presence of the executor-signed
  `details.consentRequests` so it works regardless of whether the VTA in front
  of it emits the explicit reason yet. The prior tests encoded the wrong wire
  shape as correct and were rewritten against the real one.

### Migration

The `payloadDigest` **wire format changed**, on both sides at once and without
a type-URI version to signal it — Trust Tasks 0.4 re-pinned
`task-consent/{request,decision,granted}` errata-style, in place. This release
pairs with `verifiable-trust-infrastructure` **#911**; a wallet and an executor
on opposite sides of that change do not interoperate on consent.

**Upgrade the wallet and the VTA together.** Unlike the 0.1.3 authcrypt change
there is no dual-accept fallback to stage behind, because the digest is the
value the approver signs — accepting both encodings would mean accepting two
different digests for one payload, which is precisely the substitution the
digest exists to prevent.

The failure is fail-closed in both directions, which bounds the blast radius:

- **Wallet ≥ 0.3.0, VTA pre-0.4** (bare hex on the wire): the digest is refused
  as non-conforming, no match code is rendered, and approval is blocked with an
  explicit message.
- **Wallet ≤ 0.2.0, VTA on 0.4** (multibase on the wire): the old code slices
  the encoded string, so the wallet displays `zQmSK9…` where the requesting
  screen and the mobile approver display `3b0c7f`. Destructive approvals become
  impossible — the codes cannot match — while non-destructive ones still
  complete with a cosmetically wrong code shown. **Rebuild and reinstall the
  extension**; there is no store auto-update path in this repository.

Nothing is silently mis-approved in either direction.

## [0.2.0] - 2026-06-08

### Changed

- **Trust-Tasks 0.2 migration** (#59): `device/set-wake` and
  `vault/{list,upsert,release,proxy-login,sign-trust-task}` now target the
  `/0.2` Trust-Task URIs. `push/register` moved to `/0.2` once the gateway
  added 0.2 acceptance (vti-push-gateway#7). `provision/integration` moved off the legacy
  `firstperson.network` type to `https://trusttasks.org/spec/provision/integration/0.2`
  once the VTA added 0.2 dual-accept (#306); the signed BootstrapRequest VP's
  `ask.type` discriminator is now the 0.2 camelCase form (`adminRotation`). The
  `trust-task-error` parser now reads the canonical `message` field (was a
  non-existent `comment`) and accepts both `trust-task-error/0.1` and `/0.2`.
- `vta/passkey-vms/{enroll-challenge,enroll-submit,list,revoke}` moved from the
  pre-spec `/1.0` to the now-published `/0.1` once the VTA added `/0.1`
  dual-accept (#309, vta-sdk ≥ 0.10.0). Payloads are field-identical; this is a
  version-string bump.
- Bumped `@scure/base` `^1.1.9` → `^2.2.0` (API-compatible).

### BREAKING

- **`SecretKind` and `SiteTarget` `kind` enum *values* are now camelCase**
  (Trust-Tasks 0.2). These values cross the public `window.vtaWallet`
  provider API (e.g. `vaultList({ secretKind })` and the `secretKind` /
  `targets[].kind` on returned entries), so RP **web pages** that call the
  provider directly must update:

  | Before (0.1) | After (0.2) |
  | --- | --- |
  | `oauth-tokens` | `oauthTokens` |
  | `did-self-issued` | `didSelfIssued` |
  | `didcomm-peer` | `didcommPeer` |
  | `bearer-token` | `bearerToken` |
  | `ssh-key` | `sshKey` |
  | `web-origin` | `webOrigin` |
  | `ios-app` | `iosApp` |
  | `android-app` | `androidApp` |

  `password`, `passkey`, `custom`, and the `did` target kind are unchanged.
  `@openvtc/rp-sdk-js` is **not** affected — it verifies the login id_token,
  not vault calls.

## [0.1.3] - 2026-06-01

### Changed

- Ship the `@openvtc/vti-didcomm-js` **0.5.0** adoption (the dep pin moved
  to `^0.5.0` in the prior commit). 0.5.0 length-prefixes the ECDH-1PU
  Concat KDF `cc_tag`, making `ECDH-1PU+A256KW` authcrypt spec-correct
  and interoperable with credo-ts / didcomm-python /
  affinidi-messaging-didcomm ≥ 0.14 — and adds a dual-KEK decrypt
  fallback so an upgraded recipient still reads authcrypt from a
  not-yet-upgraded peer. `pnm-core`'s own API surface is unchanged; this
  is a version bump so the fixed authcrypt behaviour reaches npm
  consumers (the published `0.1.2` still pulled the pre-fix
  `vti-didcomm-js ^0.4.2`).

### Migration

The authcrypt **wire format changed** (via vti-didcomm-js 0.5.0): a 0.1.3
sender's authcrypt cannot be decrypted by a peer still on `pnm-core`
≤ 0.1.2 / `vti-didcomm-js` ≤ 0.4.x. **Upgrade recipients before
senders** — the dual-KEK fallback makes upgraded recipients accept both
old and new senders.
