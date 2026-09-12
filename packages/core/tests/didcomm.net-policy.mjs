// The egress policy on the endpoints a mediator's DID document names.
//
// `@openvtc/vti-didcomm-js` 0.8 checks every advertised endpoint before it is
// dialed. What needs pinning is the wallet's side of that, because two mistakes
// here look nothing alike from production:
//
//   - not passing a policy at all leaves the library's strict default in place,
//     so the wallet keeps working and only a developer's local stack breaks —
//     which is the failure people fix by reaching for the opt-out;
//   - passing `allowInsecure` alone, which WAS sufficient before 0.8, silently
//     re-admits a mediator on loopback while looking like a scheme decision.
//
// So both are asserted, and so is the positive control: the same document the
// production policy refuses is accepted under the dev policy, which is what
// says the refusal is the policy at work rather than a broken fixture.
//
// The resolver is injected (`resolve`, the seam `verifyDid` already uses) and
// the fetch and WebSocket are spies, so a refusal is proved by nothing being
// dialed rather than by the error alone.

import { test } from "node:test";
import assert from "node:assert/strict";

import * as x25519 from "@openvtc/vti-didcomm-js/x25519";
import * as multibase from "@openvtc/vti-didcomm-js/multibase";

import {
  Identity,
  connectMediatorSession,
  resolveMediatorEndpoint,
} from "../dist/didcomm/index.js";

/** The stable code every refusal carries. Spelled out rather than imported so
 *  the test would notice the constant changing value (R3.7). */
const BLOCKED_ENDPOINT = "E_BLOCKED_ENDPOINT";

/** An X25519 did:key — resolvable offline, so a test needs no network. */
function keypairDid() {
  const kp = x25519.generateKeyPair();
  const mb = multibase.encodeMultikey(multibase.MULTICODEC.X25519_PUB, kp.publicKey);
  return { did: `did:key:${mb}`, kid: `did:key:${mb}#${mb}`, multibase: mb, ...kp };
}

/** A mediator whose document advertises `rest` + `ws`, with a real X25519
 *  keyAgreement key so the parse reaches the endpoint checks rather than
 *  failing earlier for a reason the test did not intend. */
function mediator({ rest, ws }) {
  const kp = keypairDid();
  return {
    ...kp,
    resolve: async () => ({
      didDocument: {
        id: kp.did,
        keyAgreement: [
          {
            id: kp.kid,
            type: "Multikey",
            controller: kp.did,
            publicKeyMultibase: kp.multibase,
          },
        ],
        service: [
          {
            id: `${kp.did}#didcomm`,
            type: "DIDCommMessaging",
            serviceEndpoint: [{ uri: rest }, { uri: ws }],
          },
        ],
      },
    }),
  };
}

// TLS on loopback, deliberately: it isolates the address check from the scheme
// check, so a refusal here cannot be the plaintext gate doing the work. This is
// also the shape that was reachable before 0.8 — `allowInsecure: false` said
// nothing about the host.
const LOOPBACK = { rest: "https://127.0.0.1:9099", ws: "wss://127.0.0.1:9099" };
// What a developer's local stack actually looks like.
const LOCAL_DEV = { rest: "http://localhost:9099", ws: "ws://localhost:9099" };
// What a dev build passes, and the only combination that admits either.
const DEV_POLICY = { allowInsecure: true, allowPrivate: true };

test("a mediator advertising a loopback endpoint is refused by default", async () => {
  const m = mediator(LOOPBACK);
  await assert.rejects(
    () => resolveMediatorEndpoint(m.did, { resolve: m.resolve }),
    (err) => {
      assert.equal(err.code, BLOCKED_ENDPOINT, "must carry the stable code (R3.7)");
      assert.equal(err.reason, "private_address");
      return true;
    },
  );
});

test("allowInsecure alone no longer admits a private host", async () => {
  // The breaking change the 0.8 bump carries. Before it, this document was
  // refused only because of its scheme, so a caller that wanted plaintext got
  // loopback thrown in.
  const m = mediator(LOOPBACK);
  await assert.rejects(
    () => resolveMediatorEndpoint(m.did, { netPolicy: { allowInsecure: true }, resolve: m.resolve }),
    (err) => err.code === BLOCKED_ENDPOINT,
  );
});

test("the dev policy admits the document the production one refuses", async () => {
  const m = mediator(LOOPBACK);
  const resolved = await resolveMediatorEndpoint(m.did, {
    netPolicy: DEV_POLICY,
    resolve: m.resolve,
  });
  assert.equal(resolved.restEndpoint, LOOPBACK.rest);
  assert.equal(resolved.websocketUrl, LOOPBACK.ws);
  // Derived rather than advertised: with no `Authentication` service the parse
  // appends `/authenticate` to the REST endpoint — and that derived URL is
  // vetted too, which is why it appears here at all.
  assert.equal(resolved.authEndpoint, `${LOOPBACK.rest}/authenticate`);
});

