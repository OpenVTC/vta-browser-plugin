// What the page-facing proxy will and will not dial, and the two properties of
// `proxyFetch` that the vet depends on.
//
// The second half reads `background.ts` rather than calling it. Driving a real
// redirect needs a browser, and `proxyFetch` is not exported; what can be
// asserted is the shape of the call it makes — which is where both bugs would
// reappear, either as a `redirect` option lost in a refactor or as the vet
// moved below the permission check, where it no longer says anything useful.

import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

import { vetEgressUrl } from "../src/proxy-url.ts";

test("https on a public host is what the proxy is for", () => {
  assert.equal(vetEgressUrl("https://vta.example.com/api/v1").hostname, "vta.example.com");
});

test("loopback http stays dialable — a local VTA and the demo RP are real targets", () => {
  assert.equal(vetEgressUrl("http://127.0.0.1:4040/api/login").port, "4040");
  assert.equal(vetEgressUrl("http://localhost:8080/x").hostname, "localhost");
});

test("http on a public host is refused", () => {
  assert.throws(() => vetEgressUrl("http://vta.example.com/api/v1"), /must be https/);
});

test("a private or local-only host is refused even over https", () => {
  for (const url of [
    "https://169.254.169.254/latest/meta-data/",
    "https://10.0.0.7/api",
    "https://router.local/api",
    "https://metadata.google.internal/api",
  ]) {
    assert.throws(() => vetEgressUrl(url), /not a public internet host/, url);
  }
});

test("a scheme that is not http(s) is refused here rather than looking ungranted", () => {
  // `hasOriginPermission` answers false for these, which would send the popup
  // to ask for a permission that cannot exist. This is the reason the vet runs
  // first.
  for (const url of ["file:///etc/passwd", "data:text/plain,x", "chrome://settings"]) {
    assert.throws(() => vetEgressUrl(url), /.*/, url);
  }
});

test("credentials in the URL are refused", () => {
  assert.throws(
    () => vetEgressUrl("https://vta.example.com@169.254.169.254/api"),
    /username or password/,
  );
});

// ── The two properties of `proxyFetch` the vet leans on ─────────────────────

/** `proxyFetch`'s body, as source. */
function proxyFetchSource(): string {
  const src = readFileSync(new URL("../src/background.ts", import.meta.url), "utf8");
  const start = src.indexOf("async function proxyFetch(");
  assert.notEqual(start, -1, "proxyFetch has been renamed; this test needs updating with it");
  const end = src.indexOf("\n}\n", start);
  return src.slice(start, end);
}

test("the proxy refuses to follow a redirect", () => {
  // A granted origin is one host, and a 302 leaves it. Without this the wallet
  // would follow a redirect to `http://localhost:…` or a metadata endpoint with
  // the extension's permissions, and hand the answer back to the page as though
  // the granted origin had produced it.
  const body = proxyFetchSource();
  assert.match(body, /redirect: "error"/);
  // After the caller's `init`, so a caller cannot spread it away.
  assert.match(body, /\.\.\.init,[\s\S]*redirect: "error"/);
});

test("the URL is vetted before the grant is checked", () => {
  const body = proxyFetchSource();
  const vet = body.indexOf("vetEgressUrl(url)");
  const grant = body.indexOf("hasOriginPermission(url)");
  assert.notEqual(vet, -1, "proxyFetch must vet the URL");
  assert.notEqual(grant, -1, "proxyFetch must still check the host grant");
  assert.ok(vet < grant, "the vet must run first — see proxy-url.ts for why");
});
