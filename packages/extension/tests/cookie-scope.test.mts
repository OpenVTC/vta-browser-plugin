// Scope checks for SessionBlob cookie injection — see src/cookie-scope.ts.
//
// Imports the TypeScript source directly: Node strips types natively on the
// engines floor (24), and `cookie-scope.ts` is deliberately dependency-free
// so there is nothing to build first. The extension's own tsconfig is
// `noEmit`, so there is no `dist/` to test against as core does.

import test from "node:test";
import assert from "node:assert/strict";
import {
  checkInjectableOrigin,
  cookieDomainScope,
  isLoopbackHost,
} from "../src/cookie-scope.ts";

test("https origins are injectable", () => {
  const r = checkInjectableOrigin("https://app.example.com");
  assert.equal(r.ok, true);
  assert.equal(r.ok && r.url.host, "app.example.com");
});

test("plaintext http is refused off loopback", () => {
  const r = checkInjectableOrigin("http://example.com");
  assert.equal(r.ok, false);
  assert.match(r.ok === false ? r.reason : "", /must be https/);
});

test("http on loopback is allowed so a local demo RP can be exercised", () => {
  for (const origin of [
    "http://localhost:5173",
    "http://127.0.0.1:8080",
    "http://rp.localhost",
    "http://[::1]:3000",
  ]) {
    assert.equal(checkInjectableOrigin(origin).ok, true, origin);
  }
});

test("non-http schemes that still parse as URLs are refused", () => {
  // These are the ones that would otherwise sail through `new URL()` and
  // reach chrome.cookies.set.
  for (const origin of ["file:///etc/passwd", "javascript:alert(1)", "data:text/html,x", "ftp://example.com"]) {
    assert.equal(checkInjectableOrigin(origin).ok, false, origin);
  }
});

test("empty and unparseable origins are refused", () => {
  assert.equal(checkInjectableOrigin("").ok, false);
  assert.equal(checkInjectableOrigin("not a url").ok, false);
});

test("loopback detection does not match lookalike hosts", () => {
  assert.equal(isLoopbackHost("localhost"), true);
  assert.equal(isLoopbackHost("app.localhost"), true);
  assert.equal(isLoopbackHost("notlocalhost"), false);
  assert.equal(isLoopbackHost("localhost.evil.com"), false);
  assert.equal(isLoopbackHost("127.0.0.1.evil.com"), false);
});

test("absent domain means a host-only cookie", () => {
  assert.deepEqual(cookieDomainScope(undefined, "app.example.com"), { kind: "host-only" });
  assert.deepEqual(cookieDomainScope("", "app.example.com"), { kind: "host-only" });
});

test("a domain equal to the host is host-only however it is spelled", () => {
  // Emitting an explicit `domain` here would widen a host-only cookie to
  // every subdomain — the opposite of what the third party asked for.
  assert.deepEqual(cookieDomainScope("app.example.com", "app.example.com"), { kind: "host-only" });
  assert.deepEqual(cookieDomainScope(".app.example.com", "app.example.com"), { kind: "host-only" });
  assert.deepEqual(cookieDomainScope("APP.Example.COM", "app.example.com"), { kind: "host-only" });
});

test("a genuine parent domain is accepted, dot-stripped", () => {
  assert.deepEqual(cookieDomainScope(".example.com", "app.example.com"), {
    kind: "domain",
    domain: "example.com",
  });
  assert.deepEqual(cookieDomainScope("example.com", "a.b.example.com"), {
    kind: "domain",
    domain: "example.com",
  });
});

test("suffix-without-boundary is rejected — the bug this file exists for", () => {
  // `"evilexample.com".endsWith("example.com")` is true. A cookie written
  // under that domain would be sent to the real example.com.
  const r = cookieDomainScope("example.com", "evilexample.com");
  assert.equal(r.kind, "rejected");
  assert.match(r.kind === "rejected" ? r.reason : "", /does not domain-match/);
});

test("an unrelated domain is rejected", () => {
  assert.equal(cookieDomainScope("attacker.test", "app.example.com").kind, "rejected");
  // Host is a suffix of the domain rather than the other way round.
  assert.equal(cookieDomainScope("app.example.com", "example.com").kind, "rejected");
});

test("bare TLDs and single labels are rejected", () => {
  assert.equal(cookieDomainScope("com", "app.example.com").kind, "rejected");
  assert.equal(cookieDomainScope(".com", "app.example.com").kind, "rejected");
  // ...but the single-label check must not fire when it *is* the host, which
  // is the ordinary intranet / loopback case.
  assert.deepEqual(cookieDomainScope("localhost", "localhost"), { kind: "host-only" });
});

test("malformed domains are rejected", () => {
  assert.equal(cookieDomainScope("example.com.", "app.example.com").kind, "rejected");
  assert.equal(cookieDomainScope("exa mple.com", "app.exa mple.com").kind, "rejected");
});
