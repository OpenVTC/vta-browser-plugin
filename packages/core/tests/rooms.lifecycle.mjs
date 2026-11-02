// A room's owner lifecycle as a member sees it — `vtc/rooms/memberships/list/0.2`
// (`suspended`, `roomState`, `roomAccess`, `purgeAt`) — and renewals collected
// from `vtc/rooms/offers/list/0.4` into the member's VTA, each in place of the
// credential it renews (VTI #2380, trust-tasks-tf #1006).

import { test } from "node:test";
import assert from "node:assert/strict";

import {
  collectRoomRenewals,
  communityRoomRenewals,
  isAcceptable,
  roomCondition,
  roomNamesFromOffers,
  roomStanding,
} from "../dist/rooms/index.js";

const WALLET = { did: "did:key:zWallet" };
const VTA = "did:webvh:QmAgent:agent.example";
const COMMUNITY = "did:webvh:QmCommunity:community.example";
const MEMBER = "did:webvh:QmAlice:people.example";
const BOARD = "did:webvh:QmBoard:community.example:room-dids:board";

function vta() {
  const sent = [];
  return {
    sent,
    async send(envelope) {
      sent.push(envelope);
      const doc = structuredClone(envelope.payload.document);
      doc.proof = { type: "DataIntegrityProof" };
      return { principal: doc.issuer, document: doc };
    },
  };
}

function reader(pages) {
  return {
    holder: WALLET,
    vta: { did: VTA, sender: vta() },
    community: { did: COMMUNITY, sender: { async sendCompleted() { return pages.shift(); } } },
    member: MEMBER,
  };
}

const cred = (id) => JSON.stringify({ id, type: ["VerifiableCredential"], proof: { proofValue: `z${id}` } });

function renewal(roomId, m, a) {
  return {
    roomId, host: COMMUNITY, label: "Board pack", visibility: "attributed", actions: ["read"],
    validUntil: "2027-10-01T00:00:00Z", renewsAt: "2027-10-01T00:00:00Z", issuedAt: "2026-11-03T10:00:00Z",
    credentials: { membership: cred(m), authority: cred(a) },
  };
}

/** A vault holding `held` (handle → body), recording what it was asked to store. */
function vault(held) {
  const stored = [];
  return {
    stored,
    async query({ type, issuerDid, subjectDid }) {
      assert.equal(issuerDid, BOARD);
      assert.equal(subjectDid, MEMBER);
      return Object.entries(held).filter(([, b]) => b.kind === type).map(([id]) => id);
    },
    async get(id) {
      return held[id]?.body;
    },
    async receive(credential, replaces) {
      stored.push({ id: credential.id, replaces });
    },
  };
}

test("a suspended admission is its own standing, and is not one to accept", () => {
  assert.equal(roomStanding({ visibility: "private", state: "suspended" }, true), "suspended");
  assert.equal(roomStanding({ visibility: "open", state: "suspended" }, false), "suspended");
  assert.ok(!isAcceptable("suspended"));
});

test("a room's own state reads as what it means to the member", () => {
  assert.deepEqual(roomCondition({ roomState: "active" }), { kind: "active" });
  assert.deepEqual(roomCondition({}), { kind: "active" });
  assert.deepEqual(roomCondition({ roomState: "archived", roomAccess: "readOnly" }), { kind: "readOnly" });
  assert.deepEqual(roomCondition({ roomState: "archived", roomAccess: "noAccess" }), { kind: "closed" });
  assert.deepEqual(roomCondition({ roomState: "removalScheduled", roomAccess: "noAccess", purgeAt: "2026-12-02T10:00:00Z" }), {
    kind: "goingAway",
    purgeAt: "2026-12-02T10:00:00Z",
  });
  assert.deepEqual(roomCondition({ roomState: "purging" }), { kind: "goingAway" });
  assert.deepEqual(roomCondition({ roomState: "removed" }), { kind: "removed" });
});

test("a room's name carries its state from the record, and only values the schema allows", () => {
  const names = roomNamesFromOffers([
    { roomId: BOARD, label: "Board pack", visibility: "private", roomState: "archived", roomAccess: "noAccess", purgeAt: "nope" },
    { roomId: "did:example:other", label: "Other", roomState: "exploded", roomAccess: "sometimes" },
  ]);
  assert.deepEqual(names[BOARD], { label: "Board pack", visibility: "private", roomState: "archived", roomAccess: "noAccess" });
  assert.deepEqual(names["did:example:other"], { label: "Other" });
});

test("renewals are read from offers/list 0.4 across its pages", async () => {
  const r = reader([
    { items: [], renewals: [renewal(BOARD, "m1", "a1")], nextCursor: "p2" },
    { items: [] },
  ]);
  const got = await communityRoomRenewals(r);
  assert.deepEqual(got.map((x) => x.roomId), [BOARD]);
  assert.equal(r.vta.sender.sent[0].payload.document.type, "https://trusttasks.org/spec/vtc/rooms/offers/list/0.4");
});

test("a renewal is stored in place of each credential it renews", async () => {
  const v = vault({
    h1: { kind: "MembershipCredential", body: JSON.parse(cred("old-m")) },
    h2: { kind: "AuthorityCredential", body: JSON.parse(cred("old-a")) },
  });
  const out = await collectRoomRenewals(reader([]), v, [renewal(BOARD, "new-m", "new-a")]);
  assert.deepEqual(out, { stored: [BOARD], alreadyHeld: [], failed: [] });
  assert.deepEqual(v.stored, [
    { id: "new-m", replaces: "h1" },
    { id: "new-a", replaces: "h2" },
  ]);
});

test("a renewal already held is not stored again — collecting is idempotent", async () => {
  const v = vault({
    h1: { kind: "MembershipCredential", body: JSON.parse(cred("new-m")) },
    h2: { kind: "AuthorityCredential", body: JSON.parse(cred("new-a")) },
  });
  const out = await collectRoomRenewals(reader([]), v, [renewal(BOARD, "new-m", "new-a")]);
  assert.deepEqual(out, { stored: [], alreadyHeld: [BOARD], failed: [] });
  assert.deepEqual(v.stored, []);
});

test("a restored member holding nothing for the room has the renewal stored fresh", async () => {
  const v = vault({});
  const out = await collectRoomRenewals(reader([]), v, [renewal(BOARD, "new-m", "new-a")]);
  assert.deepEqual(out.stored, [BOARD]);
  assert.deepEqual(v.stored, [
    { id: "new-m", replaces: undefined },
    { id: "new-a", replaces: undefined },
  ]);
});

test("two held credentials of one kind are refused, never guessed between, and the pass goes on", async () => {
  const v = vault({
    h1: { kind: "MembershipCredential", body: JSON.parse(cred("x")) },
    h2: { kind: "MembershipCredential", body: JSON.parse(cred("y")) },
  });
  const bad = { ...renewal(BOARD, "new-m", "new-a") };
  const broken = { ...renewal(BOARD, "z", "z"), credentials: { membership: "not json", authority: cred("z") } };
  const out = await collectRoomRenewals(reader([]), v, [bad, broken]);
  assert.equal(out.failed.length, 2);
  assert.match(out.failed[0].error, /holds 2 MembershipCredentials/);
  assert.match(out.failed[1].error, /not JSON/);
  assert.deepEqual(v.stored, []);
});
