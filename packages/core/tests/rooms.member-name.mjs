// A member's name in a room (`memberProfile`, rooms/_shared/0.3/member-profile,
// trust-tasks-tf #1035): the reader's rules, how an author is shown, and the
// writer's gate.
//
// Each test states one rule as the schema words it.

import { test } from "node:test";
import assert from "node:assert/strict";

import { base64url } from "@openvtc/vti-didcomm-js";

import {
  assembleRoomRecords,
  authorLabels,
  inertName,
  isNameWithdrawal,
  memberNameRefusal,
  memberNameWriteRefusal,
  readingFromCleartext,
  MEMBER_NAME_REWRITE_DISTANCE,
  memberNameRewriteDue,
  RecordWriteRefused,
  rewriteMemberNameAsMember,
  writeMemberNameAsMember,
} from "../dist/rooms/index.js";

const ALICE = "did:webvh:QmAlice:people.example:alice-room";
const BOB = "did:webvh:QmBob:people.example:bob-room";
const CAROL = "did:webvh:QmCarol:people.example:carol-room";
const NOW = Date.parse("2026-11-05T12:00:00Z");

/** A verified sealed body by `author`: a name record unless `content` says otherwise. */
function nameRec(key, title, author = ALICE, meta = {}, extra = {}) {
  const content = { author, kind: "memberProfile", title, hasFile: false, bodyVersion: meta.version ?? 1, members: ["kind", "title"], ...extra };
  return {
    key,
    version: meta.version ?? 1,
    status: meta.status ?? "active",
    updatedAt: meta.updatedAt ?? "2026-11-05T10:00:00Z",
    ...(meta.bodyStoredAt !== undefined ? { bodyStoredAt: meta.bodyStoredAt } : {}),
    ...(meta.createdBy !== undefined ? { createdBy: meta.createdBy } : {}),
    ...(meta.held !== undefined ? { held: meta.held } : {}),
    reading: { state: "read", content },
  };
}
const message = (key, body, author = ALICE, extra = {}) => ({
  key,
  version: 1,
  status: "active",
  updatedAt: "2026-11-05T09:00:00Z",
  reading: { state: "read", content: { author, kind: "message", body, hasFile: false, bodyVersion: 1, ...extra } },
});
const assemble = (inputs) => assembleRoomRecords(inputs, { now: NOW });

// ── Reading one, rule 1: never a note, a message or a reaction, never counted ──

test("rule 1: a name record is shown as no note, message or reaction, and counts in nothing", () => {
  const view = assemble([
    nameRec("n", "Alice"),
    message("m", "hello", BOB),
    message("reply", "to the name", BOB, { inReplyTo: { key: "n" } }),
    message("r", "👍", BOB, { kind: "reaction", inReplyTo: { key: "n" } }),
  ]);
  const shown = [...view.records, ...view.expired].map((r) => r.key);
  assert.ok(!shown.includes("n"), "not in the conversation or the library");
  assert.deepEqual(view.tombstones, []);
  assert.deepEqual(view.nameRecords, ["n"]);
  assert.equal(view.names[ALICE].name, "Alice");
  const reply = view.records.find((r) => r.key === "reply");
  assert.equal(reply.replyTo.available, false, "a reply to a name answers nothing a reader shows");
  assert.ok(view.records.every((r) => r.reactions.length === 0), "a reaction to a name counts nowhere");
});

test("rule 1: a name record that is refused, unreadable or retracted is still shown nowhere", () => {
  const view = assemble([
    { ...nameRec("bad", "x"), reading: { state: "refused", reason: "signature" }, listedKind: "memberProfile" },
    { ...nameRec("gone", "x"), reading: { state: "tombstone" }, status: "retracted", held: { version: 1, content: nameRec("gone", "Alice").reading.content }, version: 2 },
  ]);
  assert.deepEqual(view.records, []);
  assert.deepEqual(view.tombstones, [], "a retracted name is not a tombstone in the room either");
  assert.deepEqual(new Set(view.nameRecords), new Set(["bad", "gone"]));
  assert.equal(view.names[ALICE]?.name, undefined, "a retracted name names nobody");
});

// ── Rule 2: the current version the host stored most recently ────────────────

test("rule 2: of an author's name records, the one the host stored most recently wins — by bodyStoredAt, else updatedAt", () => {
  const view = assemble([
    nameRec("a", "Old", ALICE, { updatedAt: "2026-11-05T11:00:00Z", bodyStoredAt: "2026-11-01T00:00:00Z" }),
    nameRec("b", "New", ALICE, { updatedAt: "2026-11-02T00:00:00Z" }),
  ]);
  // `a` was curated later (updatedAt), but its body was stored first.
  assert.equal(view.names[ALICE].name, "New");
  assert.equal(view.names[ALICE].key, "b");
});

