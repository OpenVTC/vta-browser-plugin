// Deferred presentations — the answerable half of `credential-exchange/*`.
//
// What these protect is the claim list. A verifier's deferred request names
// the specific claims it wants, and a UI that renders "approve this
// presentation" without them is asking for consent to something unstated —
// so the list has to survive the round trip intact rather than being
// summarised into a count.

import { test } from "node:test";
import assert from "node:assert/strict";

import {
  pendingPresentations,
  approvePendingPresentation,
  denyPendingPresentation,
} from "../dist/credentials/index.js";

const HOLDER = { did: "did:key:zHolder" };
const SERVICE = { did: "did:webvh:QmAgent:agent.example" };

const PENDING = {
  id: "p1",
  verifierDid: "did:webvh:QmVerifier:rp.example",
  purpose: "Age verification for account opening",
  createdAt: "2026-08-18T00:00:00Z",
  expiresAt: "2026-08-19T00:00:00Z",
  requested: [
    { credentialQueryId: "q1", credentialId: "cred-1", claims: ["birthDate", "givenName"] },
  ],
};

function recorder(reply) {
  const sent = [];
  return {
    sent,
    send(envelope, opts) {
      sent.push({ envelope, opts });
      return Promise.resolve(reply);
    },
  };
}

test("pending list sends an empty payload under the canonical type", async () => {
  const channel = recorder({ pending: [PENDING] });
  await pendingPresentations(channel, { holder: HOLDER, service: SERVICE });
  const { envelope, opts } = channel.sent[0];
  assert.equal(
    envelope.type,
    "https://trusttasks.org/spec/credential-exchange/pending/list/0.1",
  );
  assert.deepEqual(envelope.payload, {});
  assert.equal(
    opts.expectedResponseType,
    "https://trusttasks.org/spec/credential-exchange/pending/list/0.1#response",
  );
});

test("the requested claims survive intact — they are what consent is about", async () => {
  const channel = recorder({ pending: [PENDING] });
  const [item] = await pendingPresentations(channel, { holder: HOLDER, service: SERVICE });
  assert.deepEqual(item.requested[0].claims, ["birthDate", "givenName"]);
  assert.equal(item.verifierDid, PENDING.verifierDid);
  assert.equal(item.purpose, PENDING.purpose);
});

test("no pending presentations is an empty list, not undefined", async () => {
  const channel = recorder({});
  assert.deepEqual(await pendingPresentations(channel, { holder: HOLDER, service: SERVICE }), []);
});

test("approve names the id and returns the token that goes to the verifier", async () => {
  // Approving is what mints the vp_token, so an error here means nothing was
  // disclosed — the reassuring direction, and worth being able to say.
  const channel = recorder({ vp_token: "eyJhbGciOi..." });
  const result = await approvePendingPresentation(channel, {
    holder: HOLDER,
    service: SERVICE,
    id: "p1",
  });
  assert.deepEqual(channel.sent[0].envelope.payload, { id: "p1" });
  assert.equal(result.vp_token, "eyJhbGciOi...");
});

test("a vp_token may be an object rather than a compact string", async () => {
  const channel = recorder({ vp_token: { verifiableCredential: [] } });
  const result = await approvePendingPresentation(channel, {
    holder: HOLDER,
    service: SERVICE,
    id: "p1",
  });
  assert.deepEqual(result.vp_token, { verifiableCredential: [] });
});

test("deny reports the denial and discloses nothing", async () => {
  const channel = recorder({ id: "p1", status: "denied" });
  const result = await denyPendingPresentation(channel, {
    holder: HOLDER,
    service: SERVICE,
    id: "p1",
  });
  assert.deepEqual(channel.sent[0].envelope.payload, { id: "p1" });
  assert.equal(result.status, "denied");
  assert.ok(!("vp_token" in result));
});

test("a refusal from the agent propagates rather than resolving empty", async () => {
  const failing = {
    send: () => Promise.reject(new Error("e.cx.expired: the request has expired")),
  };
  await assert.rejects(
    () => approvePendingPresentation(failing, { holder: HOLDER, service: SERVICE, id: "p1" }),
    /e\.cx\.expired/,
  );
});
