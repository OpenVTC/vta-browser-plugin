// A session grant: "send messages and reactions in this room without asking
// while this room is open" (P7b; VTI `data-rooms-files.md` §8.5).
//
// The second bounded exception to "every page write is confirmed". Only the box
// in a message's or reaction's own confirm grants it; it is bound to the one
// document (tab + documentId) that holds the room open through a watch port,
// covers messages and reactions only, and ends with that port, the tab, the
// share, 30 minutes idle, 8 hours, a lock, or Stop. Too many writes, or a long
// message, are asked for again.

import test from "node:test";
import assert from "node:assert/strict";

import { deliverConsentResult, type ConsentDecision } from "../src/consent-window.ts";
import { RoomPageGates, type PortLike, type RoomPageBackgroundDeps } from "../src/room-page-background.ts";
import type { RoomShareConsentView, RoomWriteConsentView } from "../src/room-page-policy.ts";
import {
  RoomSessionGrants,
  SESSION_GRANT_CAP_MS,
  SESSION_GRANT_IDLE_MS,
  SESSION_GRANT_RATE_LIMIT,
  SESSION_MESSAGE_MAX_CHARS,
  type PageSession,
  type SessionGrantRow,
} from "../src/room-session-grant.ts";

const PORTAL = "https://members.northwind.example";
const HOST = "did:webvh:QmHost:northwind.example";
const VTA = "did:webvh:QmAgent:agent.example";
const ROOM = "did:webvh:QmRoom:rooms.example";
const ROOM2 = "did:webvh:QmRoom2:rooms.example";
const MEMBER = "did:webvh:QmAlice:people.example";
const T0 = 1_800_000_000_000;
const TAB: PageSession = { tabId: 7, documentId: "DOC-A" };

class FakePort implements PortLike {
  connected = true;
  private onMsg: ((m: unknown) => void)[] = [];
  private onDisc: (() => void)[] = [];
  postMessage() {}
  disconnect() {
    if (!this.connected) return;
    this.connected = false;
    for (const f of this.onDisc) f();
  }
  onMessage = { addListener: (fn: (m: unknown) => void) => void this.onMsg.push(fn) };
  onDisconnect = { addListener: (fn: () => void) => void this.onDisc.push(fn) };
  receive(m: unknown) {
    for (const f of this.onMsg) f(m);
  }
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

interface Harness {
  gates: RoomPageGates;
  prompts: (RoomShareConsentView | RoomWriteConsentView)[];
  asked: { op: string; [k: string]: unknown }[];
  answer: { approved: boolean; reactionGrant?: boolean; sessionGrant?: boolean };
  shared: boolean;
  now: number;
  badge: SessionGrantRow[][];
}

function harness(): Harness {
  const h: Harness = { gates: undefined as never, prompts: [], asked: [], answer: { approved: true }, shared: true, now: T0, badge: [] };
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
          return { ok: true, result: { key: op.key, version: 2, status: "active", updatedAt: "2026-11-25T10:00:00Z", body: "Lunch?" } };
        case "watch":
          return { ok: true, result: op.rooms.map((r: { roomId: string }) => ({ roomId: r.roomId, armed: op.cancel !== true })) };
        default:
          return { ok: true, result: { did: op.op } };
      }
    },
    canReach: async () => true,
    loadGrants: async () =>
      h.shared
        ? [ROOM, ROOM2].map((roomId) => ({
            origin: PORTAL,
            hostDid: HOST,
            vtaDid: VTA,
            roomId,
            member: MEMBER,
            grantedAt: T0 - 1000,
            expiresAt: T0 + 30 * 86_400_000,
          }))
        : [],
    saveGrants: async () => undefined,
    prompt: async (view) => {
      h.prompts.push(view);
      return h.answer;
    },
    openTransfer: async () => new FakePort(),
    now: () => h.now,
    setTimer: (fn, ms) => {
      const t = setTimeout(fn, Math.min(ms, 5));
      (t as { unref?: () => void }).unref?.();
      return t;
    },
    sessionsChanged: (rows) => void h.badge.push(rows),
  };
  h.gates = new RoomPageGates(deps);
  return h;
}

/** The room open in `session`: a watch port held, as a room page holds one. */
async function openRoom(h: Harness, session: PageSession = TAB, roomId = ROOM): Promise<FakePort> {
  const port = new FakePort();
  h.gates.serveWatchPort(port, PORTAL, session);
  port.receive({ kind: "watch", hostDid: HOST, roomId });
  await sleep(30);
  return port;
}