test("rule 2: an empty or white-space name withdraws it, and a withdrawal stored last leaves no name", () => {
  assert.ok(isNameWithdrawal(""));
  assert.ok(isNameWithdrawal(" 　\t"));
  assert.ok(!isNameWithdrawal(" a "));
  const view = assemble([
    nameRec("a", "Alice", ALICE, { bodyStoredAt: "2026-11-01T00:00:00Z" }),
    nameRec("a2", "  ", ALICE, { bodyStoredAt: "2026-11-03T00:00:00Z" }),
  ]);
  assert.equal(view.names[ALICE].name, undefined);
  assert.equal(view.names[ALICE].key, "a2", "the withdrawal is still the record a new name is written over");
});

test("rule 2: a version refused as a name gives no name, even over an earlier good one", () => {
  const view = assemble([
    nameRec("a", "Alice", ALICE, { bodyStoredAt: "2026-11-01T00:00:00Z" }),
    nameRec("b", "Alice", ALICE, { bodyStoredAt: "2026-11-02T00:00:00Z" }, { description: "not allowed", members: ["kind", "title", "description"] }),
  ]);
  assert.equal(view.names[ALICE].name, undefined);
  assert.match(view.names[ALICE].refused, /description/);
});

// ── Rule 3: a rewrite by another member names nobody ─────────────────────────

test("rule 2: a name record whose deciding version did not verify leaves its author no name", () => {
  const view = assemble([
    nameRec("a", "Alice", ALICE, { bodyStoredAt: "2026-11-01T00:00:00Z" }),
    { ...nameRec("b", "x", ALICE, { bodyStoredAt: "2026-11-02T00:00:00Z", createdBy: ALICE }), reading: { state: "refused", reason: "signature" }, listedKind: "memberProfile" },
  ]);
  assert.equal(view.names[ALICE].name, undefined);
  assert.equal(view.names[ALICE].key, "b");
});

test("rule 3: a version written over another member's record never names that member — it is the rewriter's claim", () => {
  const view = assemble([nameRec("n", "Mallory", BOB, { createdBy: ALICE })]);
  assert.equal(view.names[ALICE], undefined, "never the original author");
  assert.equal(view.names[BOB].name, "Mallory", "the rewriter's own claim about themselves (trust-tasks-tf #1038)");
  assert.deepEqual(view.records, [], "and it is still no note");
});

test("rule 3: against the version the reader held, where the host records no creator", () => {
  const held = { version: 1, content: nameRec("n", "Alice").reading.content };
  const view = assemble([nameRec("n", "Mallory", BOB, { version: 2, held })]);
  assert.equal(view.names[ALICE], undefined);
  assert.equal(view.names[BOB].name, "Mallory");
});

// ── Several records by one author (trust-tasks-tf #1038) ─────────────────────

test("several records: a rewrite of someone else's record is weighed by when it was stored, like the author's own", () => {
  const own = nameRec("bobs", "Bob", BOB, { bodyStoredAt: "2026-11-05T10:00:00Z" });
  const later = nameRec("alices", "Robert", BOB, { createdBy: ALICE, version: 4, bodyStoredAt: "2026-11-05T11:00:00Z" });
  const earlier = nameRec("alices", "Robert", BOB, { createdBy: ALICE, version: 4, bodyStoredAt: "2026-11-05T09:00:00Z" });
  assert.equal(assemble([own, later]).names[BOB].name, "Robert", "stored after the own record: it gives the name");
  assert.equal(assemble([own, earlier]).names[BOB].name, "Bob", "stored before: the own record gives the name");
});

test("several records: the name does not depend on the order the records were met", () => {
  const a = nameRec("one", "First", ALICE, { version: 2, bodyStoredAt: "2026-11-05T08:00:00Z" });
  const b = nameRec("two", "Second", ALICE, { version: 9, bodyStoredAt: "2026-11-05T10:00:00Z" });
  const c = nameRec("three", "Third", ALICE, { version: 5, bodyStoredAt: "2026-11-05T09:00:00Z" });
  const orders = [[a, b, c], [c, b, a], [b, a, c], [c, a, b]];
  for (const order of orders) {
    const got = assemble(order).names[ALICE];
    assert.equal(got.name, "Second", "the most recently stored, never the first met");
    assert.equal(got.key, "two");
  }
});

