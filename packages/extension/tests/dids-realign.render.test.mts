// Realigning a DID's key records, from the console.
//
// The screen carries the whole diagnosis, which is what makes these rendered
// tests rather than tests of the client: nothing else on the DIDs pane tells an
// operator whether a DID needs this, so the preview *is* the answer — and a
// preview that renders the wrong one of the agent's three outcomes is a bug the
// type checker cannot see.
//
// The three the pane must keep apart:
//
//   1. nothing to change            — consistent, and says so
//   2. renames to make              — lists them, and says the key material is safe
//   3. a method with no key held    — the agent cannot finish the job, and must say so
//
// Folding (3) into (1) is the sharp one: both have an empty `moved`, and the
// reassuring reading is the wrong one.

import { test } from "node:test";
import assert from "node:assert/strict";
import { agent, h, render, PARTIES } from "./harness/dom.mjs";
import { DidsPane } from "../src/manager/panes/dids.js";

const LIST = "vta/webvh/dids/list/1.0";
const REALIGN = "vta/webvh/dids/realign-keys/1.0";
const SERVERS = "vta/webvh/servers/list/1.0";

const DID = "did:webvh:QmScid:example.com:rooms:northwind";

const didRecord = {
  did: DID,
  serverId: "prod",
  scid: "QmScid",
  contextId: "rooms",
  portable: false,
  logEntryCount: 1,
  preRotationCount: 0,
  createdAt: "2026-09-11T00:00:00Z",
  updatedAt: "2026-09-11T00:00:00Z",
};

const plan = (over: Record<string, unknown> = {}) => ({
  did: DID,
  moved: [],
  alreadyAligned: [],
  unmatched: [],
  nextFragmentId: 2,
  dryRun: true,
  ...over,
});

const TWO_MOVES = [
  { from: `${DID}#key-0`, to: `${DID}#key-1`, publicKey: "z6MkSigning" },
  { from: `${DID}#key-1`, to: `${DID}#key-2`, publicKey: "z6LSKeyAgreement" },
];

const mount = async (answers: Record<string, unknown>) => {
  const a = agent({
    [LIST]: { dids: [didRecord], total: 1 },
    [SERVERS]: { servers: [] },
    ...answers,
  });
  const screen = await render(
    h(DidsPane, { parties: PARTIES, authority: null, contextId: "rooms" } as never),
    { chrome: { runtime: { sendMessage: a.sendMessage } } },
  );
  return { a, screen };
};

/** Press Realign keys and let the dry run settle. */
const openPlan = async (screen: { button: (s: string) => Element; click: (e: Element) => Promise<void>; settle: () => Promise<void> }) => {
  await screen.click(screen.button("Realign keys"));
  await screen.settle();
};

test("the preview is a dry run, and it is what gets sent first", async () => {
  const { a, screen } = await mount({ [REALIGN]: plan({ moved: TWO_MOVES }) });
  await openPlan(screen);

  const calls = a.calls.filter((c: { type: string }) => c.type.endsWith(REALIGN));
  assert.equal(calls.length, 1, "the preview sent more than one call");
  assert.deepEqual(calls[0]!.payload, { did: DID, dryRun: true });
});

test("a plan lists every rename, and says the key material is untouched", async () => {
  const { screen } = await mount({ [REALIGN]: plan({ moved: TWO_MOVES }) });
  await openPlan(screen);

  const text = screen.text();
  assert.match(text, /2 keys would be renamed/);
  assert.match(text, /key material is untouched/);
  for (const m of TWO_MOVES) {
    assert.ok(text.includes(m.from), `${m.from} is not on screen`);
    assert.ok(text.includes(m.to), `${m.to} is not on screen`);
  }
});

test("an aligned DID says so rather than offering a change", async () => {
  const { screen } = await mount({ [REALIGN]: plan({ alreadyAligned: [`${DID}#key-1`] }) });
  await openPlan(screen);
  assert.match(screen.text(), /Nothing to change/);
});

// The one that matters. `moved: []` with an unmatched method is NOT "nothing to
// change" — it is an agent that cannot complete the repair, and the operator has
// to know which reading they are looking at.
test("a method the agent holds no key for is never drawn as nothing to do", async () => {
  const { screen } = await mount({ [REALIGN]: plan({ unmatched: [`${DID}#key-2`] }) });
  await openPlan(screen);

  const text = screen.text();
  assert.doesNotMatch(text, /Nothing to change/);
  assert.match(text, /holds no key for 1 of the methods/);
  assert.ok(text.includes(`${DID}#key-2`), "the method is not named");
});

test("confirming applies exactly what was shown, without the dry run", async () => {
  const { a, screen } = await mount({
    [REALIGN]: (payload: { dryRun?: boolean }) =>
      plan({ moved: TWO_MOVES, nextFragmentId: 3, dryRun: payload.dryRun === true }),
  });
  await openPlan(screen);
  await screen.click(screen.button("Realign keys"));
  await screen.settle();

  const calls = a.calls.filter((c: { type: string }) => c.type.endsWith(REALIGN));
  assert.equal(calls.length, 2);
  assert.deepEqual(calls[1]!.payload, { did: DID, dryRun: false });
});

// A repair drawn in danger overstates it, and `--w-danger` is one of three
// colours in this console that mean something. The words are the check a test
// can make: the destructive path asks what would be *destroyed*.
test("the repair is not dressed as a destruction", async () => {
  const { screen } = await mount({ [REALIGN]: plan({ moved: TWO_MOVES }) });
  await openPlan(screen);
  assert.doesNotMatch(screen.text(), /destroy/i);
  assert.doesNotMatch(screen.text(), /cannot be undone/i);
});
