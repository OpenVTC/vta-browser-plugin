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
import { signingIdentityFromSecret } from "@openvtc/pnm-core";
import { signRecordBody, type SealedRecordBody } from "@openvtc/pnm-core/rooms";

const BROWSE = "rooms/keys/browse/0.4";
const READ = "rooms/keys/read/0.2";
const HOST = "did:webvh:QmHost:host.example";
const ROOM = "did:webvh:QmRoom:rooms.example";

const ROOMS_ROOM = { roomId: ROOM, epoch: 7, earliestReadableEpoch: 1 };

const head = (recordCount: number, headVersion = 412) => ({
  dataCommitment: "zQmbWqxBEKC3P8tqsKc98xmWNzrzDtRLMiMPL8wBuTGsMnR",
  recordCount,
  headVersion,
});

const record = (key: string, version = 412) => ({ key, version, status: "active" });

// The author of every sealed body below, and someone who is not.
const AUTHOR = signingIdentityFromSecret(new Uint8Array(32).fill(5));
const OTHER = signingIdentityFromSecret(new Uint8Array(32).fill(6));

type Fields = Omit<SealedRecordBody, "roomId" | "key" | "version" | "author">;

/** A body signed by `by` for `key` at `version` in ROOM, as the agent returns it opened: base64url. */
const sealed = async (key: string, version: number, fields: Fields, by = AUTHOR) =>
  Buffer.from(
    await signRecordBody({ roomId: ROOM, key, version, author: by.did, ...fields }, by),
  ).toString("base64url");

// Every listing opens its newest records straight away, so a test about the
// listing's verdict still needs the agent to answer a read. A clean one.
const QUIET = await sealed("a", 412, { title: "Quiet" });
const QUIET_READ = (p: { key: string }) => ({
  roomId: ROOM,
  key: p.key,
  version: 412,
  status: "active",
  plaintext: QUIET,
  verification: { trace: "verified", priorRoots: "agree", head: head(1) },
});

/**
 * `rooms/keys/read/0.2` naming `keys`, from an answer for one key: one entry per
 * key, in order, with what a single read says in its `ext` said once, by key.
 */
const batch = (one: unknown) => (p: { keys: string[] }) => {
  const sealedAt: Record<string, number> = {};
  const results = p.keys.map((key) => {
    const a = (typeof one === "function" ? one({ key }) : one) as Record<string, unknown>;
    const { roomId: _r, ext, ...rest } = a;
    const at = (ext as { "org.openvtc.rooms"?: { sealedAt?: number } } | undefined)?.["org.openvtc.rooms"]?.sealedAt;
    if (at !== undefined) sealedAt[key] = at;
    return rest;
  });
  return {
    roomId: ROOM,
    results,
    ...(Object.keys(sealedAt).length > 0 ? { ext: { "org.openvtc.rooms": { sealedAt } } } : {}),
  };
};

const mount = async (answers: Record<string, unknown>) => {
  const a = agent({ ...answers, [READ]: batch(answers[READ] ?? QUIET_READ) });
  const screen = await render(
    h(RoomRecords, { parties: PARTIES, room: ROOMS_ROOM } as never),
    { chrome: { runtime: { sendMessage: a.sendMessage } } },
  );
  await screen.type(screen.all("input")[0]!, HOST);
  return { a, screen };
};

const browse = async (screen: Awaited<ReturnType<typeof mount>>["screen"]) =>
  screen.click(screen.button("List the records"));

/** Let the reads land and their bodies verify: a signature check is a few turns of the loop. */
const settled = async (screen: Awaited<ReturnType<typeof mount>>["screen"]) => {
  for (let i = 0; i < 20; i++) await screen.settle();
};

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
  await settled(screen);
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
  await settled(screen);
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
  await settled(screen);
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
  await settled(screen);
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
      plaintext: await sealed("giXFLTGBdnnQJRoIsktuIg", 412, { title: "Pricing holds" }),
      verification: { trace: "verified", priorRoots: "agree", head: head(1) },
    },
  });
  await browse(screen);
  await settled(screen);

  // The newest records open as the list arrives: the title is the row's name.
  assert.match(screen.text(), /Pricing holds/);
  // Every call went to this wallet's own agent. A host verb from here would be
  // dropped by the bridge and land somewhere that does not serve it.
  const types = a.calls.map((call: { type: string }) => call.type);
  assert.ok(types.every((ty: string) => ty.includes("/rooms/keys/")));
});

// A tombstone is an answer. A member told "no body" without being told why
// reads a retraction as a fault. One the reader held nothing of is shown in no
// conversation (`SealedRecordBody`, *Tombstones*): it is counted, not listed.
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
  await settled(screen);
  // A tombstone is not read — there is no body to read.
  assert.equal(a.of("keys/read").length, 0);
  assert.match(screen.text(), /1 record was retracted — the body is gone/);
  assert.doesNotMatch(screen.text(), /could not be/);
});

