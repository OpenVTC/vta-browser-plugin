// The reading rules for a room's records (`SealedRecordBody`, rooms/_shared/0.2,
// trust-tasks-tf #1027): kind, replies, reactions, withdrawn messages,
// tombstones, `writtenAt`, `editedAt` and `validUntil`.
//
// Each test states one rule as the specification words it, against the pure
// assembly every surface shares.

import { test } from "node:test";
import assert from "node:assert/strict";

import {
  assembleRoomRecords,
  normaliseReactionValue,
  reactionValue,
  readingFromCleartext,
  shownKind,
} from "../dist/rooms/index.js";

const ALICE = "did:key:zAlice";
const BOB = "did:key:zBob";
const CAROL = "did:key:zCarol";
const NOW = Date.parse("2026-11-05T12:00:00Z");

/** One record that read and verified: `content` over a message by ALICE. */
function rec(key, content = {}, meta = {}) {
  return {
    key,
    version: meta.version ?? 1,
    status: meta.status ?? "active",
    updatedAt: meta.updatedAt ?? "2026-11-05T10:00:00Z",
    ...(meta.createdAt !== undefined ? { createdAt: meta.createdAt } : {}),
    ...(meta.createdBy !== undefined ? { createdBy: meta.createdBy } : {}),
    ...(meta.held !== undefined ? { held: meta.held } : {}),
    reading: {
      state: "read",
      content: { author: ALICE, hasFile: false, bodyVersion: meta.version ?? 1, ...content },
    },
  };
}
const reaction = (key, target, value, author = ALICE, meta = {}) =>
  rec(key, { kind: "reaction", inReplyTo: { key: target }, body: value, author }, meta);
const assemble = (inputs) => assembleRoomRecords(inputs, { now: NOW });
const find = (view, key) => view.records.find((r) => r.key === key);

// ── Kind ────────────────────────────────────────────────────────────────────

test("kind: absent is a note, an unknown kind is shown as a note and never refused", () => {
  assert.equal(shownKind({ title: "Plan" }), "note");
  assert.equal(shownKind({ kind: "note", title: "Plan" }), "note");
  assert.equal(shownKind({ kind: "poll", title: "Lunch?" }), "note");
  assert.equal(shownKind({ kind: "poll" }), "note", "an unknown kind is a note even untitled");
  const view = assemble([rec("p", { kind: "poll", body: "?" })]);
  assert.equal(find(view, "p").shown, "note");
});

test("kind: a message is a message, and an untitled record without a kind joins the conversation", () => {
  const view = assemble([rec("m", { kind: "message", body: "hi" }), rec("u", { body: "lunch?" }), rec("n", { title: "T", body: "x" })]);
  assert.equal(find(view, "m").shown, "message");
  assert.equal(find(view, "u").shown, "message");
  assert.equal(find(view, "n").shown, "note");
});

test("kind: a new version that changes the kind of the version held is refused, alone", () => {
  const held = { version: 1, content: { author: ALICE, kind: "message", body: "hi", hasFile: false, bodyVersion: 1 } };
  const view = assemble([
    rec("m", { kind: "reaction", inReplyTo: { key: "o" }, body: "👍" }, { version: 2, held }),
    rec("o", { kind: "message", body: "other" }),
  ]);
  assert.equal(find(view, "m"), undefined);
  assert.ok(view.ignored.some((i) => i.key === "m" && /kind/.test(i.reason)));
  assert.ok(find(view, "o"), "the room's other records stand");
  assert.deepEqual(find(view, "o").reactions, [], "and the rewrite counts as no reaction");
});

// ── Replies ─────────────────────────────────────────────────────────────────

test("replies: a reply to a record the reader can show names it as available", () => {
  const view = assemble([rec("a", { kind: "message", body: "q" }), rec("b", { kind: "message", body: "a", inReplyTo: { key: "a" } })]);
  assert.deepEqual(find(view, "b").replyTo, { key: "a", available: true });
});

