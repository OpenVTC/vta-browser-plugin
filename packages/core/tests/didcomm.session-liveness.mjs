// What a warm-session holder needs from a connection to tell a live socket from
// a dead one that still reads open.
//
// After a laptop sleeps, the mediator has closed the socket on token expiry,
// the close frame never arrived, and `isOpen` is still true. Two facts let the
// holder stop trusting it: when the mediator will close it (`expiresAt`, the
// access token's expiry) and that a request on it just went unanswered
// (`onReplyTimeout`). Both are pinned here against a real
// `connectMediatorSession`, with the mediator's network faked.

import { test } from "node:test";
import assert from "node:assert/strict";

import * as x25519 from "@openvtc/vti-didcomm-js/x25519";
import * as multibase from "@openvtc/vti-didcomm-js/multibase";

import { Identity, connectMediatorSession } from "../dist/didcomm/index.js";

function keypairDid() {
  const kp = x25519.generateKeyPair();
  const mb = multibase.encodeMultikey(multibase.MULTICODEC.X25519_PUB, kp.publicKey);
  return { did: `did:key:${mb}`, kid: `did:key:${mb}#${mb}`, multibase: mb, ...kp };
}

const LOCAL_DEV = { rest: "http://localhost:9099", ws: "ws://localhost:9099" };
const DEV_POLICY = { allowInsecure: true, allowPrivate: true };

function mediator() {
  const kp = keypairDid();
  return {
    ...kp,
    resolve: async () => ({
      didDocument: {
        id: kp.did,
        keyAgreement: [
          { id: kp.kid, type: "Multikey", controller: kp.did, publicKeyMultibase: kp.multibase },
        ],
        service: [
          {
            id: `${kp.did}#didcomm`,
            type: "DIDCommMessaging",
            serviceEndpoint: [{ uri: LOCAL_DEV.rest }, { uri: LOCAL_DEV.ws }],
          },
        ],
      },
    }),
  };
}

/** A socket that opens and then never delivers anything: from the client's
 *  side, exactly what a socket the mediator closed during sleep looks like. */
class SilentWebSocket {
  constructor(url) {
    this.url = url;
    this.readyState = 0;
    this.onopen = null;
    this.onmessage = null;
    this.onerror = null;
    this.onclose = null;
    setTimeout(() => {
      this.readyState = 1;
      this.onopen && this.onopen();
    }, 0);
  }
  addEventListener() {}
  send() {}
  close() {
    this.readyState = 3;
    this.onclose && this.onclose();
  }
}

function authFetch(accessExpiresAt) {
  const bodies = [
    { data: { challenge: "c-1", session_id: "s-1" } },
    {
      data: {
        access_token: "med.jwt",
        ...(accessExpiresAt === undefined ? {} : { access_expires_at: accessExpiresAt }),
        refresh_token: "r-1",
        refresh_expires_at: Math.floor(Date.now() / 1000) + 3600,
      },
    },
  ];
  let i = 0;
  return async () =>
    new Response(JSON.stringify(bodies[i++] ?? {}), {
      status: 200,
      headers: { "content-type": "application/json" },
    });
}

async function connect({ accessExpiresAt, onReplyTimeout } = {}) {
  const m = mediator();
  const vta = keypairDid();
  const holder = Identity.generate("did:example:holder-liveness");
  const conn = await connectMediatorSession({
    holder,
    mediatorDid: m.did,
    vtaDid: vta.did,
    netPolicy: DEV_POLICY,
    resolve: m.resolve,
    fetch: authFetch(accessExpiresAt),
    webSocketImpl: SilentWebSocket,
    ...(onReplyTimeout ? { onReplyTimeout } : {}),
  });
  return { conn, holder };
}

test("expiresAt is the access token's expiry, in milliseconds", async () => {
  const exp = Math.floor(Date.now() / 1000) + 900;
  const { conn, holder } = await connect({ accessExpiresAt: exp });
  try {
    assert.ok(conn.isOpen);
    assert.equal(conn.expiresAt, exp * 1000);
  } finally {
    conn.close();
    holder.dispose();
  }
});

test("a mediator that reports no expiry leaves expiresAt undefined", async () => {
  const { conn, holder } = await connect({ accessExpiresAt: undefined });
  try {
    assert.equal(conn.expiresAt, undefined);
  } finally {
    conn.close();
    holder.dispose();
  }
});

test("a TSP reply that never comes fails the request and reports the timeout", async () => {
  let timeouts = 0;
  const { conn, holder } = await connect({
    accessExpiresAt: Math.floor(Date.now() / 1000) + 900,
    onReplyTimeout: () => timeouts++,
  });
  try {
    const reply = conn.awaitTspFrame(20, () => true);
    conn.sendBinary(new Uint8Array([0xf8, 0x01]));
    await assert.rejects(reply, /timed out awaiting reply frame/);
    assert.equal(timeouts, 1, "the holder is told, once");
    // The socket still reads open. That is the point: only the timeout says
    // anything is wrong.
    assert.ok(conn.isOpen);
  } finally {
    conn.close();
    holder.dispose();
  }
});

test("a DIDComm reply that never comes reports the timeout too", async () => {
  let timeouts = 0;
  const { conn, holder } = await connect({
    accessExpiresAt: Math.floor(Date.now() / 1000) + 900,
    onReplyTimeout: () => timeouts++,
  });
  try {
    await assert.rejects(conn.waitFor("thid-1", 20), /timeout/);
    assert.equal(timeouts, 1);
  } finally {
    conn.close();
    holder.dispose();
  }
});

test("a session closed under a waiter is not reported as a timeout", async () => {
  // `onClose` covers a closed socket. Reporting it here as well would make
  // the holder evict twice.
  let timeouts = 0;
  const { conn, holder } = await connect({
    accessExpiresAt: Math.floor(Date.now() / 1000) + 900,
    onReplyTimeout: () => timeouts++,
  });
  try {
    const tsp = conn.awaitTspFrame(5_000, () => true);
    const dc = conn.waitFor("thid-2", 5_000);
    conn.close();
    await assert.rejects(tsp, /closed/);
    await assert.rejects(dc, /closed/);
    assert.equal(timeouts, 0);
  } finally {
    holder.dispose();
  }
});