// ── The list ────────────────────────────────────────────────────────────────

const b64 = (o: unknown) => Buffer.from(JSON.stringify(o)).toString("base64url");

// Keys are opaque and the title is sealed with the body, so an unread record
// says nothing — and replies, reactions and the order of a conversation need
// every record. All are read, in batches of keys, and shown newest first.
test("every record is read in one batch, and shown newest first", async () => {
  const records = Array.from({ length: 7 }, (_, i) => record(`k${i + 1}`, i + 1));
  const bodies = Object.fromEntries(
    await Promise.all(records.map(async (r) => [r.key, await sealed(r.key, r.version, { title: `Note ${r.key}` })])),
  );
  const { a, screen } = await mount({
    [BROWSE]: { roomId: ROOM, records, complete: true, verification: { priorRoots: "agree", count: "agrees", head: head(7, 7) } },
    [READ]: (p: { key: string }) => ({
      roomId: ROOM,
      key: p.key,
      version: Number(p.key.slice(1)),
      status: "active",
      plaintext: bodies[p.key],
      verification: { trace: "verified", priorRoots: "agree", head: head(7, 7) },
    }),
  });
  await browse(screen);
  await settled(screen);
  const reads = a.of("keys/read");
  assert.equal(reads.length, 1, "one request");
  assert.deepEqual([...reads[0].payload.keys].sort(), records.map((r) => r.key).sort());
  const text = screen.text();
  assert.ok(text.indexOf("Note k7") < text.indexOf("Note k1"), "newest first");
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
      plaintext: await sealed("n", 412, { title: "Mascot Name", body: "Settled on \"Trustie\"\n\nNot T-Bot" }),
      verification: { trace: "verified", priorRoots: "agree", head: head(1) },
    },
  });
  await browse(screen);
  await settled(screen);
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
      plaintext: await sealed("bad", 412, { title: "Suspect" }),
      verification: { trace: "failed", priorRoots: "agree", head: head(1) },
    },
  });
  await browse(screen);
  await settled(screen);
  assert.match(screen.text(), /check failed/);
  assert.match(screen.text(), /does not reach the root it asserted/);
});

// A message is written as `body` alone (a chat-style client, Keyring from
// 277.8). It is named by its own first line, not listed as "Untitled record".
test("an untitled record is named by its first line, and previewed by the rest", async () => {
  const { screen } = await mount({
    [BROWSE]: { roomId: ROOM, records: [record("m")], complete: true, verification: { priorRoots: "agree", count: "agrees", head: head(1) } },
    [READ]: {
      roomId: ROOM,
      key: "m",
      version: 412,
      status: "active",
      plaintext: await sealed("m", 412, { body: "Lunch at one?\nBring the slides." }),
      verification: { trace: "verified", priorRoots: "agree", head: head(1) },
    },
  });
  await browse(screen);
  await settled(screen);
  const text = screen.text();
  assert.doesNotMatch(text, /Untitled record/);
  assert.ok(screen.button("Lunch at one?"), "the first line names the row");
  assert.match(text, /Bring the slides\./);
});

// A file record's `body` is its caption. It was never shown, so a photo's words
// were lost here.
test("a file record shows its caption", async () => {
  const { screen } = await mount({
    [BROWSE]: { roomId: ROOM, records: [record("f")], complete: true, verification: { priorRoots: "agree", count: "agrees", head: head(1) } },
    [READ]: {
      roomId: ROOM,
      key: "f",
      version: 412,
      status: "active",
      plaintext: await sealed("f", 412, {
        body: "The view from the venue",
        file: { name: "venue.png", size: 12, mediaType: "image/png", blobRef: "zQmBlob" } as never,
      }),
      verification: { trace: "verified", priorRoots: "agree", head: head(1) },
    },
  });
  await browse(screen);
  await settled(screen);
  assert.match(screen.text(), /The view from the venue/, "collapsed, as the row's preview");
  await screen.click(screen.button("venue.png"));
  assert.match(screen.text(), /The view from the venue/, "and expanded");
});

// ── The author's signature (`SealedRecordBody`, *Reading*) ──────────────────
//
// A sealed body is shown only once its author's proof, its signed location and,
// on an attributed room, the host's author all hold. One that fails shows none
// of its content — never the content with a warning — and "signed" is said only
// of one that passed. The host's listing verdict is a separate finding, worded
// apart.

const OK = { trace: "verified", priorRoots: "agree", head: head(1) };

