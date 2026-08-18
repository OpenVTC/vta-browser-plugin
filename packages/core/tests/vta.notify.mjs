// The one-way primitive.
//
// `notify` exists because some tasks define no response document, and awaiting
// one on those means blocking until a timeout on a message that arrived
// perfectly. Each transport therefore has to promise the same weak thing —
// "handed to the transport" — and no more.
//
// The case worth guarding hardest is the TSP refusal. A TSP transport with no
// one-way path must NOT quietly fall back to `sendAndAwaitReply`: that would
// look like it worked and then hang. It refuses with `e.client.unsupported`,
// which is precisely the code a session treats as "try the next channel".

import { test } from "node:test";
import assert from "node:assert/strict";

import { TspChannel, VtaSession, VtaClientError } from "../dist/index.js";
import { decodeTrustTaskHttpAck } from "../dist/vta/rest-channel.js";

const ENVELOPE = {
  id: "req-1",
  type: "https://trusttasks.org/spec/credential-exchange/offer/0.1",
  payload: { credential_offer: {} },
};

// ── REST ────────────────────────────────────────────────────────────────────
//
// Exercises `decodeTrustTaskHttpAck` directly — the same function
// `RestChannel.notify` calls — so it needs no bearer handshake, matching how
// `vta.rest-reply.mjs` covers the request/response decoder.

function json(body, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

test("an empty 202 is delivery — there is nothing to decode", async () => {
  await decodeTrustTaskHttpAck(new Response(null, { status: 202 }));
});

test("a courtesy trust-task-ok is accepted without being read for meaning", async () => {
  await decodeTrustTaskHttpAck(
    json({ type: "https://trusttasks.org/spec/trust-task-ok/0.1", payload: {} }),
  );
});

test("a refusal keeps its machine-readable code — rejected is not delivered", async () => {
  await assert.rejects(
    () =>
      decodeTrustTaskHttpAck(
        json(
          {
            type: "https://trusttasks.org/spec/trust-task-error/0.2",
            payload: { code: "e.p.msg.forbidden", message: "not authorised" },
          },
          403,
        ),
      ),
    (err) => {
      assert.ok(err instanceof VtaClientError);
      assert.equal(err.code, "e.p.msg.forbidden");
      return true;
    },
  );
});

test("a non-2xx that is not JSON still fails, from the status alone", async () => {
  await assert.rejects(
    () => decodeTrustTaskHttpAck(new Response("<html>502</html>", { status: 502 })),
    (err) => {
      assert.ok(err instanceof VtaClientError);
      return true;
    },
  );
});

// ── TSP ─────────────────────────────────────────────────────────────────────

const TSP_HOLDER = {
  vid: "did:key:zHolder",
  signingPrivateKey: new Uint8Array(32).fill(1),
  encryptionPrivateKey: new Uint8Array(32).fill(2),
  encryptionPublicKey: new Uint8Array(32).fill(3),
};
const TSP_VTA = {
  vid: "did:webvh:QmAgent:agent.example",
  encryptionPublicKey: new Uint8Array(32).fill(4),
  signingPublicKey: new Uint8Array(32).fill(5),
};

test("TSP notify refuses rather than blocking when the transport is reply-only", async () => {
  let awaited = false;
  const transport = {
    async sendAndAwaitReply() {
      awaited = true;
      return new Uint8Array();
    },
  };
  const channel = new TspChannel({ transport, holder: TSP_HOLDER, vta: TSP_VTA });

  await assert.rejects(() => channel.notify(ENVELOPE), (err) => {
    assert.equal(err.code, "e.client.unsupported");
    return true;
  });
  assert.equal(awaited, false, "must not fall back to the request/response path");
});

test("TSP notify uses the one-way path when the transport has one", async () => {
  const sent = [];
  const transport = {
    sendAndAwaitReply: async () => new Uint8Array(),
    send: async (packed) => {
      sent.push(packed);
    },
  };
  const channel = new TspChannel({ transport, holder: TSP_HOLDER, vta: TSP_VTA });
  await channel.notify(ENVELOPE);
  assert.equal(sent.length, 1);
  assert.ok(sent[0] instanceof Uint8Array && sent[0].length > 0);
});

// ── session fallback ────────────────────────────────────────────────────────

function fakeChannel(kind, notify) {
  return { kind, send: async () => ({}), notify };
}

test("a session falls through a channel that cannot carry a one-way task", async () => {
  const tried = [];
  const session = new VtaSession([
    fakeChannel("tsp", async () => {
      tried.push("tsp");
      throw new VtaClientError("e.client.unsupported", "no one-way send");
    }),
    fakeChannel("didcomm", async () => {
      tried.push("didcomm");
    }),
  ]);

  await session.notify(ENVELOPE);
  assert.deepEqual(tried, ["tsp", "didcomm"]);
});

test("a real failure stops the chain instead of trying the next channel", async () => {
  // Falling onward on a network error would deliver the same message twice as
  // soon as the first channel's failure was a timeout rather than a refusal.
  const tried = [];
  const session = new VtaSession([
    fakeChannel("didcomm", async () => {
      tried.push("didcomm");
      throw new VtaClientError("e.client.network", "socket closed");
    }),
    fakeChannel("rest", async () => {
      tried.push("rest");
    }),
  ]);

  await assert.rejects(() => session.notify(ENVELOPE), /socket closed/);
  assert.deepEqual(tried, ["didcomm"]);
});

test("a session with no channel for the task refuses up front", async () => {
  const session = new VtaSession([
    { kind: "rest", send: async () => ({}), notify: async () => {}, supports: () => false },
  ]);
  await assert.rejects(() => session.notify(ENVELOPE), (err) => {
    assert.equal(err.code, "e.client.unsupported");
    return true;
  });
});
