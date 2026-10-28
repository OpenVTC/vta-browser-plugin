// A room's own profile in the console's room list (`rooms/keys/profile/read/0.1`).
//
// What is asserted is what a member reads: the name the room gives itself wins
// over the community's offer label; its description shows as text; a rename by
// somebody without the standing to is said in words; and an agent that cannot
// answer leaves the row as it was.

import { test } from "node:test";
import assert from "node:assert/strict";
import { agent, h, render, PARTIES } from "./harness/dom.mjs";
import { RoomsPane } from "../src/manager/panes/rooms.js";
import { roomDisplayName } from "../src/manager/panes/rooms-profile.js";
import { roomNamesKey } from "../src/room-page-policy.js";

const LIST = "rooms/keys/list/0.2";
const PROFILE = "rooms/keys/profile/read/0.1";
const SERVERS = "vta/webvh/servers/list/1.0";
const SERVICES = "vta/services/list/1.1";
const ROOM = "did:webvh:example.com:rooms:board";
const HOST = "did:webvh:example.com:community";
const MEMBER = "did:webvh:example.com:people:alice";

const settle = () => new Promise((r) => setTimeout(r, 0));

const mount = async (profile: unknown, remembered = true) => {
  const a = agent({
    [LIST]: {
      rooms: [{ roomId: ROOM, member: MEMBER, epoch: 4, earliestReadableEpoch: 1 }],
    },
    [PROFILE]: profile,
    [SERVERS]: { servers: [] },
    [SERVICES]: { services: [] },
  });
  const stored = remembered
    ? { [roomNamesKey(PARTIES.service.did, HOST)]: { [ROOM]: { label: "Offered name", seenAt: 1 } } }
    : {};
  const screen = await render(h(RoomsPane, { parties: PARTIES, contexts: [] } as never), {
    chrome: { runtime: { sendMessage: a.sendMessage }, storage: { local: { get: async () => stored } } },
  });
  await settle();
  await settle();
  return { a, screen };
};

test("the name the room gives itself wins over the community's label, with its description", async () => {
  const { a, screen } = await mount({
    roomId: ROOM,
    status: "found",
    profile: { name: "Board pack — 2027", description: "Papers for the board", emoji: "📋" },
    stale: false,
  });
  assert.match(screen.text(), /📋 Board pack — 2027/);
  assert.match(screen.text(), /Papers for the board/);
  assert.doesNotMatch(screen.text(), /Offered name/);
  const asked = a.of("profile/read");
  assert.equal(asked.length, 1, "read once for the listing");
  assert.deepEqual(asked[0]!.payload, {
    roomId: ROOM,
    host: HOST,
    ext: { "org.openvtc.rooms": { member: MEMBER } },
  });
});

test("a refused rename and a stale profile are said in words", async () => {
  const { screen } = await mount({
    roomId: ROOM,
    status: "found",
    profile: { name: "Board pack" },
    stale: true,
    rejected: [{ epoch: 5, version: 93, reason: "noAuthority", author: "did:example:mallory" }],
  });
  assert.match(screen.text(), /Board pack/);
  assert.match(screen.text(), /without the standing to name this room tried to rename it/);
  assert.match(screen.text(), /may be out of date/);
});

test("markup in a profile is shown as text, never rendered", async () => {
  const { screen } = await mount({
    roomId: ROOM,
    status: "found",
    profile: { name: "<img src=x onerror=alert(1)>Board" },
  });
  assert.match(screen.text(), /<img src=x onerror=alert\(1\)>Board/);
  assert.equal(screen.all("img").length, 0);
});

test("an agent that does not serve the task leaves the community's name", async () => {
  const { screen } = await mount(() => {
    throw new Error("unsupportedType");
  });
  assert.match(screen.text(), /Offered name/);
});

test("a room no community named is not read from anywhere until its host is named", async () => {
  const { a } = await mount({ roomId: ROOM, status: "absent" }, false);
  assert.equal(a.of("profile/read").length, 0);
});

test("display order: your own label, then the room's profile, then the community's, then none", () => {
  const profile = { status: "found" as const, name: "Profile", stale: false, renameRefused: false, refusedAuthors: [] };
  assert.deepEqual(roomDisplayName({ personal: "Mine", profile, community: "Offer" }), { name: "Mine", source: "personal" });
  assert.deepEqual(roomDisplayName({ profile, community: "Offer" }), { name: "Profile", source: "profile" });
  assert.deepEqual(roomDisplayName({ community: "Offer" }), { name: "Offer", source: "community" });
  assert.equal(roomDisplayName({}), undefined);
});

test("under a row whose host the member named: the room's name, or that it has none they can read", async () => {
  const { RoomProfileAt } = await import("../src/manager/panes/rooms-profile.js");
  const a = agent({ [PROFILE]: { roomId: ROOM, status: "absent", searched: { fromEpoch: 9, toEpoch: 9 } } });
  const screen = await render(h(RoomProfileAt, { parties: PARTIES, roomId: ROOM, member: MEMBER, host: HOST } as never), {
    chrome: { runtime: { sendMessage: a.sendMessage } },
  });
  await settle();
  assert.match(screen.text(), /has not given itself a name you can read/);

  const b = agent({ [PROFILE]: { roomId: ROOM, status: "cleared" } });
  const cleared = await render(h(RoomProfileAt, { parties: PARTIES, roomId: ROOM, host: HOST } as never), {
    chrome: { runtime: { sendMessage: b.sendMessage } },
  });
  await settle();
  assert.match(cleared.text(), /A curator cleared this room's name/);
});
