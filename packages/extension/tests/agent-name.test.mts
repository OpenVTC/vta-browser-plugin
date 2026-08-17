// Agent names — see src/agent-name.ts.
//
// The canonicalisation cases below are the conformance table from the Agent
// Names Design & Implementation Guide, copied deliberately. Two implementations
// that canonicalise differently disagree about whether a name verifies against
// a document, which is a security disagreement rather than a cosmetic one, so
// these are pinned rather than reasoned about locally.

import test from "node:test";
import assert from "node:assert/strict";
import {
  parseAgentName,
  extractAgentNames,
  alsoKnownAsContains,
  looksLikeAgentName,
  withoutScheme,
  displayAgentName,
} from "../src/agent-name.ts";

const canon = (s: string) => parseAgentName(s)?.canonical;

test("canonicalisation matches the specification table", () => {
  assert.equal(canon("example.com/@alice"), "https://example.com/@alice");
  assert.equal(canon("EXAMPLE.COM/@alice"), "https://example.com/@alice");
  assert.equal(canon("https://example.com:443/@alice"), "https://example.com/@alice");
  assert.equal(canon("https://example.com/@alice/"), "https://example.com/@alice");
  assert.equal(canon("  example.com/@alice  "), "https://example.com/@alice");
  assert.equal(canon("https://example.com:8443/@alice"), "https://example.com:8443/@alice");
});

test("local part case is preserved, never folded", () => {
  // Folding could silently merge two distinct identities — strictly worse than
  // a name that occasionally fails to match.
  assert.equal(canon("example.com/@Alice"), "https://example.com/@Alice");
  assert.notEqual(canon("example.com/@Alice"), canon("example.com/@alice"));
});

test("the marker is '/@', never a bare '@'", () => {
  assert.equal(looksLikeAgentName("alice@example.com"), false);
  assert.equal(parseAgentName("alice@example.com"), null);
  assert.equal(looksLikeAgentName("example.com/@alice"), true);
});

test("the community name is a valid name with an empty local part", () => {
  const community = parseAgentName("example.com/@");
  assert.equal(community?.canonical, "https://example.com/@");
  assert.equal(community?.localName, "");
});

test("the community name must not carry a path", () => {
  // Otherwise `example.com/@/alice` and `example.com/@alice` differ by one
  // slash while looking near-identical in a URL bar.
  assert.equal(parseAgentName("example.com/@/alice"), null);
});

test("trailing segments are part of the identity", () => {
  const q = parseAgentName("firstperson.network/@drummond/h2hsummit");
  assert.equal(q?.canonical, "https://firstperson.network/@drummond/h2hsummit");
  assert.deepEqual(q?.pathSegments, ["h2hsummit"]);
  assert.notEqual(q?.canonical, canon("firstperson.network/@drummond"));
});

test("more than one marker is ambiguous and rejected", () => {
  assert.equal(parseAgentName("example.com/@a/@b"), null);
});

test("malformed and non-http inputs are rejected", () => {
  for (const bad of ["", "   ", "example.com/alice", "ftp://example.com/@alice", "/@alice"]) {
    assert.equal(parseAgentName(bad), null, bad);
  }
});

// ── alsoKnownAs: the authoritative DID → name direction ──────────────────

const AKA = [
  "https://example.com/@alice",
  "did:web:example.com",
  "mailto:alice@example.com",
];

test("extract skips entries that are not agent names", () => {
  // alsoKnownAs legitimately holds other identifier types; those are not errors.
  const names = extractAgentNames(AKA);
  assert.equal(names.length, 1);
  assert.equal(names[0]?.canonical, "https://example.com/@alice");
});

test("extract handles a missing alsoKnownAs", () => {
  assert.deepEqual(extractAgentNames(undefined), []);
  assert.deepEqual(extractAgentNames([]), []);
});

test("a claim matches across cosmetic spellings", () => {
  const typed = parseAgentName("EXAMPLE.COM/@alice/")!;
  assert.equal(alsoKnownAsContains(AKA, typed), true);
  assert.equal(alsoKnownAsContains(["example.com/@alice"], typed), true);
});

test("matching is exact — no prefix or wildcard", () => {
  const alice = parseAgentName("example.com/@alice")!;
  assert.equal(alsoKnownAsContains(["https://example.com/@alicia"], alice), false);
  // A path-qualified name is not satisfied by its bare parent, nor the reverse.
  const qualified = parseAgentName("example.com/@alice/work")!;
  assert.equal(alsoKnownAsContains(["https://example.com/@alice"], qualified), false);
  assert.equal(alsoKnownAsContains(["https://example.com/@alice/work"], alice), false);
});

test("a different host never matches", () => {
  const alice = parseAgentName("example.com/@alice")!;
  assert.equal(alsoKnownAsContains(["https://evil.com/@alice"], alice), false);
});

test("an undefined alsoKnownAs claims nothing", () => {
  const alice = parseAgentName("example.com/@alice")!;
  assert.equal(alsoKnownAsContains(undefined, alice), false);
});

test("withoutScheme gives the compact display spelling", () => {
  assert.equal(withoutScheme(parseAgentName("https://example.com/@alice")!), "example.com/@alice");
});

test("the community name is spelled out, not left as a dangling marker", () => {
  // `example.com/@` reads like a truncation bug; it is not one.
  const community = parseAgentName("example.com/@")!;
  assert.equal(displayAgentName(community), "example.com (community)");
  assert.equal(displayAgentName(parseAgentName("example.com/@alice")!), "example.com/@alice");
});
