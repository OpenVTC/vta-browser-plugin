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

/** HKDF `info` — the sign-in approval key's KEK domain (`sign-in-uv-key.ts`).
 *  Same credential, same per-call PRF output, a third independent key. */
const SIGN_IN_UV_INFO = "pnm/sign-in-uv-secret/aes-gcm/v1";

/** Envelope `algorithm` tag on a wrapped sign-in approval key. */
export const SIGN_IN_UV_WRAP_ALGORITHM = "webauthn-prf-aes-gcm/sign-in-uv";

/** Derive a non-extractable AES-256-GCM KEK from a PRF output via HKDF-SHA256
 *  under `info`. Non-extractable: even a heap dump only yields a `CryptoKey`
 *  handle, not raw bytes. */
async function derivePrfKek(prfOutput: Uint8Array, info: string): Promise<CryptoKey> {
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
      info: new TextEncoder().encode(info),
    },
    hkdfKey,
    { name: "AES-GCM", length: 256 },
    false,
    ["encrypt", "decrypt"],
  );
}

/** Seals a seed under a KEK derived, per call, from an injected WebAuthn-PRF
 *  output, in one key domain. Never caches the KEK. */
abstract class PrfDomainSecretWrap implements SecretWrap {
  abstract readonly algorithm: string;
  protected abstract readonly info: string;

  /** @param prfOutput raw bytes from `navigator.credentials.get`'s `prf` result,
   *  produced by the ceremony the popup runs at approval time. */
  constructor(private readonly prfOutput: Uint8Array) {}

  async wrap(secret: Uint8Array): Promise<WrappedSecret | null> {
    const kek = await derivePrfKek(this.prfOutput, this.info);
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
    const kek = await derivePrfKek(this.prfOutput, this.info);
    const plaintext = await crypto.subtle.decrypt(
      { name: "AES-GCM", iv: base64url.decode(wrapped.ivB64u) as BufferSource },
      kek,
      base64url.decode(wrapped.ciphertextB64u) as BufferSource,
    );
    return new Uint8Array(plaintext);
  }
}

/**
 * A [`SecretWrap`] that seals the approver seed under a KEK derived, per call,
 * from an injected WebAuthn-PRF output. Construct a fresh instance per
 * mint/approval with that decision's PRF output.
 */
export class ApproverPrfSecretWrap extends PrfDomainSecretWrap {
  readonly algorithm = APPROVER_WRAP_ALGORITHM;
  protected readonly info = APPROVER_INFO;
}

/**
 * The same, for the key that approves this browser's wallet sign-ins
 * (`sign-in-uv-key.ts`): its own KEK domain and `algorithm`, so neither an
 * approver record nor a holder record opens with it, nor it with theirs.
 */
export class SignInUvPrfSecretWrap extends PrfDomainSecretWrap {
  readonly algorithm = SIGN_IN_UV_WRAP_ALGORITHM;
  protected readonly info = SIGN_IN_UV_INFO;
}
