/// <reference types="chrome" />

/**
 * WebAuthn-PRF holder-secret wrap.
 *
 * Implements [`@pnm/core::SecretWrap`] using the WebAuthn
 * `prf` extension. Tap the operator's biometric (Touch ID,
 * Windows Hello) or external authenticator on first
 * persistence; derive an AES-GCM key from the PRF output;
 * encrypt the wallet's Ed25519 root secret with it. On every
 * subsequent load, the same authenticator yields the same PRF
 * output yields the same key — no server round-trip, no
 * passphrase, no exfiltrable cleartext at rest.
 *
 * **Status**: foundation only. The wrap implements the
 * interface but is not yet auto-enabled in [`./holder.ts`].
 * The full enable is a follow-up:
 *
 * 1. Settings page toggle (operator opts in).
 * 2. First-enroll UX (passkey ceremony, error handling for
 *    operators with no PRF-capable authenticator).
 * 3. Lock / unlock UX on every cold-cache load (currently
 *    every load → the operator taps; a warm cache for the
 *    derived AES key is the obvious optimisation — currently
 *    held only in module-scoped memory, gone on every offscreen
 *    page reload).
 * 4. Migration UX (existing plaintext-stored wallets get an
 *    "encrypt your wallet?" prompt on first load).
 *
 * For now this module provides the cryptography + WebAuthn
 * dance so the rest of the workspace can build against the
 * trait and the operator-visible UX can land in a separate
 * commit.
 *
 * Closes the **infrastructure** half of H1 from the May 2026
 * security review; the operator-visible flow is the second
 * half.
 */

import { base64url } from "@openvtc/vti-didcomm-js";
import { IndexedDBKVStore, type SecretWrap, type WrappedSecret } from "@pnm/core";

const ALGORITHM = "webauthn-prf-aes-gcm";
const CREDENTIAL_KEY = "pnm/holder-prf/credentialId";
const SALT_KEY = "pnm/holder-prf/salt";

/** Thrown by `WebAuthnPrfSecretWrap.unwrap` when the in-memory AES
 *  cache is empty — the encrypted wallet needs an unlock ceremony
 *  before this operation can complete. Surfaced through the
 *  offscreen op handlers so the popup (which IS able to run
 *  WebAuthn) can render UnlockView; page-triggered ops with the
 *  popup closed see this and surface "open the wallet popup to
 *  unlock" to their caller. */
export class WalletLockedError extends Error {
  constructor() {
    super("wallet is locked: unlock via popup before retrying");
    this.name = "WalletLockedError";
  }
}

/** Where the enrolled WebAuthn credential id + PRF salt are
 *  persisted. **IndexedDB, not `chrome.storage.local`.** The wrap
 *  is called from the offscreen document during onboarding —
 *  `chrome.storage` is NOT exposed in offscreen pages (MV3 only
 *  exposes it to the service worker, popup, and options page). The
 *  wallet's IndexedDBKVStore IS available in every extension
 *  context, including offscreen, and is already the persistence
 *  backend for the holder identity and pending-onboard state. */
function prfStore(): IndexedDBKVStore {
  return new IndexedDBKVStore();
}

/**
 * In-memory cache of the derived AES-GCM key for the lifetime
 * of the offscreen instance. Cleared on browser restart and on
 * `WebAuthnPrfSecretWrap.lock()`. The persisted credentialId
 * lives in IndexedDB (see `prfStore`); only this in-memory key
 * survives between unlock prompts within a session.
 *
 * The `CryptoKey` is non-extractable so even with a heap dump
 * the operator can't recover the raw bytes — only signed
 * operations through SubtleCrypto.
 */
let cachedKey: CryptoKey | null = null;

interface PrfParams extends Record<string, string> {
  /** Base64url credentialId of the WebAuthn credential the
   *  wrap enrolled. The unwrap path passes this to
   *  `navigator.credentials.get` so the same authenticator is
   *  challenged. */
  credentialId: string;
  /** Base64url 32-byte salt fed into the PRF. Generated at
   *  enroll time, persisted alongside the credentialId so the
   *  same PRF output is reproduced on every unwrap. */
  prfSalt: string;
}

export class WebAuthnPrfSecretWrap implements SecretWrap {
  readonly algorithm = ALGORITHM;

  /**
   * `rpId` is the WebAuthn RP identifier — typically the
   * extension's chrome-extension:// origin host (i.e. the
   * extension id). PRF outputs are bound to (credentialId, rpId,
   * prfSalt), so the rpId must be stable across loads.
   */
  constructor(private readonly rpId: string) {}

