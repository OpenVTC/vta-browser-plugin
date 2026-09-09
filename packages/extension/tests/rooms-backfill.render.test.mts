// Fetching a room's history, rendered.
//
// One call now, so the interesting tests are no longer about ordering hops —
// the agent does those. What is left is the thing a screen can still get wrong:
// **reporting the wrong number.**
//
// The response carries three, and they come apart. Counting what was delivered
// would say "12 rungs stored" over a room that still cannot read a word of its
// history, because rungs below a gap extend reach not at all. Only
// `earliestReadableEpoch` answers the question, and these pin that it is the one
// the screen reads.

import { test } from "node:test";
import assert from "node:assert/strict";
import { agent, h, render, PARTIES } from "./harness/dom.mjs";
import { FetchHistory } from "../src/manager/panes/rooms-backfill.js";

const BACKFILL = "rooms/keys/backfill/0.1";
const HOST = "did:webvh:QmHost:host.example";
const ROOM = "did:webvh:QmRoom:rooms.example";

const room = (epoch: number, earliestReadableEpoch: number) => ({
  roomId: ROOM,
  epoch,
  earliestReadableEpoch,
});

const mount = async (answer: unknown, r = room(7, 7)) => {
  const a = agent({ [BACKFILL]: answer });
  const screen = await render(
    h(FetchHistory, { parties: PARTIES, room: r, onFetched: () => {} } as never),
    { chrome: { runtime: { sendMessage: a.sendMessage } } },
  );
  await screen.type(screen.all("input")[0]!, HOST);
  return { a, screen };
};

const run = async (screen: Awaited<ReturnType<typeof mount>>["screen"]) =>
  screen.click(screen.button("Fetch the history"));

// ── One call, to the agent ──────────────────────────────────────────────────

// The console cannot address a host at all — its bridge drops the recipient —
// so a repair that tried would land at an agent that does not serve it. This is
// the whole reason `rooms/keys/backfill` exists.
test("the repair is one call, and the host travels as a payload member", async () => {
  const { a, screen } = await mount({ roomId: ROOM, earliestReadableEpoch: 1, fetched: 2, stored: 2 });
  await run(screen);

  assert.equal(a.calls.length, 1);
  assert.match(a.calls[0]!.type, /rooms\/keys\/backfill\/0\.1$/);
  assert.equal((a.calls[0]!.payload as { host: string }).host, HOST);
});

// Asking for the whole chain again when the agent already reads most of it
// makes a host serve rungs that will all be discarded as already-held.
test("it asks only for what is missing", async () => {
  const { a, screen } = await mount(
    { roomId: ROOM, earliestReadableEpoch: 1, fetched: 3, stored: 3 },
    room(9, 4),
  );
  await run(screen);
  assert.equal((a.calls[0]!.payload as { fromEpoch: number }).fromEpoch, 3);
});

// A room already reading to its first epoch has nothing to ask for, and
// `fromEpoch: 0` is below the schema's minimum.
test("a room reading from epoch 1 never asks for epoch 0", async () => {
  const { a, screen } = await mount(
    { roomId: ROOM, earliestReadableEpoch: 1, fetched: 0, stored: 0 },
    room(5, 1),
  );
  await run(screen);
  assert.equal((a.calls[0]!.payload as { fromEpoch: number }).fromEpoch, 1);
});

// ── The three numbers, read together ────────────────────────────────────────

test("a walk to the first epoch says the whole history is readable", async () => {
  const { screen } = await mount({ roomId: ROOM, earliestReadableEpoch: 1, fetched: 5, stored: 5 });
  await run(screen);
  assert.match(screen.text(), /whole history is readable now/);
});

// The case that must not read as success.
test("rungs that did not extend the reach are reported as a gap, not a win", async () => {
  const { screen } = await mount({ roomId: ROOM, earliestReadableEpoch: 7, fetched: 12, stored: 12 });
  await run(screen);
  const text = screen.text();
  assert.match(text, /did not move/);
  assert.match(text, /gap in what the host served rather than history that is gone/);
  assert.doesNotMatch(text, /whole history is readable now/);
});

test("a partial walk names the epoch it reached", async () => {
  const { screen } = await mount({ roomId: ROOM, earliestReadableEpoch: 4, fetched: 3, stored: 3 });
  await run(screen);
  assert.match(screen.text(), /back to epoch 4/);
});

// Nothing served is an answer, not a failure — and it is a different answer
// from "rungs arrived and did not help", which is why `fetched` is read first.
test("a host with nothing to serve says so, without calling it a gap", async () => {
  const { screen } = await mount({ roomId: ROOM, earliestReadableEpoch: 7, fetched: 0, stored: 0 });
  await run(screen);
  const text = screen.text();
  assert.match(text, /served no rungs below what your agent already holds/);
  assert.doesNotMatch(text, /gap in what the host served/);
});

// `stored: 0` with rungs served is a retry that found everything already held —
// a success, and it must not be drawn as nothing having happened.
test("an already-delivered chain still reports the reach it achieved", async () => {
  const { screen } = await mount({ roomId: ROOM, earliestReadableEpoch: 1, fetched: 4, stored: 0 });
  await run(screen);
  assert.match(screen.text(), /whole history is readable now/);
});

// ── Failures and refusals ───────────────────────────────────────────────────

// The agent surfaces the host's own refusal — a room policy declining is not a
// broken network, and the words have to be the host's.
test("a host's refusal is shown as the host's words", async () => {
  const { screen } = await mount(() => {
    throw new Error("room host `did:webvh:QmHost:host.example` refused: notAMember: not a member");
  });
  await run(screen);
  assert.match(screen.text(), /refused: notAMember/);
});

test("nothing is asked until a host is named", async () => {
  const a = agent({});
  const screen = await render(
    h(FetchHistory, { parties: PARTIES, room: room(7, 7), onFetched: () => {} } as never),
    { chrome: { runtime: { sendMessage: a.sendMessage } } },
  );
  await screen.click(screen.button("Fetch the history"));
  assert.deepEqual(a.calls, []);
});

// The console never sees the credentials — the agent presents them — and the
// screen says so, because "where did my membership go" is the obvious question.
test("the screen says the credentials do not pass through it", async () => {
  const { screen } = await mount({ roomId: ROOM, earliestReadableEpoch: 1, fetched: 1, stored: 1 });
  assert.match(screen.text(), /do not pass through this console/);
});
