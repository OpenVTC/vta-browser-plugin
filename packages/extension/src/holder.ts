import {
  IndexedDBKVStore,
  loadHolderStrict,
  type HolderIdentityResult,
  type SecretWrap,
} from "@openvtc/pnm-core";
import { getSettings } from "./config.js";
import { WebAuthnPrfSecretWrap } from "./webauthn-prf-wrap.js";

/**
 * Build the secret wrap the load path should use, given the
 * current `encryptHolderSecret` setting. Returns `undefined`
 * when encryption is off (the loader then operates plaintext).
 *
 * The wrap's WebAuthn rpId is the extension's runtime id —
 * `chrome-extension://<id>` is the effective origin; WebAuthn
 * rejects `chrome-extension:` scheme as an rpId, so we pass the
 * bare id (the authenticator stores the credential against
 * that). The authenticator uses the same rpId on every unwrap.
 *
 * Exported because both `loadHolder` (read side) and the
 * onboarding installer in `offscreen.ts:doOnboardConnect` (write
 * side) need the SAME wrap — installing with one wrap and
 * loading with a different one would brick the wallet on the
 * next boot.
 */
export async function buildHolderSecretWrap(): Promise<SecretWrap | undefined> {
  const settings = await getSettings();
  if (!settings.encryptHolderSecret) return undefined;
  return new WebAuthnPrfSecretWrap(chrome.runtime.id);
}

/** Load the wallet's holder identity (strict — v4 only).
 *
 *  - v4 record present → return the VTA-minted holder.
 *  - v3 record present but no v4 → throws `RequiresReonboardError`. The
 *    wallet predates the M2C identity migration and the operator must
 *    re-onboard.
 *  - neither → throws `NoHolderError`. Fresh install — operator should
 *    onboard.
 *
 *  Callers that need to surface these to the popup should catch and
 *  branch on `error.name`. The unhandled-throw path lands as a generic
 *  error and the operator gets a generic "wallet error" — fine for a
 *  prototype, less so for production UX.
 *
 *  When `encryptHolderSecret` is on, the persisted Ed25519 secret is
 *  unwrapped through a `WebAuthnPrfSecretWrap` — the first invocation
 *  per cold-start prompts the operator for their authenticator; subsequent
 *  invocations in the same SW lifetime reuse the in-memory derived key. */
export async function loadHolder(vtaDid: string): Promise<HolderIdentityResult> {
  const secretWrap = await buildHolderSecretWrap();
  return loadHolderStrict(new IndexedDBKVStore(), {
    vtaDid,
    ...(secretWrap ? { secretWrap } : {}),
  });
}