test("replies: a reply whose target is not available is still shown, marked as such", () => {
  const cases = {
    "never written": [],
    withdrawn: [rec("t", { kind: "message", body: "" })],
    retracted: [{ key: "t", version: 2, status: "retracted", reading: { state: "tombstone" } }],
    expired: [rec("t", { title: "Old", body: "x", validUntil: "2026-01-01T00:00:00Z" })],
    refused: [{ key: "t", version: 1, reading: { state: "refused", reason: "bad signature" } }],
    unverifiable: [{ key: "t", version: 1, reading: { state: "placeholder", reason: "author cannot be verified" } }],
    unopened: [{ key: "t", version: 1, reading: { state: "unreadable", reason: "cannotOpen" } }],
  };
  for (const [why, target] of Object.entries(cases)) {
    const view = assemble([...target, rec("r", { kind: "message", body: "agreed", inReplyTo: { key: "t" } })]);
    const reply = find(view, "r");
    assert.ok(reply, `the reply is shown when its target is ${why}`);
    assert.equal(reply.replyTo.available, false, why);
    assert.equal(reply.content.body, "agreed");
  }
});

test("replies: a target edited after the reply was written is said to have changed — never because its version moved", () => {
  const target = rec("t", { kind: "message", body: "v2", editedAt: "2026-11-05T09:00:00Z", bodyVersion: 5 }, { version: 7 });
  const reply = (version) =>
    rec("r", { kind: "message", body: "ok", writtenAt: "2026-11-05T08:00:00Z", inReplyTo: { key: "t", version } });
  assert.equal(find(assemble([target, reply(3)]), "r").replyTo.changed, "edited");
  // The body was written at the version named: unchanged, however far curation moved the record.
  assert.equal(find(assemble([target, reply(5)]), "r").replyTo.changed, undefined);
  // Curated, never edited: unchanged.
  const curated = rec("t", { kind: "message", body: "v1", bodyVersion: 3 }, { version: 9 });
  assert.equal(find(assemble([curated, reply(3)]), "r").replyTo.changed, undefined);
});

test("nothing answers a reaction: a record naming one is shown nowhere and counts as no reaction", () => {
  const view = assemble([
    rec("m", { kind: "message", body: "hello" }),
    reaction("x", "m", "👍", BOB),
    rec("r", { kind: "message", body: "why?", inReplyTo: { key: "x" } }),
    reaction("rr", "x", "😂", CAROL),
  ]);
  assert.equal(find(view, "r"), undefined);
  assert.ok(view.ignored.some((i) => i.key === "r"));
  assert.ok(view.ignored.some((i) => i.key === "rr"));
  assert.deepEqual(find(view, "m").reactions.map((r) => [r.value, r.count]), [["👍", 1]]);
});

// ── Reactions ───────────────────────────────────────────────────────────────

test("reactions: shown beside their target, never as a note or a message", () => {
  const view = assemble([rec("m", { kind: "message", body: "hi" }), reaction("x", "m", "👍", BOB)]);
  assert.equal(find(view, "x"), undefined);
  assert.deepEqual(find(view, "m").reactions, [{ value: "👍", normalised: "👍", count: 1, authors: [BOB] }]);
});

test("reactions: a value is NFC with VS15/VS16 removed, so \u2764 and \u2764\uFE0F are one", () => {
  assert.equal(normaliseReactionValue("\u2764\uFE0F"), "\u2764");
  assert.equal(normaliseReactionValue("\u2764\uFE0E"), "\u2764");
  assert.equal(normaliseReactionValue("e\u0301"), "\u00E9");
  const view = assemble([
    rec("m", { kind: "message", body: "hi" }),
    reaction("x1", "m", "\u2764\uFE0F", BOB),
    reaction("x2", "m", "\u2764", CAROL),
    reaction("x3", "m", "cafe\u0301", BOB),
    reaction("x4", "m", "caf\u00E9", CAROL),
  ]);
  const counts = Object.fromEntries(find(view, "m").reactions.map((r) => [r.normalised, r.count]));
  assert.deepEqual(counts, { "\u2764": 2, "caf\u00E9": 2 });
});