  async wrap(secret: Uint8Array): Promise<WrappedSecret | null> {
    const prfSalt = crypto.getRandomValues(new Uint8Array(32));
    const credential = await this.enrollOrLoadCredential(prfSalt);
    if (!credential) return null;

    const aesKey = await this.deriveAesKey(credential.prfOutput);
    cachedKey = aesKey;

    const iv = crypto.getRandomValues(new Uint8Array(12));
    const ciphertext = new Uint8Array(
      await crypto.subtle.encrypt(
        { name: "AES-GCM", iv: iv as BufferSource },
        aesKey,
        secret as BufferSource,
      ),
    );

    return {
      algorithm: this.algorithm,
      ciphertextB64u: base64url.encode(ciphertext),
      ivB64u: base64url.encode(iv),
      params: {
        credentialId: credential.credentialId,
        prfSalt: base64url.encode(prfSalt),
      },
    };
  }

  async unwrap(wrapped: WrappedSecret): Promise<Uint8Array | null> {
    const params = wrapped.params as PrfParams;
    if (!params.credentialId || !params.prfSalt) {
      throw new Error("webauthn-prf-wrap: missing credentialId or prfSalt in record");
    }

    // Cache-only path. If the in-memory AES key isn't populated, throw
    // a typed `WalletLockedError` rather than running the WebAuthn
    // ceremony here. The ceremony only works from a visible context —
    // popup, options page — never from offscreen. Offscreen ops that
    // hit this branch bubble the error up so the caller (popup or
    // page) can surface "open the popup to unlock".
    //
    // The legacy fallback `cachedKey ?? unlockAesKey(...)` was the
    // root cause of the hang #28 surfaced and #30 reverted around:
    // offscreen would call unlockAesKey which calls navigator.
    // credentials.get from a hidden context, never returning.
    if (!cachedKey) {
      throw new WalletLockedError();
    }

    const iv = base64url.decode(wrapped.ivB64u);
    const ciphertext = base64url.decode(wrapped.ciphertextB64u);
    const plaintext = await crypto.subtle.decrypt(
      { name: "AES-GCM", iv: iv as BufferSource },
      cachedKey,
      ciphertext as BufferSource,
    );
    return new Uint8Array(plaintext);
  }

  /** Clear the in-memory key cache. Use on operator-initiated
   *  lock; the next unwrap re-prompts for the authenticator. */
  static lock(): void {
    cachedKey = null;
  }

  /** True when the AES key is currently held in this context's
   *  module-scope cache. Used by `RUNTIME_WALLET_LOCK_STATE` so
   *  the popup can decide whether to render the unlock prompt. */
  static isUnlocked(): boolean {
    return cachedKey !== null;
  }

  /** Seed the module-scope `cachedKey` from raw PRF output bytes —
   *  the unlock-relay path. The popup runs `navigator.credentials.
   *  get` (visible context, fresh user gesture), extracts the PRF
   *  output, and ships the bytes via `RUNTIME_UNLOCK_PRF` to
   *  offscreen, which calls this to install the derived AES key.
   *
   *  After this returns, the in-memory cache is populated and the
   *  next `WebAuthnPrfSecretWrap.unwrap()` call inside this
   *  context completes without prompting. Equivalent in effect to
   *  having just run `unlockAesKey()` here — same HKDF, same AES
   *  key bytes, same non-extractable handle.
   *
   *  The raw `prfOutput` bytes ARE sensitive (they're the
   *  key-derivation root for this session). They cross the
   *  chrome.runtime.sendMessage boundary in the bytes form. That
   *  boundary is in-process within the same extension origin —
   *  same trust boundary as IndexedDB sharing between popup and
   *  offscreen. An attacker who can intercept this channel already
   *  has arbitrary code execution in the extension and doesn't
   *  need to intercept anything. */
  static async seedCachedKeyFromPrfOutput(prfOutput: Uint8Array): Promise<void> {
    // Reuse the existing HKDF derivation by constructing a
    // throwaway instance — `deriveAesKey` is the canonical place
    // and doesn't depend on instance state beyond the salt/info
    // strings (which are constants). Avoids inlining the same
    // crypto twice; one source of truth for the key-derivation
    // recipe.
    const dummy = new WebAuthnPrfSecretWrap("");
    cachedKey = await dummy.deriveAesKey(prfOutput);
  }

  /**
   * Forget the enrolled WebAuthn credential.
   *
   * Use when the operator disables wallet encryption — the
   * stored credentialId would otherwise block a future
   * re-enable (the enroll path refuses to mint a new credential
   * when one already exists, to avoid losing the existing
   * wrapped secret). Clears both the in-memory key cache
   * (same as `lock`) and the persisted credentialId + PRF
   * salt in IndexedDB.
   *
   * Does NOT call `navigator.credentials.delete` on the
   * authenticator — that API isn't available in MV3 service
   * workers; the orphan credential sits inertly on the
   * authenticator until the operator removes it through their
   * platform's authenticator settings.
   */
  static async unenroll(): Promise<void> {
    cachedKey = null;
    const store = prfStore();
    await store.delete(CREDENTIAL_KEY);
    await store.delete(SALT_KEY);
  }

