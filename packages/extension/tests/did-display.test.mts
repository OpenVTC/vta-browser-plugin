// Display-splitting of DIDs — see src/did-display.ts.
//
// The invariant that matters most is lossless round-tripping: this feeds a
// security prompt, and a renderer that drops a segment would show the user a
// different identifier than the one being approved.

import test from "node:test";
import assert from "node:assert/strict";
import { splitDid, didHost, collapseDid } from "../src/did-display.ts";

/** Concatenating the parts must reproduce the input, always. */
function rejoin(did: string): string {
  return splitDid(did)
    .map((p) => p.text)
    .join("");
}

const WEBVH = "did:webvh:QmZ4tDx9fLp3nR7wUvKp2v:vta.affinidi.com";
const WEBVH_PATH = `${WEBVH}:contexts:acme`;
const PEER = "did:peer:2.Ez6LSpSrLxbAhg2SHwKk7kwpsH7DM7QjMbvCoDsJRRDLmvXtF";

test("a webvh DID splits into method, scid, host", () => {
  assert.deepEqual(splitDid(WEBVH), [
    { text: "did:webvh:", role: "method" },
    { text: "QmZ4tDx9fLp3nR7wUvKp2v", role: "opaque" },
    { text: ":", role: "method" },
    { text: "vta.affinidi.com", role: "host" },
  ]);
});

test("trailing path segments are kept as one path part", () => {
  const parts = splitDid(WEBVH_PATH);
  assert.equal(parts.at(-1)?.role, "path");
  assert.equal(parts.at(-1)?.text, ":contexts:acme");
});

test("every shape round-trips losslessly", () => {
  // The security-relevant invariant: what is rendered is what was passed in.
  for (const did of [WEBVH, WEBVH_PATH, PEER, "did:key:z6Mkf", "did:webvh:", "nonsense", ""]) {
    assert.equal(rejoin(did), did, did);
  }
});

test("non-webvh DIDs are left whole rather than guessed at", () => {
  // Emphasising the wrong segment as "the host" would invite exactly the
  // misread the treatment exists to prevent, so unknown methods stay plain.
  assert.deepEqual(splitDid(PEER), [{ text: PEER, role: "opaque" }]);
  assert.equal(didHost(PEER), undefined);
});

test("malformed webvh DIDs are left whole", () => {
  for (const did of ["did:webvh:", "did:webvh:onlyscid"]) {
    const parts = splitDid(did);
    assert.equal(parts.length, 1, did);
    assert.equal(parts[0]?.role, "opaque", did);
  }
});

test("empty input yields no parts", () => {
  assert.deepEqual(splitDid(""), []);
});

test("didHost lifts the verification target", () => {
  assert.equal(didHost(WEBVH), "vta.affinidi.com");
  assert.equal(didHost(WEBVH_PATH), "vta.affinidi.com");
});

test("a percent-encoded host is left encoded", () => {
  // webvh encodes `:` in the host segment; it is compared by eye against a
  // domain, which never contains one, so decoding would only invite confusion.
  assert.equal(didHost("did:webvh:QmAbc:localhost%3A8080"), "localhost%3A8080");
});

// ── Collapsed rendering ──────────────────────────────────────────────────
// The consent prompt shows a shortened DID by default. Whatever it elides, it
// must not be the host — that is the segment the whole prompt asks the user to
// check.

test("collapsing never hides the host, even with a path after it", () => {
  const text = collapseDid(WEBVH_PATH).map((p) => p.text).join("");
  assert.ok(text.includes("vta.affinidi.com"), text);
  assert.ok(text.includes("contexts:acme"), text);
  assert.ok(text.length < WEBVH_PATH.length, "should actually shorten");
});

test("collapsing elides the scid, which is what nobody reads", () => {
  const parts = collapseDid(WEBVH);
  const opaque = parts.find((p) => p.role === "opaque");
  assert.ok(opaque?.text.endsWith("…"), opaque?.text);
  assert.equal(parts.find((p) => p.role === "host")?.text, "vta.affinidi.com");
});

test("a short scid is left alone rather than gratuitously elided", () => {
  const parts = collapseDid("did:webvh:QmAbc:vta.example");
  assert.equal(parts.find((p) => p.role === "opaque")?.text, "QmAbc");
});

test("did:peer falls back to head-and-tail", () => {
  const text = collapseDid(PEER).map((p) => p.text).join("");
  assert.ok(text.startsWith("did:peer:2.Ez6LS"), text);
  assert.ok(text.includes("…"), text);
});

// Agent names are NOT derived from DID structure — they come from the
// document's alsoKnownAs. See tests/agent-name.test.mts; the helpers that used
// to guess one from a trailing path segment were removed as a spoofing risk.

test("a trailing segment is a path, never promoted to a name", () => {
  const parts = splitDid("did:webvh:QmV2DUD2u665:webvh.storm.ws:glenn-vta");
  assert.deepEqual(parts.map((p) => p.role), ["method", "opaque", "method", "host", "path"]);
  assert.equal(parts.at(-1)?.text, ":glenn-vta");
});
