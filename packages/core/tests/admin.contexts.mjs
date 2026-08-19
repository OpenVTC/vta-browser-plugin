// Context deletion — the snake_case corner of the admin surface.
//
// `vta_sdk::protocols::context_management::delete` declares no `rename_all`, so
// unlike `acl/*` these bodies are snake_case. Both request fields are single
// words, which hides the difference; the response is not (`webvh_dids`), and
// that is where a casing assumption shows up as an empty list rather than an
// error. Hence a test for the one field that can silently disagree.

import { test } from "node:test";
import assert from "node:assert/strict";

import { contextDelete, contextPreviewDelete } from "../dist/admin/index.js";

const HOLDER = { did: "did:key:zAdmin" };
const SERVICE = { did: "did:webvh:QmAgent:agent.example" };

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

test("delete sends force explicitly, defaulting to false", async () => {
  const channel = recorder({ id: "demo", deleted: true });
  const result = await contextDelete(channel, { holder: HOLDER, service: SERVICE, id: "demo" });

  const { envelope, opts } = channel.sent[0];
  assert.equal(envelope.type, "https://trusttasks.org/spec/vta/contexts/delete/1.0");
  assert.deepEqual(envelope.payload, { id: "demo", force: false });
  assert.equal(
    opts.expectedResponseType,
    "https://trusttasks.org/spec/vta/contexts/delete/1.0#response",
  );
  assert.deepEqual(result, { id: "demo", deleted: true });
});

test("force is passed through when the caller means it", async () => {
  const channel = recorder({ id: "demo", deleted: true });
  await contextDelete(channel, { holder: HOLDER, service: SERVICE, id: "demo", force: true });
  assert.equal(channel.sent[0].envelope.payload.force, true);
});

test("a delete the agent refused reports deleted:false rather than throwing", async () => {
  const channel = recorder({ id: "demo", deleted: false });
  const result = await contextDelete(channel, { holder: HOLDER, service: SERVICE, id: "demo" });
  assert.equal(result.deleted, false);
});

test("preview translates webvh_dids across the casing boundary", async () => {
  const channel = recorder({ id: "demo", keys: ["key-1"], webvh_dids: ["did:webvh:QmX:h"] });
  const result = await contextPreviewDelete(channel, { holder: HOLDER, service: SERVICE, id: "demo" });
  assert.deepEqual(result, { id: "demo", keys: ["key-1"], webvhDids: ["did:webvh:QmX:h"] });
});

test("preview defaults both lists when the context holds nothing", async () => {
  const channel = recorder({ id: "demo" });
  const result = await contextPreviewDelete(channel, { holder: HOLDER, service: SERVICE, id: "demo" });
  assert.deepEqual(result, { id: "demo", keys: [], webvhDids: [] });
});