test("rule 2 tie-break: of two versions stored at the same time, the greater version wins, whichever comes first", () => {
  const at = "2026-11-05T10:00:00Z";
  const low = nameRec("x", "Lower", ALICE, { version: 3, bodyStoredAt: at });
  const high = nameRec("y", "Higher", ALICE, { version: 7, bodyStoredAt: at });
  assert.equal(assemble([low, high]).names[ALICE].name, "Higher");
  assert.equal(assemble([high, low]).names[ALICE].name, "Higher");
});

test("rule 2: the deciding version's writtenAt and editedAt are kept for a rewrite near the head", () => {
  const view = assemble([
    nameRec("n", "Alice", ALICE, { version: 3 }, { writtenAt: "2026-10-01T00:00:00Z", editedAt: "2026-10-02T00:00:00Z", members: ["kind", "title", "writtenAt", "editedAt"] }),
  ]);
  assert.equal(view.names[ALICE].writtenAt, "2026-10-01T00:00:00Z");
  assert.equal(view.names[ALICE].editedAt, "2026-10-02T00:00:00Z");
});

// ── Rule 4: only the record's author, only this room ─────────────────────────

test("rule 4: a name applies only to its record's author", () => {
  const view = assemble([nameRec("n", "Bob", BOB), message("m", "hi", ALICE)]);
  assert.deepEqual(Object.keys(view.names), [BOB]);
  const labels = authorLabels([ALICE, BOB], { roomNames: view.names });
  assert.deepEqual(labels.get(ALICE), { source: "did" });
  assert.deepEqual(labels.get(BOB), { source: "room", text: "Bob" });
});

test("rule 4: a name never reaches the same DID in another room", () => {
  const here = assemble([nameRec("n", "Alice")]);
  const there = assemble([message("m", "hi", ALICE)]);
  assert.equal(there.names[ALICE], undefined);
  assert.deepEqual(authorLabels([ALICE], { roomNames: there.names }).get(ALICE), { source: "did" });
  assert.equal(here.names[ALICE].name, "Alice");
});

// ── The record's shape ───────────────────────────────────────────────────────

test("shape: a name is one line of plain text, at most 64 code points as written and after NFC", () => {
  for (const good of ["Alice", "", "  ", "Zoë 🌿", "a".repeat(64), "名前", "é".repeat(32)]) {
    assert.equal(memberNameRefusal(good), undefined, JSON.stringify(good));
  }
  for (const bad of ["two\nlines", "tab\there", "nul\u0000", "del\u007f", "c1\u0085", "sep\u2028", "para\u2029", "a".repeat(65)]) {
    assert.ok(memberNameRefusal(bad), JSON.stringify(bad));
  }
});

test("shape: a sealed name carries no body; an open room's carries an empty one and nothing beyond its five members", () => {
  const sealedWithBody = assemble([nameRec("n", "Alice", ALICE, {}, { body: "", members: ["kind", "title", "body"] })]);
  assert.match(sealedWithBody.names[ALICE].refused, /body/);

  const open = (cleartext) => {
    const reading = readingFromCleartext(cleartext, ALICE, 1);
    return assemble([{ key: "n", version: 1, status: "active", updatedAt: "2026-11-05T10:00:00Z", reading }]);
  };
  assert.equal(open({ kind: "memberProfile", title: "Alice", body: "" }).names[ALICE].name, "Alice");
  assert.match(open({ kind: "memberProfile", title: "Alice", body: "hi" }).names[ALICE].refused, /empty body/);
  assert.match(open({ kind: "memberProfile", title: "Alice", body: "", pinned: true }).names[ALICE].refused, /pinned/);
  assert.match(open({ kind: "memberProfile", title: "Alice", body: "", tags: ["x"] }).names[ALICE].refused, /tags/);
  assert.match(open({ kind: "memberProfile", title: "a".repeat(65), body: "" }).names[ALICE].refused, /64/);
});

// ── Showing a name ───────────────────────────────────────────────────────────

test("showing: the reader's petname first, then the name in this room, then the DID", () => {
  const roomNames = assemble([nameRec("a", "Alice", ALICE), nameRec("b", "Bobby", BOB)]).names;
  const labels = authorLabels([ALICE, BOB, CAROL], { petnames: new Map([[BOB, "My Bob"]]), roomNames });
  assert.deepEqual(labels.get(BOB), { source: "petname", text: "My Bob" });
  assert.deepEqual(labels.get(ALICE), { source: "room", text: "Alice" });
  assert.deepEqual(labels.get(CAROL), { source: "did" });
});