/** One record listed and read, opened by a click; the screen's text and the rows' folds. */
async function readOne(
  row: { key: string; version: number; author?: string },
  read: Record<string, unknown>,
) {
  const { screen } = await mount({
    [BROWSE]: { roomId: ROOM, records: [{ ...row, status: "active" }], complete: true, verification: { priorRoots: "agree", count: "agrees", head: head(1) } },
    [READ]: { roomId: ROOM, key: row.key, version: row.version, status: "active", verification: OK, ...read },
  });
  await browse(screen);
  await settled(screen);
  const rowButton = screen.all("button").find((b) => b.getAttribute("aria-expanded") !== null);
  assert.ok(rowButton, "the record's row");
  await screen.click(rowButton);
  await settled(screen);
  return screen.text();
}

/** What a refused record must and must not say. */
function assertRefused(text: string, secret: RegExp) {
  assert.match(text, /could not be verified, so none of it is shown/);
  assert.match(text, /signature not verified/);
  assert.doesNotMatch(text, secret, "none of the body is shown");
  assert.doesNotMatch(text, /The signed record/);
  assert.doesNotMatch(text, /Signed by/);
}

test("a valid sealed record is shown as signed, by its signed author", async () => {
  const text = await readOne(
    { key: "v", version: 412, author: AUTHOR.did },
    { author: AUTHOR.did, plaintext: await sealed("v", 412, { title: "Budget", body: "Approved at 40k" }) },
  );
  assert.match(text, /Approved at 40k/);
  assert.match(text, /Signed by/);
  assert.ok(text.includes(AUTHOR.did.slice(0, 22)), "the signed author is named");
  assert.match(text, /The signed record/);
  // The host's verdict is still there, and still about the host.
  assert.match(text, /In the set this host committed to/);
});

test("a private room's record is signed by whoever its body names, once that verifies", async () => {
  const text = await readOne({ key: "p", version: 412 }, { plaintext: await sealed("p", 412, { body: "Private words" }) });
  assert.match(text, /Private words/);
  assert.match(text, /Signed by/);
  assert.ok(text.includes(AUTHOR.did.slice(0, 22)));
});

