import { base64url } from "@openvtc/vti-didcomm-js";

import type { SecretWrap, WrappedSecret } from "./secret-wrap.js";

// PRF-derived wrap for the **approver** signing key, deliberately different from
// the worker/holder wrap in two ways that matter for security:
//
//   1. **A separate KEK domain.** The AES key is derived with a distinct HKDF
//      `info`, so even though the approver reuses the same WebAuthn credential
//      (same PRF output bytes), its key-encryption-key is cryptographically
//      independent of the worker's. A worker-key compromise never yields the
//      approver key. The `algorithm` tag is distinct too, so `unwrapSecret`
//      refuses to load an approver record with the worker's wrap.
//
//   2. **No session cache — per-decision.** The worker wrap caches a derived AES
//      key for the session (one unlock, reused for every op). The approver is the
//      opposite: the PRF output is *injected per call* (from a fresh
//      `navigator.credentials.get` the popup runs at the moment the human
//      approves, with the `payloadDigest` as the WebAuthn challenge). This class
//      holds that one PRF output and derives the KEK on the spot; it never caches
//      it, so a fresh biometric gesture is required for each approval.
//
// The wrap/unwrap here is pure Web Crypto (`crypto.subtle`), available in both
// the browser and Node — so it lives in core and is unit-tested. The
// browser-only WebAuthn ceremony that produces `prfOutput` lives in the
// extension and feeds it in.

/** HKDF `info` — the approver KEK domain. Distinct from the worker's
 *  `pnm/holder-secret/aes-gcm/v1`. */
const APPROVER_INFO = "pnm/approver-secret/aes-gcm/v1";

/** Envelope `algorithm` tag persisted on the wrapped approver seed. Distinct
 *  from the worker's `webauthn-prf-aes-gcm`, so `unwrapSecret` dispatch requires
 *  an `ApproverPrfSecretWrap` and can never mix the two key domains. */
export const APPROVER_WRAP_ALGORITHM = "webauthn-prf-aes-gcm/approver";

/** Derive the non-extractable AES-256-GCM approver KEK from a PRF output via
 *  HKDF-SHA256 under the approver `info`. Non-extractable: even a heap dump only
 *  yields a `CryptoKey` handle, not raw bytes. */
async function deriveApproverKek(prfOutput: Uint8Array): Promise<CryptoKey> {
  const hkdfKey = await crypto.subtle.importKey(
    "raw",
    prfOutput as BufferSource,
    "HKDF",
    false,
    ["deriveKey"],
  );
  return crypto.subtle.deriveKey(
    {
      name: "HKDF",
      hash: "SHA-256",
      salt: new Uint8Array(0),
      info: new TextEncoder().encode(APPROVER_INFO),
    },
    hkdfKey,
    { name: "AES-GCM", length: 256 },
    false,
    ["encrypt", "decrypt"],
  );
}

/**
 * A [`SecretWrap`] that seals the approver seed under a KEK derived, per call,
 * from an injected WebAuthn-PRF output. Construct a fresh instance per
 * mint/approval with that decision's PRF output.
 */
export class ApproverPrfSecretWrap implements SecretWrap {
  readonly algorithm = APPROVER_WRAP_ALGORITHM;

  /** @param prfOutput raw bytes from `navigator.credentials.get`'s `prf` result,
   *  produced by the ceremony the popup runs at approval time. */
  constructor(private readonly prfOutput: Uint8Array) {}

  async wrap(secret: Uint8Array): Promise<WrappedSecret | null> {
    const kek = await deriveApproverKek(this.prfOutput);
    const iv = crypto.getRandomValues(new Uint8Array(12));
    const ciphertext = new Uint8Array(
      await crypto.subtle.encrypt(
        { name: "AES-GCM", iv: iv as BufferSource },
        kek,
        secret as BufferSource,
      ),
    );
    return {
      algorithm: this.algorithm,
      ciphertextB64u: base64url.encode(ciphertext),
      ivB64u: base64url.encode(iv),
      params: {},
    };
  }

  async unwrap(wrapped: WrappedSecret): Promise<Uint8Array | null> {
    const kek = await deriveApproverKek(this.prfOutput);
    const plaintext = await crypto.subtle.decrypt(
      { name: "AES-GCM", iv: base64url.decode(wrapped.ivB64u) as BufferSource },
      kek,
      base64url.decode(wrapped.ciphertextB64u) as BufferSource,
    );
    return new Uint8Array(plaintext);
  }
}
