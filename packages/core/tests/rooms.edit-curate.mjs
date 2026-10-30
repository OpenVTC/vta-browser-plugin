// Editing a room's records as the member: replacing a note at the version that
// was read, putting one in the clear on an open room, and changing a record's
// standing (rooms/records/curate/0.1).

import { test } from "node:test";
import assert from "node:assert/strict";

import { curateRecordAsMember, putCleartextAsMember, writeSealedAsMember } from "../dist/rooms/index.js";

const WALLET = { did: "did:key:zWallet" };
const VTA = "did:webvh:QmAgent:agent.example";
const HOST = "did:webvh:QmHost:host.example";
const PERSONA = "did:webvh:QmAlice:people.example";
const ROOM = "did:webvh:QmRoom:rooms.example";

/**
 * A room whose VTA seals and completes as PERSONA, and whose host answers by
 * task: the room's head is `head`, and a put lands at `landed` (default: the
 * version it was sealed for). Every completed document reaches `sent`.
 */
function room({ head = 6, landed, curated } = {}) {
  const sent = [];
  let sealedFor = 0;
  const agent = {
    async send(envelope) {
      if (envelope.type.includes("rooms/keys/seal/")) {
        sealedFor = envelope.payload.version;
        return { sealed: { ciphertext: "c", nonce: "n", epoch: 1 } };
      }
      const doc = structuredClone(envelope.payload.document);
      doc.issuer = PERSONA;
      doc.payload.presentation = { membership: "vmc", authority: ["leaf"] };
      doc.proof = { type: "DataIntegrityProof" };
      return { principal: PERSONA, document: doc };
    },
  };
  const host = {
    async sendCompleted(doc) {
      sent.push(doc);
      if (doc.type.includes("rooms/records/list/")) return { roomId: ROOM, records: [], headVersion: head };
      if (doc.type.includes("rooms/records/put/")) return { key: doc.payload.key, version: landed ?? sealedFor };
      if (doc.type.includes("rooms/records/curate/")) {
        return curated ?? { key: doc.payload.key, version: head + 1, status: doc.payload.status ?? "active" };
      }
      throw new Error(`unexpected ${doc.type}`);
    },
  };
  return {
    sent,
    room: { roomId: ROOM, member: PERSONA, holder: WALLET, vta: { did: VTA, sender: agent }, host: { did: HOST, sender: host } },
  };
}

const puts = (sent) => sent.filter((d) => d.type.includes("rooms/records/put/"));

test("a new note is create-only: the host refuses it if the key is taken", async () => {
  const r = room();
  const version = await writeSealedAsMember(r.room, { roomId: ROOM, key: "k", author: PERSONA, title: "T" });
  assert.equal(version, 7);
  assert.equal(puts(r.sent)[0].payload.expectedVersion, 0);
});

// The edit names the version the member read, so the host refuses it if
// anything replaced the record since — an edit never silently undoes another.
test("an edit replaces at the version that was read", async () => {
  const r = room();
  await writeSealedAsMember(r.room, { roomId: ROOM, key: "k", author: PERSONA, title: "T", body: "new" }, undefined, { replaces: 3 });
  assert.equal(puts(r.sent)[0].payload.expectedVersion, 3);
});

// When another write takes the predicted version, the rewrite is over exactly
// what landed — the member's own put — never blind.
test("an edit that lands at another version is rewritten over what landed", async () => {
  let n = 0;
  const r = room({ landed: undefined });
  const host = r.room.host.sender;
  const send = host.sendCompleted;
  host.sendCompleted = async (doc) => {
    if (doc.type.includes("rooms/records/put/") && n++ === 0) {
      r.sent.push(doc);
      return { key: doc.payload.key, version: 9 };
    }
    return send(doc);
  };
  await writeSealedAsMember(r.room, { roomId: ROOM, key: "k", author: PERSONA, title: "T" }, undefined, { replaces: 3 });
  assert.deepEqual(puts(r.sent).map((d) => d.payload.expectedVersion), [3, 9]);
});

test("an open room's note goes in the clear, create-only unless it replaces", async () => {
  const r = room({ landed: 4 });
  assert.equal(await putCleartextAsMember(r.room, { key: "k", title: "T", body: "B" }), 4);
  assert.deepEqual(puts(r.sent)[0].payload.cleartext, { title: "T", body: "B" });
  assert.equal(puts(r.sent)[0].payload.expectedVersion, 0);
  await putCleartextAsMember(r.room, { key: "k", title: "T", replaces: 4 });
  assert.equal(puts(r.sent)[1].payload.expectedVersion, 4);
});

test("an open room's note carries its description and tags, and a body even when it has none", async () => {
  const r = room({ landed: 1 });
  await putCleartextAsMember(r.room, { key: "k", title: "T", description: "D", tags: ["a", "b"] });
  // rooms/records/put/0.3 requires the cleartext's body.
  assert.deepEqual(puts(r.sent)[0].payload.cleartext, { title: "T", description: "D", tags: ["a", "b"], body: "" });
});

test("a retraction carries its reason and the version read, and an empty reason is left out", async () => {
  const r = room();
  const out = await curateRecordAsMember(r.room, { key: "k", status: "retracted", reason: "posted in error", expectedVersion: 5 });
  assert.equal(out.status, "retracted");
  const sent = r.sent.find((d) => d.type.includes("rooms/records/curate/"));
  assert.equal(sent.issuer, PERSONA, "sent as the member");
  assert.ok(sent.payload.presentation, "with the authority the VTA presented");
  assert.deepEqual(
    { ...sent.payload, presentation: undefined },
    { roomId: ROOM, key: "k", status: "retracted", reason: "posted in error", expectedVersion: 5, presentation: undefined },
  );

  const r2 = room();
  await curateRecordAsMember(r2.room, { key: "k", status: "deprecated", reason: "" });
  assert.equal("reason" in r2.sent.find((d) => d.type.includes("curate")).payload, false);
});

test("a curation answered for another record is refused", async () => {
  const r = room({ curated: { key: "other", version: 8, status: "retracted" } });
  await assert.rejects(curateRecordAsMember(r.room, { key: "k", status: "retracted", reason: "x" }), /answered rooms\/records\/curate for other, not k/);
});
