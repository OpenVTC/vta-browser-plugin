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

test("preview translates every snake_case list across the casing boundary", async () => {
  const channel = recorder({
    id: "demo",
    keys: ["key-1"],
    webvh_dids: ["did:webvh:QmX:h"],
    acl_entries_removed: ["did:key:zGone"],
    acl_entries_updated: ["did:key:zNarrowed"],
    did_templates: ["persona"],
  });
  const result = await contextPreviewDelete(channel, { holder: HOLDER, service: SERVICE, id: "demo" });
  assert.deepEqual(result, {
    id: "demo",
    keys: ["key-1"],
    webvhDids: ["did:webvh:QmX:h"],
    aclEntriesRemoved: ["did:key:zGone"],
    aclEntriesUpdated: ["did:key:zNarrowed"],
    didTemplates: ["persona"],
  });
});

test("preview reads the camelCase spellings the spec actually declares", async () => {
  // The snake_case arms above are the compatibility path, for an agent that
  // has not taken the camelCase change. These are what a conforming agent
  // sends, and reading them was what the client was missing: three of the six
  // lists were dropped on the floor, so no consumer could show them.
  const channel = recorder({
    id: "demo",
    keys: [],
    webvhDids: [],
    aclEntriesRemoved: ["did:key:zGone"],
    aclEntriesUpdated: ["did:key:zNarrowed"],
    didTemplates: ["persona"],
  });
  const result = await contextPreviewDelete(channel, { holder: HOLDER, service: SERVICE, id: "demo" });
  assert.deepEqual(result.aclEntriesRemoved, ["did:key:zGone"]);
  assert.deepEqual(result.aclEntriesUpdated, ["did:key:zNarrowed"]);
  assert.deepEqual(result.didTemplates, ["persona"]);
});

test("preview defaults every list when the context holds nothing", async () => {
  const channel = recorder({ id: "demo" });
  const result = await contextPreviewDelete(channel, { holder: HOLDER, service: SERVICE, id: "demo" });
  assert.deepEqual(result, {
    id: "demo",
    keys: [],
    webvhDids: [],
    aclEntriesRemoved: [],
    aclEntriesUpdated: [],
    didTemplates: [],
  });
});