const message = (h: Harness, session: PageSession | undefined = TAB, body = "hello", roomId = ROOM) =>
  h.gates.handle(PORTAL, { op: "putMessage", hostDid: HOST, roomId, body }, session);
const react = (h: Harness, session: PageSession | undefined = TAB, op: "react" | "unreact" = "react") =>
  h.gates.handle(PORTAL, { op, hostDid: HOST, roomId: ROOM, key: "m1", value: "👍" }, session);
const note = (h: Harness, session: PageSession = TAB) =>
  h.gates.handle(PORTAL, { op: "putNote", hostDid: HOST, roomId: ROOM, title: "Minutes", body: "…" }, session);
const offered = (h: Harness, i = -1) => ((h.prompts.at(i) as RoomWriteConsentView).what as { session?: unknown }).session;

/** Open the room in TAB and grant a session through a message's confirm. */
async function granted(h: Harness): Promise<FakePort> {
  const port = await openRoom(h);
  h.answer = { approved: true, sessionGrant: true };
  assert.ok((await message(h)).ok);
  h.answer = { approved: true };
  assert.equal(h.gates.sessions.list().length, 1);
  return port;
}

test("the box is offered only while the asking document holds the room open", async () => {
  const h = harness();
  await message(h);
  assert.equal(offered(h), undefined, "no watch port: nothing would end it");
  await message(h, undefined);
  assert.equal(offered(h), undefined, "a call with no document");
  await openRoom(h);
  await message(h);
  assert.deepEqual(offered(h), {});
  await react(h);
  assert.deepEqual(offered(h), {}, "a reaction's confirm offers it too, beside the 30-minute reaction box");
  assert.ok(((h.prompts.at(-1) as RoomWriteConsentView).what as { grant?: unknown }).grant);
});

test("only the explicit box grants: approving without it keeps every message confirmed", async () => {
  const h = harness();
  await openRoom(h);
  assert.ok((await message(h)).ok);
  assert.ok((await message(h)).ok);
  assert.equal(h.prompts.length, 2);
  assert.equal(h.gates.sessions.list().length, 0);
  // A denial with the box ticked grants nothing.
  h.answer = { approved: false, sessionGrant: true };
  assert.equal(((await message(h)) as { code?: string }).code, "declined");
  assert.equal(h.gates.sessions.list().length, 0);
  // The consent window passes the box only with an approval.
  const got: unknown[][] = [];
  deliverConsentResult(new Map<string, ConsentDecision>([["c1", (...a) => void got.push(a)]]), {
    consentId: "c1",
    approved: false,
    sessionGrant: true,
  });
  deliverConsentResult(new Map<string, ConsentDecision>([["c2", (...a) => void got.push(a)]]), {
    consentId: "c2",
    approved: true,
    sessionGrant: true,
  });
  assert.equal(got[0]![8], false);
  assert.equal(got[1]![8], true);
});

test("while it is live, messages, replies and reactions run without a window — and notes are still asked", async () => {
  const h = harness();
  await granted(h);
  const before = h.prompts.length;
  assert.ok((await message(h, TAB, "second")).ok);
  assert.ok((await h.gates.handle(PORTAL, { op: "putMessage", hostDid: HOST, roomId: ROOM, body: "re", replyTo: { key: "m1" } }, TAB)).ok);
  assert.ok((await react(h)).ok);
  assert.ok((await react(h, TAB, "unreact")).ok);
  assert.equal(h.prompts.length, before, "no window");
  // Every write still goes as the share's member.
  assert.ok(h.asked.filter((a) => ["putMessage", "react", "unreact"].includes(a.op)).every((a) => a.member === MEMBER));
  await note(h);
  assert.equal(h.prompts.length, before + 1, "a note is always confirmed");
});

