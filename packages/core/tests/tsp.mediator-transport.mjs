import { test } from "node:test";
import assert from "node:assert/strict";

import { MediatorSessionTspTransport } from "../dist/index.js";

/** A fake MediatorConnection TSP surface: records binary sends and lets the test
 *  resolve/reject the awaited reply frame. */
function fakeConn() {
  const sent = [];
  let pending = null;
  return {
    sent,
    sendBinary(bytes) {
      sent.push(bytes);
    },
    awaitTspFrame(timeoutMs, claims) {
      return new Promise((resolve, reject) => {
        pending = { resolve, reject, timeoutMs, claims };
      });
    },
    // test helpers
    deliver(bytes) {
      pending.resolve(bytes);
    },
    fail(err) {
      pending.reject(err);
    },
    pendingTimeout() {
      return pending.timeoutMs;
    },
    /** The predicate the transport registered — the connection needs one to
     *  tell this request's reply from an unsolicited frame on the same socket. */
    pendingClaims() {
      return pending.claims;
    },
  };
}

test("sends the packed bytes as a binary frame and resolves the awaited reply", async () => {
  const conn = fakeConn();
  const transport = new MediatorSessionTspTransport({ connection: conn, timeoutMs: 1234 });
  const packed = new Uint8Array([0xf8, 1, 2, 3]);
  const reply = new Uint8Array([0xf8, 9, 8, 7]);

  const p = transport.sendAndAwaitReply(packed, { claims: () => true });
  assert.equal(conn.sent.length, 1);
  assert.deepEqual(conn.sent[0], packed);
  assert.equal(conn.pendingTimeout(), 1234); // default timeout used

  conn.deliver(reply);
  assert.deepEqual(await p, reply);
});

test("per-call timeout overrides the default", async () => {
  const conn = fakeConn();
  const transport = new MediatorSessionTspTransport({ connection: conn, timeoutMs: 1234 });
  const p = transport.sendAndAwaitReply(new Uint8Array([0xf8]), {
    timeoutMs: 50,
    claims: () => true,
  });
  assert.equal(conn.pendingTimeout(), 50);
  conn.deliver(new Uint8Array([0xf8, 1]));
  await p;
});

test("a send failure surfaces e.client.unsupported (safe fallback, pre-send)", async () => {
  const conn = {
    sendBinary() {
      throw new Error("socket not connected");
    },
    awaitTspFrame() {
      return new Promise(() => {}); // never resolves; must be swallowed
    },
  };
  const transport = new MediatorSessionTspTransport({ connection: conn });
  await assert.rejects(
    transport.sendAndAwaitReply(new Uint8Array([0xf8]), { claims: () => true }),
    (err) => {
      assert.equal(err.code, "e.client.unsupported");
      return true;
    },
  );
});

test("a reply timeout surfaces e.client.network (no retry, post-send)", async () => {
  const conn = fakeConn();
  const transport = new MediatorSessionTspTransport({ connection: conn });
  const p = transport.sendAndAwaitReply(new Uint8Array([0xf8, 5]), { claims: () => true });
  conn.fail(new Error("timed out awaiting reply frame"));
  await assert.rejects(p, (err) => {
    assert.equal(err.code, "e.client.network");
    return true;
  });
});

test("refuses to send without a claims predicate", async () => {
  // Registering a waiter with no way to recognise its own reply is how a
  // consent push meant for the inbox gets swallowed as somebody's answer. The
  // refusal is `unsupported` — pre-send, so a VtaSession simply moves to the
  // next channel rather than treating it as a possibly-applied mutation.
  const conn = fakeConn();
  const transport = new MediatorSessionTspTransport({ connection: conn });
  await assert.rejects(
    transport.sendAndAwaitReply(new Uint8Array([0xf8])),
    (err) => {
      assert.equal(err.code, "e.client.unsupported");
      return true;
    },
  );
  assert.equal(conn.sent.length, 0, "nothing may reach the VTA");
});