test("a body whose proof does not verify shows none of its content", async () => {
  const signed = JSON.parse(Buffer.from(await sealed("t", 412, { title: "Original", body: "Original text" }), "base64url").toString());
  signed.title = "Altered";
  signed.body = "Altered text";
  const text = await readOne({ key: "t", version: 412 }, { plaintext: Buffer.from(JSON.stringify(signed)).toString("base64url") });
  assertRefused(text, /Altered|Original/);
  assert.match(text, /author's signature does not verify/);
});

test("a body that carries no proof at all is refused", async () => {
  const text = await readOne({ key: "u", version: 412 }, { plaintext: b64({ roomId: ROOM, key: "u", version: 412, author: AUTHOR.did, title: "Unsigned" }) });
  assertRefused(text, /Unsigned/);
});

test("a host author that is not the signer fails the record", async () => {
  const text = await readOne(
    { key: "h", version: 412, author: OTHER.did },
    { author: OTHER.did, plaintext: await sealed("h", 412, { title: "Minutes", body: "Minutes text" }) },
  );
  assertRefused(text, /Minutes/);
  assert.match(text, /host names a different author/);
});

test("a listing author that is not the signer fails the record", async () => {
  const text = await readOne(
    { key: "l", version: 412, author: OTHER.did },
    { plaintext: await sealed("l", 412, { title: "Listed", body: "Listed text" }) },
  );
  assertRefused(text, /Listed text/);
  assert.match(text, /host names a different author/);
});

test("a body signed for another record is refused", async () => {
  const text = await readOne({ key: "here", version: 412 }, { plaintext: await sealed("elsewhere", 412, { title: "Moved", body: "Moved text" }) });
  assertRefused(text, /Moved/);
  assert.match(text, /signed for a different room, record or version/);
});

test("a body signed for another version is refused", async () => {
  const text = await readOne({ key: "w", version: 412 }, { plaintext: await sealed("w", 400, { title: "Older", body: "Older text" }) });
  assertRefused(text, /Older/);
});

test("a body signed for another room is refused", async () => {
  const signed = Buffer.from(
    await signRecordBody({ roomId: "did:webvh:QmOther:rooms.example", key: "r", version: 412, author: AUTHOR.did, title: "Foreign" }, AUTHOR),
  ).toString("base64url");
  const text = await readOne({ key: "r", version: 412 }, { plaintext: signed });
  assertRefused(text, /Foreign/);
});

// A curated record moves past the version its body was sealed at; the agent
// says where it opened (`ext["org.openvtc.rooms"].sealedAt`), and that is the
// location the signature is checked against.
test("a curated record verifies at the version its body was sealed at", async () => {
  const text = await readOne(
    { key: "c", version: 412 },
    { plaintext: await sealed("c", 300, { title: "Archived note", body: "Still readable" }), ext: { "org.openvtc.rooms": { sealedAt: 300 } } },
  );
  assert.match(text, /Still readable/);
  assert.match(text, /Signed by/);
});

// The provenance members are in the released schema: an honest record carrying
// them must read, not be refused as malformed.
test("a record carrying provenance members verifies and reads", async () => {
  const text = await readOne(
    { key: "pv", version: 412 },
    {
      plaintext: await sealed("pv", 412, {
        body: "Venue is booked",
        basis: "observed",
        confidence: 0.9,
        evidence: [{ kind: "record", key: "booking" }],
        validFor: { note: "planning only" },
        validUntil: "2099-01-01T00:00:00Z",
      }),
    },
  );
  assert.match(text, /Venue is booked/);
  assert.match(text, /Signed by/);
});

// ── The reading rules (`SealedRecordBody`, trust-tasks-tf #1027) ─────────────

/** A room of sealed records by AUTHOR, each `[key, fields]`, read and verified. */
async function room(entries: [string, Fields, Record<string, unknown>?][], extra: Record<string, unknown> = {}) {
  const bodies = Object.fromEntries(
    await Promise.all(entries.map(async ([key, fields]) => [key, await sealed(key, 412, fields)])),
  );
  const rows = entries.map(([key, , meta]) => ({ ...record(key), ...(meta ?? {}) }));
  const { a, screen } = await mount({
    [BROWSE]: { roomId: ROOM, records: rows, complete: true, verification: { priorRoots: "agree", count: "agrees", head: head(rows.length) } },
    [READ]: (p: { key: string }) => ({
      key: p.key,
      version: 412,
      status: "active",
      plaintext: bodies[p.key],
      verification: { trace: "verified", priorRoots: "agree", head: head(rows.length) },
    }),
    ...extra,
  });
  await browse(screen);
  await settled(screen);
  return { a, screen };
}

test("a reaction is shown beside its target, counted, and never as a record of its own", async () => {
  const { screen } = await room([
    ["m", { kind: "message", body: "Ship it?" }],
    ["r1", { kind: "reaction", inReplyTo: { key: "m" }, body: "\u{1F44D}" }],
    ["r2", { kind: "reaction", inReplyTo: { key: "m" }, body: "\u{1F44D}" }],
    ["r3", { kind: "reaction", inReplyTo: { key: "gone" }, body: "\u{1F389}" }],
  ]);
  const text = screen.text();
  assert.match(text, /Ship it\?/);
  // One author, one value, one target: counted once, however many records.
  assert.match(text, /\u{1F44D} 1/u);
  assert.doesNotMatch(text, /\u{1F389}/u, "no reaction whose target is not available");
  assert.equal(screen.all("button[aria-expanded]").length, 1, "the reactions are not rows");
});

test("a reply whose target is not available is shown, and says so", async () => {
  const { screen } = await room([["r", { kind: "message", body: "Agreed", inReplyTo: { key: "never-written" } }]]);
  const text = screen.text();
  assert.match(text, /Agreed/);
  assert.match(text, /In reply to a record that is not available/);
});

test("a reply names the record it answers", async () => {
  const { screen } = await room([
    ["q", { title: "Venue", body: "Where?" }],
    ["r", { kind: "message", body: "The hall", inReplyTo: { key: "q" } }],
  ]);
  assert.match(screen.text(), /In reply to Venue/);
});

test("a withdrawn message shows nothing of itself", async () => {
  const { screen } = await room([["w", { kind: "message", body: "" }]]);
  assert.match(screen.text(), /Withdrawn message/);
});

test("an edited message says it was edited", async () => {
  const { screen } = await room(
    [["e", { kind: "message", body: "Fixed", writtenAt: "2026-11-01T09:00:00Z", editedAt: "2026-11-01T09:10:00Z" }, { updatedAt: "2026-11-01T09:10:00Z", createdAt: "2026-11-01T09:00:00Z" }]],
  );
  assert.match(screen.text(), /edited/);
});

test("a message written more than a day before the room received it is shown as arriving later than it claims", async () => {
  const { screen } = await room([
    ["old", { kind: "message", body: "From the past", writtenAt: "2026-10-01T09:00:00Z" }, { createdAt: "2026-11-01T09:00:00Z" }],
  ]);
  assert.match(screen.text(), /later than the .* it claims/);
});

test("a record past its validUntil is hidden, and shown on request marked expired", async () => {
  const { screen } = await room([
    ["x", { title: "Old plan", body: "Stale", validUntil: "2020-01-01T00:00:00Z" }],
    ["y", { title: "Current plan", body: "Fresh" }],
  ]);
  assert.doesNotMatch(screen.text(), /Old plan/);
  assert.match(screen.text(), /1 record is past the time its author stood behind it/);
  await screen.click(screen.button("Show expired records"));
  await settled(screen);
  assert.match(screen.text(), /Old plan/);
  assert.match(screen.text(), /expired/);
});
