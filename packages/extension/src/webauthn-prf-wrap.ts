/// <reference types="chrome" />

/**
 * WebAuthn-PRF holder-secret wrap.
 *
 * Implements [`@openvtc/pnm-core::SecretWrap`] using the WebAuthn
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
import { IndexedDBKVStore, type SecretWrap, type WrappedSecret } from "@openvtc/pnm-core";

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

/**
 * Side-channel slot for the raw PRF output from the most recent
 * `wrap()` enrollment. Drained at-most-once by
 * `consumeLastEnrolledPrfOutput()`.
 *
 * Rationale: `wrap()` runs in the popup (visible context, fresh user
 * gesture). Its derived AES key lands in this module's `cachedKey` —
 * but that's the *popup's* module scope; offscreen runs the same code
 * in a separate document with its own `cachedKey: null`. The next
 * holder-touching op in offscreen would throw `WalletLockedError`
 * because offscreen's cache is empty. The popup needs to relay the
 * raw PRF output to offscreen (via `RUNTIME_UNLOCK_PRF`) so offscreen
 * can derive the same AES key into its own cache.
 *
 * The bytes are sensitive (key-derivation root); the slot is one-shot
 * (cleared on first read) so a stale value can't leak into a later
 * caller that doesn't drain.
 */
let lastEnrolledPrfOutput: Uint8Array | null = null;

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
    // `enrollOrLoadCredential` is now multi-wallet-aware: on first
    // call it mints a fresh credential + salt and persists both; on
    // subsequent calls (a second VTA's wallet being onboarded on this
    // device) it loads the stored credentialId + salt and runs
    // `.get` to recover the same PRF output. Same credential → same
    // PRF output → same derived AES key, so every wallet on this
    // device is encrypted under one key with distinct IVs.
    const credential = await this.enrollOrLoadCredential();
    if (!credential) return null;

    const aesKey = await this.deriveAesKey(credential.prfOutput);
    cachedKey = aesKey;
    // Surface for the immediate caller to relay to the sibling context
    // (popup ↔ offscreen). One-shot — drained on read.
    lastEnrolledPrfOutput = credential.prfOutput;

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
        prfSalt: base64url.encode(credential.prfSalt),
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
    lastEnrolledPrfOutput = null;
  }

  /** One-shot drain of the raw PRF output captured by the most recent
   *  `wrap()` enrollment. Returns `null` if nothing's pending (either
   *  no wrap has run, or the slot has already been read). Clears the
   *  slot on read.
   *
   *  Caller (popup) immediately ships the bytes to offscreen via
   *  `RUNTIME_UNLOCK_PRF` so offscreen's `cachedKey` is seeded too —
   *  without that relay the very next holder-touching op in offscreen
   *  would throw `WalletLockedError` and force the operator to run the
   *  unlock ceremony a second time. */
  static consumeLastEnrolledPrfOutput(): Uint8Array | null {
    const v = lastEnrolledPrfOutput;
    lastEnrolledPrfOutput = null;
    return v;
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
    lastEnrolledPrfOutput = null;
    const store = prfStore();
    await store.delete(CREDENTIAL_KEY);
    await store.delete(SALT_KEY);
  }

  /**
   * Either mint a fresh PRF credential (first wallet on this device)
   * OR load the existing one and re-run the PRF assertion to recover
   * the same PRF output (subsequent wallets — multi-VTA).
   *
   * Multi-wallet rationale: every wallet record on this device is
   * encrypted under the SAME AES key derived from the SAME PRF
   * credential + salt; only the AES-GCM IVs differ. So the second
   * (third, fourth, …) call to `wrap()` should not enroll a new
   * credential — it should reuse the existing one. Replacing the
   * credential would orphan every previously-wrapped record.
   *
   * Returns `null` if the operator cancels either ceremony.
   * `prfSalt` is the salt persisted alongside the credential — fresh
   * one on first enroll, stored one on subsequent loads.
   */
  private async enrollOrLoadCredential(): Promise<
    { credentialId: string; prfSalt: Uint8Array; prfOutput: Uint8Array } | null
  > {
    const store = prfStore();
    const existingCredentialId = await store.get<string>(CREDENTIAL_KEY);
    const existingSalt = await store.get<string>(SALT_KEY);

    if (existingCredentialId && existingSalt) {
      // Reuse the existing credential + its original salt. `unlockAesKey`
      // already implements the .get ceremony; reuse it to keep one
      // source of truth for the PRF-assertion code path. We only need
      // `prfOutput` here, not the derived AES key, so this helper
      // bypasses `deriveAesKey` (the caller derives it itself).
      const prfSalt = base64url.decode(existingSalt);
      const prfOutput = await this.assertPrfOutput(existingCredentialId, prfSalt);
      if (!prfOutput) return null;
      return { credentialId: existingCredentialId, prfSalt, prfOutput };
    }

    // First-ever enroll on this device.
    const prfSalt = crypto.getRandomValues(new Uint8Array(32));
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

    return { credentialId, prfSalt, prfOutput: new Uint8Array(prfOutput) };
  }

  /** Run a WebAuthn `.get` assertion against the existing credential
   *  and return the raw PRF output bytes. Used by the multi-wallet
   *  "reuse the credential" branch of `enrollOrLoadCredential` — we
   *  need the prfOutput but NOT to derive the AES key here (the
   *  caller does that). Returns `null` if the operator cancels. */
  private async assertPrfOutput(
    credentialIdB64u: string,
    prfSalt: Uint8Array,
  ): Promise<Uint8Array | null> {
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
    return new Uint8Array(prfOutput);
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
