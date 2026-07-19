// The dependency contract this repo's R1.6 fix rests on.
//
// Everything else about persist-before-ack is our code; THIS is the assumption
// underneath it: that returning a promise from the inbound handler holds the
// mediator's ack until it settles. That is only true from
// @openvtc/vti-didcomm-js 0.6.2 — 0.6.0 acked first and ignored the return
// value entirely, and the range in package.json would happily resolve to it.
//
// So this test drives the REAL installed library through a fake socket. If the
// dependency is ever downgraded or the ordering regresses upstream, the wallet
// silently goes back to losing consent requests on an MV3 teardown; this fails
// instead.

import { test } from "node:test";
import assert from "node:assert/strict";

import { MediatorSession } from "@openvtc/vti-didcomm-js/mediator-transport";
import { pack } from "@openvtc/vti-didcomm-js/pack";
import { unpack } from "@openvtc/vti-didcomm-js/unpack";
import { generateEphemeralClient } from "@openvtc/vti-didcomm-js/vta-rest-auth";
import * as x25519 from "@openvtc/vti-didcomm-js/x25519";
import * as multibase from "@openvtc/vti-didcomm-js/multibase";
import * as jwk from "@openvtc/vti-didcomm-js/jwk";

const ACK_TYPE = "https://didcomm.org/messagepickup/3.0/messages-received";

function keypairDid() {
  const kp = x25519.generateKeyPair();
  const mb = multibase.encodeMultikey(multibase.MULTICODEC.X25519_PUB, kp.publicKey);
  return {
    did: `did:key:${mb}`,
    kid: `did:key:${mb}#${mb}`,
    privateKey: kp.privateKey,
    publicKey: kp.publicKey,
  };
}

class FakeWebSocket {
  constructor(url, protocols) {
    this.url = url;
    this.protocols = protocols;
    this.sent = [];
    this.closed = false;
    this.readyState = 0;
    this.onopen = null;
    this.onmessage = null;
    this.onerror = null;
    this.onclose = null;
    FakeWebSocket.last = this;
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
    this.closed = true;
    this.readyState = 3;
    this.onclose && this.onclose();
  }
  inject(data) {
    this.onmessage && this.onmessage({ data });
  }
}

async function harness(onMessage) {
  const client = generateEphemeralClient();
  const vta = generateEphemeralClient();
  const mediatorKp = keypairDid();

  const session = new MediatorSession({
    mediator: {
      did: mediatorKp.did,
      kid: mediatorKp.kid,
      x25519Pub: mediatorKp.publicKey,
      wsEndpoint: "wss://mediator.test/ws",
    },
    mediatorJwt: "med.jwt",
    client,
    senderKeys: new Map([[vta.did, { publicJwk: jwk.publicJwk("X25519", vta.publicKey) }]]),
    WebSocketImpl: FakeWebSocket,
    onMessage,
  });
  await session.connect();
  const ws = FakeWebSocket.last;
  ws.sent.length = 0; // discard the live-delivery-change

  const jwe = await pack({
    message: {
      id: "urn:uuid:consent-1",
      type: "https://trusttasks.org/spec/task-consent/request/0.1",
      from: vta.did,
      to: [client.did],
      body: { payloadDigest: "z6Mkdigest", challenge: "c-1" },
    },
    sender: { kid: vta.kid, privateJwk: jwk.privateJwk("X25519", vta.privateKey, vta.publicKey) },
    recipient: { kid: client.kid, publicJwk: jwk.publicJwk("X25519", client.publicKey) },
  });

  const readAck = async () =>
    (
      await unpack(
        ws.sent[0],
        {
          kid: mediatorKp.kid,
          privateJwk: jwk.privateJwk("X25519", mediatorKp.privateKey, mediatorKp.publicKey),
        },
        { publicJwk: jwk.publicJwk("X25519", client.publicKey) },
      )
    ).message;

  return { session, ws, jwe, readAck };
}

const settle = (ms = 20) => new Promise((r) => setTimeout(r, ms));

test("the ack waits for a promise-returning handler (the whole R1.6 premise)", async () => {
  const order = [];
  let release;
  const gate = new Promise((r) => (release = r));

  const { ws, jwe, readAck } = await harness(async () => {
    order.push("handler-start");
    await gate; // stand-in for the durable write
    order.push("persisted");
  });

  const originalSend = ws.send.bind(ws);
  ws.send = (data) => {
    order.push("ack");
    originalSend(data);
  };

  ws.inject(jwe);
  await settle();

  assert.deepEqual(order, ["handler-start"], "no ack while the persist is in flight");
  assert.equal(ws.sent.length, 0, "the mediator must still hold its copy");

  release();
  await settle();

  assert.deepEqual(order, ["handler-start", "persisted", "ack"]);
  const ack = await readAck();
  assert.equal(ack.type, ACK_TYPE, "and it is a messages-received ack");
});

test("KNOWN GAP: a rejecting handler does NOT suppress the ack (0.6.2)", async () => {
  // Pins current library behaviour rather than the desired behaviour.
  //
  // `_deliver` wraps the listener in a bare `catch {}` ("a throwing listener
  // must not break frame processing") and `_dispatchFrame` then acks
  // unconditionally. So a handler that could not persist still causes the
  // mediator to delete its only copy, and the message is lost — the narrow
  // remainder of R1.6 after the ordering fix.
  //
  // Ideally a rejection would suppress the ack and let the mediator redeliver,
  // which our `dedup.ts` already makes safe. If that lands upstream this test
  // FAILS, which is the point: the change should be noticed and the wallet's
  // comment in `onInboundMessage` updated, not silently absorbed.
  const { ws, jwe } = await harness(async () => {
    throw new Error("IndexedDB unavailable");
  });

  ws.inject(jwe);
  await settle();

  assert.equal(
    ws.sent.length,
    1,
    "as of 0.6.2 the ack is sent even though the handler rejected — if this " +
      "now reads 0, the library began honouring rejections: good news, but " +
      "update onInboundMessage's comment and this test together",
  );
});

test("a synchronous handler still acks — nothing regressed for other callers", async () => {
  const seen = [];
  const { ws, jwe, readAck } = await harness((m) => {
    seen.push(m.id);
  });

  ws.inject(jwe);
  await settle();

  assert.deepEqual(seen, ["urn:uuid:consent-1"]);
  assert.equal(ws.sent.length, 1);
  assert.equal((await readAck()).type, ACK_TYPE);
});
