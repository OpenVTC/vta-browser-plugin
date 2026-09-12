// The consent prompt resolves whatever did:webvh a page names, with no host
// grant, so the DID's host decides where the extension sends a request. These
// tests pin the guard that stands in front of that request.
//
// Two things are checked separately, because either can fail on its own: that
// the guard refuses a host, and that both resolving entry points actually
// consult it before resolving. The last test drives the real resolver with a
// recording `fetch`, so it would notice the guard being bypassed by a path
// these stubs do not model.

import { test } from "node:test";
import assert from "node:assert/strict";

import {
  assertResolvableWebvhHost,
  BLOCKED_ENDPOINT,
  BlockedEndpointError,
  deriveSigningKeyId,
  verifyDid,
} from "../dist/did/index.js";

const webvh = (host, ...path) => ["did", "webvh", "QmSCID", host, ...path].join(":");

// Local-only names. An extension cannot resolve DNS, so these are refused by
// name. (`*.internal` covers `metadata.google.internal`.)
const BLOCKED_NAMES = [
  "localhost",
  "LOCALHOST",
  "localhost.",
  "localhost%3A8080",
  "svc.localhost",
  "router.local",
  "kube-dns.kube-system.svc.cluster.local",
  "metadata.google.internal",
  "router.home.arpa",
  "intranet",
  "metadata",
];

// Spellings the URL parser turns into a non-public IPv4 address.
const BLOCKED_NUMERIC = [
  "0x7f000001",
  "127.1",
  "127.0.1",
  "2130706433",
  "017700000001",
  "0177.0.0.1",
  "0x7f.0.0.1",
  "0xa9fea9fe",
  "10.1",
  "172.16.1",
  "192.168.257",
  "0x0a000005",
  "0x0",
  "0",
  "169.254.169.254.",
  "127。0。0。1",
  "①②⑦.0.0.1",
  "%31%32%37.0.0.1",
];

// Plain literals. The resolver library refuses these today; the guard must
// not depend on it doing so.
const BLOCKED_LITERALS = [
  "127.0.0.1",
  "127.0.0.1%3A8080",
  "169.254.169.254",
  "169.254.169.254%3A80",
  "169.254.170.2",
  "10.0.0.1",
  "172.31.255.255",
  "192.168.1.1",
  "100.64.0.1",
  "100.100.100.200",
  "0.0.0.0",
  "255.255.255.255",
  "[%3A%3A1]",
  "%5B%3A%3A1%5D",
  "[%3A%3A1]%3A8443",
  "[%3A%3Affff%3A127.0.0.1]",
  "[%3A%3Affff%3A7f00%3A1]",
  "[%3A%3A127.0.0.1]",
  "[fc00%3A%3A1]",
  "[fd00%3Aec2%3A%3A254]",
  "[fe80%3A%3A1]",
];

// No usable host, or a host the parser would read differently from the DID.
const BLOCKED_INVALID = [
  "",
  "fe80%3A%3A1",
  "127.0.0.1%40example.com",
  "user%40example.com",
  "example.com%2Fpath",
  "example.com%253A80",
  "exa mple.com",
  "%E0%A4%A",
];

const ALLOWED = [
  "example.com",
  "EXAMPLE.com",
  "example.com.",
  "example.com%3A8443",
  "localhost.example.com",
  "local.example.com",
  "internal.example.co.uk",
  "my-localhost.dev",
  // Range boundaries: the neighbours of blocked networks are public.
  "11.0.0.1",
  "100.63.255.255",
  "100.128.0.0",
  "172.15.255.255",
  "172.32.0.1",
  "169.253.255.255",
  "192.169.0.1",
  "[2606%3A4700%3A4700%3A%3A1111]",
];

function refusal(host) {
  try {
    assertResolvableWebvhHost(webvh(host));
  } catch (e) {
    return e;
  }
  return null;
}

test("local-only names are refused", () => {
  for (const host of BLOCKED_NAMES) {
    const err = refusal(host);
    assert.ok(err instanceof BlockedEndpointError, `${host} was not refused`);
    assert.equal(err.code, BLOCKED_ENDPOINT);
    assert.equal(err.reason, "private_name", host);
  }
});

test("numeric spellings of non-public addresses are refused as the address they parse to", () => {
  for (const host of BLOCKED_NUMERIC) {
    const err = refusal(host);
    assert.ok(err instanceof BlockedEndpointError, `${host} was not refused`);
    assert.equal(err.reason, "private_address", host);
  }
  // The message names the address it became, and how it was written, so the
  // person reading the prompt can see through the disguise.
  assert.match(refusal("0x7f000001").message, /127\.0\.0\.1 \(written 0x7f000001\)/);
  assert.equal(refusal("192.168.257").host, "192.168.1.1");
});

test("non-public IPv4 and IPv6 literals are refused without relying on the resolver library", () => {
  for (const host of BLOCKED_LITERALS) {
    const err = refusal(host);
    assert.ok(err instanceof BlockedEndpointError, `${host} was not refused`);
    assert.equal(err.reason, "private_address", host);
  }
});

