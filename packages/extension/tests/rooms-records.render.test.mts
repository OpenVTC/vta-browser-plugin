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

// Every listing opens its newest records straight away, so a test about the
// listing's verdict still needs the agent to answer a read. A clean one.
const QUIET_READ = (p: { key: string }) => ({
  roomId: ROOM,
  key: p.key,
  version: 412,
  status: "active",
  plaintext: "eyJ0aXRsZSI6IlF1aWV0In0", // {"title":"Quiet"}
  verification: { trace: "verified", priorRoots: "agree", head: head(1) },
});

const mount = async (answers: Record<string, unknown>) => {
  const a = agent({ [READ]: QUIET_READ, ...answers });
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
  await screen.settle();

  // The newest records open as the list arrives: the title is the row's name.
  assert.match(screen.text(), /Pricing holds/);
  // Every call went to this wallet's own agent. A host verb from here would be
  // dropped by the bridge and land somewhere that does not serve it.
  const types = a.calls.map((call: { type: string }) => call.type);
  assert.ok(types.every((ty: string) => ty.includes("/rooms/keys/")));
});

// A tombstone is an answer. A member told "no body" without being told why
// reads a retraction as a fault.
test("a retracted record says the body is gone rather than failing", async () => {
  const { a, screen } = await mount({
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
  // A tombstone is not opened unasked — there is no body to read.
  assert.equal(a.of("keys/read").length, 0);
  await screen.click(screen.button("Retracted record"));
  await screen.settle();
  assert.match(screen.text(), /retracted — the body is gone/);
});

// ── The list ────────────────────────────────────────────────────────────────

const b64 = (o: unknown) => Buffer.from(JSON.stringify(o)).toString("base64url");

// Keys are opaque and the title is sealed with the body, so a closed record
// says nothing. The newest five open as the list arrives; the rest wait for a
// click rather than costing the agent a read each on every listing.
test("the newest five records open themselves, newest first, and the rest wait", async () => {
  const records = Array.from({ length: 7 }, (_, i) => record(`k${i + 1}`, i + 1));
  const { a, screen } = await mount({
    [BROWSE]: { roomId: ROOM, records, complete: true, verification: { priorRoots: "agree", count: "agrees", head: head(7, 7) } },
    [READ]: (p: { key: string }) => ({
      roomId: ROOM,
      key: p.key,
      version: Number(p.key.slice(1)),
      status: "active",
      plaintext: b64({ title: `Note ${p.key}` }),
      verification: { trace: "verified", priorRoots: "agree", head: head(7, 7) },
    }),
  });
  await browse(screen);
  await screen.settle();
  const read = a.of("keys/read").map((call: { payload: { key: string } }) => call.payload.key).sort();
  assert.deepEqual(read, ["k3", "k4", "k5", "k6", "k7"]);
  const text = screen.text();
  assert.ok(text.indexOf("Note k7") < text.indexOf("Note k3"), "newest first");
  assert.equal((text.match(/Not opened yet/g) ?? []).length, 2);
  assert.match(text, /Holds exactly the 7 records this host committed to/);
});

// A note is shown as what it says, not as the JSON it is signed as. The signed
// document stays one click away.
test("a note reads as its title and text, with the signed record folded", async () => {
  const { screen } = await mount({
    [BROWSE]: { roomId: ROOM, records: [record("n")], complete: true, verification: { priorRoots: "agree", count: "agrees", head: head(1) } },
    [READ]: {
      roomId: ROOM,
      key: "n",
      version: 412,
      status: "active",
      plaintext: b64({ title: "Mascot Name", body: "Settled on \"Trustie\"\n\nNot T-Bot", proof: { proofValue: "z4bj" } }),
      verification: { trace: "verified", priorRoots: "agree", head: head(1) },
    },
  });
  await browse(screen);
  await screen.settle();
  await screen.click(screen.button("Mascot Name"));
  const text = screen.text();
  assert.match(text, /Settled on "Trustie"/);
  assert.match(text, /In the set this host committed to/);
  const folded = screen.all("details pre").map((el) => el.textContent ?? "");
  assert.ok(folded.some((x) => x.includes("proofValue")), "the signed record is inside a fold");
});

// The one-line verdict is for the clean case only. A record whose path does not
// reach the root is said in full on the row, opened or not.
test("a record that fails its check says so in full without being expanded", async () => {
  const { screen } = await mount({
    [BROWSE]: { roomId: ROOM, records: [record("bad")], complete: true, verification: { priorRoots: "agree", count: "agrees", head: head(1) } },
    [READ]: {
      roomId: ROOM,
      key: "bad",
      version: 412,
      status: "active",
      plaintext: b64({ title: "Suspect" }),
      verification: { trace: "failed", priorRoots: "agree", head: head(1) },
    },
  });
  await browse(screen);
  await screen.settle();
  assert.match(screen.text(), /check failed/);
  assert.match(screen.text(), /does not reach the root it asserted/);
});
