// Replies and reactions, written as the member (`writeMessageAsMember`'s
// `replyTo`, `writeReactionAsMember`, `withdrawReactionAsMember`), and the
// member's own reactions as the reading rules find them (`ownReactions`).
//
// The writer's rule throughout: a member a room's profile does not list is
// never written (`SealedRecordBody`, *When a writer may use these members*) —
// a reply or a reaction is refused before anything is sealed or sent, never
// written without what makes it one.

import { test } from "node:test";
import assert from "node:assert/strict";

import { base64url } from "@openvtc/vti-didcomm-js";

import {
  assembleRoomRecords,
  ownReactions,
  recordMembersRefusal,
  RecordWriteRefused,
  withdrawReactionAsMember,
  writeMessageAsMember,
  writeReactionAsMember,
} from "../dist/rooms/index.js";

const ALICE = "did:webvh:QmAlice:people.example:alice-room";
const BOB = "did:webvh:QmBob:people.example:bob-room";
const WALLET = { did: "did:key:zWallet" };
const VTA = "did:webvh:QmAgent:agent.example";
const HOST = "did:webvh:QmHost:host.example";
const ROOM = "did:webvh:QmRoom:rooms.example";
const NOW = () => new Date("2026-11-25T12:00:00.456Z");

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
const nothingWritten = (r) => {
  assert.deepEqual(puts(r.sent), [], "nothing reached the host");
  assert.ok(!r.vtaAsked.some((t) => t.includes("seal")), "nothing was sealed");
};

// ── The gate ─────────────────────────────────────────────────────────────────

test("recordMembersRefusal names what is missing, with the code a page reads", () => {
  assert.equal(recordMembersRefusal(["kind", "inReplyTo"], ["kind", "inReplyTo"], "reactions"), undefined);
  const e = recordMembersRefusal(["kind"], ["kind", "inReplyTo"], "reactions");
  assert.ok(e instanceof RecordWriteRefused);
  assert.equal(e.code, "recordMembersNotListed");
  assert.match(e.message, /inReplyTo/);
  assert.match(recordMembersRefusal(undefined, ["inReplyTo"], "replies").message, /replies/);
});

// ── A reply ──────────────────────────────────────────────────────────────────

test("a reply carries inReplyTo — the key, and the version where given — beside kind and writtenAt", async () => {
  const r = room({ recordMembers: ["kind", "inReplyTo", "writtenAt"] });
  await writeMessageAsMember(r.room, { body: "Yes", replyTo: { key: "m1", version: 3 }, now: NOW });
  const [body] = r.sealed;
  assert.deepEqual(body.inReplyTo, { key: "m1", version: 3 });
  assert.equal(body.kind, "message");
  assert.equal(body.writtenAt, "2026-11-25T12:00:00Z");
  assert.equal(body.title, undefined);
});

test("a reply in a room that takes none is refused, and nothing is sealed or sent — never written without it", async () => {
  for (const recordMembers of [undefined, ["kind", "writtenAt"]]) {
    const r = room({ recordMembers });
    await assert.rejects(
      writeMessageAsMember(r.room, { body: "Yes", replyTo: { key: "m1" } }),
      (e) => e instanceof RecordWriteRefused && e.code === "recordMembersNotListed",
    );
    nothingWritten(r);
  }
});

test("a reply on an open room is inReplyTo in the clear", async () => {
  const r = room({ recordMembers: ["inReplyTo"], visibility: "open" });
  await writeMessageAsMember(r.room, { body: "Yes", replyTo: { key: "m1" } });
  assert.deepEqual(puts(r.sent)[0].payload.cleartext, { body: "Yes", inReplyTo: { key: "m1" } });
  assert.deepEqual(r.sealed, []);
});

test("a message with no replyTo needs no inReplyTo, as before", async () => {
  const r = room({ recordMembers: ["kind"] });
  await writeMessageAsMember(r.room, { body: "hi" });
  assert.equal(r.sealed[0].inReplyTo, undefined);
});

// ── A reaction ───────────────────────────────────────────────────────────────

test("a reaction is a record of kind reaction, the value as its body, naming the record; create-only", async () => {
  const r = room({ recordMembers: ["kind", "inReplyTo", "writtenAt"] });
  const out = await writeReactionAsMember(r.room, { target: { key: "m1", version: 2 }, value: "👍", now: NOW });
  assert.equal(out.principal, ALICE);
  const [body] = r.sealed;
  assert.deepEqual(Object.keys(body).sort(), ["author", "body", "inReplyTo", "key", "kind", "roomId", "version", "writtenAt"]);
  assert.equal(body.kind, "reaction");
  assert.equal(body.body, "👍");
  assert.deepEqual(body.inReplyTo, { key: "m1", version: 2 });
  assert.equal(puts(r.sent)[0].payload.expectedVersion, 0);

  // It is exactly what the reading rules count.
  const view = assembleRoomRecords(
    [
      { key: "m1", version: 2, status: "active", updatedAt: "2026-11-25T11:00:00Z", reading: { state: "read", content: { author: BOB, kind: "message", body: "hi", hasFile: false, bodyVersion: 2 } } },
      { key: body.key, version: 7, status: "active", updatedAt: "2026-11-25T12:00:00Z", reading: { state: "read", content: { author: ALICE, kind: "reaction", body: "👍", inReplyTo: { key: "m1", version: 2 }, hasFile: false, bodyVersion: 7 } } },
    ],
    { now: Date.parse("2026-11-25T12:30:00Z") },
  );
  assert.deepEqual(view.records[0].reactions.map((x) => [x.value, x.count, x.authors]), [["👍", 1, [ALICE]]]);
});

