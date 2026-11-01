/// <reference types="chrome" />

// The popup's half of reporting a consent decision. The background's half, and
// the race both halves exist to close (Keyring VTI-40), are in
// `consent-window.ts`.
//
// The rule is one line: **send, wait for the acknowledgement, then close.** The
// popup used to fire the result and call `window.close()` in the same tick, and
// the window's removal could reach the service worker ahead of the result — which
// the background reads as the operator dismissing the prompt. An Approve became a
// Deny with nothing on screen to say so.
//
// One window stays open after its decision: the ballot window, which goes on to
// show the vote's progress (`election-consent.tsx`). It asks with `keepOpen`,
// and stays only once the background acknowledged a consent it was waiting for
// (`matched`); anything else closes it as below, because a window left open on
// an undelivered decision would wait for progress that never comes. The
// background treats that window's later closing as nothing: the consent has
// already settled, and `settle` is idempotent.
//
// A failed send still closes the window. The background then settles the consent
// as a denial when it sees the window go, which is the correct answer to "the
// decision never arrived" — and a popup that stayed open on an error would leave
// the operator clicking a button that can no longer do anything.

import { RUNTIME_CONSENT_RESULT, type RuntimeConsentResult } from "./bridge-protocol.js";

export interface ConsentResultDeps {
  send: (message: RuntimeConsentResult) => unknown;
  close: () => void;
}

function browserDeps(): ConsentResultDeps {
  return {
    send: (message) => chrome.runtime.sendMessage(message),
    close: () => window.close(),
  };
}

/** Build a sender that reports the popup's decision once. It resolves `true`
 *  when the window stays open (`keepOpen`, and the background took the decision).
 *
 *  Once, because the window now stays up for the round trip: a second click in
 *  that interval (Approve, then Deny) must not send a second, contradicting
 *  answer. The background keeps the first decision anyway — `settle` is
 *  idempotent — but the popup should not offer a race it then loses. */
export function consentResultSender(
  consentId: string,
  deps: ConsentResultDeps = browserDeps(),
): (decision: Omit<RuntimeConsentResult, "type" | "consentId">, opts?: { keepOpen?: boolean }) => Promise<boolean> {
  let sent = false;
  return async (decision, opts) => {
    if (sent) return false;
    sent = true;
    let matched = false;
    try {
      const ack = await deps.send({ type: RUNTIME_CONSENT_RESULT, consentId, ...decision });
      matched = (ack as { matched?: unknown } | undefined)?.matched === true;
    } catch {
      // Nothing to do: see the header. The close below is the fallback.
    }
    if (opts?.keepOpen && matched) return true;
    deps.close();
    return false;
  };
}
