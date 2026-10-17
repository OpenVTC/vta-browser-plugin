// Your own name for a room (`rooms/keys/label`), rendered.
//
// What matters is what the form *sends*: only what the member changed, a field
// emptied as its removal, never a detail they did not touch — so a rename here
// does not overwrite notes written on another device — and always the row's own
// member, never one the console picked.

import { test } from "node:test";
import assert from "node:assert/strict";
import { agent, h, render, PARTIES } from "./harness/dom.mjs";
import { RoomLabel, forgetEdit, labelEdit, tagsOf } from "../src/manager/panes/rooms-label.js";

const LABEL = "rooms/keys/label/0.1";
const ROOM = "did:webvh:QmRoom:rooms.example";
const MEMBER = "did:key:z6MkMember";

const held = (personal?: Record<string, unknown>) => ({
  roomId: ROOM,
  member: MEMBER,
  epoch: 3,
  earliestReadableEpoch: 1,
  ...(personal ? { personal } : {}),
});

const mount = async (room: unknown, answer: unknown = { roomId: ROOM, member: MEMBER, changed: true }) => {
  const a = agent({ [LABEL]: answer });
  let saved = 0;
  const screen = await render(h(RoomLabel, { parties: PARTIES, room, onSaved: () => saved++ } as never), {
    chrome: { runtime: { sendMessage: a.sendMessage } },
  });
  return { a, screen, saved: () => saved };
};

const input = (screen: Awaited<ReturnType<typeof mount>>["screen"], name: string) => {
  const el = screen.all(`[aria-label="${name}"]`)[0];
  if (!el) throw new Error(`no field ${name}`);
  return el;
};

test("naming a room sends the name, for the row's member, and nothing else", async () => {
  const { a, screen, saved } = await mount(held(), {
    roomId: ROOM,
    member: MEMBER,
    personal: { label: "Northwind", updatedAt: "2026-10-16T09:00:00Z" },
    changed: true,
  });
  await screen.type(input(screen, "NAME"), "  Northwind ");
  await screen.click(screen.button("Save my label"));
  assert.equal(a.calls.length, 1);
  assert.deepEqual(a.calls[0]!.payload, { roomId: ROOM, member: MEMBER, label: "Northwind" });
  assert.match(screen.text(), /Saved — for you alone/);
  assert.equal(saved(), 1, "the list is read again");
});

test("an emptied field is its removal, and an untouched one is not sent", async () => {
  const { a, screen } = await mount(
    held({ label: "Northwind", notes: "From the laptop", tags: ["work"], updatedAt: "2026-10-16T09:00:00Z" }),
  );
  await screen.type(input(screen, "NAME"), "");
  await screen.click(screen.button("Save my label"));
  assert.deepEqual(a.calls[0]!.payload, { roomId: ROOM, member: MEMBER, removeLabel: true });
});

test("nothing changed is nothing sent", async () => {
  const { a, screen } = await mount(held({ label: "Northwind", updatedAt: "2026-10-16T09:00:00Z" }));
  await screen.click(screen.button("Save my label"));
  assert.equal(a.calls.length, 0);
  assert.match(screen.text(), /Nothing to change/);
});

test("forgetting removes every detail the label holds", async () => {
  const { a, screen } = await mount(held({ label: "N", tags: ["t"], updatedAt: "2026-10-16T09:00:00Z" }), {
    roomId: ROOM,
    member: MEMBER,
    changed: true,
  });
  await screen.click(screen.button("Forget my label"));
  assert.deepEqual(a.calls[0]!.payload, { roomId: ROOM, member: MEMBER, removeLabel: true, removeTags: true });
  assert.match(screen.text(), /Your label is removed/);
});

test("labelEdit: trimmed, tags as a set, emptied as removal", () => {
  const current = { label: "A", description: "D", tags: ["x", "y"], updatedAt: "2026-01-01T00:00:00Z" };
  assert.equal(labelEdit(current, { label: " A ", description: "D", notes: "", tags: "y, x" }), null);
  assert.deepEqual(labelEdit(current, { label: "B", description: "", notes: "n", tags: "x" }), {
    label: "B",
    removeDescription: true,
    notes: "n",
    tags: ["x"],
  });
  assert.deepEqual(labelEdit(current, { label: "A", description: "D", notes: "", tags: " , " }), { removeTags: true });
  assert.deepEqual(tagsOf("a, b,,a , c"), ["a", "b", "c"]);
  assert.equal(forgetEdit(undefined), null);
});
