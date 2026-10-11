// The self-test's round trip: one timed `auth/whoami`, classified so that an
// agent's refusal counts as an answer and only this side's own failures fail.

import { test } from "node:test";
import assert from "node:assert/strict";

import { probeRoundTrip, VtaClientError } from "../dist/index.js";

const parties = { holder: { did: "did:key:zHolder" }, service: { did: "did:example:vta" } };
let t = 0;
const clock = () => (t += 250);

test("an answer is timed", async () => {
  const sent = [];
  const sender = { send: async (env, opts) => (sent.push({ env, opts }), { session: {} }) };
  const r = await probeRoundTrip(sender, { ...parties, timeoutMs: 1234, now: clock });
  assert.equal(r.kind, "answered");
  assert.equal(r.ms, 250);
  assert.equal(sent[0].env.type, "https://trusttasks.org/spec/auth/whoami/0.1");
  assert.equal(sent[0].env.recipient, "did:example:vta");
  assert.equal(sent[0].opts.timeoutMs, 1234);
});

test("an agent's refusal is an answer: the path worked both ways", async () => {
  const sender = {
    send: async () => {
      throw new VtaClientError("e.p.msg.forbidden", "permission denied: forbidden: DID not in ACL");
    },
  };
  const r = await probeRoundTrip(sender, { ...parties, now: clock });
  assert.equal(r.kind, "answered");
  assert.deepEqual(r.refusal, { code: "e.p.msg.forbidden", message: "permission denied: forbidden: DID not in ACL" });
});

test("this side's own failure is a failure, with what the channel saw", async () => {
  const sender = {
    send: async () => {
      throw new VtaClientError("e.client.network", "tsp: timed out — no frame arrived on this socket while waiting");
    },
  };
  const r = await probeRoundTrip(sender, { ...parties, now: clock });
  assert.equal(r.kind, "failed");
  assert.equal(r.code, "e.client.network");
  assert.match(r.message, /no frame arrived/);
});

test("an uncoded throw is a failure too, and never escapes", async () => {
  const r = await probeRoundTrip({ send: async () => { throw new TypeError("Failed to fetch"); } }, parties);
  assert.equal(r.kind, "failed");
  assert.equal(r.code, undefined);
  assert.equal(r.message, "Failed to fetch");
});
