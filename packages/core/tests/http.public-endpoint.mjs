// What the wallet may dial — the table, driven.
//
// The payloads are the ones a probe of the shipped resolver showed getting
// through a literal-IP check: local-only names, and the IPv4 spellings the
// WHATWG URL parser rewrites into a private address. They are here as strings
// rather than as a description, because "rejects private addresses" is the
// claim every incomplete guard also makes.

import { test } from "node:test";
import assert from "node:assert/strict";

import { assertPublicHttpsUrl, isLoopbackHost, isPublicHost } from "../dist/http/index.js";

/** A URL the wallet is expected to be willing to dial, so every refusal test
 *  below is paired with something that must still pass. */
const GOOD = "https://gateway.example.com/trust-tasks";

/** Run something that must throw and hand back what it threw. `assert.throws`
 *  returns nothing, so it cannot be used where the assertion is about the
 *  thrown value's members rather than a pattern. */
function caught(fn) {
  try {
    fn();
  } catch (e) {
    return e;
  }
  assert.fail("expected a throw, and nothing was thrown");
}

test("an https URL on a public host is what this is for", () => {
  const url = assertPublicHttpsUrl(GOOD);
  assert.equal(url.hostname, "gateway.example.com");
  // A port, a path and a long suffix are all ordinary.
  assert.equal(assertPublicHttpsUrl("https://gw.example.co.uk:8443/x").port, "8443");
  assert.equal(assertPublicHttpsUrl("https://[2606:4700::1111]/x").hostname, "[2606:4700::1111]");
});

test("plain http is refused, and the reason names the scheme", () => {
  assert.throws(() => assertPublicHttpsUrl("http://gateway.example.com"), /must be https/);
  assert.throws(() => assertPublicHttpsUrl("ws://gateway.example.com"), /must be https/);
  assert.throws(() => assertPublicHttpsUrl("file:///etc/passwd"), /must be https/);
  assert.doesNotThrow(() => assertPublicHttpsUrl(GOOD));
});

test("userinfo is refused — it hides the host the request would reach", () => {
  const err = caught(() => assertPublicHttpsUrl("https://gateway.example.com@127.0.0.1/"));
  assert.match(err.message, /username or password/);
  // The message says where it would actually have gone…
  assert.match(err.message, /127\.0\.0\.1/);
  // …and not what was in the URL, which is a credential.
  assert.doesNotMatch(err.message, /gateway\.example\.com/);

  // A password-bearing form, and one where the userinfo is the only reason to
  // refuse: `example.com` on its own passes.
  assert.throws(
    () => assertPublicHttpsUrl("https://user:pw@gateway.example.com/x"),
    /username or password/,
  );
  assert.doesNotThrow(() => assertPublicHttpsUrl("https://gateway.example.com/x"));
});

test("what does not parse as a URL is refused as such", () => {
  assert.throws(() => assertPublicHttpsUrl("gateway.example.com"), /is not a URL/);
  assert.throws(() => assertPublicHttpsUrl(""), /is not a URL/);
  // webvh's percent-encoded port is not a URL either; that spelling belongs to
  // the DID host guard, which decodes it first.
  assert.throws(() => assertPublicHttpsUrl("https://localhost%3A8080/"), /is not a URL/);
});

// ── Names a browser can recognise as local-only ──────────────────────────────

const LOCAL_ONLY_NAMES = [
  "localhost",
  "app.localhost",
  "router.local",
  "metadata.google.internal",
  "printer.home.arpa",
  "intranet", // single label
  "metadata", // single label
];

test("a local-only name is refused even over https", () => {
  for (const host of LOCAL_ONLY_NAMES) {
    assert.throws(
      () => assertPublicHttpsUrl(`https://${host}/trust-tasks`),
      /not a public internet host/,
      `${host} must be refused`,
    );
    assert.equal(isPublicHost(host), false, host);
  }
  // A name that merely contains one of those labels is fine.
  assert.equal(isPublicHost("local.example.com"), true);
  assert.equal(isPublicHost("internal-tools.example.com"), true);
});

