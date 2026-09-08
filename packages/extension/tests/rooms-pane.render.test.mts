// The rooms pane, rendered.
//
// The whole screen turns on one thing being said out loud, and it is the thing
// a type checker cannot see: **a member who can read less than they expected
// needs to know WHICH of two unrelated failures they are looking at.**
//
// `epoch` behind the room's own means a commit was not delivered. `earliest`
// equal to `epoch` means the epoch key chain has not arrived. The repairs are
// different, and a pane that renders both as "you can't read this" tells a
// member their history was lost when it is sitting on a host waiting to be
// fetched. So each of the three standings is asserted against the words on
// screen rather than against `standing()`, which is a pure function and would
// pass while the pane drew none of it.
//
// The second thing asserted here is a refusal: this list is key custody, and
// the pane must never present it as membership or as permission to write.

import { test } from "node:test";
import assert from "node:assert/strict";
import { agent, h, render, PARTIES } from "./harness/dom.mjs";
import { RoomsPane } from "../src/manager/panes/rooms.js";

const LIST = "rooms/keys/list/0.1";

const room = (roomId: string, epoch: number, earliestReadableEpoch: number) => ({
  roomId,
  epoch,
  earliestReadableEpoch,
});

const mount = async (rooms: unknown[]) => {
  const a = agent({ [LIST]: { rooms } });
  const screen = await render(h(RoomsPane, { parties: PARTIES } as never), {
    chrome: { runtime: { sendMessage: a.sendMessage } },
  });
  return { a, screen };
};

// ── The three standings ─────────────────────────────────────────────────────

test("a chain walked to the room's first epoch reads as the whole history", async () => {
  const { screen } = await mount([room("did:webvh:example.com:rooms:northwind", 7, 1)]);
  assert.match(screen.text(), /whole history/);
  assert.match(screen.text(), /Every record this room retains can be opened/);
});

// The case a member misreads as loss. Nothing is missing — a delivery has not
// happened — so the words have to name the delivery.
test("no chain at all says the history is undelivered, not gone", async () => {
  const { screen } = await mount([room("did:webvh:example.com:rooms:northwind", 7, 7)]);
  assert.match(screen.text(), /from joining/);
  assert.match(screen.text(), /has not been delivered/);
});

// Partly delivered is its own answer and must not round to either neighbour:
// rounding up promises history the member cannot read, rounding down hides
// history they can.
test("a partial chain names the epoch the walk stopped at", async () => {
  const { screen } = await mount([room("did:webvh:example.com:rooms:northwind", 7, 4)]);
  assert.match(screen.text(), /back to epoch 4/);
  assert.doesNotMatch(screen.text(), /whole history/);
});

test("the three standings are distinguishable on one screen", async () => {
  const { screen } = await mount([
    room("did:webvh:example.com:rooms:a", 7, 1),
    room("did:webvh:example.com:rooms:b", 7, 7),
    room("did:webvh:example.com:rooms:c", 7, 4),
  ]);
  const text = screen.text();
  for (const label of ["whole history", "from joining", "back to epoch 4"]) {
    assert.match(text, new RegExp(label), `${label} is missing — three rooms, three answers`);
  }
});

// ── Custody is not membership ───────────────────────────────────────────────

// The pane's central refusal. A room listed here may still refuse a write, and
// a room the principal belongs to may not be listed at all; a screen that
// implies otherwise is telling the member they have authority the host will not
// honour, which they find out at the point of use.
test("the screen says custody is not permission, and not membership", async () => {
  const { screen } = await mount([room("did:webvh:example.com:rooms:northwind", 3, 1)]);
  const text = screen.text();
  assert.match(text, /Holding keys is not permission to act/);
  assert.match(text, /credentials the room issued/);
  assert.match(text, /Welcome never arrived/);
});

// An empty list is ambiguous in a way that matters: it is what "no rooms" and
// "invited, not yet joined" both look like. Saying only "none" invites the
// member to conclude the invitation failed.
test("an empty list says what else it could mean", async () => {
  const { screen } = await mount([]);
  assert.match(screen.text(), /before an invitation has been accepted/);
});

// ── It asks the member's own VTA, and asks it once ──────────────────────────

// `rooms/keys/*` terminates at the member's own key holder; the room's host
// serves everything else and must never see this. A pane that sent it to the
// host would be asking a party that cannot answer to enumerate the member's
// rooms.
test("the listing goes to the agent, with no other task alongside it", async () => {
  const { a } = await mount([room("did:webvh:example.com:rooms:northwind", 2, 1)]);
  assert.equal(a.calls.length, 1, `expected one call, got: ${a.calls.map((c) => c.type).join(", ")}`);
  assert.match(a.calls[0]!.type, /rooms\/keys\/list\/0\.1$/);
});

// A failed listing must not render as an empty one — "this agent holds keys to
// no rooms" is a claim, and an agent that did not answer has made none.
test("a listing that failed is not drawn as a listing that was empty", async () => {
  const screen = await render(h(RoomsPane, { parties: PARTIES } as never), {
    chrome: { runtime: { sendMessage: async () => ({ ok: false, error: "agent unreachable" }) } },
  });
  assert.doesNotMatch(screen.text(), /before an invitation has been accepted/);
});