test("reactions: at most 64 code points after normalisation, on one line", () => {
  assert.equal(reactionValue("x".repeat(64)).kind, "value");
  assert.equal(reactionValue("x".repeat(65)).kind, "invalid");
  // 64 emoji with VS16 are 128 code points as written and 64 once normalised.
  assert.equal(reactionValue("\u2764\uFE0F".repeat(64)).kind, "value");
  assert.equal(reactionValue("😀".repeat(64)).kind, "value", "code points, not UTF-16 units");
  for (const lt of ["\n", "\u000B", "\u000C", "\r", "\u0085", "\u2028", "\u2029"]) {
    assert.equal(reactionValue(`a${lt}b`).kind, "invalid", JSON.stringify(lt));
  }
  const view = assemble([rec("m", { kind: "message", body: "hi" }), reaction("long", "m", "x".repeat(65), BOB), reaction("nl", "m", "a\nb", BOB)]);
  assert.deepEqual(find(view, "m").reactions, []);
  assert.ok(view.ignored.some((i) => i.key === "long") && view.ignored.some((i) => i.key === "nl"));
});

test("reactions: one per author, value and target, however many records carry it", () => {
  const view = assemble([
    rec("m", { kind: "message", body: "hi" }),
    reaction("a", "m", "👍", BOB),
    reaction("b", "m", "👍", BOB),
    reaction("c", "m", "🎉", BOB),
    reaction("d", "m", "👍", CAROL),
  ]);
  const counts = find(view, "m").reactions.map((r) => [r.value, r.count]);
  assert.deepEqual(counts, [["👍", 2], ["🎉", 1]], "one author's different values are different reactions");
});

test("reactions: an empty or white-space value withdraws; a new value changes the author's reaction", () => {
  assert.equal(reactionValue("").kind, "empty");
  assert.equal(reactionValue(" \u3000\t").kind, "empty");
  const held = (value) => ({ version: 1, content: { author: BOB, kind: "reaction", inReplyTo: { key: "m" }, body: value, hasFile: false, bodyVersion: 1 } });
  const withdrawn = assemble([rec("m", { kind: "message", body: "hi" }), reaction("x", "m", "", BOB, { version: 2, held: held("👍") })]);
  assert.deepEqual(find(withdrawn, "m").reactions, []);
  const changed = assemble([rec("m", { kind: "message", body: "hi" }), reaction("x", "m", "🎉", BOB, { version: 2, held: held("👍") })]);
  assert.deepEqual(find(changed, "m").reactions.map((r) => r.value), ["🎉"]);
});

test("reactions: only the reaction's author withdraws it — an empty version by another leaves the earlier one counting", () => {
  const held = { version: 1, content: { author: BOB, kind: "reaction", inReplyTo: { key: "m" }, body: "👍", hasFile: false, bodyVersion: 1 } };
  const view = assemble([rec("m", { kind: "message", body: "hi" }), reaction("x", "m", "", CAROL, { version: 2, held })]);
  assert.deepEqual(find(view, "m").reactions.map((r) => [r.value, r.authors]), [["👍", [BOB]]]);
});

test("reactions: a new version that moves a reaction to another record is refused", () => {
  const held = { version: 1, content: { author: BOB, kind: "reaction", inReplyTo: { key: "m" }, body: "👍", hasFile: false, bodyVersion: 1 } };
  const view = assemble([
    rec("m", { kind: "message", body: "hi" }),
    rec("n", { kind: "message", body: "there" }),
    reaction("x", "n", "👍", BOB, { version: 2, held }),
  ]);
  assert.deepEqual(find(view, "n").reactions, []);
  assert.deepEqual(find(view, "m").reactions, []);
  assert.ok(view.ignored.some((i) => i.key === "x"));
});

test("reactions: none is shown on a target that is not available, or without a target", () => {
  const view = assemble([
    rec("w", { kind: "message", body: "" }),
    reaction("x", "w", "👍", BOB),
    reaction("y", "nowhere", "👍", BOB),
    rec("z", { kind: "reaction", body: "👍", author: BOB }),
  ]);
  assert.equal(find(view, "w").shown, "withdrawn");
  assert.deepEqual(find(view, "w").reactions, []);
  assert.ok(view.ignored.some((i) => i.key === "z" && /names no record/.test(i.reason)));
});

// ── Withdrawn messages ──────────────────────────────────────────────────────

test("a message rewritten empty by its author is withdrawn, nothing of any version shown, replies kept", () => {
  const held = { version: 1, content: { author: ALICE, kind: "message", body: "secret", hasFile: false, bodyVersion: 1 } };
  const view = assemble([
    rec("m", { kind: "message", body: "" }, { version: 2, held }),
    rec("r", { kind: "message", body: "re", author: BOB, inReplyTo: { key: "m" } }),
  ]);
  const m = find(view, "m");
  assert.equal(m.shown, "withdrawn");
  assert.equal(m.content, undefined);
  assert.equal(find(view, "r").replyTo.available, false);
});