test("another room, another member, another tab or the same tab reloaded asks again", async () => {
  const h = harness();
  await granted(h);
  await openRoom(h, TAB, ROOM2);
  const n = h.prompts.length;
  await message(h, TAB, "x", ROOM2);
  assert.equal(h.prompts.length, n + 1, "another room");
  await message(h, { tabId: 8, documentId: "DOC-B" });
  assert.equal(h.prompts.length, n + 2, "another tab");
  await message(h, { tabId: 7, documentId: "DOC-A2" });
  assert.equal(h.prompts.length, n + 3, "the same tab reloaded: a new document");
  // Another member, origin or community is another scope.
  const s = new RoomSessionGrants(() => T0);
  s.roomOpened(TAB, PORTAL, HOST, ROOM);
  const scope = { origin: PORTAL, hostDid: HOST, vtaDid: VTA, roomId: ROOM, member: MEMBER };
  assert.ok(s.grant(scope, TAB));
  assert.equal(s.cover(scope, TAB), "covered");
  assert.equal(s.cover({ ...scope, member: "did:webvh:QmBob:people.example" }, TAB), "none");
  assert.equal(s.cover({ ...scope, origin: "https://elsewhere.example" }, TAB), "none");
  assert.equal(s.cover({ ...scope, vtaDid: "did:key:zOther" }, TAB), "none");
});

test("leaving the room — the watch port closing — ends it", async () => {
  const h = harness();
  const port = await granted(h);
  port.disconnect();
  await message(h, TAB, "after");
  assert.equal(h.gates.sessions.list().length, 0);
  assert.equal(offered(h), undefined, "and with the room closed, nothing is offered");
});

test("two ports for one room in one document: the grant lives until the last closes", async () => {
  const h = harness();
  const a = await granted(h);
  const b = await openRoom(h);
  a.disconnect();
  assert.equal(h.gates.sessions.list().length, 1);
  b.disconnect();
  assert.equal(h.gates.sessions.list().length, 0);
});

test("the tab closing, a lock, Stop, or the share going each end it", async () => {
  for (const end of ["tab", "lock", "stop", "share"] as const) {
    const h = harness();
    await granted(h);
    if (end === "tab") h.gates.sessions.endForTab(TAB.tabId);
    if (end === "lock") h.gates.sessions.endAll();
    if (end === "stop") assert.ok(h.gates.sessions.stop(h.gates.sessions.list()[0]!.id));
    if (end === "share") {
      h.shared = false;
      await h.gates.reviewSessionGrants();
    }
    assert.equal(h.gates.sessions.list().length, 0, end);
  }
});

test("30 minutes without a write ends it; use keeps it, but never past 8 hours", async () => {
  const h = harness();
  await granted(h);
  h.now = T0 + SESSION_GRANT_IDLE_MS - 1000;
  const n = h.prompts.length;
  assert.ok((await message(h)).ok);
  assert.equal(h.prompts.length, n, "still live just inside the idle limit");
  h.now += SESSION_GRANT_IDLE_MS;
  await message(h);
  assert.equal(h.prompts.length, n + 1, "idle: asked again");

  const k = harness();
  await granted(k);
  // A write every 20 minutes keeps it from idling, up to the cap.
  for (let t = 20 * 60_000; t < SESSION_GRANT_CAP_MS; t += 20 * 60_000) {
    k.now = T0 + t;
    await message(k);
  }
  const m = k.prompts.length;
  k.now = T0 + SESSION_GRANT_CAP_MS;
  await message(k);
  assert.equal(k.prompts.length, m + 1, "8 hours: asked again, however used");
});

test("more than the rate in a minute, or a long message, is asked for — and the grant stays", async () => {
  const h = harness();
  await granted(h); // the granting message counts as one
  const n = h.prompts.length;
  for (let i = 1; i < SESSION_GRANT_RATE_LIMIT; i++) await message(h, TAB, `m${i}`);
  assert.equal(h.prompts.length, n);
  await message(h, TAB, "one too many");
  assert.equal(h.prompts.length, n + 1);
  h.now += 61_000;
  await message(h, TAB, "a minute later");
  assert.equal(h.prompts.length, n + 1, "covered again");
  await message(h, TAB, "x".repeat(SESSION_MESSAGE_MAX_CHARS + 1));
  assert.equal(h.prompts.length, n + 2, "a long message is confirmed");
  assert.equal(h.gates.sessions.list().length, 1);
});

test("the badge is told when a grant starts and when it ends", async () => {
  const h = harness();
  const port = await granted(h);
  assert.equal(h.badge.at(-1)?.length, 1);
  port.disconnect();
  assert.equal(h.badge.at(-1)?.length, 0);
});

test("a grant is refused for a document that does not hold the room open", () => {
  const s = new RoomSessionGrants(() => T0);
  const scope = { origin: PORTAL, hostDid: HOST, vtaDid: VTA, roomId: ROOM, member: MEMBER };
  assert.equal(s.grant(scope, TAB), false);
  assert.equal(s.list().length, 0);
});
