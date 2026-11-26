// A reaction grant: the one bounded, revocable exception to "every page write is
// confirmed" (P7b; VTI `data-rooms-files.md` §8.5).
//
// In a reaction's own confirm the member may tick "let this portal add and
// remove your reactions in this room for 30 minutes". Only that box grants it;
// it rides on the share (this origin, community, VTA, room and member), is never
// extended by use, and ends with the share. Reactions only: a message or a note
// under a live grant is still confirmed, and every other gate still applies.

import test from "node:test";
import assert from "node:assert/strict";

import { deliverConsentResult, type ConsentDecision } from "../src/consent-window.ts";
import { RoomPageGates, type PortLike, type RoomPageBackgroundDeps } from "../src/room-page-background.ts";
import {
  REACTION_GRANT_TTL_MS,
  reactionGrantLive,
  withGrants,
  withReactionGrant,
  withoutGrant,
  withoutReactionGrant,
  type RoomGrant,
  type RoomShareConsentView,
  type RoomWriteConsentView,
} from "../src/room-page-policy.ts";

const PORTAL = "https://members.northwind.example";
const HOST = "did:webvh:QmHost:northwind.example";
const VTA = "did:webvh:QmAgent:agent.example";
const ROOM = "did:webvh:QmRoom:rooms.example";
const ROOM2 = "did:webvh:QmRoom2:rooms.example";
const MEMBER = "did:webvh:QmAlice:people.example";
const BOB = "did:webvh:QmBob:people.example";
const T0 = 1_800_000_000_000;
const AT = { origin: PORTAL, hostDid: HOST, vtaDid: VTA };

function share(roomId: string, member = MEMBER, extra: Partial<RoomGrant> = {}): RoomGrant {
  return { ...AT, roomId, member, grantedAt: T0 - 1000, expiresAt: T0 + 30 * 86_400_000, ...extra };
}

interface Harness {
  gates: RoomPageGates;
  prompts: (RoomShareConsentView | RoomWriteConsentView)[];
  asked: { op: string; [k: string]: unknown }[];
  answer: { approved: boolean; reactionGrant?: boolean };
  grants: RoomGrant[];
  now: number;
}

function harness(grants: RoomGrant[] = [share(ROOM), share(ROOM2)]): Harness {
  const h: Harness = { gates: undefined as never, prompts: [], asked: [], answer: { approved: true }, grants, now: T0 };
  const deps: RoomPageBackgroundDeps = {
    active: async () => ({ ok: true, vta: { vtaDid: VTA } }),
    async offscreen(_vta, op) {
      h.asked.push(op as never);
      switch (op.op) {
        case "portal":
          return { ok: true, result: { portalOrigin: PORTAL, endpoint: `${PORTAL}/v1/trust-tasks` } };
        case "info":
          return { ok: true, result: { roomId: op.roomId, visibility: "attributed", epoch: 3, member: op.member, limits: {}, usage: {} } };
        case "recordMembers":
          return { ok: true, result: ["kind", "inReplyTo", "writtenAt"] };
        case "read":
          return {
            ok: true,
            result: { key: op.key, version: 2, status: "active", updatedAt: "2026-11-25T10:00:00Z", author: BOB, kind: "message", body: "Lunch at one?" },
          };
        default:
          return { ok: true, result: { did: op.op } };
      }
    },
    canReach: async () => true,
    loadGrants: async () => h.grants,
    saveGrants: async (_o, _v, g) => {
      h.grants = g;
    },
    prompt: async (view) => {
      h.prompts.push(view);
      return h.answer;
    },
    openTransfer: async () => ({}) as PortLike,
    now: () => h.now,
  };
  h.gates = new RoomPageGates(deps);
  return h;
}

const react = (h: Harness, roomId = ROOM, op: "react" | "unreact" = "react") =>
  h.gates.handle(PORTAL, { op, hostDid: HOST, roomId, key: "m1", value: "👍" });
const writes = (h: Harness) => h.asked.filter((a) => ["putMessage", "putNote", "react", "unreact"].includes(a.op));

test("the reaction prompt offers the grant, unticked, for 30 minutes", async () => {
  const h = harness();
  await react(h);
  const what = (h.prompts[0] as RoomWriteConsentView).what as { grant?: { minutes: number } };
  assert.deepEqual(what.grant, { minutes: 30 });
  assert.equal(REACTION_GRANT_TTL_MS, 30 * 60 * 1000);
});

test("only the explicit box grants: an approval without it leaves every reaction confirmed", async () => {
  const h = harness();
  h.answer = { approved: true };
  assert.ok((await react(h)).ok);
  assert.ok((await react(h)).ok);
  assert.equal(h.prompts.length, 2);
  assert.equal(h.grants.find((g) => g.roomId === ROOM)!.reactionsUntil, undefined);
});

test("a denial with the box ticked grants nothing, at the consent window too", async () => {
  const h = harness();
  h.answer = { approved: false, reactionGrant: true };
  const res = await react(h);
  assert.equal((res as { code?: string }).code, "declined");
  assert.equal(h.grants.find((g) => g.roomId === ROOM)!.reactionsUntil, undefined);
  // The consent window itself never passes a grant on a denial.
  const got: unknown[][] = [];
  const pending = new Map<string, ConsentDecision>([["c1", (...a) => void got.push(a)]]);
  deliverConsentResult(pending, { consentId: "c1", approved: false, reactionGrant: true });
  assert.equal(got[0]![7], false);
  deliverConsentResult(new Map([["c2", (...a) => void got.push(a)]]), { consentId: "c2", approved: true, reactionGrant: true });
  assert.equal(got[1]![7], true);
});

