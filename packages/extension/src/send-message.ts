/// <reference types="chrome" />

// One place that talks to the background, so a missing reply reads as itself.
//
// `chrome.runtime.sendMessage` resolves **undefined** when nothing answers —
// the service worker failed to start, an exception stopped its listeners
// registering, or the message type predates the currently-loaded build. Every
// call site here was written as:
//
//     const res = (await chrome.runtime.sendMessage(...)) as Response;
//     if (res.ok) { … }
//
// which turns that silence into `Cannot read properties of undefined (reading
// 'ok')` — a TypeError that names none of the causes and sends the reader
// looking in the wrong file. This turns it into a sentence that says what to
// do.

/** Thrown when nothing answered. Distinct from a handler that answered with
 *  `{ ok: false }`: that is a failure the wallet understands, this is the
 *  wallet not being there at all. */
export class NoBackgroundResponse extends Error {
  readonly type: string;

  constructor(type: string) {
    super(
      `The wallet's background service didn't respond to "${type}". It may have been ` +
        `restarted, or the extension may need reloading at chrome://extensions.`,
    );
    this.type = type;
    this.name = "NoBackgroundResponse";
  }
}

/**
 * Send a message to the background and insist on a reply.
 *
 * Callers get the typed response or a thrown `NoBackgroundResponse` — never
 * `undefined`, so `res.ok` is always safe to read.
 */
export async function sendToBackground<T>(
  message: { type: string } & Record<string, unknown>,
): Promise<T> {
  const res = (await chrome.runtime.sendMessage(message)) as T | undefined;
  if (res === undefined || res === null) {
    throw new NoBackgroundResponse(message.type);
  }
  return res;
}
