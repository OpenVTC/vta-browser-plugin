// `vta/did-templates/*` (2.0) and `vta/memory/*`.
//
// Both families are scoped by context, and the two treat that scoping
// differently on purpose: a template omitting `contextId` addresses the global
// namespace, while memory has no global namespace at all and requires one. The
// tests pin both, because "the same name in a different scope" is how a console
// shows an operator the wrong record.

import { test } from "node:test";
import assert from "node:assert/strict";

import {
  didTemplateCreate,
  didTemplateGet,
  didTemplateList,
  didTemplateUpdate,
  didTemplateDelete,
  didTemplateRender,
  memoryPut,
  memoryList,
  memoryDelete,
} from "../dist/admin/index.js";

const HOLDER = { did: "did:key:zAdmin" };
const SERVICE = { did: "did:webvh:QmAgent:agent.example" };

const TEMPLATE = {
  schemaVersion: 1,
  name: "persona",
  kind: "webvh",
  document: { "@context": ["https://www.w3.org/ns/did/v1"] },
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

// ── did-templates ───────────────────────────────────────────────────────────

test("create targets 2.0 — the version the agent actually declares", async () => {
  // The bindings also ship 1.0, and a 1.0 import compiles perfectly well; only
  // the agent would object. The conformance test is the other half of this.
  const channel = recorder({ ...TEMPLATE, scope: { type: "global" } });
  await didTemplateCreate(channel, { holder: HOLDER, service: SERVICE, template: TEMPLATE });
  const { envelope, opts } = channel.sent[0];
  assert.equal(envelope.type, "https://trusttasks.org/spec/vta/did-templates/create/2.0");
  assert.equal(
    opts.expectedResponseType,
    "https://trusttasks.org/spec/vta/did-templates/create/2.0#response",
  );
});

test("omitting contextId addresses the global namespace", async () => {
  const channel = recorder({ templates: [] });
  await didTemplateList(channel, { holder: HOLDER, service: SERVICE });
  assert.deepEqual(channel.sent[0].envelope.payload, {});
});

test("contextId scopes the call to that context's templates", async () => {
  const channel = recorder({ templates: [] });
  await didTemplateList(channel, { holder: HOLDER, service: SERVICE, contextId: "demo" });
  assert.deepEqual(channel.sent[0].envelope.payload, { contextId: "demo" });
});

test("list returns [] rather than undefined when a scope holds nothing", async () => {
  const channel = recorder({});
  assert.deepEqual(await didTemplateList(channel, { holder: HOLDER, service: SERVICE }), []);
});

test("get and delete name the template, and carry the scope through", async () => {
  const got = recorder({ ...TEMPLATE, scope: { type: "context", contextId: "demo" } });
  await didTemplateGet(got, {
    holder: HOLDER,
    service: SERVICE,
    contextId: "demo",
    name: "persona",
  });
  assert.deepEqual(got.sent[0].envelope.payload, { contextId: "demo", name: "persona" });

  const del = recorder({ name: "persona", deleted: true });
  const result = await didTemplateDelete(del, {
    holder: HOLDER,
    service: SERVICE,
    name: "persona",
  });
  assert.deepEqual(del.sent[0].envelope.payload, { name: "persona" });
  assert.equal(result.deleted, true);
});

test("a delete of something that was not there reports deleted:false", async () => {
  const channel = recorder({ name: "gone", deleted: false });
  const result = await didTemplateDelete(channel, {
    holder: HOLDER,
    service: SERVICE,
    name: "gone",
  });
  assert.equal(result.deleted, false);
});

test("update sends the whole template — it replaces, it does not patch", async () => {
  const channel = recorder({ ...TEMPLATE, scope: { type: "global" } });
  await didTemplateUpdate(channel, {
    holder: HOLDER,
    service: SERVICE,
    name: "persona",
    template: TEMPLATE,
  });
  assert.deepEqual(channel.sent[0].envelope.payload, {
    name: "persona",
    template: TEMPLATE,
  });
});

test("render returns the document and creates nothing", async () => {
  const document = { id: "did:webvh:example:persona" };
  const channel = recorder({ document });
  const result = await didTemplateRender(channel, {
    holder: HOLDER,
    service: SERVICE,
    name: "persona",
    vars: { handle: "alice" },
  });
  assert.deepEqual(channel.sent[0].envelope.payload, {
    name: "persona",
    vars: { handle: "alice" },
  });
  assert.deepEqual(result, document);
});

test("render with no vars omits the member rather than sending an empty object", async () => {
  const channel = recorder({ document: {} });
  await didTemplateRender(channel, { holder: HOLDER, service: SERVICE, name: "persona" });
  assert.deepEqual(channel.sent[0].envelope.payload, { name: "persona" });
});

// ── memory ──────────────────────────────────────────────────────────────────

test("every memory call carries its context — there is no global memory", async () => {
  const channel = recorder({ key: "k" });
  await memoryPut(channel, {
    holder: HOLDER,
    service: SERVICE,
    contextId: "demo",
    key: "k",
    value: "v",
  });
  assert.deepEqual(channel.sent[0].envelope.payload, {
    contextId: "demo",
    key: "k",
    value: "v",
  });
});

test("list is a directory of keys, not a dump of values", async () => {
  const channel = recorder({ items: [{ key: "k1" }, { key: "k2" }] });
  const items = await memoryList(channel, {
    holder: HOLDER,
    service: SERVICE,
    contextId: "demo",
  });
  assert.deepEqual(channel.sent[0].envelope.payload, { contextId: "demo" });
  assert.deepEqual(items, [{ key: "k1" }, { key: "k2" }]);
  assert.ok(items.every((i) => !("value" in i)));
});

test("delete names the key within its context", async () => {
  const channel = recorder({ key: "k1" });
  await memoryDelete(channel, {
    holder: HOLDER,
    service: SERVICE,
    contextId: "demo",
    key: "k1",
  });
  assert.deepEqual(channel.sent[0].envelope.payload, { contextId: "demo", key: "k1" });
});
