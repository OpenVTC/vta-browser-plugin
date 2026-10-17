// The rooms pane's model: where a room was last found, and how cards group.
//
// The remembered host is a hint the pane lists from without asking, so what
// matters is which hint wins and that nothing it did not write is believed.
// The grouping matters because a room must never vanish from the screen: every
// entry lands in exactly one host group (or *unknown*), and by context every
// place lands in exactly one context group.

import { test } from "node:test";
import assert from "node:assert/strict";
import { knownRoomHosts, roomHostsKey, withRoomHost, ROOM_HOSTS_MAX } from "../src/manager/room-hosts.js";
import { groupRooms, mostReadable, roomEntries } from "../src/manager/room-groups.js";
import { roomNamesKey } from "../src/room-page-policy.js";

const VTA = "did:webvh:QmAgent:agent.example";
const COMMUNITY = "did:webvh:QmCommunity:community.example";
const MIRROR = "did:webvh:QmMirror:mirror.example";

test("a host this console saw answer outranks a community's offer", () => {
  const all = {
    [roomNamesKey(VTA, COMMUNITY)]: { a: { label: "A", seenAt: 1 }, b: { label: "B", seenAt: 1 } },
    [roomHostsKey(VTA)]: { a: { host: MIRROR, source: "used", seenAt: 2 } },
  };
  assert.deepEqual(knownRoomHosts(all, VTA), {
    a: { host: MIRROR, source: "used" },
    b: { host: COMMUNITY, source: "community" },
  });
});

test("another agent's record, and anything this wallet could not have written, are ignored", () => {
  const all = {
    [roomHostsKey("did:webvh:QmOther:other.example")]: { a: { host: MIRROR, source: "used", seenAt: 1 } },
    [roomHostsKey(VTA)]: {
      b: { host: "https://not-a-did.example", source: "used", seenAt: 1 },
      c: { host: MIRROR, source: "community", seenAt: 1 },
      d: { host: MIRROR, source: "created" },
      e: { host: MIRROR, source: "created", seenAt: 3 },
    },
  };
  assert.deepEqual(knownRoomHosts(all, VTA), { e: { host: MIRROR, source: "created" } });
});

test("the record keeps the most recently seen rooms past its cap", () => {
  let stored: unknown = {};
  for (let i = 0; i <= ROOM_HOSTS_MAX; i++) stored = withRoomHost(stored, `room-${i}`, MIRROR, "used", i);
  const kept = Object.keys(stored as object);
  assert.equal(kept.length, ROOM_HOSTS_MAX);
  assert.ok(!kept.includes("room-0"), "the oldest goes");
  assert.ok(kept.includes(`room-${ROOM_HOSTS_MAX}`), "the newest stays");
});

const place = (roomId: string, member: string, context: string | undefined, earliest = 1) => ({
  roomId,
  member,
  epoch: 5,
  earliestReadableEpoch: earliest,
  ...(context !== undefined ? { context } : {}),
});

test("one entry per room, in the order the agent listed them", () => {
  const entries = roomEntries([place("a", "m1", "x"), place("b", "m1", "x"), place("a", "m2", "y")]);
  assert.deepEqual(entries.map((e) => [e.roomId, e.places.map((p) => p.member)]), [
    ["a", ["m1", "m2"]],
    ["b", ["m1"]],
  ]);
});

test("a card's history is its most readable place", () => {
  const [entry] = roomEntries([place("a", "m1", "x", 5), place("a", "m2", "y", 2)]);
  assert.equal(mostReadable(entry!).member, "m2");
});

test("by host, every room is under exactly one group, the unknown ones last", () => {
  const entries = roomEntries([place("a", "m", "x"), place("b", "m", "x"), place("c", "m", "x")]);
  const groups = groupRooms(entries, { a: { host: COMMUNITY, source: "community" }, c: { host: COMMUNITY, source: "used" } }, "host");
  assert.deepEqual(groups.map((g) => [g.kind, g.entries.map((e) => e.roomId)]), [
    ["host", ["a", "c"]],
    ["unknown", ["b"]],
  ]);
  const first = groups[0]!;
  assert.equal(first.kind === "host" && first.host.source, "community", "a community's name for its host wins");
});

test("by context, each place is under its own context, unreported ones last", () => {
  const entries = roomEntries([place("a", "m1", "x"), place("a", "m2", "y"), place("b", "m1", undefined)]);
  const groups = groupRooms(entries, {}, "context");
  assert.deepEqual(groups.map((g) => [g.key, g.entries.map((e) => `${e.roomId}:${e.places.map((p) => p.member).join(",")}`)]), [
    ["context:x", ["a:m1"]],
    ["context:y", ["a:m2"]],
    ["context:", ["b:m1"]],
  ]);
});