test("showing: two authors whose names match after NFC and case folding are told apart", () => {
  const roomNames = assemble([nameRec("a", "Zoë", ALICE), nameRec("b", "ZOË", BOB), nameRec("c", "Carol", CAROL)]).names;
  const labels = authorLabels([ALICE, BOB, CAROL], { roomNames });
  assert.ok(labels.get(ALICE).fingerprint);
  assert.ok(labels.get(BOB).fingerprint);
  assert.notEqual(labels.get(ALICE).fingerprint, labels.get(BOB).fingerprint);
  assert.equal(labels.get(CAROL).fingerprint, undefined, "a name nobody else holds needs no fingerprint");
});

test("showing: two names that look the same — equal UTS #39 skeletons — are told apart", () => {
  // A Cyrillic а (U+0430) for a Latin a, and "rn" for "m".
  const roomNames = {
    [ALICE]: { key: "a", version: 1, name: "Alice" },
    [BOB]: { key: "b", version: 1, name: "\u0410lice" },
    [CAROL]: { key: "c", version: 1, name: "Pam" },
  };
  const labels = authorLabels([ALICE, BOB, CAROL], { roomNames });
  assert.ok(labels.get(ALICE).fingerprint, "the Latin one carries a fingerprint");
  assert.ok(labels.get(BOB).fingerprint, "and the Cyrillic one");
  assert.notEqual(labels.get(ALICE).fingerprint, labels.get(BOB).fingerprint);
  assert.equal(labels.get(BOB).text, "\u0410lice", "the name shown is the name, never its skeleton");
  assert.equal(labels.get(CAROL).fingerprint, undefined, "a name nobody else's looks like carries none");

  const rn = authorLabels([ALICE, BOB], { roomNames: { [ALICE]: { key: "a", version: 1, name: "Pam" }, [BOB]: { key: "b", version: 1, name: "Parn" } } });
  assert.ok(rn.get(ALICE).fingerprint && rn.get(BOB).fingerprint, "\"rn\" reads as \"m\"");
});

test("showing: a room name that looks like the reader's petname for another DID is told apart", () => {
  const labels = authorLabels([ALICE, BOB], {
    petnames: new Map([[ALICE, "Alice"]]),
    roomNames: { [BOB]: { key: "b", version: 1, name: "\u0410lice" } },
  });
  assert.ok(labels.get(BOB).fingerprint);
});

test("before a name is found: an author is the petname, else the DID — never a guessed name", () => {
  // Bob's name record has not been read yet (an older page): he is his DID.
  const view = assemble([message("m", "hi", BOB)]);
  const labels = authorLabels([BOB], { roomNames: view.names });
  assert.deepEqual(labels.get(BOB), { source: "did" });
  // A name from another room is not a name here.
  const elsewhere = assemble([nameRec("n", "Bob", BOB)]).names;
  assert.deepEqual(authorLabels([BOB], { roomNames: view.names }).get(BOB), { source: "did" });
  assert.equal(elsewhere[BOB].name, "Bob");
});

test("showing: a room name equal to the reader's petname for another DID is told apart", () => {
  const roomNames = assemble([nameRec("a", "bob", ALICE)]).names;
  const labels = authorLabels([ALICE, BOB], { petnames: new Map([[BOB, "Bob"]]), roomNames });
  assert.ok(labels.get(ALICE).fingerprint, "Alice cannot pass for the reader's Bob");
  assert.equal(labels.get(BOB).source, "petname");
});

test("showing: a name is text, with control and bidi characters removed", () => {
  assert.equal(inertName("‮ecilA‬ "), "ecilA");
  const roomNames = assemble([nameRec("a", "Al‎ice", ALICE)]).names;
  assert.equal(authorLabels([ALICE], { roomNames }).get(ALICE).text, "Alice");
});

// ── The writer's gate ────────────────────────────────────────────────────────

test("writer's gate: only a profile listing both `kind` and `memberProfile` permits a name", () => {
  assert.match(memberNameWriteRefusal(undefined), /lists none/);
  assert.match(memberNameWriteRefusal(["kind"]), /`memberProfile`/);
  assert.match(memberNameWriteRefusal(["memberProfile"]), /`kind`/);
  assert.equal(memberNameWriteRefusal(["writtenAt", "memberProfile", "kind"]), undefined);
});

