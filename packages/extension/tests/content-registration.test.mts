// Which origins the page provider registers for — see content-registration.ts.
//
// Only the pure selection is covered; the register/update/unregister calls are
// thin wrappers over chrome.scripting with nothing to assert without a browser.

import test from "node:test";
import assert from "node:assert/strict";
import { providerMatches } from "../src/content-registration.ts";

test("granted origins become the match list, sorted", () => {
  assert.deepEqual(
    providerMatches(["https://b.example/*", "https://a.example/*"]),
    ["https://a.example/*", "https://b.example/*"],
  );
});

test("no grants means no matches", () => {
  // The caller unregisters rather than registering an empty list, which
  // Chrome rejects.
  assert.deepEqual(providerMatches([]), []);
});

test("a blanket grant collapses to <all_urls>", () => {
  // Filtering it out would run the provider nowhere while Chrome reports full
  // access — the most confusing possible state.
  assert.deepEqual(providerMatches(["<all_urls>", "https://a.example/*"]), ["<all_urls>"]);
  assert.deepEqual(providerMatches(["*://*/*"]), ["<all_urls>"]);
});

test("non-http origins are dropped, not passed through", () => {
  // One bad pattern fails the whole registration call, taking the working
  // origins down with it.
  assert.deepEqual(
    providerMatches(["file:///*", "ftp://x.example/*", "https://ok.example/*"]),
    ["https://ok.example/*"],
  );
});

test("http is kept — loopback development targets are real", () => {
  assert.deepEqual(providerMatches(["http://localhost/*"]), ["http://localhost/*"]);
});
