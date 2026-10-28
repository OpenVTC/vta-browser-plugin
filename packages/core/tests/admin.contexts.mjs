// Context deletion — the destructive corner of the admin surface.
//
// The preview's lists are what an operator reads before destroying a subtree,
// so a spelling the client does not read shows up as an empty list rather than
// an error. Hence tests that pin the one spelling the specification declares.

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
  assert.equal(envelope.type, "https://trusttasks.org/spec/vta/contexts/delete/1.1");
  assert.deepEqual(envelope.payload, { id: "demo", force: false });
  assert.equal(
    opts.expectedResponseType,
    "https://trusttasks.org/spec/vta/contexts/delete/1.1#response",
  );
  assert.deepEqual(result, { id: "demo", deleted: true, daemonCleanupErrors: [] });
});

test("force is passed through when the caller means it", async () => {
  const channel = recorder({ id: "demo", deleted: true });
  await contextDelete(channel, { holder: HOLDER, service: SERVICE, id: "demo", force: true });
  assert.equal(channel.sent[0].envelope.payload.force, true);
});

test("host copies are abandoned only when the caller says so", async () => {
  // 1.1 refuses (`hostCleanupFailed`) a deletion whose DIDs' host copies it
  // could not confirm removed, unless asked to abandon them. The member is
  // never sent on the caller's behalf.
  const quiet = recorder({ id: "demo", deleted: true });
  await contextDelete(quiet, { holder: HOLDER, service: SERVICE, id: "demo" });
  assert.equal("abandonHostCopies" in quiet.sent[0].envelope.payload, false);

  const meant = recorder({ id: "demo", deleted: true });
  await contextDelete(meant, { holder: HOLDER, service: SERVICE, id: "demo", abandonHostCopies: true });
  assert.equal(meant.sent[0].envelope.payload.abandonHostCopies, true);
});

test("a delete the agent refused reports deleted:false rather than throwing", async () => {
  const channel = recorder({ id: "demo", deleted: false });
  const result = await contextDelete(channel, { holder: HOLDER, service: SERVICE, id: "demo" });
  assert.equal(result.deleted, false);
});

test("preview reads every list under the spelling the spec declares", async () => {
  const channel = recorder({
    id: "demo",
    keys: ["key-1"],
    webvhDids: ["did:webvh:QmX:h"],
    subContexts: ["demo/sub"],
    aclEntriesRemoved: ["did:key:zGone"],
    aclEntriesUpdated: ["did:key:zNarrowed"],
    didTemplates: ["persona"],
  });
  const result = await contextPreviewDelete(channel, { holder: HOLDER, service: SERVICE, id: "demo" });
  assert.equal(
    channel.sent[0].opts.expectedResponseType,
    "https://trusttasks.org/spec/vta/contexts/preview-delete/1.0#response",
  );
  assert.deepEqual(result, {
    id: "demo",
    subContexts: ["demo/sub"],
    keys: ["key-1"],
    webvhDids: ["did:webvh:QmX:h"],
    aclEntriesRemoved: ["did:key:zGone"],
    aclEntriesUpdated: ["did:key:zNarrowed"],
    didTemplates: ["persona"],
  });
});

test("a snake_case list is not read: the spec declares none", async () => {
  const channel = recorder({ id: "demo", keys: [], webvhDids: [], webvh_dids: ["did:webvh:QmX:h"] });
  const result = await contextPreviewDelete(channel, { holder: HOLDER, service: SERVICE, id: "demo" });
  assert.deepEqual(result.webvhDids, []);
});

test("preview defaults every list when the context holds nothing", async () => {
  const channel = recorder({ id: "demo" });
  const result = await contextPreviewDelete(channel, { holder: HOLDER, service: SERVICE, id: "demo" });
  assert.deepEqual(result, {
    id: "demo",
    subContexts: [],
    keys: [],
    webvhDids: [],
    aclEntriesRemoved: [],
    aclEntriesUpdated: [],
    didTemplates: [],
  });
});

test("a delete that left host copies behind says so, rather than reporting done", async () => {
  // The agent removed the records and the hosting server did not confirm
  // removing the published logs, so those DIDs may still resolve. A success
  // the caller must not read as a completed deletion.
  const channel = recorder({
    id: "demo",
    deleted: true,
    daemonCleanupErrors: ["did:webvh:QmX:h: daemon `h` rejected delete: 503"],
  });
  const result = await contextDelete(channel, {
    holder: HOLDER,
    service: SERVICE,
    id: "demo",
    abandonHostCopies: true,
  });
  assert.equal(result.deleted, true);
  assert.deepEqual(result.daemonCleanupErrors, [
    "did:webvh:QmX:h: daemon `h` rejected delete: 503",
  ]);
});