  /**
   * Run the WebAuthn enrollment ceremony with the PRF
   * extension. Persists the credentialId so future unwraps
   * find the same authenticator. Returns `null` if the
   * operator cancels or the platform doesn't support PRF.
   */
  private async enrollOrLoadCredential(
    prfSalt: Uint8Array,
  ): Promise<{ credentialId: string; prfOutput: Uint8Array } | null> {
    // Check for an existing enrolled credentialId — re-enrolling
    // would lose the existing wrapped secret. Caller is
    // responsible for not invoking wrap() twice on the same
    // identity; this guard surfaces the misuse loudly.
    const store = prfStore();
    const existingId = await store.get<string>(CREDENTIAL_KEY);
    if (existingId) {
      throw new Error(
        "webauthn-prf-wrap: credential already enrolled; refusing to mint a new one (would lose existing wrapped secret)",
      );
    }

    const challenge = crypto.getRandomValues(new Uint8Array(32));
    const userId = crypto.getRandomValues(new Uint8Array(16));

    const credential = (await navigator.credentials.create({
      publicKey: {
        rp: { id: this.rpId, name: "OpenVTC Wallet" },
        user: {
          id: userId,
          name: "wallet@openvtc",
          displayName: "OpenVTC Wallet",
        },
        challenge,
        pubKeyCredParams: [
          { type: "public-key", alg: -8 }, // EdDSA
          { type: "public-key", alg: -7 }, // ES256
        ],
        authenticatorSelection: {
          residentKey: "required",
          userVerification: "required",
        },
        extensions: {
          // The `prf` extension's `eval` field tells the
          // authenticator to evaluate the PRF at enroll time
          // alongside the registration ceremony.
          prf: { eval: { first: prfSalt } },
        } as AuthenticationExtensionsClientInputs,
      },
    })) as PublicKeyCredential | null;

    if (!credential) return null;
    const extOutputs = credential.getClientExtensionResults() as {
      prf?: { results?: { first?: ArrayBuffer } };
    };
    const prfOutput = extOutputs.prf?.results?.first;
    if (!prfOutput) {
      throw new Error(
        "webauthn-prf-wrap: authenticator does not support the PRF extension",
      );
    }

    const credentialId = base64url.encode(new Uint8Array(credential.rawId));
    await store.put(CREDENTIAL_KEY, credentialId);
    await store.put(SALT_KEY, base64url.encode(prfSalt));

    return { credentialId, prfOutput: new Uint8Array(prfOutput) };
  }

  /**
   * Run a WebAuthn `get` ceremony with the stored credential
   * and PRF salt, derive the AES key from the resulting PRF
   * output. Returns `null` if the operator cancels.
   */
  private async unlockAesKey(
    credentialIdB64u: string,
    prfSalt: Uint8Array,
  ): Promise<CryptoKey | null> {
    const challenge = crypto.getRandomValues(new Uint8Array(32));
    const credentialId = base64url.decode(credentialIdB64u);

    const assertion = (await navigator.credentials.get({
      publicKey: {
        rpId: this.rpId,
        challenge,
        allowCredentials: [
          { type: "public-key", id: credentialId.buffer as ArrayBuffer },
        ],
        userVerification: "required",
        extensions: {
          prf: { eval: { first: prfSalt } },
        } as AuthenticationExtensionsClientInputs,
      },
    })) as PublicKeyCredential | null;

    if (!assertion) return null;
    const extOutputs = assertion.getClientExtensionResults() as {
      prf?: { results?: { first?: ArrayBuffer } };
    };
    const prfOutput = extOutputs.prf?.results?.first;
    if (!prfOutput) {
      throw new Error(
        "webauthn-prf-wrap: assertion returned no PRF output (authenticator may have rotated keys)",
      );
    }
    return this.deriveAesKey(new Uint8Array(prfOutput));
  }

  /**
   * HKDF the PRF output into a non-extractable AES-256-GCM key.
   * The non-extractable flag means the key can be used for
   * encrypt / decrypt but the raw bytes are unreachable —
   * even a heap dump won't surface them.
   */
  private async deriveAesKey(prfOutput: Uint8Array): Promise<CryptoKey> {
    const hkdfMaterial = await crypto.subtle.importKey(
      "raw",
      prfOutput as BufferSource,
      { name: "HKDF" },
      false,
      ["deriveKey"],
    );
    return crypto.subtle.deriveKey(
      {
        name: "HKDF",
        hash: "SHA-256",
        salt: new Uint8Array(0),
        info: new TextEncoder().encode("pnm/holder-secret/aes-gcm/v1"),
      },
      hkdfMaterial,
      { name: "AES-GCM", length: 256 },
      false, // non-extractable
      ["encrypt", "decrypt"],
    );
  }
}