test("under a live grant a reaction and taking one back run without a window, and are still written as the member", async () => {
  const h = harness();
  h.answer = { approved: true, reactionGrant: true };
  assert.ok((await react(h)).ok);
  assert.equal(h.grants.find((g) => g.roomId === ROOM)!.reactionsUntil, T0 + REACTION_GRANT_TTL_MS);
  h.now = T0 + 10 * 60_000;
  assert.ok((await react(h)).ok);
  assert.ok((await react(h, ROOM, "unreact")).ok);
  assert.equal(h.prompts.length, 1);
  assert.deepEqual(
    writes(h).map((w) => [w.op, w.member]),
    [
      ["react", MEMBER],
      ["react", MEMBER],
      ["unreact", MEMBER],
    ],
  );
  // The record-members gate still ran for every one.
  assert.equal(h.asked.filter((a) => a.op === "recordMembers").length, 3);
});

test("using a grant never extends it, and it ends at 30 minutes", async () => {
  const h = harness();
  h.answer = { approved: true, reactionGrant: true };
  await react(h);
  h.now = T0 + REACTION_GRANT_TTL_MS - 1;
  await react(h);
  assert.equal(h.grants.find((g) => g.roomId === ROOM)!.reactionsUntil, T0 + REACTION_GRANT_TTL_MS);
  h.now = T0 + REACTION_GRANT_TTL_MS;
  h.answer = { approved: true };
  await react(h);
  assert.equal(h.prompts.length, 2);
});

test("a grant is for one room: another shared room still asks", async () => {
  const h = harness();
  h.answer = { approved: true, reactionGrant: true };
  await react(h, ROOM);
  h.answer = { approved: true };
  await react(h, ROOM2);
  assert.equal(h.prompts.length, 2);
  assert.equal((h.prompts[1] as RoomWriteConsentView).roomId, ROOM2);
});

test("a message or a note under a live grant is still confirmed", async () => {
  const h = harness();
  h.answer = { approved: true, reactionGrant: true };
  await react(h);
  h.answer = { approved: false };
  const msg = await h.gates.handle(PORTAL, { op: "putMessage", hostDid: HOST, roomId: ROOM, body: "Hi" });
  const note = await h.gates.handle(PORTAL, { op: "putNote", hostDid: HOST, roomId: ROOM, title: "T", body: "B" });
  assert.equal((msg as { code?: string }).code, "declined");
  assert.equal((note as { code?: string }).code, "declined");
  assert.equal(h.prompts.length, 3);
  assert.deepEqual(
    writes(h).map((w) => w.op),
    ["react"],
  );
});

test("a grant ends with its share: stopped on its own, revoked with the share, or the room shared afresh", async () => {
  // Stopped on its own (the console's Stop): the share stays, the grant goes.
  let h = harness();
  h.answer = { approved: true, reactionGrant: true };
  await react(h);
  h.grants = withoutReactionGrant(h.grants, AT, ROOM);
  h.answer = { approved: true };
  await react(h);
  assert.equal(h.prompts.length, 2);

  // Revoked with the share (the console's Stop sharing, or the page's `forget`).
  h = harness();
  h.answer = { approved: true, reactionGrant: true };
  await react(h);
  h.grants = withoutGrant(h.grants, AT, ROOM);
  assert.equal((await react(h) as { code?: string }).code, "notShared");

  // Shared afresh, here as another member: a new share carries no grant.
  h = harness();
  h.answer = { approved: true, reactionGrant: true };
  await react(h);
  h.grants = withGrants(h.grants, AT, [{ roomId: ROOM, member: BOB }], T0);
  h.answer = { approved: true };
  await react(h);
  assert.equal(h.prompts.length, 2);
});

test("a grant applies only to its own origin, community, VTA, room and member, and never past its share", () => {
  const grants = [share(ROOM), { ...share(ROOM), origin: "https://other.example" }, { ...share(ROOM), member: BOB }];
  const after = withReactionGrant(grants, AT, ROOM, MEMBER, T0);
  assert.equal(after[0]!.reactionsUntil, T0 + REACTION_GRANT_TTL_MS);
  assert.equal(after[1]!.reactionsUntil, undefined);
  assert.equal(after[2]!.reactionsUntil, undefined);
  // A share ending sooner caps it.
  const short = withReactionGrant([share(ROOM, MEMBER, { expiresAt: T0 + 60_000 })], AT, ROOM, MEMBER, T0);
  assert.equal(short[0]!.reactionsUntil, T0 + 60_000);
  // A stored value no grant could have made is no grant.
  assert.equal(reactionGrantLive({ reactionsUntil: T0 + REACTION_GRANT_TTL_MS + 1, expiresAt: T0 + 86_400_000 }, T0), false);
  assert.equal(reactionGrantLive({ reactionsUntil: T0 + 1000, expiresAt: T0 + 500 }, T0), false);
  assert.equal(reactionGrantLive({ reactionsUntil: T0, expiresAt: T0 + 86_400_000 }, T0), false);
  assert.equal(reactionGrantLive({ expiresAt: T0 + 86_400_000 }, T0), false);
  assert.equal(reactionGrantLive({ reactionsUntil: T0 + 1000, expiresAt: T0 + 86_400_000 }, T0), true);
});