test("a reaction in a room without kind and inReplyTo is refused before anything is sealed or sent", async () => {
  for (const recordMembers of [undefined, ["kind"], ["inReplyTo"]]) {
    const r = room({ recordMembers });
    await assert.rejects(
      writeReactionAsMember(r.room, { target: { key: "m1" }, value: "👍" }),
      (e) => e instanceof RecordWriteRefused && e.code === "recordMembersNotListed",
    );
    nothingWritten(r);
  }
});

test("a reaction's value is the reading rules' own: not empty, no line break, at most 64 characters", async () => {
  for (const value of ["", "  ", "a\nb", "x".repeat(65)]) {
    const r = room({ recordMembers: ["kind", "inReplyTo"] });
    await assert.rejects(writeReactionAsMember(r.room, { target: { key: "m1" }, value }), RecordWriteRefused);
    assert.deepEqual(r.vtaAsked, [], "refused before the profile is read");
  }
});

test("a reaction on an open room is in the clear", async () => {
  const r = room({ recordMembers: ["kind", "inReplyTo"], visibility: "open" });
  await writeReactionAsMember(r.room, { target: { key: "m1" }, value: "❤️" });
  assert.deepEqual(puts(r.sent)[0].payload.cleartext, { body: "❤️", kind: "reaction", inReplyTo: { key: "m1" } });
});

// ── Taking one back ──────────────────────────────────────────────────────────

test("a withdrawal is a new version of the member's own reaction: empty body, same kind and target, over the version read", async () => {
  const r = room({ recordMembers: ["kind", "inReplyTo", "editedAt"] });
  await withdrawReactionAsMember(r.room, { key: "rx", version: 4, target: { key: "m1" } }, { now: NOW });
  const [body] = r.sealed;
  assert.equal(body.key, "rx");
  assert.equal(body.kind, "reaction");
  assert.equal(body.body, "");
  assert.deepEqual(body.inReplyTo, { key: "m1" });
  assert.equal(body.editedAt, "2026-11-25T12:00:00Z");
  assert.equal(puts(r.sent)[0].payload.expectedVersion, 4, "replaces exactly the version read");
});

test("a withdrawal reads, by the reading rules, as no reaction", () => {
  const msg = { key: "m1", version: 1, status: "active", updatedAt: "2026-11-25T11:00:00Z", reading: { state: "read", content: { author: BOB, kind: "message", body: "hi", hasFile: false, bodyVersion: 1 } } };
  const was = { author: ALICE, kind: "reaction", body: "👍", inReplyTo: { key: "m1" }, hasFile: false, bodyVersion: 2 };
  const now = { author: ALICE, kind: "reaction", body: "", inReplyTo: { key: "m1" }, hasFile: false, bodyVersion: 3 };
  const view = assembleRoomRecords(
    [msg, { key: "rx", version: 3, status: "active", updatedAt: "2026-11-25T12:00:00Z", held: { version: 2, content: was }, reading: { state: "read", content: now } }],
    { now: Date.parse("2026-11-25T12:30:00Z") },
  );
  assert.deepEqual(view.records[0].reactions, []);
});

// ── The member's own reactions ───────────────────────────────────────────────

test("ownReactions finds the member's live reactions with that value on that record — by its normalised value, nobody else's", () => {
  const rx = (key, author, body, target = "m1", version = 2) => ({
    key,
    version,
    status: "active",
    reading: { state: "read", content: { author, kind: "reaction", body, inReplyTo: { key: target }, hasFile: false, bodyVersion: version } },
  });
  const inputs = [
    rx("a", ALICE, "❤️"),
    rx("b", ALICE, "❤"), // the same value without its variation selector
    rx("c", BOB, "❤️"),
    rx("d", ALICE, "👍"),
    rx("e", ALICE, "❤️", "m2"),
    rx("f", ALICE, ""), // withdrawn already
    { key: "g", version: 1, status: "active", reading: { state: "refused", reason: "signature" } },
  ];
  assert.deepEqual(
    ownReactions(inputs, { author: ALICE, target: "m1", value: "❤️" }).map((r) => [r.key, r.version, r.target.key]),
    [
      ["a", 2, "m1"],
      ["b", 2, "m1"],
    ],
  );
  assert.deepEqual(ownReactions(inputs, { author: ALICE, target: "m1", value: "" }), []);
});