test("a local stack on http://localhost needs both opt-outs, not either", async () => {
  const m = mediator(LOCAL_DEV);
  // Neither: refused.
  await assert.rejects(() => resolveMediatorEndpoint(m.did, { resolve: m.resolve }));
  // Private hosts but not plaintext: still refused, on the scheme.
  await assert.rejects(() =>
    resolveMediatorEndpoint(m.did, { netPolicy: { allowPrivate: true }, resolve: m.resolve }),
  );
  // Plaintext but not private hosts: still refused, on the address.
  await assert.rejects(
    () => resolveMediatorEndpoint(m.did, { netPolicy: { allowInsecure: true }, resolve: m.resolve }),
    (err) => err.code === BLOCKED_ENDPOINT,
  );
  // Both. This is the line a developer's config has to produce.
  const resolved = await resolveMediatorEndpoint(m.did, {
    netPolicy: DEV_POLICY,
    resolve: m.resolve,
  });
  assert.equal(resolved.websocketUrl, LOCAL_DEV.ws);
});

test("a public mediator is unaffected by any of this", async () => {
  const m = mediator({ rest: "https://mediator.example", ws: "wss://mediator.example/ws" });
  const resolved = await resolveMediatorEndpoint(m.did, { resolve: m.resolve });
  assert.equal(resolved.websocketUrl, "wss://mediator.example/ws");
});

// ─── The session: nothing dialed, and the WebSocket held to the policy ───

class FakeWebSocket {
  static constructed = [];

  constructor(url, protocols) {
    this.url = url;
    this.protocols = protocols;
    this.sent = [];
    this.readyState = 0;
    this.onopen = null;
    this.onmessage = null;
    this.onerror = null;
    this.onclose = null;
    FakeWebSocket.constructed.push(this);
    setTimeout(() => {
      this.readyState = 1;
      this.onopen && this.onopen();
    }, 0);
  }
  addEventListener() {}
  send(data) {
    this.sent.push(data);
  }
  close() {
    this.readyState = 3;
    this.onclose && this.onclose();
  }
}

function spyFetch(bodies) {
  const calls = [];
  const impl = async (url) => {
    calls.push(String(url));
    const body = bodies[calls.length - 1];
    return new Response(JSON.stringify(body ?? {}), {
      status: 200,
      headers: { "content-type": "application/json" },
    });
  };
  return { calls, impl };
}

test("a refused endpoint is never dialed, by fetch or by WebSocket", async () => {
  // The assertion that matters. An error alone would not distinguish "refused
  // before the request" from "refused after it", and only the first is a
  // control: the second still hands an internal host a connection from the
  // user's browser.
  FakeWebSocket.constructed = [];
  const m = mediator(LOOPBACK);
  const vta = keypairDid();
  const holder = Identity.generate("did:example:holder");
  const fetchSpy = spyFetch([]);

  try {
    await assert.rejects(
      () =>
        connectMediatorSession({
          holder,
          mediatorDid: m.did,
          vtaDid: vta.did,
          resolve: m.resolve,
          fetch: fetchSpy.impl,
          webSocketImpl: FakeWebSocket,
        }),
      (err) => err.code === BLOCKED_ENDPOINT,
    );
    assert.deepEqual(fetchSpy.calls, [], "the auth handshake must not reach the network");
    assert.equal(FakeWebSocket.constructed.length, 0, "no socket may be opened");
  } finally {
    holder.dispose();
  }
});

test("under the dev policy the same session opens, socket and all", async () => {
  // The positive control for the whole path, not just the parse: handshake,
  // then the WebSocket the session checks separately (it is a second endpoint
  // from the same untrusted document, and it carries the mediator JWT).
  FakeWebSocket.constructed = [];
  const m = mediator(LOCAL_DEV);
  const vta = keypairDid();
  const holder = Identity.generate("did:example:holder-dev");
  const now = Math.floor(Date.now() / 1000);
  const fetchSpy = spyFetch([
    { data: { challenge: "c-1", session_id: "s-1" } },
    {
      data: {
        access_token: "med.jwt",
        access_expires_at: now + 900,
        refresh_token: "r-1",
        refresh_expires_at: now + 3600,
      },
    },
  ]);

  let conn;
  try {
    conn = await connectMediatorSession({
      holder,
      mediatorDid: m.did,
      vtaDid: vta.did,
      netPolicy: DEV_POLICY,
      resolve: m.resolve,
      fetch: fetchSpy.impl,
      webSocketImpl: FakeWebSocket,
    });

    assert.deepEqual(
      fetchSpy.calls,
      [`${LOCAL_DEV.rest}/authenticate/challenge`, `${LOCAL_DEV.rest}/authenticate`],
      "the handshake ran against the local mediator",
    );
    assert.equal(FakeWebSocket.constructed.length, 1);
    assert.equal(FakeWebSocket.constructed[0].url, LOCAL_DEV.ws);
    assert.ok(conn.isOpen, "live delivery is enabled once connect() resolves");
  } finally {
    conn?.close();
    holder.dispose();
  }
});
