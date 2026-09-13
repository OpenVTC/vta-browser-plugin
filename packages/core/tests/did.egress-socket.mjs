// The did:webvh host guard, proved at the socket rather than at a spy.
//
// `did.egress-guard.mjs` next to this file already drives the whole vector set
// through an injected `fetch` that throws, and that is the pass which can
// safely name `169.254.169.254`: a request built there cannot leave the
// process, so a run with the guard removed stays inside the sandbox. What it
// cannot show is *where* in the sequence the refusal happens. A spy that throws
// on call proves a URL was never handed to `fetch`; it does not prove a socket
// was never opened, and those are different claims once anything downstream of
// `fetch` — an agent, a keep-alive pool, a resolver that dials on its own —
// enters the picture.
//
// So this file is the other half, and it is deliberately narrower: **every host
// here names this machine**, so the request a run without the guard would make
// is a connection to a listener started three lines above it. Nothing can leave
// the machine even when the guard is gone, and the refusal is proved by a
// listener that counts TCP connections and counts none.
//
// ── Why these spellings and not the headline ones ───────────────────────────
//
// The vectors below are the ones where **this repo's guard is the only thing
// that can refuse them**, which is the whole point of the file.
//
// `didwebvh-ts@2.8.0` — the resolver under `@openvtc/vti-didcomm-js` — has its
// own `isIPAddress()` check that throws "IP addresses are not allowed as hosts"
// for a dotted quad and for anything spelled only from `[0-9a-f:]`. So
// `127.0.0.1`, `2130706433`, `[::1]` and `[::ffff:127.0.0.1]` never reach a
// socket whether this repo's guard runs or not: a socket test built on those
// would pass with the guard deleted, and would be pinning the dependency.
// (`did.egress-guard.mjs` does assert them, but against
// `assertResolvableWebvhHost` directly, where nothing else is consulted.)
//
// A probe of the shipped resolver says which spellings it lets through to a
// real `fetch`, and those are the ones here:
//
//   - `localhost`, and `localhost.` with the root dot — names, which the
//     dependency does not look at at all;
//   - `0x7f000001`, `127.1`, `127.0.1`, `0x7f.0.0.1` — IPv4 in forms its regex
//     misses and the WHATWG URL parser rewrites into `127.0.0.1`;
//   - `127。0。0。1` and `①②⑦.0.0.1` — the same address written with an
//     ideographic full stop and circled digits, which the parser also
//     normalises.
//
// Each is pointed at the listener's port, so with the guard removed the
// resolver dials loopback and the count is non-zero. That is the RED state this
// file exists to produce, and it is why the vectors that would egress to a
// metadata service are left to the spy pass.

import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:net";

import { resolve as vtiResolve } from "@openvtc/vti-didcomm-js";

import { BLOCKED_ENDPOINT, deriveSigningKeyId, verifyDid } from "../dist/did/index.js";

/** Every TCP connection either listener accepted, in arrival order. */
let connections = [];
/** The port both listeners are on. */
let port;
/** Listeners to shut down afterwards. */
const servers = [];

/**
 * A listener that records the connection and drops it at once.
 *
 * Dropping matters: the resolver dials `https:`, nothing here speaks TLS, and
 * a socket left open would leave the client waiting on a ServerHello that never
 * comes. Destroying it turns that into an immediate reset, so a RED run fails
 * in milliseconds instead of sitting on a timeout.
 */
function countingListener(address, listenPort) {
  return new Promise((resolve, reject) => {
    const server = createServer((socket) => {
      connections.push(`${address}:${server.address().port}`);
      socket.destroy();
    });
    server.once("error", reject);
    server.listen(listenPort, address, () => resolve(server));
  });
}

before(async () => {
  // 127.0.0.1 first, for an OS-assigned port…
  const v4 = await countingListener("127.0.0.1", 0);
  servers.push(v4);
  port = v4.address().port;
  // …then ::1 on the same port, because `localhost` may resolve to either and
  // a connection to the family we did not bind would look like a refusal. If
  // this machine has no IPv6 the numeric vectors still carry the file; they
  // need no name resolution at all.
  try {
    servers.push(await countingListener("::1", port));
  } catch {
    // No IPv6 loopback here. Nothing to do: the assertions below are about
    // connections *not* happening, and the positive control uses a numeric
    // spelling that can only be 127.0.0.1.
  }
});

after(async () => {
  await Promise.all(servers.map((s) => new Promise((r) => s.close(r))));
});

/** A did:webvh naming this machine's listener, written `spelling`. */
const dialsListener = (spelling) => `did:webvh:QmSCID:${spelling}%3A${port}`;

