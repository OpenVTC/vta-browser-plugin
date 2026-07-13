import { test } from "node:test";
import assert from "node:assert/strict";

import { attestedOrigin } from "../dist/bridge/origin.js";

test("a page's origin is taken from the browser, not from anything it said", () => {
  assert.equal(
    attestedOrigin({ tab: { id: 7 }, origin: "https://rp.example" }),
    "https://rp.example",
  );
});

test("a sender with no tab has no attested origin, whatever origin it reports", () => {
  // This is the case that matters. The popup, the options page, the consent
  // window and the offscreen document all pass an extension's `sender.id`
  // check, and all report an origin — `chrome-extension://<id>` — which is a
  // perfectly real one. A check that merely asked "is an origin present?" would
  // wave them through as if they were a page.
  assert.equal(
    attestedOrigin({ origin: "chrome-extension://abcdef" }),
    undefined,
    "an extension context is not a page",
  );
  assert.equal(attestedOrigin({ origin: "https://bank.example" }), undefined);
  assert.equal(attestedOrigin(undefined), undefined);
  assert.equal(attestedOrigin({}), undefined);
});

test("falls back to the sender's URL when the engine omits origin", () => {
  assert.equal(
    attestedOrigin({ tab: { id: 1 }, url: "https://rp.example/some/path?q=1" }),
    "https://rp.example",
  );
});

test("a malformed sender URL yields no origin rather than a guess", () => {
  assert.equal(attestedOrigin({ tab: { id: 1 }, url: "not a url" }), undefined);
  assert.equal(attestedOrigin({ tab: { id: 1 } }), undefined);
});

test("origin is taken verbatim — port and scheme are part of it", () => {
  assert.equal(
    attestedOrigin({ tab: { id: 1 }, url: "http://localhost:5173/index.html" }),
    "http://localhost:5173",
  );
  // http and https are different origins, and so are different ports; a bridge
  // that normalised them away would let a dev server inherit a production
  // site's grants.
  assert.notEqual(
    attestedOrigin({ tab: { id: 1 }, url: "http://rp.example/" }),
    attestedOrigin({ tab: { id: 1 }, url: "https://rp.example/" }),
  );
});