const WALLET = { did: "did:key:zWallet" };
const VTA = "did:webvh:QmAgent:agent.example";
const HOST = "did:webvh:QmHost:host.example";
const ROOM = "did:webvh:QmRoom:rooms.example";

/** A room whose profile lists `recordMembers`, on a tier, with a VTA acting as ALICE. */
function room({ recordMembers, visibility = "attributed", head = 6 } = {}) {
  const vtaAsked = [];
  const sent = [];
  const sealed = [];
  let sealedFor = 0;
  const agent = {
    async send(envelope) {
      vtaAsked.push(envelope.type);
      if (envelope.type.includes("rooms/keys/profile/read/")) {
        return recordMembers === undefined
          ? { roomId: ROOM, status: "absent" }
          : { roomId: ROOM, status: "found", profile: { name: "R", recordMembers } };
      }
      if (envelope.type.includes("rooms/keys/seal/")) {
        sealedFor = envelope.payload.version;
        sealed.push(JSON.parse(new TextDecoder().decode(base64url.decode(envelope.payload.plaintext))));
        return { sealed: { ciphertext: "c", nonce: "n", epoch: 1 } };
      }
      const doc = structuredClone(envelope.payload.document);
      doc.issuer = ALICE;
      doc.proof = { type: "DataIntegrityProof" };
      return { principal: ALICE, document: doc };
    },
  };
  const host = {
    async sendCompleted(doc) {
      sent.push(doc);
      if (doc.type.includes("rooms/info/")) return { roomId: ROOM, visibility };
      if (doc.type.includes("rooms/records/list/")) return { roomId: ROOM, records: [], headVersion: head };
      if (doc.type.includes("rooms/records/put/")) return { key: doc.payload.key, version: visibility === "open" ? head + 1 : sealedFor };
      throw new Error(`unexpected ${doc.type}`);
    },
  };
  return {
    vtaAsked,
    sent,
    sealed,
    room: { roomId: ROOM, member: ALICE, holder: WALLET, vta: { did: VTA, sender: agent }, host: { did: HOST, sender: host } },
  };
}
const puts = (sent) => sent.filter((d) => d.type.includes("rooms/records/put/"));

test("writer's gate: a room whose profile does not list both is refused before anything is sealed or sent", async () => {
  for (const recordMembers of [undefined, ["kind"], ["memberProfile"]]) {
    const r = room({ recordMembers });
    await assert.rejects(writeMemberNameAsMember(r.room, { name: "Alice" }), (e) => e instanceof RecordWriteRefused && /recordMembers/.test(e.message));
    assert.deepEqual(r.sent, [], "nothing reached the host");
    assert.ok(!r.vtaAsked.some((t) => t.includes("seal")), "nothing was sealed");
  }
});

test("writer: a name that is not a MemberName is refused before the profile is even read", async () => {
  const r = room({ recordMembers: ["kind", "memberProfile"] });
  await assert.rejects(writeMemberNameAsMember(r.room, { name: "two\nlines" }), RecordWriteRefused);
  assert.deepEqual(r.vtaAsked, []);
});

test("writer: on a sealed tier the body is kind and title, no body, signed as the member; create-only", async () => {
  const r = room({ recordMembers: ["kind", "memberProfile"] });
  const out = await writeMemberNameAsMember(r.room, { name: "Alice" });
  assert.equal(out.principal, ALICE);
  const [body] = r.sealed;
  assert.deepEqual(
    Object.keys(body).sort(),
    ["author", "key", "kind", "roomId", "title", "version"],
  );
  assert.equal(body.kind, "memberProfile");
  assert.equal(body.title, "Alice");
  assert.equal(body.author, ALICE);
  assert.ok(r.vtaAsked.some((t) => t.endsWith("rooms/keys/seal/0.3")));
  assert.equal(puts(r.sent)[0].payload.expectedVersion, 0);
});

test("writer: a new name is a new version of the member's own record, never a second record", async () => {
  const r = room({ recordMembers: ["kind", "memberProfile", "writtenAt", "editedAt"] });
  const held = [
    { author: BOB, key: "bobs", version: 3 },
    { author: ALICE, key: "mine", version: 5 },
  ];
  const out = await writeMemberNameAsMember(r.room, { name: "", held, now: () => new Date("2026-11-05T12:00:00.123Z") });
  assert.equal(out.key, "mine");
  assert.equal(puts(r.sent)[0].payload.expectedVersion, 5);
  assert.equal(r.sealed[0].title, "", "an empty name withdraws it");
  assert.equal(r.sealed[0].writtenAt, "2026-11-05T12:00:00Z");
  assert.equal(r.sealed[0].editedAt, "2026-11-05T12:00:00Z");
});

