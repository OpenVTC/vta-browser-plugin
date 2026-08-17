// Match-pattern derivation for just-in-time host grants.
//
// Only the pure part is covered here — `hasOriginPermission` /
// `requestOriginPermission` are thin wrappers over `chrome.permissions` and
// have nothing to assert without a browser. Importing the module is safe:
// the `chrome.*` calls live inside function bodies that these tests do not
// invoke.

import test from "node:test";
import assert from "node:assert/strict";
import { originPatternFor, displayHostFor } from "../src/host-permissions.ts";

test("a full URL reduces to its origin pattern", () => {
  assert.equal(originPatternFor("https://vta.example.com/api/v1"), "https://vta.example.com/*");
  assert.equal(originPatternFor("https://vta.example.com"), "https://vta.example.com/*");
});

test("a bare host from didWebvhDomain is assumed https", () => {
  assert.equal(originPatternFor("vta.example.com"), "https://vta.example.com/*");
});

test("webvh percent-encoding is decoded before parsing", () => {
  // `did:webvh:<scid>:localhost%3A8080` — the host segment encodes its colon.
  assert.equal(originPatternFor("localhost%3A8080"), "https://localhost/*");
});

test("the port is dropped — match patterns have no port component", () => {
  // `https://localhost:8080/*` is not a valid match pattern and would throw
  // at chrome.permissions.request; the portless form covers every port.
  assert.equal(originPatternFor("http://localhost:5173"), "http://localhost/*");
  assert.equal(originPatternFor("https://vta.example.com:8443/x"), "https://vta.example.com/*");
});

test("http is preserved rather than upgraded", () => {
  // Upgrading would request a grant that does not cover the origin actually
  // being fetched, so the request would succeed and the fetch still fail.
  assert.equal(originPatternFor("http://127.0.0.1:8080"), "http://127.0.0.1/*");
});

test("unusable inputs return null rather than a bogus pattern", () => {
  assert.equal(originPatternFor(""), null);
  assert.equal(originPatternFor("file:///etc/passwd"), null);
  assert.equal(originPatternFor("javascript:alert(1)"), null);
  assert.equal(originPatternFor("did:peer:2.Ez6LS"), null);
});

test("display host strips the scheme and wildcard", () => {
  assert.equal(displayHostFor("https://vta.example.com/api"), "vta.example.com");
  assert.equal(displayHostFor("localhost%3A8080"), "localhost");
});
