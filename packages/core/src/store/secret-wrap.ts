/**
 * Pluggable encryption wrapper for the holder's Ed25519 root
 * secret.
 *
 * The wallet's persisted holder identity is keyed by an Ed25519
 * scalar that IS the authentication key — anyone with that
 * secret can impersonate the wallet at every RP. The bare
 * IndexedDB store keeps it as plaintext base64url; an attacker
 * with origin-scoped storage access (a malicious extension with
 * matching permissions, a same-origin XSS in the extension's
 * pages, or device-level exfil) walks away with the wallet.
 *
 * The H1 fix wraps the secret with a key derived from a user-
 * gesture authenticator (WebAuthn PRF in the extension build),
 * so storage exfil yields ciphertext that's useless without
 * the operator's biometric / FIDO2 device.
 *
 * This module is the abstraction; concrete implementations live
 * in the extension (`webauthn-prf-wrap.ts`) and in the PWA. The
 * core stays platform-agnostic.
 */

import { base64url } from "@openvtc/vti-didcomm-js";

/**
 * Trait every wallet-secret wrap implements.
 *
 * Wraps a fresh-minted secret on first persistence; unwraps it
 * on every subsequent load. Implementations cache derived keys
 * across calls (e.g. `chrome.storage.session`) so the operator
 * doesn't have to tap their authenticator for every wallet
 * operation — only when the cache is cold (first load after
 * browser restart).
 *
 * `wrap` is called exactly once per persisted identity (at
 * mint time). `unwrap` is called every load.
 *
 * Returning `null` from either side is a non-fatal signal that
 * the wrapper is unavailable (e.g. authenticator declined,
 * platform doesn't support PRF, operator hasn't enrolled);
 * the caller falls back to plaintext persistence with a `warn`.
 * This keeps existing plaintext-stored wallets loadable through
 * an OS upgrade or browser change that breaks the wrapper.
 */
export interface SecretWrap {
  /** Short identifier persisted alongside the wrap metadata so
   *  a future unwrap can pick the right implementation. */
  readonly algorithm: string;

  /**
   * Encrypt `secret` and return the wire envelope. Returning
   * `null` lets the caller fall back to plaintext (with a
   * warning).
   */
  wrap(secret: Uint8Array): Promise<WrappedSecret | null>;

  /**
   * Decrypt `wrapped.ciphertext` and return the original
   * secret bytes. Returning `null` lets the caller surface a
   * "wallet locked; tap your authenticator" UX without
   * crashing the load path.
   */
  unwrap(wrapped: WrappedSecret): Promise<Uint8Array | null>;
}

/**
 * On-disk envelope for a wrapped secret. Persisted as part of
 * the holder record; the wrap implementation reads `params`
 * to reconstitute its derived key.
 */
export interface WrappedSecret {
  /** Matches [`SecretWrap.algorithm`] of the wrap that produced
   *  it; the loader looks up the right implementation. */
  algorithm: string;
  /** AES-GCM ciphertext of the original secret, base64url. */
  ciphertextB64u: string;
  /** Initialisation vector / nonce, base64url. AES-GCM
   *  recommends 96 bits = 12 bytes. */
  ivB64u: string;
  /** Free-form opaque params the wrap needs at unwrap time
   *  (credentialId, PRF salt, KDF salt, etc.). The core treats
   *  this as opaque; only the matching wrap implementation
   *  reads it. */
  params: Record<string, string>;
}

/**
 * No-op wrap. Used in tests, in non-extension callers that
 * don't have a wrap available, and as the explicit "I know
 * this is plaintext" fallback. The wrap helper still records
 * a `passthrough` algorithm tag so an upgrade path can detect
 * "this record predates the encrypted-secret flow."
 */
export class PassthroughWrap implements SecretWrap {
  readonly algorithm = "passthrough";

  async wrap(secret: Uint8Array): Promise<WrappedSecret> {
    return {
      algorithm: this.algorithm,
      ciphertextB64u: base64url.encode(secret),
      ivB64u: "",
      params: {},
    };
  }

  async unwrap(wrapped: WrappedSecret): Promise<Uint8Array> {
    return base64url.decode(wrapped.ciphertextB64u);
  }
}

/**
 * Apply the wrap when present, fall back to a passthrough wrap
 * otherwise. Centralised so the [`generateOrLoadHolderIdentity`]
 * path doesn't have to branch.
 */
export async function wrapSecret(
  secret: Uint8Array,
  wrap?: SecretWrap,
): Promise<WrappedSecret> {
  if (wrap) {
    const wrapped = await wrap.wrap(secret);
    if (wrapped) return wrapped;
    // Wrapper available but declined (operator cancelled the
    // authenticator prompt, etc.). The caller may decide
    // separately whether to proceed plaintext; we surface the
    // signal as a thrown error so the choice is explicit.
    throw new Error(
      `SecretWrap '${wrap.algorithm}' declined to wrap (operator cancelled?)`,
    );
  }
  return new PassthroughWrap().wrap(secret) as Promise<WrappedSecret>;
}

/**
 * Unwrap a persisted secret. The wrap is selected by
 * `wrapped.algorithm`:
 *
 * - `"passthrough"` → use [`PassthroughWrap`] (no-op).
 * - Anything else → require the caller-supplied `wrap` to
 *   match. A mismatch (`wrap.algorithm !== wrapped.algorithm`)
 *   throws; the caller is responsible for picking the right
 *   wrap impl for the persisted record.
 */
export async function unwrapSecret(
  wrapped: WrappedSecret,
  wrap?: SecretWrap,
): Promise<Uint8Array> {
  if (wrapped.algorithm === "passthrough") {
    return new PassthroughWrap().unwrap(wrapped);
  }
  if (!wrap || wrap.algorithm !== wrapped.algorithm) {
    throw new Error(
      `wallet is wrapped with '${wrapped.algorithm}' but no matching SecretWrap was supplied`,
    );
  }
  const secret = await wrap.unwrap(wrapped);
  if (!secret) {
    throw new Error(
      `SecretWrap '${wrap.algorithm}' declined to unwrap (operator cancelled?)`,
    );
  }
  return secret;
}
