// Encrypt-at-rest enrollment, shared by the popup and the onboarding flow.
//
// Extracted from popup.tsx when onboarding moved to a full tab: both entry
// points run the same enrol-rewrap-relay sequence, and a second copy would
// eventually drift on the step ordering — which matters here, because the
// order is load-bearing (see step 2).
//
// Must run in a VISIBLE, user-gestured context. `navigator.credentials.*`
// hangs in the offscreen document, which is why this lives in the view layer
// at all.

/// <reference types="chrome" />

import { IndexedDBKVStore, rewrapHolderV4Secret } from "@openvtc/pnm-core";
import { base64url } from "@openvtc/vti-didcomm-js";
import { WebAuthnPrfSecretWrap } from "./webauthn-prf-wrap.js";
import { setSettings } from "./config.js";
import { RUNTIME_UNLOCK_PRF, type RuntimeUnlockPrfResponse } from "./bridge-protocol.js";

export // Run the encrypt-at-rest enrollment in this (visible, gestured) popup
// context AND relay the resulting PRF output to offscreen so its sibling
// `cachedKey` lands seeded too. Without the relay, the next holder-
// touching op in offscreen would throw `WalletLockedError` and force a
// redundant unlock ceremony — popup's cache is warm, offscreen's isn't,
// they live in separate module scopes.
//
// Used by both the post-onboard encrypt prompt and the in-session
// "wallet not encrypted" warning banner — same enrol-rewrap-relay
// shape from both entry points.
async function encryptHolderSecretInPopup(vtaDid: string): Promise<void> {
  // Step 1: re-wrap the persisted secret behind the PRF AES key. Runs
  // the WebAuthn enrollment ceremony as a side effect. After this, the
  // popup's module-scope `cachedKey` is warm AND the IndexedDB record
  // is encrypted at rest. Multi-VTA: `vtaDid` selects which VTA's
  // record gets the rewrap; every other VTA's record on this device
  // is untouched.
  await rewrapHolderV4Secret(new IndexedDBKVStore(), {
    vtaDid,
    toWrap: new WebAuthnPrfSecretWrap(chrome.runtime.id),
  });
  // Step 2: persist the setting so future cold starts dispatch on
  // PRF-wrap. Critical that this lands BEFORE the relay — if the relay
  // fails, the wallet's still in a consistent state (record + flag
  // both say PRF), and the operator just sees UnlockView on next op.
  // The original order (relay → setSettings) left a window where a
  // failed relay would leave the record encrypted but the flag
  // plaintext, which breaks loadHolder() on cold start.
  await setSettings({ encryptHolderSecret: true });
  // Step 3: relay the raw PRF output to offscreen so its `cachedKey`
  // is seeded alongside the popup's. Drained one-shot from the wrap
  // module to avoid stale-value reuse on a later call. Failure here is
  // recoverable — the next offscreen op throws `WalletLockedError`,
  // popup renders UnlockView, operator runs the read-side ceremony.
  const prfOutput = WebAuthnPrfSecretWrap.consumeLastEnrolledPrfOutput();
  if (prfOutput) {
    const res = (await chrome.runtime.sendMessage({
      type: RUNTIME_UNLOCK_PRF,
      prfOutputB64u: base64url.encode(prfOutput),
    })) as RuntimeUnlockPrfResponse;
    if (!res.ok) {
      throw new Error(`offscreen unlock relay failed: ${res.error}`);
    }
  }
}