/** Local-only names. The dependency never inspects a name, so a refusal here
 *  is this repo's guard or nothing. */
const NAMES = ["localhost", "localhost."];

/** IPv4 spellings `didwebvh-ts`'s `isIPAddress()` does not recognise but the
 *  URL parser turns into 127.0.0.1. */
const NUMERIC = ["0x7f000001", "127.1", "127.0.1", "0x7f.0.0.1", "127。0。0。1", "①②⑦.0.0.1"];

const ALL = [...NAMES, ...NUMERIC];

test("verifyDid opens no socket to this machine, however the host is spelled", async (t) => {
  // The resolver logs a fetch it could not complete. Nothing should get that
  // far, but silence it so a RED run's output is the assertion rather than
  // twenty stack traces.
  t.mock.method(console, "error", () => {});
  connections = [];

  // Every vector first, then the assertions — so a failure is the count, which
  // is what this file is for, rather than whichever vector came first.
  const results = ALL.map(() => undefined);
  for (const [i, spelling] of ALL.entries()) {
    results[i] = await verifyDid(dialsListener(spelling));
  }

  assert.deepEqual(connections, [], "a refused host reached the socket");

  for (const [i, spelling] of ALL.entries()) {
    assert.equal(results[i].resolved, false, spelling);
    // The refusal is the guard's, not a network error dressed up as one: its
    // message is the one `assertResolvableWebvhHost` writes. Without this, a
    // resolver that simply could not reach the listener would look the same.
    assert.match(results[i].error ?? "", /so it was not contacted$/, spelling);
  }
});

test("deriveSigningKeyId opens no socket either — the second entry point", async (t) => {
  t.mock.method(console, "error", () => {});
  connections = [];

  const results = ALL.map(() => undefined);
  for (const [i, spelling] of ALL.entries()) {
    results[i] = await deriveSigningKeyId(dialsListener(spelling));
  }

  assert.deepEqual(connections, [], "a refused host reached the socket");

  for (const [i, spelling] of ALL.entries()) {
    assert.deepEqual(results[i].candidates, [], spelling);
    assert.match(results[i].error ?? "", /so it was not contacted$/, spelling);
  }
});

test("the resolver does dial the listener when the guard is not in front of it", async (t) => {
  // The control the two tests above are worth nothing without.
  //
  // It calls the resolver the way `verifyDid` would — same DID, same default
  // resolver, same real `fetch` — but without going through `verifyDid`, so the
  // ONE difference between this and the tests above is
  // `assertResolvableWebvhHost`. A connection arriving here says the listener
  // counts, the port is reachable, and the DID does derive to it; an empty
  // count above therefore means refused, and not "this fixture never pointed
  // anywhere".
  t.mock.method(console, "error", () => {});
  connections = [];

  // `0x7f000001` rather than `localhost`: it needs no name resolution, so it
  // can only be 127.0.0.1 and the control cannot go quiet on a host whose
  // resolver answers something else.
  const did = dialsListener("0x7f000001");
  await assert.rejects(
    () => vtiResolve(did, {}),
    // Whatever the reset surfaces as. The claim is about the socket, not this.
    () => true,
  );

  assert.ok(
    connections.length > 0,
    `the resolver never dialled 127.0.0.1:${port}; this control no longer isolates the guard`,
  );
});

test("a public host still resolves through the same path, and is refused by the log rather than the guard", async (t) => {
  // Non-vacuity of a different kind: a guard that refused everything would pass
  // every assertion above. `example.com` is judged public, so it gets past the
  // guard — and then fails on the fetch, which is what a DID with no log there
  // should do. What matters is *which* failure: not the guard's.
  t.mock.method(console, "error", () => {});
  const requested = [];
  const realFetch = globalThis.fetch;
  globalThis.fetch = async (input) => {
    requested.push(String(input instanceof Request ? input.url : input));
    throw new TypeError("network disabled in this test");
  };
  t.after(() => {
    globalThis.fetch = realFetch;
  });

  const result = await verifyDid("did:webvh:QmSCID:example.com");
  assert.equal(result.resolved, false);
  assert.doesNotMatch(result.error ?? "", /so it was not contacted$/);
  assert.deepEqual(requested, ["https://example.com/.well-known/did.jsonl"]);
});

test("the refusal carries the stable code, so a caller can tell it from a network failure", () => {
  // `BLOCKED_ENDPOINT` is what `isBlockedEndpointError` matches on, and the
  // consent prompt renders a different thing for a refusal than for an
  // unreachable RP. Pinned here because the socket tests above read the message
  // text, and a message is not an interface.
  assert.equal(BLOCKED_ENDPOINT, "E_BLOCKED_ENDPOINT");
});
