import { test } from "node:test";
import assert from "node:assert/strict";

import { requestTask, ORIGIN_EXT_KEY } from "../dist/vta/request-task.js";

/** A session that records the envelope it was handed. */
function capturing(reply = { ok: true }) {
  const sent = [];
  return {
    sent,
    session: {
      async send(envelope) {
        sent.push(envelope);
        return reply;
      },
    },
  };
}

const base = {
  type: "https://trusttasks.org/spec/webvh/dids/update/1.0",
  payload: { did: "did:webvh:example.com:acme", document: { id: "did:webvh:example.com:acme" } },
  holderDid: "did:key:zHolder",
  vtaDid: "did:key:zVta",
  origin: "https://control.example.com",
};

test("the device mints the envelope — the page supplies only type and payload", async () => {
  const { sent, session } = capturing();
  await requestTask(session, base);

  const [env] = sent;
  // Every field that carries authority is written here, not by the page. A relay
  // that let the RP choose the issuer or the recipient would be notarising a
  // document it never checked.
  assert.equal(env.issuer, "did:key:zHolder");
  assert.equal(env.recipient, "did:key:zVta");
  assert.equal(env.type, base.type);
  assert.ok(env.id, "the device mints the id");
  assert.ok(env.issuedAt, "the device mints the timestamp");
});

test("an envelope the page tried to author is not honoured — there is nowhere to put one", async () => {
  const { sent, session } = capturing();
  // The page can only reach `payload`. Anything it puts there that looks like an
  // envelope field stays in the payload, where the VTA's closed schema rejects
  // it — it does not become the envelope.
  await requestTask(session, {
    ...base,
    payload: { ...base.payload, issuer: "did:key:zAttacker", recipient: "did:key:zAttacker" },
  });

  const [env] = sent;
  assert.equal(env.issuer, "did:key:zHolder");
  assert.equal(env.recipient, "did:key:zVta");
  assert.equal(env.payload.issuer, "did:key:zAttacker", "it stays in the payload");
});

test("the origin is stamped by the device, inside the payload", async () => {
  const { sent, session } = capturing();
  await requestTask(session, base);
  assert.equal(sent[0].payload.ext[ORIGIN_EXT_KEY], "https://control.example.com");
});

test("a page cannot forge the origin — the device's stamp wins", async () => {
  const { sent, session } = capturing();
  await requestTask(session, {
    ...base,
    payload: { ...base.payload, ext: { [ORIGIN_EXT_KEY]: "https://bank.example" } },
  });
  assert.equal(
    sent[0].payload.ext[ORIGIN_EXT_KEY],
    "https://control.example.com",
    "the browser-attested origin overwrites whatever the page claimed",
  );
});

test("other ext members the page set are preserved", async () => {
  const { sent, session } = capturing();
  await requestTask(session, {
    ...base,
    payload: { ...base.payload, ext: { "vendor.hint": "x" } },
  });
  assert.equal(sent[0].payload.ext["vendor.hint"], "x");
  assert.equal(sent[0].payload.ext[ORIGIN_EXT_KEY], "https://control.example.com");
});

test("no origin means no stamp — never an invented one", async () => {
  const { sent, session } = capturing();
  const { origin: _drop, ...noOrigin } = base;
  await requestTask(session, noOrigin);
  assert.equal(sent[0].payload.ext, undefined);
});

test("the caller's payload object is not mutated", async () => {
  const { session } = capturing();
  const payload = { did: "did:webvh:x" };
  await requestTask(session, { ...base, payload });
  assert.deepEqual(payload, { did: "did:webvh:x" }, "no ext leaked back into the caller's object");
});

test("a consent-required rejection is returned, not thrown away", async () => {
  // The reject carries the signed consent requests the approver must see and the
  // digest the requesting surface must display. A relay that collapsed it into a
  // generic error would discard the entire informed-consent flow at the last hop.
  const reject = {
    error: "taskFailed",
    reason: "auth:consent_required",
    details: { payloadDigest: "3b0c7f1d", challenge: "9c1f", consentRequests: [{ proof: {} }] },
  };
  const { session } = capturing(reject);
  const res = await requestTask(session, base);
  assert.equal(res.reason, "auth:consent_required");
  assert.equal(res.details.payloadDigest, "3b0c7f1d");
  assert.equal(res.details.consentRequests.length, 1);
});
