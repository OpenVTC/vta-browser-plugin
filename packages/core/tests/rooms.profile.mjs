// A room's own profile, read through the member's VTA (`rooms/keys/profile/read/0.1`),
// and what a surface may show of it.

import { test } from "node:test";
import assert from "node:assert/strict";

import { inertText, roomProfileNotices, roomProfileView, roomsKeysProfileRead } from "../dist/rooms/index.js";

const WALLET = { did: "did:key:zWallet" };
const VTA = { did: "did:webvh:QmAgent:agent.example" };
const HOST = "did:webvh:QmCommunity:community.example";
const ROOM = "did:webvh:QmBoard:community.example:room-dids:board";
const MEMBER = "did:webvh:QmAlice:people.example";

test("the profile is asked of the member's own VTA, naming the host and the member", async () => {
  const sent = [];
  const sender = {
    async send(envelope, opts) {
      sent.push({ envelope, opts });
      return { roomId: ROOM, status: "absent", searched: { fromEpoch: 3, toEpoch: 3 } };
    },
  };
  const res = await roomsKeysProfileRead(sender, {
    holder: WALLET,
    service: VTA,
    roomId: ROOM,
    host: HOST,
    member: MEMBER,
  });
  assert.equal(res.status, "absent");
  const { envelope, opts } = sent[0];
  assert.equal(envelope.type, "https://trusttasks.org/spec/rooms/keys/profile/read/0.1");
  assert.equal(envelope.recipient, VTA.did, "addressed to the VTA, never the host");
  assert.equal(envelope.issuer, WALLET.did);
  assert.deepEqual(envelope.payload, {
    roomId: ROOM,
    host: HOST,
    ext: { "org.openvtc.rooms": { member: MEMBER } },
  });
  assert.equal(opts.expectedResponseType, "https://trusttasks.org/spec/rooms/keys/profile/read/0.1#response");
});

test("a found profile becomes text, its markup and control characters inert", () => {
  const view = roomProfileView({
    roomId: ROOM,
    status: "found",
    profile: {
      name: "Board <b>pack</b>\u001b[31m‮",
      description: "Line one\nLine two\u0007",
      tags: ["board", "\u0000"],
      emoji: "📋",
    },
    stale: false,
  });
  assert.equal(view.status, "found");
  assert.equal(view.name, "Board <b>pack</b>[31m", "kept as text, escapes and bidi overrides gone");
  assert.equal(view.description, "Line one\nLine two");
  assert.deepEqual(view.tags, ["board"]);
  assert.equal(view.emoji, "📋");
  assert.equal(view.stale, false);
  assert.equal(view.renameRefused, false);
  assert.deepEqual(roomProfileNotices(view), []);
});

test("a rename by somebody without the standing to is said in words, and the name kept", () => {
  const view = roomProfileView({
    roomId: ROOM,
    status: "found",
    profile: { name: "Board pack" },
    stale: true,
    rejected: [
      { epoch: 5, version: 93, reason: "noAuthority", author: "did:example:mallory" },
      { epoch: 5, version: 92, reason: "malformed" },
    ],
  });
  assert.equal(view.name, "Board pack");
  assert.equal(view.stale, true);
  assert.equal(view.renameRefused, true);
  assert.deepEqual(view.refusedAuthors, ["did:example:mallory"]);
  const notices = roomProfileNotices(view);
  assert.equal(notices.length, 2);
  assert.match(notices[0], /without the standing to name this room tried to rename it/);
  assert.match(notices[1], /may be out of date/);
});

test("a malformed refusal alone is not a rename attempt; timing and revoked are", () => {
  assert.equal(roomProfileView({ status: "absent", rejected: [{ version: 1, reason: "malformed" }] }).renameRefused, false);
  assert.equal(roomProfileView({ status: "absent", rejected: [{ version: 1, reason: "timing" }] }).renameRefused, true);
  assert.equal(roomProfileView({ status: "absent", rejected: [{ version: 1, reason: "revoked" }] }).renameRefused, true);
});

test("absent and cleared carry no name, and cleared says so", () => {
  const absent = roomProfileView({ status: "absent" });
  assert.equal(absent.name, undefined);
  assert.deepEqual(roomProfileNotices(absent), []);
  const cleared = roomProfileView({ status: "cleared", profile: { name: "ignored" } });
  assert.equal(cleared.name, undefined, "only a found profile has a name");
  assert.match(roomProfileNotices(cleared)[0], /cleared/);
  assert.equal(roomProfileView(null).status, "absent");
});

test("inertText bounds and trims", () => {
  assert.equal(inertText("  x\ty  ", 10), "x y");
  assert.equal(inertText("abcdef", 3), "abc");
});