test("an empty version of another member's message is their rewrite, never a withdrawal", () => {
  const view = assemble([rec("m", { kind: "message", body: "", author: BOB }, { version: 2, createdBy: ALICE })]);
  const m = find(view, "m");
  assert.equal(m.shown, "message");
  assert.deepEqual(m.rewrite, { by: BOB, original: ALICE });
});

test("a message carrying a file with no body is a file sent without a caption, not a withdrawal", () => {
  const view = assemble([rec("f", { kind: "message", body: "", hasFile: true })]);
  assert.equal(find(view, "f").shown, "message");
});

// ── Tombstones ──────────────────────────────────────────────────────────────

test("a retracted record the reader held keeps its place, shown as retracted", () => {
  const held = { version: 1, content: { author: ALICE, kind: "message", body: "x", writtenAt: "2026-11-05T09:00:00Z", hasFile: false, bodyVersion: 1 } };
  const view = assemble([
    { key: "t", version: 3, status: "retracted", updatedAt: "2026-11-05T11:00:00Z", createdAt: "2026-11-05T09:00:00Z", held, reading: { state: "tombstone" } },
    rec("later", { kind: "message", body: "y", writtenAt: "2026-11-05T09:30:00Z" }, { createdAt: "2026-11-05T09:30:00Z" }),
  ]);
  assert.deepEqual(view.records.map((r) => [r.key, r.shown]), [["t", "retracted"], ["later", "message"]]);
  assert.equal(find(view, "t").content, undefined);
});

test("a retracted record the reader held nothing of is in no conversation and no count", () => {
  const view = assemble([{ key: "t", version: 3, status: "retracted", reading: { state: "tombstone" } }]);
  assert.deepEqual(view.records, []);
  assert.deepEqual(view.tombstones, [{ key: "t", version: 3 }]);
});

test("a retracted reaction counts as no reaction", () => {
  const held = { version: 1, content: { author: BOB, kind: "reaction", inReplyTo: { key: "m" }, body: "👍", hasFile: false, bodyVersion: 1 } };
  const view = assemble([rec("m", { kind: "message", body: "hi" }), { key: "x", version: 2, status: "retracted", held, reading: { state: "tombstone" } }]);
  assert.deepEqual(find(view, "m").reactions, []);
  assert.equal(find(view, "x"), undefined);
});

// ── editedAt ────────────────────────────────────────────────────────────────

test("editedAt: a version carrying it is shown as edited, and never inferred from the version", () => {
  const edited = assemble([rec("m", { kind: "message", body: "b", writtenAt: "2026-11-05T09:00:00Z", editedAt: "2026-11-05T09:30:00Z" }, { version: 9 })]);
  assert.deepEqual(find(edited, "m").edited, { at: "2026-11-05T09:30:00Z" });
  const moved = assemble([rec("m", { kind: "message", body: "b" }, { version: 9 })]);
  assert.equal(find(moved, "m").edited, undefined);
});

test("editedAt: before writtenAt, or after the version was stored, is implausible: edited, but not when", () => {
  const early = assemble([rec("m", { kind: "message", body: "b", writtenAt: "2026-11-05T09:00:00Z", editedAt: "2026-11-05T08:00:00Z" })]);
  assert.deepEqual(find(early, "m").edited, {});
  const late = assemble([rec("m", { kind: "message", body: "b", editedAt: "2026-11-05T10:06:00Z" }, { updatedAt: "2026-11-05T10:00:00Z" })]);
  assert.deepEqual(find(late, "m").edited, {});
  const skew = assemble([rec("m", { kind: "message", body: "b", editedAt: "2026-11-05T10:04:00Z" }, { updatedAt: "2026-11-05T10:00:00Z" })]);
  assert.deepEqual(find(skew, "m").edited, { at: "2026-11-05T10:04:00Z" }, "within five minutes is clock skew");
});

