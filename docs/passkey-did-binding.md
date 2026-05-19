# Passkey ↔ DID binding

This document specifies how `pnm-browser-plugin` binds a WebAuthn
passkey to a VTA-managed DID and what the VTA needs to implement.

## Goal

A WebAuthn passkey provisioned by the user's device should become a
**first-class authentication factor for the DID** controlled by the
VTA. Any relying party that resolves the DID can verify a WebAuthn
assertion against the embedded public key — no callback to the VTA,
no shared secret, no proprietary protocol.

## Non-goals

- Replacing the VTA-held signing key. The DID still has its primary
  key minted by the VTA; passkeys are *additional* VMs with purpose
  `authentication`.
- Sealing private keys to the device. WebAuthn already does that —
  we never see the private key.
- Cross-device sync of the binding state. Sync is delegated to the
  platform's passkey-sync mechanism (iCloud Keychain, Google
  Password Manager, etc.).

## End-to-end flow

```
┌────────┐   1. POST /did/verification-methods/passkey/challenge
│        │ ─────────────────────────────────────────────────────▶
│ Browser│                                                       ┌────────┐
│  app   │   2. { challenge, rpId, rpName, userHandle, ... }     │  VTA   │
│        │ ◀───────────────────────────────────────────────────  │        │
│        │                                                       │        │
│        │   3. navigator.credentials.create(...)                │        │
│        │      ↳ authenticator returns credential + attestation │        │
│        │                                                       │        │
│        │   4. POST /did/verification-methods/passkey           │        │
│        │      { credentialId, publicKeyMultibase,              │        │
│        │        attestationObject, clientDataJson, ... }       │        │
│        │ ─────────────────────────────────────────────────────▶│        │
│        │                                                       │        │
│        │   5. VTA verifies challenge, origin, attestation;     │        │
│        │      appends WebVH LogEntry with the new VM.          │        │
│        │                                                       │        │
│        │   6. { verificationMethod, webvhVersion }             │        │
│        │ ◀───────────────────────────────────────────────────  │        │
└────────┘                                                       └────────┘
```

## Verification method shape

```jsonc
{
  "id": "did:webvh:vta.example.com:abc#passkey-<sha256-b64u(credential_id)>",
  "type": "Multikey",
  "controller": "did:webvh:vta.example.com:abc",
  "publicKeyMultibase": "zDnaeY6V3sgs...",
  "webauthnCredentialId": "<base64url credential_id>",
  "webauthnTransports": ["internal", "hybrid"],
  "label": "MacBook Touch ID"
}
```

The VM is added to the DID document under `verificationMethod` and
referenced from `authentication`. It is **not** referenced from
`assertionMethod` or `capabilityInvocation` — passkeys authenticate
sessions, they do not issue credentials.

### Why `Multikey`?

`Multikey` is the W3C-recommended VM type (DI v2.0). It's
algorithm-agnostic and self-describing — the multicodec prefix in
`publicKeyMultibase` tells the verifier which curve / scheme to use.

### Why hash the credential id into the fragment?

WebAuthn credential ids can be long (often 64–128 bytes for resident
credentials). The fragment must be a stable, URL-safe handle. SHA-256
+ base64url is short, opaque, and deterministic — given an assertion,
a verifier can recompute the fragment from `credential.id` and look
the VM up by `id`.

## Algorithm support

| COSE alg | Multicodec | Multikey prefix bytes | Pubkey bytes | Supported |
|---|---|---|---|---|
| ES256 (-7)  | `p256-pub` (0x1200) | `[0x80, 0x24]` | 33 (compressed) | ✅ |
| EdDSA (-8)  | `ed25519-pub` (0xed) | `[0xED, 0x01]` | 32 | ✅ (browser-permitting) |
| ES384 (-35) | `p384-pub` (0x1201) | `[0x81, 0x24]` | 49 (compressed) | scaffolded |
| RS256 (-257)| — | — | — | ❌ (no multikey codec) |

ES256 is the default for all major platform authenticators and is
guaranteed to work. EdDSA + WebCrypto requires Chrome 124+ / Safari
17+; the code path is present but the authenticator must offer it.

## Wire shapes

### `POST /did/verification-methods/passkey/challenge?did=<did>`

**Auth**: bearer JWT. Caller must hold `admin` role on the DID's
context. For first-time enrollment (no passkey yet), the caller must
use a short-lived **enrollment token** minted by `pnm
passkey-enroll-token` — see "Bootstrap chicken-and-egg" below.

**Response 200**:

```json
{
  "challenge": "<base64url, 32 random bytes minimum>",
  "rpId": "vta.example.com",
  "rpName": "Acme VTA",
  "userHandle": "<base64url, stable per-DID handle>",
  "userName": "alice@example.com",
  "userDisplayName": "Alice",
  "timeoutMs": 60000
}
```

VTA-side, the `(did, challenge)` tuple is stored with a 5-minute TTL
and one-shot consumption semantics. `rpId` MUST be a domain that
matches the origin the browser app is served from (the VTA itself, a
PWA host, or the extension's `chrome-extension://` origin via the
`crossOrigin` clientDataJSON field handling).

### `POST /did/verification-methods/passkey`

**Auth**: same bearer as above.

**Request body**:

