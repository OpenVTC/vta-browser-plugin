// Same-device trigger links: the click half (VTI-LNK-056, contract C2).
//
// A portal shows its sign-in code as a QR code wrapped in `<a href="https://
// link.trustoverip.org/t#_from=…">` (VTI-LNK-086). On a desktop with this
// plugin, clicking the code should open the wallet rather than the link host's
// no-wallet page. This module is the content script's listener for that click.
//
// Four properties, each a rule rather than a preference:
//
//  1. **Only a click the person made.** `event.isTrusted` is false for
//     `a.click()`, a dispatched `MouseEvent` and every other synthetic event a
//     page can produce; such an activation is never acted on (VTI-LNK-056).
//
//  2. **The origin is recorded at the click.** `location.origin` is read in the
//     listener, synchronously, before anything else can run — a page that
//     navigates itself a moment later must not change which page the link was
//     activated from. The background then holds it to the browser-attested
//     `sender.origin` (the body's copy is a claim, never the answer).
//
//  3. **Text that is not a trigger link navigates normally** (`pass-on`,
//     VTI-LNK-021). Anything else is ours: the default navigation is prevented
//     and the link goes to the service worker, which re-parses it and shows the
//     person the outcome. A refused link is shown in the wallet's own window,
//     with the spec's message — never by letting the browser carry the handle
//     to the link host.
//
//  4. **The page learns nothing of the result.** The message to the worker is
//     fire-and-forget; its answer is never posted back into the page, no event
//     is dispatched, nothing is written to the DOM. (A page can observe that
//     its own click was default-prevented — that says a wallet is present, not
//     what it decided, and the portal already knows it showed a code.)
//
// The parse here is a *routing* decision, made synchronously because
// `preventDefault` only works inside the listener. It is not trusted: the
// background parses the same text again before it acts.

import { parseTriggerLink } from "@openvtc/pnm-core/links";

/** What the content script hands the worker. `content.ts` wraps it in the
 *  `RUNTIME_TRIGGER_LINK` message, whose type string it inlines beside the
 *  others so `page-facing-surface.test.mts` checks it. */
export interface TriggerLinkActivation {
  /** The anchor's resolved `href`, unchanged. */
  link: string;
  /** `location.origin` at the moment of the click. */
  origin: string;
}

export interface TriggerLinkClickDeps {
  /** Deliver the activation to the worker. The result is never read. */
  send: (message: TriggerLinkActivation) => void;
  /** Epoch seconds. */
  now: () => number;
}

/**
 * Install the capture-phase click listener on `win`.
 *
 * Capture on the window, so the decision is taken before a page handler can
 * stop the event — and so a page cannot hide a trigger link from the wallet by
 * calling `stopPropagation` on the anchor.
 */
export function installTriggerLinkClickHandler(win: Window, deps: TriggerLinkClickDeps): () => void {
  const listener = (event: Event) => onClick(win, event as MouseEvent, deps);
  win.addEventListener("click", listener, { capture: true });
  return () => win.removeEventListener("click", listener, { capture: true });
}

function onClick(win: Window, event: MouseEvent, deps: TriggerLinkClickDeps): void {
  // 1. A click the person made, with the primary button and no modifier. A
  //    modified click asks the browser for a new tab or window; leaving those
  //    alone keeps "open the link host's page" one gesture away.
  if (!event.isTrusted) return;
  if (event.defaultPrevented) return;
  if (event.button !== 0 || event.ctrlKey || event.metaKey || event.shiftKey || event.altKey) return;

  const href = anchorHref(event, win);
  if (href === undefined) return;

  // 3. Routing only — the worker re-parses.
  const parsed = parseTriggerLink(href, { now: deps.now() });
  if (!parsed.ok && parsed.outcome === "pass-on") return;

  // 2. The origin, now.
  const origin = win.location.origin;
  event.preventDefault();

  // 4. Fire and forget. Errors are swallowed: reporting one to the page would
  //    tell it something, and there is nothing it could do with it anyway.
  try {
    deps.send({ link: href, origin });
  } catch {
    // The extension context may have been invalidated by a reload. The click
    // is already prevented; the person clicks again after the page reloads.
  }
}

/** The resolved `href` of the nearest anchor on the event's path, if any.
 *  `composedPath` reaches into open shadow roots, where a portal's QR
 *  component may render its anchor. SVG `<a>` carries its href as an
 *  attribute and is resolved against the document's base URL. */
function anchorHref(event: Event, win: Window): string | undefined {
  const path = typeof event.composedPath === "function" ? event.composedPath() : [];
  for (const node of path) {
    if (!node || typeof (node as Element).tagName !== "string") continue;
    const el = node as Element;
    if (el.tagName.toLowerCase() !== "a") continue;
    const raw = el.getAttribute("href") ?? el.getAttribute("xlink:href");
    if (raw === null) return undefined;
    try {
      return new URL(raw, win.document.baseURI).href;
    } catch {
      return undefined;
    }
  }
  return undefined;
}