test("a DID with no parseable host is refused", () => {
  for (const host of BLOCKED_INVALID) {
    const err = refusal(host);
    assert.ok(err instanceof BlockedEndpointError, `${JSON.stringify(host)} was not refused`);
    assert.equal(err.reason, "invalid_url", host);
  }
  assert.throws(() => assertResolvableWebvhHost("did:key:z6Mk"), BlockedEndpointError);
});

test("public hosts pass, including names that merely contain a blocked word", () => {
  for (const host of ALLOWED) {
    assert.doesNotThrow(() => assertResolvableWebvhHost(webvh(host)), host);
  }
  // Only the host is judged; a path segment called `localhost` is a path.
  assert.doesNotThrow(() => assertResolvableWebvhHost(webvh("example.com", "localhost")));
});

const ALL_BLOCKED = [...BLOCKED_NAMES, ...BLOCKED_NUMERIC, ...BLOCKED_LITERALS];

function recordingResolver(doc) {
  const calls = [];
  return {
    calls,
    resolveDid: async (did) => {
      calls.push(did);
      return { didDocument: { id: did, ...doc } };
    },
  };
}

test("verifyDid refuses a blocked host without calling the resolver", async () => {
  for (const host of ALL_BLOCKED) {
    const { calls, resolveDid } = recordingResolver({});
    const did = webvh(host);
    const result = await verifyDid(did, { resolveDid });
    assert.deepEqual(calls, [], `${host} reached the resolver`);
    assert.equal(result.resolved, false, host);
    assert.equal(result.method, "webvh");
    assert.match(result.error ?? "", /so it was not contacted$/, host);
    assert.equal(result.alsoKnownAs, undefined);
  }
});

test("verifyDid still resolves a public host through the same path", async () => {
  // Without this, a guard that refused everything would pass the test above.
  const { calls, resolveDid } = recordingResolver({ alsoKnownAs: ["https://example.com/@rp"] });
  const did = webvh("example.com");
  const result = await verifyDid(did, { resolveDid });
  assert.deepEqual(calls, [did]);
  assert.equal(result.resolved, true);
  assert.equal(result.domain, "example.com");
  assert.deepEqual(result.alsoKnownAs, ["https://example.com/@rp"]);
});

test("deriveSigningKeyId refuses a blocked host without calling the resolver", async () => {
  for (const host of ALL_BLOCKED) {
    const { calls, resolveDid } = recordingResolver({ authentication: ["x#key-0"] });
    const did = webvh(host);
    const result = await deriveSigningKeyId(did, { resolveDid });
    assert.deepEqual(calls, [], `${host} reached the resolver`);
    assert.deepEqual(result.candidates, [], host);
    assert.match(result.error ?? "", /so it was not contacted$/, host);
  }
});

test("deriveSigningKeyId still resolves public did:webvh and did:peer through the resolver", async () => {
  const webvhDid = webvh("example.com");
  const a = recordingResolver({ authentication: [`${webvhDid}#key-0`] });
  assert.deepEqual(await deriveSigningKeyId(webvhDid, { resolveDid: a.resolveDid }), {
    did: webvhDid,
    candidates: [`${webvhDid}#key-0`],
  });
  assert.deepEqual(a.calls, [webvhDid]);

  // The guard is for did:webvh only; did:peer carries no host.
  const peerDid = "did:peer:2.Vz6MkExample";
  const b = recordingResolver({ authentication: [`${peerDid}#key-1`] });
  const peer = await deriveSigningKeyId(peerDid, { resolveDid: b.resolveDid });
  assert.deepEqual(b.calls, [peerDid]);
  assert.deepEqual(peer.candidates, [`${peerDid}#key-1`]);
});

test("with the real resolver, a blocked host produces no network request", async (t) => {
  const requested = [];
  const realFetch = globalThis.fetch;
  globalThis.fetch = async (input) => {
    requested.push(String(input instanceof Request ? input.url : input));
    throw new TypeError("network disabled in this test");
  };
  t.after(() => {
    globalThis.fetch = realFetch;
  });
  // The resolver library logs the refused fetch below; that is expected.
  t.mock.method(console, "error", () => {});

  for (const host of ALL_BLOCKED) {
    const did = webvh(host);
    assert.equal((await verifyDid(did)).resolved, false, host);
    assert.deepEqual((await deriveSigningKeyId(did)).candidates, [], host);
  }
  assert.deepEqual(requested, [], "a blocked host reached fetch");

  // Non-vacuity: the same path does reach fetch for a public host, so an empty
  // list above means "refused", not "this spy is not where requests go".
  await verifyDid(webvh("example.com"));
  assert.ok(
    requested.some((url) => url.startsWith("https://example.com/")),
    `expected a request to example.com, saw ${JSON.stringify(requested)}`,
  );
});
