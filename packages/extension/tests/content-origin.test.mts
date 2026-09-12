// The content script's page-facing listener, driven with forged `message`
// events.
//
// `event.source === window` already means the sender is code in this frame, so
// the origin check this pins is defence in depth rather than a hole being
// closed — the background never trusts the origin in the body anyway, it
// overwrites it with the browser-attested `sender.origin`. What the test is
// for is the *pair*: the two conditions fail for different reasons, and a later
// change that loosens either one should have to come through here.
//
// Imports the real `content.ts` into a happy-dom window rather than
// re-implementing its predicate. A copied predicate is the shape of test that
// keeps passing after the code it describes has changed.

import { test } from "node:test";
import assert from "node:assert/strict";
import { Window } from "happy-dom";

const PAGE_ORIGIN = "https://rp.example";
const INPAGE_SOURCE = "vta-wallet/inpage";

const window = new Window({
  url: `${PAGE_ORIGIN}/login`,
  settings: {
    // `content.ts` injects `provider.js` as a page-world <script> on load. The
    // test is not about that, and letting happy-dom try to fetch a
    // `chrome-extension://` URL only produces noise.
    disableJavaScriptFileLoading: true,
    disableCSSFileLoading: true,
  },
});

const define = (name: string, value: unknown): void => {
  Object.defineProperty(globalThis, name, { value, writable: true, configurable: true });
};
define("window", window);
define("document", window.document);
// A real window has `origin`; happy-dom does not always, and the listener reads
// it. Set from the window's own URL, which is what a browser would report.
if (typeof (window as unknown as { origin?: string }).origin !== "string") {
  Object.defineProperty(window, "origin", { value: PAGE_ORIGIN, configurable: true });
}

/** Every message the content script relayed to the background. */
const relayed: Array<{ type: string; origin: string }> = [];

define("chrome", {
  runtime: {
    getURL: (path: string) => `chrome-extension://testextensionidtestextensionid/${path}`,
    sendMessage: async (message: { type: string; origin: string }) => {
      relayed.push(message);
      return { ok: true, result: {} };
    },
    onMessage: { addListener: () => {} },
  },
});

// After the globals: the listener is registered at import time.
await import("../src/content.ts");

let nextId = 0;

/** Post a well-formed provider request, with `origin` and `source` forged. */
function post(origin: string, source: unknown): void {
  const data = {
    source: INPAGE_SOURCE,
    id: `req-${++nextId}`,
    method: "walletDefaults",
    params: {},
  };
  const event = new window.MessageEvent("message", { data, origin });
  // `source` is read-only on a constructed MessageEvent and is the field a page
  // cannot forge in a real browser — which is exactly why the test must.
  Object.defineProperty(event, "source", { value: source, configurable: true });
  window.dispatchEvent(event);
}

/** Let the listener's async relay run. */
const settle = (): Promise<void> => new Promise((resolve) => setTimeout(resolve, 0));

test("a request from this window at this origin is relayed", async () => {
  relayed.length = 0;
  post(PAGE_ORIGIN, window);
  await settle();
  assert.equal(relayed.length, 1, "the ordinary case must still work");
  assert.equal(relayed[0]?.type, "vta-wallet/wallet-defaults");
});

test("a same-window message claiming another origin is dropped", async () => {
  relayed.length = 0;
  for (const origin of ["https://evil.example", "null", ""]) {
    post(origin, window);
  }
  await settle();
  assert.deepEqual(relayed, [], "event.origin must be checked, not ignored");
});

test("a message from another window is dropped whatever origin it claims", async () => {
  relayed.length = 0;
  const iframe = { name: "some other window" };
  post(PAGE_ORIGIN, iframe);
  post("https://evil.example", iframe);
  await settle();
  assert.deepEqual(relayed, []);
});

test("a message without the provider marker is dropped", async () => {
  relayed.length = 0;
  const event = new window.MessageEvent("message", {
    data: { source: "something-else", id: "x", method: "login", params: {} },
    origin: PAGE_ORIGIN,
  });
  Object.defineProperty(event, "source", { value: window, configurable: true });
  window.dispatchEvent(event);
  await settle();
  assert.deepEqual(relayed, []);
});