test("a version by someone other than the record's author is their rewrite, never the author's edit", () => {
  const held = { version: 1, content: { author: ALICE, kind: "message", body: "mine", hasFile: false, bodyVersion: 1 } };
  const view = assemble([rec("m", { kind: "message", body: "theirs", author: BOB, editedAt: "2026-11-05T09:00:00Z" }, { version: 2, held })]);
  assert.deepEqual(find(view, "m").rewrite, { by: BOB, original: ALICE });
  // First sight, by the host's `createdBy`.
  const first = assemble([rec("m", { kind: "message", body: "theirs", author: BOB }, { version: 2, createdBy: ALICE })]);
  assert.deepEqual(find(first, "m").rewrite, { by: BOB, original: ALICE });
});

// ── writtenAt ───────────────────────────────────────────────────────────────

test("writtenAt: messages are ordered by it, then by key", () => {
  const view = assemble([
    rec("c", { kind: "message", body: "3", writtenAt: "2026-11-05T09:02:00Z" }, { createdAt: "2026-11-05T09:02:00Z" }),
    rec("b", { kind: "message", body: "2", writtenAt: "2026-11-05T09:01:00Z" }, { createdAt: "2026-11-05T09:05:00Z" }),
    rec("a", { kind: "message", body: "2'", writtenAt: "2026-11-05T09:01:00Z" }, { createdAt: "2026-11-05T09:03:00Z" }),
  ]);
  assert.deepEqual(view.records.map((r) => r.key), ["a", "b", "c"]);
  assert.equal(find(view, "c").written.at, "2026-11-05T09:02:00Z");
  assert.equal(find(view, "c").orderedBy, "writtenAt");
});

test("writtenAt: without one, a record is ordered by createdAt, else updatedAt", () => {
  const view = assemble([
    rec("x", { kind: "message", body: "x" }, { createdAt: "2026-11-05T08:00:00Z", updatedAt: "2026-11-05T11:00:00Z" }),
    rec("y", { kind: "message", body: "y" }, { updatedAt: "2026-11-05T09:00:00Z" }),
  ]);
  assert.deepEqual(view.records.map((r) => [r.key, r.orderedBy]), [["x", "createdAt"], ["y", "updatedAt"]]);
});

test("writtenAt: more than five minutes after the host received the record is implausible — ordered by createdAt, its time not shown", () => {
  const view = assemble([
    rec("f", { kind: "message", body: "f", writtenAt: "2026-11-05T09:06:00Z" }, { createdAt: "2026-11-05T09:00:00Z" }),
    rec("s", { kind: "message", body: "s", writtenAt: "2026-11-05T09:04:00Z" }, { createdAt: "2026-11-05T09:00:00Z" }),
  ]);
  const f = find(view, "f");
  assert.deepEqual(f.written, { implausible: true });
  assert.equal(f.orderAt, Date.parse("2026-11-05T09:00:00Z"));
  assert.equal(find(view, "s").written.at, "2026-11-05T09:04:00Z", "within five minutes is clock skew");
  // With neither createdAt nor updatedAt, against the instant it was read.
  const unhosted = assembleRoomRecords(
    [{ key: "u", version: 1, reading: { state: "read", content: { author: ALICE, kind: "message", body: "u", writtenAt: "2026-11-05T12:10:00Z", hasFile: false, bodyVersion: 1 } } }],
    { now: NOW },
  );
  assert.deepEqual(unhosted.records[0].written, { implausible: true });
  assert.equal(unhosted.records[0].orderedBy, "readAt");
});

test("writtenAt: more than 24 hours before createdAt is backdated — ordered by createdAt and shown as arriving later", () => {
  const view = assemble([
    rec("old", { kind: "message", body: "old", writtenAt: "2026-11-01T09:00:00Z" }, { createdAt: "2026-11-05T09:00:00Z" }),
    rec("mid", { kind: "message", body: "mid", writtenAt: "2026-11-05T08:00:00Z" }, { createdAt: "2026-11-05T08:00:00Z" }),
  ]);
  const old = find(view, "old");
  assert.equal(old.orderedBy, "createdAt");
  assert.deepEqual(old.written, { arrivedLate: { claimed: "2026-11-01T09:00:00Z", received: "2026-11-05T09:00:00Z" } });
  assert.deepEqual(view.records.map((r) => r.key), ["mid", "old"], "it does not slip into the room's past");
  // Within 24 hours it is ordered by its claim.
  const day = assemble([rec("d", { kind: "message", body: "d", writtenAt: "2026-11-04T10:00:00Z" }, { createdAt: "2026-11-05T09:00:00Z" })]);
  assert.equal(find(day, "d").orderedBy, "writtenAt");
});