```json
{
  "did": "did:webvh:...",
  "credentialId": "<base64url>",
  "publicKeyMultibase": "z...",
  "coseAlgorithm": -7,
  "attestationObject": "<base64url>",
  "clientDataJson": "<base64url>",
  "authenticatorData": "<base64url>",
  "transports": ["internal", "hybrid"],
  "label": "MacBook Touch ID"
}
```

**VTA-side verification** (mandatory, in order):

1. `did` is admin-controlled by the caller; bearer's `sub` is in the
   DID's context ACL with `admin` role.
2. `clientDataJson.type == "webauthn.create"`.
3. `clientDataJson.challenge` (base64url-decoded) equals the
   challenge issued in step 1 and stored under `(did, …)`. Consume
   the stored challenge on success — even if later steps fail.
4. `clientDataJson.origin` is in the configured allow-list for this
   VTA (typically `https://<vta-host>`, plus declared PWA / extension
   origins).
5. `authenticatorData[0..32]` (the RP ID hash) equals
   `SHA-256(rpId)` where `rpId` is the value from step 1.
6. Re-derive the public key from `attestationObject.authData` and
   confirm it matches `publicKeyMultibase`. The browser computed the
   multikey; the VTA recomputes it from scratch and rejects on
   mismatch (no trust in browser-derived crypto).
7. (Optional, configurable) verify the attestation statement chain.
   `attestationObject.fmt` of `none` / `packed` / `apple` /
   `android-safetynet` are common; rejecting attestation chains is
   acceptable for self-asserted operator devices but recommended for
   enterprise deployments.
8. Compute `fragment = "passkey-" + base64url(sha256(credential_id))`.
   Reject 409 if `<did>#<fragment>` already exists.

**On success**: append a WebVH LogEntry to the DID's `did.jsonl`
that adds the VM and references it from `authentication`. Return:

```json
{
  "verificationMethod": { ... },
  "webvhVersion": "1-Qm..."
}
```

### `GET /did/verification-methods/passkey?did=<did>`

Returns `{ verificationMethods: [...] }` for the caller's review.

### `DELETE /did/verification-methods/passkey/<fragment>?did=<did>`

Removes the VM by WebVH update. Symmetric with WebVH key-rotation —
the deleted VM is gone from the current DID document but the LogEntry
history preserves it for audit.

## Bootstrap chicken-and-egg

A passkey doesn't exist on first run, so the user can't authenticate
to the VTA with one. Three options, in order of preference:

1. **Enrollment token from the `pnm` CLI** *(recommended)*. The
   operator runs `pnm passkey-enroll-token --did <did> --expires 10m`
   on their CLI host (which already holds the admin signing key) and
   pastes the resulting token into the browser app. The token is a
   short-lived JWT with claim `scope: passkey-enroll-only` and
   audience `<did>`. After the first passkey is enrolled, the browser
   does its own challenge-response using that passkey.
2. **Direct admin signing-key import**. The browser app accepts an
   exported admin DID secret, performs the standard
   `/auth/challenge` + `/auth/` ceremony, then immediately rotates
   away from the imported key. Higher operational risk; the
   plaintext secret crosses the browser boundary.
3. **QR code from the CLI**. The CLI displays a QR with `(vtaUrl,
   did, enrollmentToken)` packed; the browser app scans it. Same
   security model as (1), better mobile UX.

The browser code in this repo expects option (1); the access token
in `Connection` is the enrollment-scope JWT.

## Threat model

| Threat | Mitigation |
|---|---|
| Stolen enrollment token | Short TTL (10m), one-shot challenge consumption, scope-limited audience, ACL enforcement on the new-VM endpoint. |
| Browser-supplied bogus public key | VTA re-derives the multikey from `attestationObject.authData` and rejects mismatches (step 6 above). |
| Replayed registration | Challenge is one-shot per `(did, challenge)` tuple. |
| Cross-RP credential reuse | `rpId` is bound to the VTA host; authenticators scope credentials to RP id. |
| Authenticator cloning | WebAuthn-level concern. Attestation chain verification (step 7) detects unknown authenticators when configured. |
| Lost passkey | Operator deletes the VM via `pnm` CLI or another enrolled passkey on a different device. The DID's primary VTA key still rotates VMs — losing all passkeys ≠ losing the DID. |

## Revocation

Revocation = WebVH update that removes the VM. The VTA's WebVH log
keeps the history, so an RP that cached the DID document and
verified a stale assertion is auditable but not in danger — the next
DID resolution drops the VM and the assertion stops verifying.

There is intentionally **no `credentialStatus`** field on the VM
(no StatusList machinery). DID resolution is the source of truth;
the VM either appears in the current document or it doesn't.

## Open questions

- **Multi-RP support**: a single passkey is scoped to one RP id
  (the VTA's host). If the user wants the same passkey to
  authenticate to a third-party site directly, that site must accept
  the VTA's `rpId` as the RP — which it won't. The realistic flow is
  the browser app fronting SIOPv2 / OpenID4VP responses to the
  third-party RP, where the browser asks the user for a passkey
  assertion against the VTA's `rpId` to prove DID control, then
  emits a signed SIOPv2 response. This is the second milestone.
- **Hybrid transport (cross-device QR)**: works transparently with
  WebAuthn level 3. No code changes needed; the authenticator handles
  it.
