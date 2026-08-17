/// <reference types="chrome" />

// Unlocking, in one place.
//
// It used to live only in the popup's UnlockView, which meant the options page
// could be open against a locked wallet with no way to unlock and no sign that
// anything was wrong — settings render from storage, so the page looks fully
// alive right up until an operation fails.
//
// Must run in a VISIBLE, user-gestured context: `navigator.credentials.get`
// hangs in the offscreen document, which is the whole reason the ceremony
// happens in the view layer and the resulting PRF output is relayed inward.

import { base64url } from "@openvtc/vti-didcomm-js";
import { runPrfUnlockCeremony } from "./webauthn-prf-unlock.js";
import { readActiveVtaDid } from "./active-vta.js";
import {
  RUNTIME_UNLOCK_APPROVER,
  RUNTIME_UNLOCK_PRF,
  type RuntimeUnlockPrfResponse,
} from "./bridge-protocol.js";
import { sendToBackground } from "./send-message.js";

/**
 * Run the passkey ceremony and seed both the wallet and, if one exists, the
 * approver.
 *
 * One ceremony for both: they are separate *identities* but the same
 * authenticator and the same PRF output, so demanding two consecutive
 * biometric prompts bought nothing except teaching people to click through
 * them — which is corrosive to the per-approval gesture that does matter.
 *
 * The approver leg is best-effort. A wallet that unlocked is unlocked; an
 * approver that could not reach its mediator is a separate problem, reported
 * separately by the Advanced page rather than by failing this.
 */
export async function unlockWalletAndApprover(): Promise<void> {
  const { prfOutput } = await runPrfUnlockCeremony(chrome.runtime.id);
  // base64url: chrome.runtime.sendMessage's JSON serialisation turns a
  // Uint8Array into a plain object on the far side.
  const encoded = base64url.encode(prfOutput);

  const res = await sendToBackground<RuntimeUnlockPrfResponse>({
    type: RUNTIME_UNLOCK_PRF,
    prfOutputB64u: encoded,
  });
  if (!res.ok) throw new Error(res.error);

  const vtaDid = await readActiveVtaDid();
  if (!vtaDid) return;
  try {
    await sendToBackground({
      type: RUNTIME_UNLOCK_APPROVER,
      prfOutputB64u: encoded,
      vtaDid,
    });
  } catch {
    /* no approver minted, or its mediator is unreachable */
  }
}