// ── Addresses, in every spelling the URL parser accepts ──────────────────────

// Left: what an attacker writes. Right: what the parser dials.
const NON_PUBLIC_ADDRESSES = [
  ["127.0.0.1", "loopback"],
  ["127.1", "loopback, short form"],
  ["0x7f000001", "loopback, hex"],
  ["2130706433", "loopback, decimal"],
  ["169.254.169.254", "link-local, cloud metadata"],
  ["0xa9fea9fe", "link-local, hex"],
  ["10.1", "RFC 1918, short form"],
  ["172.16.1", "RFC 1918, short form"],
  ["192.168.257", "RFC 1918, overflowing octet"],
  ["100.64.0.1", "CGNAT"],
  ["0.0.0.0", "this network"],
  ["255.255.255.255", "broadcast"],
  ["224.0.0.1", "multicast"],
  ["[::1]", "loopback"],
  ["[fc00::1]", "unique local"],
  ["[fe80::1]", "link-local"],
  ["[::ffff:127.0.0.1]", "IPv4-mapped loopback"],
  ["[2001:db8::1]", "documentation"],
  ["[2002:a00:1::1]", "6to4, carries an IPv4 address"],
];

test("a non-public address is refused, however it is spelled", () => {
  for (const [host, why] of NON_PUBLIC_ADDRESSES) {
    assert.throws(
      () => assertPublicHttpsUrl(`https://${host}/trust-tasks`),
      /not a public internet host/,
      `${host} (${why}) must be refused`,
    );
  }
  // Paired positive: a public address in both families still passes, so the
  // test above is not passing because everything is refused.
  assert.doesNotThrow(() => assertPublicHttpsUrl("https://8.8.8.8/x"));
  assert.doesNotThrow(() => assertPublicHttpsUrl("https://[2606:4700::1111]/x"));
});

test("neighbouring public addresses are not swept up with the blocked ranges", () => {
  // Off-by-one on a prefix length is the way a range table goes wrong quietly.
  for (const host of [
    "9.255.255.255",
    "11.0.0.1",
    "100.63.255.255",
    "100.128.0.0",
    "126.255.255.255",
    "128.0.0.1",
    "169.253.255.255",
    "169.255.0.1",
    "172.15.255.255",
    "172.32.0.1",
    "192.167.255.255",
    "192.169.0.1",
  ]) {
    assert.equal(isPublicHost(host), true, `${host} is public and must stay dialable`);
  }
});

// ── The loopback carve-out ───────────────────────────────────────────────────

test("loopback is dialable only when the caller asks for it, http included", () => {
  const opts = { allowLoopback: true };
  for (const url of [
    "http://127.0.0.1:4040/api/login",
    "http://localhost:8080/x",
    "https://[::1]:9000/x",
  ]) {
    assert.doesNotThrow(() => assertPublicHttpsUrl(url, opts), url);
    assert.throws(() => assertPublicHttpsUrl(url), /.*/, `${url} must need the carve-out`);
  }
  // The carve-out is loopback and nothing else: it is not a way to reach the
  // rest of the local network, or a public host over plain http.
  assert.throws(() => assertPublicHttpsUrl("http://router.local/x", opts), /must be https/);
  assert.throws(() => assertPublicHttpsUrl("http://10.0.0.5/x", opts), /must be https/);
  assert.throws(() => assertPublicHttpsUrl("https://10.0.0.5/x", opts), /not a public internet/);
  assert.throws(() => assertPublicHttpsUrl("http://gateway.example.com/x", opts), /must be https/);
});

test("isLoopbackHost knows the spellings of this machine", () => {
  for (const host of ["localhost", "app.localhost", "127.0.0.1", "127.1.2.3", "::1", "[::1]"]) {
    assert.equal(isLoopbackHost(host), true, host);
  }
  for (const host of ["gateway.example.com", "10.0.0.1", "128.0.0.1", "[2606:4700::1111]"]) {
    assert.equal(isLoopbackHost(host), false, host);
  }
});
