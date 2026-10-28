// A member's own name for a room (`rooms/keys/label/0.1`), and the list that
// shows it back (`rooms/keys/list/0.2`).
//
// Two things these hold. A label is asked for only by the member's own surface:
// a list asked without `includePersonal` — what a portal page gets — carries
// none, even if an agent sent one. And a label edit is a patch: what is given,
// what is removed, nothing else, and never nothing at all.

import { test } from "node:test";
import assert from "node:assert/strict";

import { roomsKeysList, roomsKeysLabel, roomLabelPayload } from "../dist/rooms/index.js";

const HOLDER = { did: "did:key:zMember" };
const AGENT = { did: "did:webvh:QmAgent:agent.example" };
const ROOM = "did:webvh:QmRoom:rooms.example";
const MEMBER = "did:key:z6MkPersona";

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

const LISTED = {
  rooms: [
    {
      roomId: ROOM,
      member: MEMBER,
      epoch: 4,
      earliestReadableEpoch: 1,
      personal: { label: "Mine", updatedAt: "2026-10-16T09:00:00Z" },
    },
  ],
  ext: { "org.openvtc.rooms": { held: [{ member: MEMBER, context: "alice", actions: ["read"] }] } },
};

test("a list asked without includePersonal asks for none and keeps none", async () => {
  const channel = recorder(LISTED);
  const rooms = await roomsKeysList(channel, { holder: HOLDER, service: AGENT });
  assert.deepEqual(channel.sent[0].envelope.payload, {});
  assert.match(channel.sent[0].envelope.type, /rooms\/keys\/list\/0\.2$/);
  assert.equal(rooms[0].personal, undefined, "a label not asked for is dropped");
  assert.equal(rooms[0].member, MEMBER);
  assert.equal(rooms[0].context, "alice");
});

test("includePersonal asks for labels and returns them", async () => {
  const channel = recorder(LISTED);
  const rooms = await roomsKeysList(channel, { holder: HOLDER, service: AGENT }, { includePersonal: true });
  assert.deepEqual(channel.sent[0].envelope.payload, { includePersonal: true });
  assert.equal(rooms[0].personal.label, "Mine");
});

test("a label edit is the patch it names, for the member it names", async () => {
  const channel = recorder({ roomId: ROOM, member: MEMBER, changed: true });
  await roomsKeysLabel(channel, {
    holder: HOLDER, service: AGENT, roomId: ROOM, member: MEMBER,
    label: "Northwind", tags: ["work"], removeNotes: true,
  });
  const { envelope } = channel.sent[0];
  assert.match(envelope.type, /rooms\/keys\/label\/0\.1$/);
  assert.deepEqual(envelope.payload, {
    roomId: ROOM, member: MEMBER, label: "Northwind", tags: ["work"], removeNotes: true,
  });
});

test("an edit that changes nothing, or gives and removes one detail, is refused before sending", () => {
  assert.throws(() => roomLabelPayload(ROOM, MEMBER, {}), /changes nothing/);
  assert.throws(() => roomLabelPayload(ROOM, MEMBER, { label: "x", removeLabel: true }), /both given and removed/);
  assert.throws(() => roomLabelPayload(ROOM, MEMBER, { tags: [] }), /at least one tag/);
  assert.deepEqual(roomLabelPayload(ROOM, MEMBER, { removeTags: true }), { roomId: ROOM, member: MEMBER, removeTags: true });
});

// No fold to rooms/keys/list 0.1: the wallet and the VTA cut over together, so
// a VTA refusing 0.2 for its version is answered with that refusal, never with
// an older listing that names its members somewhere else.
test("a version refusal of list 0.2 is not retried as 0.1", async () => {
  const sent = [];
  const channel = {
    send(envelope) {
      sent.push(envelope);
      const e = new Error("unsupported version");
      e.details = { code: "unsupportedVersion" };
      return Promise.reject(e);
    },
  };
  await assert.rejects(roomsKeysList(channel, { holder: HOLDER, service: AGENT }), /unsupported version/);
  assert.equal(sent.length, 1);
  assert.match(sent[0].type, /rooms\/keys\/list\/0\.2$/);
});

test("any other refusal of list 0.2 propagates", async () => {
  const sent = [];
  const channel = {
    send(envelope) {
      sent.push(envelope);
      const e = new Error("permission denied");
      e.details = { code: "permissionDenied" };
      return Promise.reject(e);
    },
  };
  await assert.rejects(roomsKeysList(channel, { holder: HOLDER, service: AGENT }), /permission denied/);
  assert.equal(sent.length, 1);
});