test("writtenAt: without createdAt, one long before updatedAt is not by itself implausible", () => {
  const view = assemble([rec("e", { kind: "message", body: "e", writtenAt: "2026-10-01T09:00:00Z" }, { updatedAt: "2026-11-05T09:00:00Z" })]);
  assert.deepEqual(find(view, "e").written, { at: "2026-10-01T09:00:00Z" });
});

test("writtenAt: a rewrite that changes the writtenAt of the version held is implausible", () => {
  const held = { version: 1, content: { author: ALICE, kind: "message", body: "a", writtenAt: "2026-11-05T09:00:00Z", hasFile: false, bodyVersion: 1 } };
  const view = assemble([rec("m", { kind: "message", body: "b", writtenAt: "2026-11-05T07:00:00Z" }, { version: 2, held, createdAt: "2026-11-05T09:00:00Z" })]);
  assert.deepEqual(find(view, "m").written, { implausible: true });
});

// ── Placeholders and expiry ─────────────────────────────────────────────────

test("an author who cannot be verified is a placeholder in the conversation, ordered by createdAt", () => {
  const view = assemble([
    { key: "p", version: 1, createdAt: "2026-11-05T08:00:00Z", updatedAt: "2026-11-05T11:00:00Z", reading: { state: "placeholder", reason: "x" } },
    rec("m", { kind: "message", body: "m", writtenAt: "2026-11-05T09:00:00Z" }, { createdAt: "2026-11-05T09:00:00Z" }),
  ]);
  assert.deepEqual(view.records.map((r) => [r.key, r.shown]), [["p", "placeholder"], ["m", "message"]]);
  assert.equal(view.records[0].content, undefined);
});

test("validUntil: a record at or past it is hidden from the default listing, and kept for an explicit request", () => {
  const view = assemble([
    rec("gone", { title: "Gone", body: "x", validUntil: "2026-11-05T11:00:00Z" }),
    rec("edge", { title: "Edge", body: "x", validUntil: new Date(NOW).toISOString() }),
    rec("live", { title: "Live", body: "x", validUntil: "2026-12-01T00:00:00Z" }),
    rec("forever", { title: "Forever", body: "x" }),
  ]);
  assert.deepEqual(view.records.map((r) => r.key).sort(), ["forever", "live"]);
  assert.deepEqual(view.expired.map((r) => r.key).sort(), ["edge", "gone"]);
  assert.ok(view.expired.every((r) => r.expired));
});

test("validUntil: an expired reaction is not counted", () => {
  const view = assemble([rec("m", { kind: "message", body: "hi" }), rec("x", { kind: "reaction", inReplyTo: { key: "m" }, body: "👍", author: BOB, validUntil: "2026-11-01T00:00:00Z" })]);
  assert.deepEqual(find(view, "m").reactions, []);
});

test("the room's own profile is not one of its records", () => {
  assert.deepEqual(assemble([{ key: "room-profile", version: 1, reading: { state: "profile" } }]).records, []);
});

// ── Open rooms ──────────────────────────────────────────────────────────────

test("an open room's cleartext carries the same members, and a malformed one is refused", () => {
  const ok = readingFromCleartext(
    { body: "hi", kind: "message", inReplyTo: { key: "a", version: 2 }, writtenAt: "2026-11-05T09:00:00Z", validUntil: "2027-01-01T00:00:00Z" },
    ALICE,
    4,
  );
  assert.equal(ok.state, "read");
  assert.deepEqual(
    { kind: ok.content.kind, inReplyTo: ok.content.inReplyTo, writtenAt: ok.content.writtenAt, bodyVersion: ok.content.bodyVersion },
    { kind: "message", inReplyTo: { key: "a", version: 2 }, writtenAt: "2026-11-05T09:00:00Z", bodyVersion: 4 },
  );
  for (const bad of [{ kind: "Message" }, { inReplyTo: "a" }, { inReplyTo: { key: "a", x: 1 } }, { writtenAt: "2026-11-05T09:00:00+01:00" }, { validUntil: "soon" }]) {
    assert.equal(readingFromCleartext({ body: "x", ...bad }, ALICE, 1).state, "refused", JSON.stringify(bad));
  }
});
