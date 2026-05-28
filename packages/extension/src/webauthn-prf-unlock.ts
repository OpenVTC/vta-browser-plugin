/// <reference types="chrome" />

/**
 * Popup-side WebAuthn-PRF unlock ceremony.
 *
 * Counterpart to `WebAuthnPrfSecretWrap`: the wrap class runs in
 * the offscreen context (it owns the cachedKey + the on-disk
 * unwrap path); this helper runs in the **popup** (visible context,
 * fresh user gesture from the click that triggered it) and gets
 * the PRF output bytes out of the WebAuthn assertion. The popup
 * then ships the bytes to offscreen via the `RUNTIME_UNLOCK_PRF`
 * bridge, where they're piped into
 * `WebAuthnPrfSecretWrap.seedCachedKeyFromPrfOutput` to populate
 * the in-memory cache.
 *
 * Why split: `navigator.credentials.get` requires a visible,
 * focused context. Offscreen pages are hidden, so calling
 * credentials.get from there hangs forever. The popup IS visible
 * during the click that opens it, so unlock works correctly here.
 * Once the offscreen has the derived AES key cached, subsequent
 * loads from offscreen don't need WebAuthn at all — the cache
 * services unwrap()s directly.
 */

import { base64url } from "@openvtc/vti-didcomm-js";
import { IndexedDBKVStore } from "@openvtc/pnm-core";

// Same keys WebAuthnPrfSecretWrap writes when it enrolls. Kept in
// sync by convention; both files need to agree on the slot.
const CREDENTIAL_KEY = "pnm/holder-prf/credentialId";
const SALT_KEY = "pnm/holder-prf/salt";

export interface PrfUnlockMaterial {
  /** Raw PRF output bytes from the WebAuthn assertion. These ARE
   *  sensitive — the AES key root for the session. Treat as you
   *  would the holder seed itself. */
  prfOutput: Uint8Array;
}

/** Reasons unlock can fail in ways the operator can act on. */
export class PrfUnlockError extends Error {
  readonly reason: "no-enrolment" | "no-prf-output" | "cancelled" | "unexpected";
  constructor(reason: PrfUnlockError["reason"], message: string) {
    super(message);
    this.name = "PrfUnlockError";
    this.reason = reason;
  }
}

/** Run the WebAuthn assertion ceremony in the popup's context and
 *  return the PRF output. Caller is the popup's UnlockView.
 *
 *  `rpId` is the extension's runtime id — must match what the
 *  enroll ceremony used in `WebAuthnPrfSecretWrap.wrap()`.
 *  Otherwise the authenticator's stored credential won't match.
 *
 *  Throws `PrfUnlockError` with an actionable `reason` for the
 *  cases the operator can recover from. Anything else bubbles as a
 *  generic Error. */
export async function runPrfUnlockCeremony(rpId: string): Promise<PrfUnlockMaterial> {
  const store = new IndexedDBKVStore();
  const credentialIdB64u = await store.get<string>(CREDENTIAL_KEY);
  const saltB64u = await store.get<string>(SALT_KEY);
  if (!credentialIdB64u || !saltB64u) {
    throw new PrfUnlockError(
      "no-enrolment",
      "Wallet isn't enrolled for encryption. Re-onboard and choose 'Encrypt with authenticator', or open Settings.",
    );
  }
  const credentialId = base64url.decode(credentialIdB64u);
  const prfSalt = base64url.decode(saltB64u);
  const challenge = crypto.getRandomValues(new Uint8Array(32));

  let assertion: PublicKeyCredential | null = null;
  try {
    assertion = (await navigator.credentials.get({
      publicKey: {
        rpId,
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
  } catch (e) {
    // `NotAllowedError` is what Chrome throws when the operator
    // dismisses the system dialog. Surface it as `cancelled` so
    // the UnlockView can re-enable the button without a scary
    // error message.
    if (e instanceof Error && e.name === "NotAllowedError") {
      throw new PrfUnlockError("cancelled", "Authenticator prompt cancelled.");
    }
    throw e;
  }

  if (!assertion) {
    throw new PrfUnlockError("cancelled", "Authenticator returned no assertion.");
  }
  const extOutputs = assertion.getClientExtensionResults() as {
    prf?: { results?: { first?: ArrayBuffer } };
  };
  const prfOutput = extOutputs.prf?.results?.first;
  if (!prfOutput) {
    throw new PrfUnlockError(
      "no-prf-output",
      "Authenticator returned no PRF output. The authenticator may not support the PRF extension, or its keys may have rotated.",
    );
  }
  return { prfOutput: new Uint8Array(prfOutput) };
}
