// The records pane, rendered — and specifically the words a verdict produces.
//
// This is the part of the feature that is copy before it is code, and the part
// a type checker cannot see. The rule it has to explain — a client that catches
// a host **serves reads and refuses writes** — is one nobody would guess. A
// member shown a warning icon dismisses it; a member later refused a write with
// no explanation concludes their own agent is broken, and a detection the member
// attributes to the wrong party is worse than no detection.
//
// So every assertion here is against the words on screen rather than against
// the component's props: a pane that computed the right verdict and drew none of
// it would pass a test written the other way.

import { test } from "node:test";
import assert from "node:assert/strict";
import { agent, h, render, PARTIES } from "./harness/dom.mjs";
import { RoomRecords } from "../src/manager/panes/rooms-records.js";

const BROWSE = "rooms/keys/browse/0.1";
const READ = "rooms/keys/read/0.1";
const HOST = "did:webvh:QmHost:host.example";
const ROOM = "did:webvh:QmRoom:rooms.example";

const ROOMS_ROOM = { roomId: ROOM, epoch: 7, earliestReadableEpoch: 1 };

const head = (recordCount: number, headVersion = 412) => ({
  dataCommitment: "zQmbWqxBEKC3P8tqsKc98xmWNzrzDtRLMiMPL8wBuTGsMnR",
  recordCount,
  headVersion,
});

const record = (key: string, version = 412) => ({ key, version, status: "active" });

const mount = async (answers: Record<string, unknown>) => {
  const a = agent(answers);
  const screen = await render(
    h(RoomRecords, { parties: PARTIES, room: ROOMS_ROOM } as never),
    { chrome: { runtime: { sendMessage: a.sendMessage } } },
  );
  await screen.type(screen.all("input")[0]!, HOST);
  return { a, screen };
};

const browse = async (screen: Awaited<ReturnType<typeof mount>>["screen"]) =>
  screen.click(screen.button("List the records"));

// ── Caught, and said out loud ───────────────────────────────────────────────

// The case the whole mechanism exists for, and the one a member must not read
// as their own agent misbehaving.
test("two roots at one version names what was observed, and what happens next", async () => {
  const { screen } = await mount({
    [BROWSE]: {
      roomId: ROOM,
      records: [record("a")],
      complete: true,
      verification: { priorRoots: "conflict", count: "agrees", head: head(1) },
    },
  });
  await browse(screen);
  const text = screen.text();
  assert.match(text, /two different answers about this room/i);
  assert.match(text, /version 412/);
  // Both halves of the rule, because either alone misleads.
  assert.match(text, /Reading still works/i);
  assert.match(text, /Writing to this host will be refused/i);
});

// Caught with NO history at all — the count is what makes that possible, and it
// is the cheapest detection in the system.
test("a short listing is caught on a first reading, with no history to compare", async () => {
  const { screen } = await mount({
    [BROWSE]: {
      roomId: ROOM,
      records: [],
      complete: true,
      verification: { priorRoots: "noneHeld", count: "short", head: head(118) },
    },
  });
  await browse(screen);
  const text = screen.text();
  assert.match(text, /fewer records than it committed to/i);
  assert.match(text, /118/);
  assert.match(text, /Writing to this host will be refused/i);
});

// ── Not caught, and not overclaiming either ─────────────────────────────────

// The failure mode on the reassuring side: a verified trace says the record is
// under the root the host asserted, and NOTHING about whether that root is the
// room's. A host serving a private view traces every record in it perfectly.
test("a verified trace never stands alone as though it settled the question", async () => {
  const { screen } = await mount({
    [BROWSE]: {
      roomId: ROOM,
      records: [record("a")],
      complete: true,
      verification: { priorRoots: "notChecked", count: "agrees", head: head(1) },
    },
  });
  await browse(screen);
  const text = screen.text();
  assert.match(text, /different question/i);
  assert.match(text, /not keeping the history/i);
  assert.doesNotMatch(text, /two different answers/i);
});

// A host that keeps no tree makes no claim, and that is not a failure — but it
// is worth knowing, because a record it left out looks like a room that never
// held one.
test("a host that offers no tree is reported as making no claim, not as failing", async () => {
  const { screen } = await mount({
    [BROWSE]: {
      roomId: ROOM,
      records: [record("a")],
      complete: true,
      verification: { priorRoots: "noneHeld" },
    },
  });
  await browse(screen);
  const text = screen.text();
  assert.match(text, /keeps no record tree/i);
  assert.match(text, /would look exactly like a room that never held one/i);
  assert.doesNotMatch(text, /refused/i);
});

// ── Reading one record ──────────────────────────────────────────────────────

test("opening a record asks the agent, and the key never enters the console", async () => {
  const { a, screen } = await mount({
    [BROWSE]: {
      roomId: ROOM,
      records: [record("giXFLTGBdnnQJRoIsktuIg")],
      complete: true,
      verification: { priorRoots: "agree", count: "agrees", head: head(1) },
    },
    [READ]: {
      roomId: ROOM,
      key: "giXFLTGBdnnQJRoIsktuIg",
      version: 412,
      status: "active",
      // base64url of `{"title":"Pricing holds"}`
      plaintext: "eyJ0aXRsZSI6IlByaWNpbmcgaG9sZHMifQ",
      verification: { trace: "verified", priorRoots: "agree", head: head(1) },
    },
  });
  await browse(screen);
  await screen.click(screen.all("tr")[1]!);
  await screen.click(screen.button("Open this record"));

  assert.match(screen.text(), /Pricing holds/);
  // Every call went to this wallet's own agent. A host verb from here would be
  // dropped by the bridge and land somewhere that does not serve it.
  const types = a.calls.map((call: { type: string }) => call.type);
  assert.ok(types.every((ty: string) => ty.includes("/rooms/keys/")));
});

// A tombstone is an answer. A member told "no body" without being told why
// reads a retraction as a fault.
test("a retracted record says the body is gone rather than failing", async () => {
  const { screen } = await mount({
    [BROWSE]: {
      roomId: ROOM,
      records: [{ key: "gone", version: 500, status: "retracted" }],
      complete: true,
      verification: { priorRoots: "agree", count: "agrees", head: head(1, 500) },
    },
    [READ]: {
      roomId: ROOM,
      key: "gone",
      version: 500,
      status: "retracted",
      verification: { trace: "verified", priorRoots: "agree", head: head(1, 500) },
    },
  });
  await browse(screen);
  await screen.click(screen.all("tr")[1]!);
  await screen.click(screen.button("Open this record"));
  assert.match(screen.text(), /retracted — the body is gone/);
});