test("writer: on an open room the cleartext of rooms/records/put/0.5 — kind, title, an empty body", async () => {
  const r = room({ recordMembers: ["kind", "memberProfile"], visibility: "open" });
  await writeMemberNameAsMember(r.room, { name: "Alice" });
  const [put] = puts(r.sent);
  assert.match(put.type, /^https:\/\/trusttasks\.org\/spec\/rooms\/records\/put\/0\.5(#request)?$/);
  assert.deepEqual(put.payload.cleartext, { kind: "memberProfile", title: "Alice", body: "" });
  assert.deepEqual(r.sealed, [], "nothing is sealed on an open room");
});

// ── Near the room's head (trust-tasks-tf #1038) ──────────────────────────────

test("near the head: a write more than 500 versions past the name record is due for a rewrite; 500 is not", () => {
  assert.equal(MEMBER_NAME_REWRITE_DISTANCE, 500);
  const own = { key: "mine", version: 100, name: "Alice" };
  assert.equal(memberNameRewriteDue(own, 600), false, "exactly 500 past");
  assert.equal(memberNameRewriteDue(own, 601), true);
  assert.equal(memberNameRewriteDue({ key: "mine", version: 100 }, 9000), false, "a withdrawn name is never written again");
  assert.equal(memberNameRewriteDue(undefined, 9000), false, "no name record held: nothing to write");
});

test("near the head: the rewrite is the same record, the same name, writtenAt kept and no new editedAt", async () => {
  const r = room({ recordMembers: ["kind", "memberProfile", "writtenAt", "editedAt"], head: 700 });
  const own = { key: "mine", version: 120, name: "Alice", writtenAt: "2026-09-01T00:00:00Z" };
  const version = await rewriteMemberNameAsMember(r.room, own, 701);
  assert.equal(typeof version, "number");
  const [body] = r.sealed;
  assert.equal(body.key, "mine", "the same key");
  assert.equal(body.title, "Alice", "the name rule 2 gives");
  assert.equal(body.kind, "memberProfile");
  assert.equal(body.writtenAt, "2026-09-01T00:00:00Z", "writtenAt unchanged");
  assert.equal(body.editedAt, undefined, "no new editedAt: the name has not changed");
  assert.equal(puts(r.sent)[0].payload.expectedVersion, 120, "over the version read, so a newer change on another device wins");
});

test("near the head: an earlier editedAt stays as it is", async () => {
  const r = room({ recordMembers: ["kind", "memberProfile", "writtenAt", "editedAt"], head: 900 });
  await rewriteMemberNameAsMember(r.room, { key: "mine", version: 10, name: "Al", writtenAt: "2026-09-01T00:00:00Z", editedAt: "2026-09-02T00:00:00Z" }, 900);
  assert.equal(r.sealed[0].editedAt, "2026-09-02T00:00:00Z");
});

test("near the head: on an open room the rewrite is cleartext with an empty body, replacing the version read", async () => {
  const r = room({ recordMembers: ["kind", "memberProfile"], visibility: "open", head: 800 });
  await rewriteMemberNameAsMember(r.room, { key: "mine", version: 200, name: "Alice" }, 801);
  const [put] = puts(r.sent);
  assert.deepEqual(put.payload.cleartext, { kind: "memberProfile", title: "Alice", body: "" });
  assert.equal(put.payload.key, "mine");
  assert.equal(put.payload.expectedVersion, 200);
});

test("near the head: nothing is written when the write is within 500, the name is withdrawn, or the room no longer takes names", async () => {
  const near = room({ recordMembers: ["kind", "memberProfile"] });
  assert.equal(await rewriteMemberNameAsMember(near.room, { key: "mine", version: 100, name: "Alice" }, 600), undefined);
  assert.deepEqual(near.vtaAsked, [], "not even the profile is read");

  const withdrawn = room({ recordMembers: ["kind", "memberProfile"] });
  assert.equal(await rewriteMemberNameAsMember(withdrawn.room, { key: "mine", version: 1, name: "  " }, 900), undefined);
  assert.deepEqual(withdrawn.sent, []);

  const closed = room({ recordMembers: ["kind"] });
  assert.equal(await rewriteMemberNameAsMember(closed.room, { key: "mine", version: 1, name: "Alice" }, 900), undefined);
  assert.deepEqual(puts(closed.sent), [], "the writer's gate holds for a rewrite too");
});

