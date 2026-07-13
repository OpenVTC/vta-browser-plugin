// Origin provenance for a page-facing wallet bridge.
//
// A wallet bridge takes security decisions on the strength of *which site is
// asking*: whether this origin has been connected before, whether the RP DID it
// claims has changed since it was pinned, what the consent prompt names. Those
// decisions are only as good as the origin they are handed.
//
// The trap is that a browser extension has two plausible sources for it, and the
// obvious one is wrong:
//
//   - the value the content script put in the *message body*, which is whatever
//     the sender chose to say, and
//   - the value the *browser* attributes to the sender, which page content
//     cannot forge.
//
// A `sender.id === runtime.id` check proves the message came from this
// extension. It says nothing about which page it came from: every content script
// (typically injected across `<all_urls>`), the popup, the options page, the
// consent window and the offscreen document all satisfy it. So a body-supplied
// origin is a *claim by an untrusted party about itself*, and treating it as
// authoritative means anyone who can reach the runtime can name any site they
// like — including one the user has already trusted.
//
// Hence this module. It is deliberately free of `chrome.*` types so it can be
// unit-tested, and so a mobile agent's IPC bridge can hold itself to the same
// rule.

/** The subset of a browser `MessageSender` that bears on provenance. */
export interface SenderLike {
  /** Present iff the sender is a page (a content script running in a tab). */
  tab?: unknown;
  /** Browser-attributed origin. Not forgeable by page content. */
  origin?: string | undefined;
  /** Browser-attributed URL. Fallback for engines that omit `origin`. */
  url?: string | undefined;
}

/**
 * The origin the **browser** attributes to a sender, or `undefined` if the
 * sender is not a page at all.
 *
 * Requires `tab`. Without that check an extension-internal sender — the popup,
 * the offscreen document, a compromised options page — reports its `origin` as
 * `chrome-extension://<id>`, which is a perfectly real origin and would sail
 * through any check that only asked "is an origin present?".
 *
 * Returns `undefined` rather than a placeholder, so a caller cannot accidentally
 * treat "no provenance" as an origin. A page-facing message with no page behind
 * it has no legitimate sender, and the caller should refuse it.
 */
export function attestedOrigin(sender: SenderLike | undefined): string | undefined {
  if (!sender?.tab) return undefined;
  if (sender.origin) return sender.origin;
  // Some engines populate the sender's URL but not its origin.
  if (sender.url) {
    try {
      return new URL(sender.url).origin;
    } catch {
      return undefined;
    }
  }
  return undefined;
}
