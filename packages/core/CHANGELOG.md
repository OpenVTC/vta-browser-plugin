# Changelog

All notable changes to `@openvtc/pnm-core` are documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this package adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).
For history before this file, see `git log` on `packages/core`.

## [Unreleased]

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
