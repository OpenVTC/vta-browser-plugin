/// <reference types="chrome" />

// The consent window's lifecycle, as seen from the background.
//
// Every consent surface — site consent, task consent, the WebAuthn approver and
// persona disclosure — is a `confirm.html` popup that reports its decision with
// a RUNTIME_CONSENT_RESULT message and then closes itself. The background also
// treats the window being closed as a denial, because a prompt dismissed with
// the X is a "no", and silence is not agreement.
//
// Those are two different Chrome events arriving at the service worker, and
// Chrome does not order them for us. Keyring (VTI-40) found the consequence: the
// popup sent its result without awaiting it and called `window.close()` in the
// same tick, so `windows.onRemoved` could reach the worker first and settle an
// **Approve as a Deny**, silently. The result then arrived at a consent that was
// already settled and was dropped.
//
// Two changes close it, and they are layered on purpose:
//
//   1. The popup awaits the result's acknowledgement before it closes
//      (`consent-result.ts`), and the background acknowledges only after the
//      decision is settled (`deliverConsentResult`). A popup that follows the
//      protocol therefore cannot be removed before its decision has landed.
//
//   2. The close-means-deny path waits a grace period before denying
//      (`CLOSE_GRACE_MS`). That covers a result already in flight when the
//      window went away for some other reason — the operator hit Approve and
//      then the X, or a close raced the ack. A microtask or a zero timeout is
//      NOT enough here: the result is a separate event on the worker's task
//      queue and may be queued behind the removal by an arbitrary amount. A
//      decision that lands inside the grace wins, because `settle` is
//      idempotent and whichever settles first is final; a decision that never
//      comes still ends as a denial, only a moment later.
//
// The grace can only ever convert a would-be denial into the decision the
// operator actually made. It never manufactures an approval: the only thing
// that settles as approved is a RUNTIME_CONSENT_RESULT carrying `approved: true`.

/** How long a closed consent window waits for an in-flight decision before the
 *  close is taken as a denial. Long enough to cover the worker's event queue
 *  under load; short enough that a dismissed prompt still reads as prompt. */
export const CLOSE_GRACE_MS = 1000;

/** The popup's settlement callback, keyed by consent id. */
export type ConsentDecision = (
  approved: boolean,
  remember: boolean,
  prfOutputB64u?: string,
  selectedDid?: string,
) => void;

/** The subset of `chrome.windows` this file drives — narrow so a test can
 *  supply it without a browser. */
export interface ConsentWindowsApi {
  create(
    data: { url: string; type: "popup"; width?: number; height?: number; left?: number; top?: number },
    callback: (win?: { id?: number }) => void,
  ): void;
  onRemoved: {
    addListener(listener: (windowId: number) => void): void;
    removeListener(listener: (windowId: number) => void): void;
  };
}

export interface ConsentWindowDeps {
  windows: ConsentWindowsApi;
  /** `chrome.runtime.lastError?.message`, read inside the create callback —
   *  the only place it exists. */
  lastError: () => string | undefined;
  setTimer: (fn: () => void, ms: number) => unknown;
  graceMs: number;
}

function chromeDeps(): ConsentWindowDeps {
  return {
    windows: chrome.windows as unknown as ConsentWindowsApi,
    lastError: () => chrome.runtime.lastError?.message,
    setTimer: (fn, ms) => setTimeout(fn, ms),
    graceMs: CLOSE_GRACE_MS,
  };
}

/**
 * Open a consent popup and arrange for it to end as a denial if it cannot be
 * opened, or if it is closed without a decision arriving.
 *
 * `deny` must be the consent's own idempotent `settle(false, …)`: it may be
 * called after the consent has already settled from the popup's result, and
 * must then do nothing.
 */
export function openConsentWindow(
  args: {
    url: string;
    bounds: { width: number; height: number; left?: number; top?: number };
    deny: () => void;
    /** Log prefix, e.g. `[pnm consent]`. */
    tag: string;
    /** Names the surface in the log line, e.g. "consent window". */
    what: string;
  },
  deps: ConsentWindowDeps = chromeDeps(),
): void {
  const { url, bounds, deny, tag, what } = args;
  deps.windows.create({ url, type: "popup", ...bounds }, (win) => {
    const winId = win?.id;
    if (winId === undefined) {
      // The window could not be opened. This used to `return` without
      // settling, leaving the promise pending forever: the caller's `await`
      // never resolved, no decision was ever produced, and nothing was logged
      // in any context. From the outside that is indistinguishable from a
      // request that never arrived — which is exactly how it presented, after
      // the message had already been verified, de-duplicated, and acked to
      // the mediator (so its queued copy was gone too).
      //
      // Settle as a DENIAL, never assent. A prompt the user never saw must
      // not become an approval, and the rest of the background is built on
      // "silence is not agreement".
      //
      // `lastError` is read inside the callback because that is the only
      // place it exists; leaving it unread also emits an "unchecked
      // runtime.lastError" warning that buries the real reason.
      const why = deps.lastError() ?? "no window was created";
      console.error(`${tag} could not open the ${what} — treating as a denial:`, why);
      deny();
      return;
    }
    // A window id proves creation succeeded; it does NOT prove the window is
    // visible. `consentWindowBounds` derives left/top from
    // `chrome.windows.getLastFocused()`, so a minimised window, a second
    // display, or an undocked DevTools window can place the prompt somewhere
    // the user never looks — and that is indistinguishable from no prompt at
    // all. Log where it went so "I see no popup" is answerable.
    console.info(`${tag} ${what} opened`, "id=", winId, "bounds=", JSON.stringify(bounds));
    // Closing the window without deciding is a denial — after the grace, so a
    // decision already on its way is not overtaken by the removal (VTI-40).
    const onClosed = (closedId: number) => {
      if (closedId !== winId) return;
      deps.windows.onRemoved.removeListener(onClosed);
      deps.setTimer(deny, deps.graceMs);
    };
    deps.windows.onRemoved.addListener(onClosed);
  });
}

/**
 * Settle the consent a RUNTIME_CONSENT_RESULT names, synchronously, and report
 * whether one was waiting.
 *
 * The caller acknowledges with `sendResponse` straight after, and that ordering
 * is the point: the popup closes itself only once the acknowledgement arrives,
 * so by the time its window is removed the decision has already settled.
 */
export function deliverConsentResult(
  pending: Map<string, ConsentDecision>,
  result: {
    consentId: string;
    approved: boolean;
    remember?: boolean;
    prfOutputB64u?: string;
    selectedDid?: string;
  },
): boolean {
  const decision = pending.get(result.consentId);
  if (!decision) return false;
  decision(result.approved, !!result.remember, result.prfOutputB64u, result.selectedDid);
  return true;
}
