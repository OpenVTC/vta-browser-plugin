// `didsList` / `didsGet` / `didMethodsList` — every identity an agent holds,
// whatever its method (`vta/dids/{list,get,methods/list}/0.1`).
//
// The defect these replaced: an agent whose identities were all did:webs
// answered `vta/webvh/dids/list` with an empty array — correctly, for that
// question — and every surface that asked only it told the holder the context
// "has no DIDs". One method-neutral listing ends the class of bug, not the
// instance; these pin its wire shape and that it is read to the end.

import { test } from "node:test";
import assert from "node:assert/strict";

import { didsList, didsGet, didMethodsList } from "../dist/vta/index.js";

const HOLDER = { did: "did:key:zHolder" };
const SERVICE = { did: "did:webs:host.example:nodes:EAgent" };
const LIST = "https://trusttasks.org/spec/vta/dids/list/0.1";

function agentOf(answer) {
  const sent = [];
  return {
    sent,
    async send(envelope, opts) {
      sent.push({ envelope, opts });
      return typeof answer === "function" ? answer(envelope.payload) : answer;
    },
  };
}

test("no filter sends an empty payload: the question is every identity", async () => {
  const ch = agentOf({ dids: [] });
  await didsList(ch, { holder: HOLDER, service: SERVICE });
  assert.equal(ch.sent[0].envelope.type, LIST);
  assert.equal(ch.sent[0].opts.expectedResponseType, `${LIST}#response`);
  assert.deepEqual(ch.sent[0].envelope.payload, {});
});

test("the filters go under the names the schema gives them", async () => {
  // `additionalProperties: false`: a misspelt member is not a tolerated
  // synonym, it makes the whole payload malformed.
  const ch = agentOf({ dids: [] });
  await didsList(ch, {
    holder: HOLDER,
    service: SERVICE,
    contextId: "personal",
    methods: ["webs", "key"],
    serverId: "prod",
    didClass: "persona",
    includeDeactivated: true,
  });
  assert.deepEqual(ch.sent[0].envelope.payload, {
    contextId: "personal",
    methods: ["webs", "key"],
    serverId: "prod",
    class: "persona",
    includeDeactivated: true,
  });
});

test("a did:webs comes back beside every other method", async () => {
  const ch = agentOf({
    dids: [
      { did: "did:webvh:QmA:h.example", method: "webvh", contextId: "vta" },
      { did: "did:webs:h.example:nodes:EVta", method: "webs", contextId: "vta" },
    ],
  });
  const dids = await didsList(ch, { holder: HOLDER, service: SERVICE, contextId: "vta" });
  assert.deepEqual(
    dids.map((d) => d.method),
    ["webvh", "webs"],
  );
});

test("the listing follows nextCursor to the end", async () => {
  const ch = agentOf((p) =>
    p.cursor === "c1"
      ? { dids: [{ did: "did:key:zB", method: "key" }] }
      : { dids: [{ did: "did:key:zA", method: "key" }], nextCursor: "c1" },
  );
  const dids = await didsList(ch, { holder: HOLDER, service: SERVICE });
  assert.deepEqual(dids.map((d) => d.did), ["did:key:zA", "did:key:zB"]);
  assert.deepEqual(ch.sent.map((s) => s.envelope.payload), [{}, { cursor: "c1" }]);
});

test("get unwraps the summary; methods unwraps the list", async () => {
  const summary = { did: "did:key:zA", method: "key" };
  const g = agentOf({ did: summary });
  assert.deepEqual(await didsGet(g, { holder: HOLDER, service: SERVICE, did: "did:key:zA" }), summary);
  assert.deepEqual(g.sent[0].envelope.payload, { did: "did:key:zA" });

  const m = agentOf({ methods: [{ method: "webs", listed: true, creatable: false }] });
  const methods = await didMethodsList(m, { holder: HOLDER, service: SERVICE });
  assert.equal(methods[0].method, "webs");
  assert.deepEqual(m.sent[0].envelope.payload, {});
});
