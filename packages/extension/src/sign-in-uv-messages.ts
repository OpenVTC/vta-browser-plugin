// What the wallet says about approving sign-ins with a PIN or the phone, where
// the sign-in flow and the options page both need the same words.

import {
  DEVICE_UV_PIN_WRONG,
  DEVICE_UV_KEY_LOCKED,
  DEVICE_UV_KEY_CHANGE_PROOF_REQUIRED,
  DEVICE_UV_KEY_CHANGE_PROOF_INVALID,
  DEVICE_UV_APPROVER_NOT_PERMITTED,
} from "@openvtc/pnm-core";

/** What it takes for a phone to approve for this browser: the agent lets only
 *  a phone its administrator designated. Said when none is listed and when one
 *  is refused. */
export const UV_APPROVER_HELP =
  "Your phone can't approve for this browser yet. Connect the OpenVTC app on your phone to the same agent, " +
  "then ask an administrator of the agent to make that phone this browser's approver.";

/** What the member is told when their agent refused to change how this
 *  browser approves (`device/heartbeat`), by its code. Shared with the
 *  options page's "Sign-in approval" section. */
export const DEVICE_UV_REFUSAL_MESSAGES: Readonly<Record<string, string>> = {
  [DEVICE_UV_PIN_WRONG]: "Wrong PIN.",
  [DEVICE_UV_KEY_LOCKED]: "Too many wrong PINs. Try again later.",
  [DEVICE_UV_KEY_CHANGE_PROOF_REQUIRED]: "Your agent needs your current PIN to change how this browser approves.",
  [DEVICE_UV_KEY_CHANGE_PROOF_INVALID]: "Your agent couldn't read the PIN check. Try again.",
  [DEVICE_UV_APPROVER_NOT_PERMITTED]: UV_APPROVER_HELP,
};

