// A portal page replies, reacts and watches a room (P7b; VTI `data-rooms-files.md` §8.5).
//
// The same gates as every room call — the page is the community's portal by its
// DID document, the member shared the room with it — then, for a write, the
// room's profile must take what is written (`recordMembersNotListed`, checked
// before the member is asked) and the member confirms it, seeing the record it
// answers or reacts to as the wallet read it, never the page's word. A watch is
// a port: armed through the member's VTA, passed on only for a room the page
// armed and is still shared, cancelled when the port closes.

import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

import { RoomPageGates, type PortLike, type RoomPageBackgroundDeps } from "../src/room-page-background.ts";
import {
  glimpseOf,
  roomWatchPageOpenRefusal,
  roomsPageParamsRefusal,
  type RoomShareConsentView,
  type RoomWriteConsentView,
} from "../src/room-page-policy.ts";
import { WALLET_ERROR_CODES } from "../src/page-error.ts";

const PORTAL = "https://members.northwind.example";
const HOST = "did:webvh:QmHost:northwind.example";
const VTA = "did:webvh:QmAgent:agent.example";
const ROOM = "did:webvh:QmRoom:rooms.example";
const MEMBER = "did:webvh:QmAlice:people.example";
const BOB = "did:webvh:QmBob:people.example";
const NOW = 1_800_000_000_000;

class FakePort implements PortLike {
  posted: unknown[] = [];
  connected = true;
  private onMsg: ((m: unknown) => void)[] = [];
  private onDisc: (() => void)[] = [];
  postMessage(m: unknown) {
    this.posted.push(m);
  }
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
  answer: { approved: boolean; selectedRooms?: string[] };
  recordMembers: string[];
  /** What the VTA answers a watch request with, per room. */
  watch: (rooms: { roomId: string }[], cancel: boolean) => unknown;
  shared: boolean;
}

function harness(over: Partial<RoomPageBackgroundDeps> = {}): Harness {
  const h: Harness = {
    gates: undefined as never,
    prompts: [],
    asked: [],
    answer: { approved: true },
    recordMembers: ["kind", "inReplyTo", "writtenAt"],
    watch: (rooms, cancel) => rooms.map((r) => ({ roomId: r.roomId, armed: !cancel, ...(!cancel ? { expiresAt: "2030-01-01T00:00:00Z" } : {}) })),
    shared: true,
  };
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
          return { ok: true, result: h.recordMembers };
        case "read":
          return {
            ok: true,
            result: { key: op.key, version: 2, status: "active", updatedAt: "2026-11-25T10:00:00Z", author: BOB, kind: "message", body: "Lunch at one?" },
          };
        case "watch":
          return { ok: true, result: h.watch(op.rooms, op.cancel === true) };
        default:
          return { ok: true, result: { did: op.op } };
      }
    },
    canReach: async () => true,
    loadGrants: async () =>
      h.shared
        ? [{ origin: PORTAL, hostDid: HOST, vtaDid: VTA, roomId: ROOM, member: MEMBER, grantedAt: NOW - 1000, expiresAt: NOW + 86_400_000 }]
        : [],
    saveGrants: async () => undefined,
    prompt: async (view) => {
      h.prompts.push(view);
      return h.answer;
    },
    openTransfer: async () => new FakePort(),
    now: () => NOW,
    setTimer: (fn, ms) => {
      const t = setTimeout(fn, ms);
      (t as { unref?: () => void }).unref?.();
      return t;
    },
    ...over,
  };
  h.gates = new RoomPageGates(deps);
  return h;
}

const writes = (h: Harness) => h.asked.filter((a) => ["putMessage", "react", "unreact"].includes(a.op));

// ── Shapes ──────────────────────────────────────────────────────────────────

test("a reply, a reaction and a watch are checked for shape before anything else", () => {
  const ok = { hostDid: HOST, roomId: ROOM };
  assert.equal(roomsPageParamsRefusal({ op: "putMessage", ...ok, body: "Yes", replyTo: { key: "m1", version: 2 } }), null);
  assert.match(roomsPageParamsRefusal({ op: "putMessage", ...ok, body: "Yes", replyTo: { key: "" } })!, /replyTo.key is required/);
  assert.match(roomsPageParamsRefusal({ op: "putMessage", ...ok, body: "Yes", replyTo: { key: "m", extra: 1 } })!, /replyTo must be/);
  assert.match(roomsPageParamsRefusal({ op: "putMessage", ...ok, body: "Yes", replyTo: { key: "m", version: 0 } })!, /version/);
  assert.equal(roomsPageParamsRefusal({ op: "react", ...ok, key: "m1", value: "👍" }), null);
  assert.match(roomsPageParamsRefusal({ op: "react", ...ok, key: "m1", value: " " })!, /value is required/);
  assert.match(roomsPageParamsRefusal({ op: "react", ...ok, key: "m1", value: "a\nb" })!, /line break/);
  assert.match(roomsPageParamsRefusal({ op: "react", ...ok, key: "m1", value: "x".repeat(65) })!, /longer than 64/);
  assert.match(roomsPageParamsRefusal({ op: "react", ...ok, value: "👍" })!, /key is required/);
  assert.equal(roomsPageParamsRefusal({ op: "unreact", ...ok, key: "m1", value: "👍" }), null);
  assert.equal(roomWatchPageOpenRefusal({ kind: "watch", ...ok, sinceVersion: 12 }), null);
  assert.match(roomWatchPageOpenRefusal({ kind: "watch", ...ok, sinceVersion: -1 })!, /whole number/);
  assert.match(roomWatchPageOpenRefusal({ kind: "watch", ...ok, member: MEMBER })!, /only/);
  assert.match(roomWatchPageOpenRefusal({ kind: "read" })!, /starts with watch/);
});

test("recordMembersNotListed is a wallet code, documented with the same words", () => {
  assert.ok("recordMembersNotListed" in WALLET_ERROR_CODES);
  const doc = readFileSync(fileURLToPath(new URL("../../../docs/page-bridge-errors.md", import.meta.url)), "utf8");
  assert.match(doc, /\| `recordMembersNotListed` \|/);
});

test("a prompt names another record by its title, else its text, else its file — bounded", () => {
  assert.deepEqual(glimpseOf({ author: BOB, body: "a\n  b" }), { author: BOB, excerpt: "a b" });
  assert.equal(glimpseOf({ title: "T", body: "b" }).excerpt, "T");
  assert.equal(glimpseOf({ file: { name: "f.pdf" } }).excerpt, "f.pdf");
  assert.equal([...glimpseOf({ body: "x".repeat(500) }).excerpt].length, 121);
});

// ── A reply ─────────────────────────────────────────────────────────────────

test("a reply is confirmed showing what it answers, as the wallet read it — never the page's word", async () => {
  const h = harness();
  const res = await h.gates.handle(PORTAL, { op: "putMessage", hostDid: HOST, roomId: ROOM, body: "Yes", replyTo: { key: "m1", version: 2 } });
  assert.ok(res.ok);
  const view = h.prompts.at(-1) as RoomWriteConsentView;
  assert.deepEqual(view.what, { message: true, excerpt: "Yes", bodyChars: 3, replyingTo: { author: BOB, excerpt: "Lunch at one?" } });
  const read = h.asked.find((a) => a.op === "read");
  assert.deepEqual(read, { op: "read", hostDid: HOST, roomId: ROOM, member: MEMBER, key: "m1" }, "read as the share's member");
  const put = writes(h)[0];
  assert.deepEqual(put, { op: "putMessage", hostDid: HOST, roomId: ROOM, member: MEMBER, body: "Yes", replyTo: { key: "m1", version: 2 } });
});

test("a reply in a room that takes none is refused before the member is asked, and nothing is written", async () => {
  const h = harness();
  h.recordMembers = ["kind", "writtenAt"];
  const res = await h.gates.handle(PORTAL, { op: "putMessage", hostDid: HOST, roomId: ROOM, body: "Yes", replyTo: { key: "m1" } });
  assert.equal(res.ok, false);
  assert.equal((res as { code?: string }).code, "recordMembersNotListed");
  assert.equal(h.prompts.length, 0, "nobody was asked");
  assert.deepEqual(writes(h), []);
  // A message that answers nothing is not held to it.
  const plain = await h.gates.handle(PORTAL, { op: "putMessage", hostDid: HOST, roomId: ROOM, body: "Yes" });
  assert.ok(plain.ok);
  assert.ok(!h.asked.some((a) => a.op === "recordMembers" && h.asked.indexOf(a) > 3), "no profile check for a plain message");
});

test("a reply to a room not shared with the page is refused, and the room is not read", async () => {
  const h = harness();
  h.shared = false;
  const res = await h.gates.handle(PORTAL, { op: "putMessage", hostDid: HOST, roomId: ROOM, body: "Yes", replyTo: { key: "m1" } });
  assert.equal((res as { code?: string }).code, "notShared");
  assert.ok(!h.asked.some((a) => a.op === "read" || a.op === "recordMembers"));
});

// ── A reaction ──────────────────────────────────────────────────────────────

test("a reaction is confirmed — the value and the record it is on — and only then written", async () => {
  const h = harness();
  h.answer = { approved: false };
  const denied = await h.gates.handle(PORTAL, { op: "react", hostDid: HOST, roomId: ROOM, key: "m1", version: 2, value: "👍" });
  assert.deepEqual(denied, { ok: false, error: "the member declined to react", code: "declined" });
  assert.deepEqual(writes(h), []);
  assert.deepEqual((h.prompts.at(-1) as RoomWriteConsentView).what, {
    reaction: true,
    value: "👍",
    on: { author: BOB, excerpt: "Lunch at one?" },
    grant: { minutes: 30 },
  });

  h.answer = { approved: true };
  const ok = await h.gates.handle(PORTAL, { op: "react", hostDid: HOST, roomId: ROOM, key: "m1", version: 2, value: "👍" });
  assert.ok(ok.ok);
  assert.deepEqual(writes(h)[0], { op: "react", hostDid: HOST, roomId: ROOM, member: MEMBER, target: { key: "m1", version: 2 }, value: "👍" });
});

test("a reaction in a room without kind and inReplyTo is refused before the member is asked", async () => {
  for (const recordMembers of [[], ["kind"], ["inReplyTo"]]) {
    const h = harness();
    h.recordMembers = recordMembers;
    const res = await h.gates.handle(PORTAL, { op: "react", hostDid: HOST, roomId: ROOM, key: "m1", value: "👍" });
    assert.equal((res as { code?: string }).code, "recordMembersNotListed");
    assert.equal(h.prompts.length, 0);
    assert.deepEqual(writes(h), []);
  }
});

test("taking a reaction back is confirmed as that, and names the record and the value", async () => {
  const h = harness();
  const res = await h.gates.handle(PORTAL, { op: "unreact", hostDid: HOST, roomId: ROOM, key: "m1", value: "👍" });
  assert.ok(res.ok);
  assert.deepEqual((h.prompts.at(-1) as RoomWriteConsentView).what, {
    reaction: true,
    value: "👍",
    on: { author: BOB, excerpt: "Lunch at one?" },
    withdraw: true,
    grant: { minutes: 30 },
  });
  assert.deepEqual(writes(h)[0], { op: "unreact", hostDid: HOST, roomId: ROOM, member: MEMBER, target: "m1", value: "👍" });
});

// ── A watch ─────────────────────────────────────────────────────────────────

const state = (p: FakePort) => p.posted.filter((m) => (m as { kind: string }).kind === "state").map((m) => (m as { state: string }).state);
const watchAsks = (h: Harness) => h.asked.filter((a) => a.op === "watch");

test("a watch is armed through the member's VTA as the share's member, and its signal reaches the page — nothing else of it", async () => {
  const h = harness();
  const page = new FakePort();
  h.gates.serveWatchPort(page, PORTAL);
  page.receive({ kind: "watch", hostDid: HOST, roomId: ROOM, sinceVersion: 40 });
  await sleep(80);
  assert.deepEqual(watchAsks(h)[0], {
    op: "watch",
    hostDid: HOST,
    member: MEMBER,
    rooms: [{ roomId: ROOM, sinceVersion: 40 }],
    leaseSeconds: 86_400,
  });
  assert.deepEqual(state(page), ["arming", "armed"]);

  assert.equal(h.gates.deliverRoomSignal(VTA, { roomId: ROOM, member: MEMBER, host: HOST, latestVersion: 43 }), true);
  await sleep(0);
  assert.deepEqual(page.posted.at(-1), { kind: "changed", latestVersion: 43 });
  assert.equal(state(page).at(-1), "fired");

  // Fired once: a second signal before the page reads again is dropped.
  assert.equal(h.gates.deliverRoomSignal(VTA, { roomId: ROOM, member: MEMBER, host: HOST, latestVersion: 44 }), false);

  // The page read the room: armed again from there.
  page.receive({ kind: "read", version: 43 });
  await sleep(80);
  assert.deepEqual(watchAsks(h).at(-1)?.rooms, [{ roomId: ROOM, sinceVersion: 43 }]);
  assert.equal(state(page).at(-1), "armed");
});

test("a signal for a watch no page armed, or for another member or host, goes nowhere", async () => {
  const h = harness();
  assert.equal(h.gates.deliverRoomSignal(VTA, { roomId: ROOM, member: MEMBER, host: HOST, latestVersion: 1 }), false);
  const page = new FakePort();
  h.gates.serveWatchPort(page, PORTAL);
  page.receive({ kind: "watch", hostDid: HOST, roomId: ROOM });
  await sleep(80);
  assert.equal(h.gates.deliverRoomSignal(VTA, { roomId: ROOM, member: BOB, host: HOST, latestVersion: 1 }), false);
  assert.equal(h.gates.deliverRoomSignal(VTA, { roomId: ROOM, member: MEMBER, host: "did:web:other.example", latestVersion: 1 }), false);
  assert.equal(h.gates.deliverRoomSignal("did:key:zOtherVta", { roomId: ROOM, member: MEMBER, host: HOST, latestVersion: 1 }), false);
  assert.ok(!page.posted.some((m) => (m as { kind: string }).kind === "changed"));
});

test("closing the port cancels the watch at the VTA", async () => {
  const h = harness();
  const page = new FakePort();
  h.gates.serveWatchPort(page, PORTAL);
  page.receive({ kind: "watch", hostDid: HOST, roomId: ROOM });
  await sleep(80);
  page.disconnect();
  await sleep(80);
  const cancel = watchAsks(h).at(-1);
  assert.equal(cancel?.cancel, true);
  assert.deepEqual(cancel?.rooms, [{ roomId: ROOM }]);
  assert.equal(h.gates.deliverRoomSignal(VTA, { roomId: ROOM, member: MEMBER, host: HOST, latestVersion: 9 }), false);
});

test("two pages on one room share its watch; the last to close cancels it", async () => {
  const h = harness();
  const a = new FakePort();
  const b = new FakePort();
  h.gates.serveWatchPort(a, PORTAL);
  h.gates.serveWatchPort(b, PORTAL);
  a.receive({ kind: "watch", hostDid: HOST, roomId: ROOM });
  b.receive({ kind: "watch", hostDid: HOST, roomId: ROOM });
  await sleep(80);
  assert.equal(h.gates.deliverRoomSignal(VTA, { roomId: ROOM, member: MEMBER, host: HOST, latestVersion: 5 }), true);
  await sleep(0);
  for (const p of [a, b]) assert.deepEqual(p.posted.filter((m) => (m as { kind: string }).kind === "changed"), [{ kind: "changed", latestVersion: 5 }]);
  // The signal spent that arming; a read arms it again (a fired watch has nothing to cancel).
  b.receive({ kind: "read", version: 5 });
  await sleep(80);
  a.disconnect();
  await sleep(80);
  assert.ok(!watchAsks(h).some((w) => w.cancel), "still held by the other page");
  b.disconnect();
  await sleep(80);
  assert.ok(watchAsks(h).some((w) => w.cancel));
});

test("a page that is not the portal, or a room not shared, gets no watch — and the VTA is not asked", async () => {
  for (const [origin, shared, code] of [
    ["https://evil.example", true, "originNotPermitted"],
    [PORTAL, false, "notShared"],
  ] as const) {
    const h = harness();
    h.shared = shared;
    const page = new FakePort();
    h.gates.serveWatchPort(page, origin);
    page.receive({ kind: "watch", hostDid: HOST, roomId: ROOM });
    await sleep(80);
    assert.deepEqual(watchAsks(h), []);
    assert.equal((page.posted[0] as { kind: string; code: string }).code, code);
    assert.equal(page.connected, false, "the port is closed");
  }
});

test("a signal after the share was taken back is not passed on, and the watch ends", async () => {
  const h = harness();
  const page = new FakePort();
  h.gates.serveWatchPort(page, PORTAL);
  page.receive({ kind: "watch", hostDid: HOST, roomId: ROOM });
  await sleep(80);
  h.shared = false;
  h.gates.deliverRoomSignal(VTA, { roomId: ROOM, member: MEMBER, host: HOST, latestVersion: 7 });
  await sleep(80);
  assert.ok(!page.posted.some((m) => (m as { kind: string }).kind === "changed"));
  assert.equal((page.posted.at(-1) as { code?: string }).code, "notShared");
  assert.equal(page.connected, false);
});

test("a VTA that cannot watch leaves the page told so — it falls back to reading on a timer", async () => {
  const h = harness();
  h.watch = () => {
    throw new Error("unsupportedType");
  };
  const page = new FakePort();
  h.gates.serveWatchPort(page, PORTAL);
  page.receive({ kind: "watch", hostDid: HOST, roomId: ROOM });
  await sleep(80);
  assert.equal(state(page).at(-1), "unavailable");
  assert.equal(page.connected, true, "the port stays: a later read may arm it");
});

test("after it starts, a watch takes only read and ping", async () => {
  const h = harness();
  const page = new FakePort();
  h.gates.serveWatchPort(page, PORTAL);
  page.receive({ kind: "watch", hostDid: HOST, roomId: ROOM });
  await sleep(80);
  page.receive({ kind: "ping" });
  assert.equal(page.connected, true);
  page.receive({ kind: "watch", hostDid: HOST, roomId: "did:webvh:QmElse:rooms.example" });
  assert.equal(page.connected, false, "a second room on one port is refused");
  assert.equal((page.posted.at(-1) as { code?: string }).code, "invalidCall");
});

test("the content script's inlined port names match the protocol's", () => {
  const read = (n: string) => readFileSync(fileURLToPath(new URL(`../src/${n}`, import.meta.url)), "utf8");
  const content = read("content.ts");
  const protocol = read("bridge-protocol.ts");
  for (const name of ["ROOM_FILES_PAGE_PORT", "ROOM_WATCH_PAGE_PORT"]) {
    const re = new RegExp(`const ${name} =\\s*"([^"]+)"`);
    assert.equal(re.exec(content)?.[1], re.exec(protocol)?.[1], name);
  }
});

// ── The offscreen half ─────────────────────────────────────────────────────

import { runRoomsPageOp } from "../src/room-page-offscreen.ts";

const OPEN_ROOM = "did:webvh:QmOpen:rooms.example";

/** An open room whose records are `records` (cleartext, by `author`), as the member's VTA lists and reads them. */
function openRoomDeps(records: { key: string; version: number; author: string; cleartext: Record<string, unknown> }[]) {
  const sent: Record<string, unknown>[] = [];
  const vtaAsked: string[] = [];
  const deps = {
    agent: async () => ({
      holderDid: "did:key:zWallet",
      sender: {
        async send<Res>(envelope: { type: string; payload: Record<string, unknown> & { document?: Record<string, unknown> } }) {
          vtaAsked.push(envelope.type);
          if (envelope.type.includes("rooms/keys/profile/read/")) {
            return { roomId: OPEN_ROOM, status: "found", profile: { name: "R", recordMembers: ["kind", "inReplyTo"] } } as Res;
          }
          if (envelope.type.includes("rooms/keys/browse/")) {
            return {
              roomId: OPEN_ROOM,
              records: records.map((r) => ({ key: r.key, version: r.version, status: "active", author: r.author, updatedAt: "2026-11-25T10:00:00Z" })),
              complete: true,
              verification: { priorRoots: "noneHeld", count: "agrees" },
            } as Res;
          }
          if (envelope.type.includes("rooms/keys/read/")) {
            const keys = envelope.payload.keys as string[];
            return {
              roomId: OPEN_ROOM,
              results: keys.map((k) => {
                const r = records.find((x) => x.key === k)!;
                return { key: r.key, version: r.version, status: "active", author: r.author, updatedAt: "2026-11-25T10:00:00Z", cleartext: r.cleartext };
              }),
            } as Res;
          }
          if (!envelope.type.includes("rooms/keys/act/")) throw new Error(`unexpected ${envelope.type}`);
          const doc = structuredClone(envelope.payload.document!);
          doc.proof = { type: "DataIntegrityProof" };
          return { principal: doc.issuer, document: doc } as Res;
        },
      } as never,
    }),
    portal: async () => ({ portalOrigin: PORTAL, endpoint: `${PORTAL}/v1/trust-tasks` }),
    completed: () => ({
      async sendCompleted<Res>(doc: Record<string, unknown>) {
        sent.push(doc);
        const type = String(doc.type);
        const payload = doc.payload as { roomId: string; key?: string };
        if (type.includes("rooms/info/")) return { roomId: payload.roomId, visibility: "open", epoch: 1, limits: {}, usage: {} } as Res;
        if (type.includes("rooms/records/put/")) return { key: payload.key, version: 9 } as Res;
        throw new Error(`unexpected ${type}`);
      },
    }),
  };
  return { deps, sent, vtaAsked };
}
const putsOf = (sent: Record<string, unknown>[]) =>
  sent.filter((d) => String(d.type).includes("rooms/records/put/")).map((d) => d.payload as Record<string, unknown>);

test("offscreen react writes a reaction record naming the target, as the member", async () => {
  const r = openRoomDeps([]);
  const out = await runRoomsPageOp(r.deps as never, { vtaDid: VTA }, {
    op: "react",
    hostDid: HOST,
    roomId: OPEN_ROOM,
    member: MEMBER,
    target: { key: "m1", version: 2 },
    value: "👍",
  });
  const [put] = putsOf(r.sent);
  assert.deepEqual(put!.cleartext, { body: "👍", kind: "reaction", inReplyTo: { key: "m1", version: 2 } });
  assert.equal(put!.expectedVersion, 0);
  assert.deepEqual(out, { key: put!.key, version: 9 });
});

test("offscreen unreact withdraws exactly the member's own reactions with that value on that record", async () => {
  const r = openRoomDeps([
    { key: "m1", version: 1, author: BOB, cleartext: { body: "hi", kind: "message" } },
    { key: "mine", version: 3, author: MEMBER, cleartext: { body: "👍", kind: "reaction", inReplyTo: { key: "m1" } } },
    { key: "mine-heart", version: 4, author: MEMBER, cleartext: { body: "❤️", kind: "reaction", inReplyTo: { key: "m1" } } },
    { key: "bobs", version: 5, author: BOB, cleartext: { body: "👍", kind: "reaction", inReplyTo: { key: "m1" } } },
  ]);
  const out = await runRoomsPageOp(r.deps as never, { vtaDid: VTA }, {
    op: "unreact",
    hostDid: HOST,
    roomId: OPEN_ROOM,
    member: MEMBER,
    target: "m1",
    value: "👍",
  });
  assert.deepEqual(out, { withdrawn: 1 });
  const puts = putsOf(r.sent);
  assert.equal(puts.length, 1);
  assert.equal(puts[0]!.key, "mine");
  assert.equal(puts[0]!.expectedVersion, 3, "over the version read");
  assert.deepEqual(puts[0]!.cleartext, { body: "", kind: "reaction", inReplyTo: { key: "m1" } });
});

test("offscreen unreact with nothing to take back writes nothing", async () => {
  const r = openRoomDeps([{ key: "m1", version: 1, author: BOB, cleartext: { body: "hi", kind: "message" } }]);
  const out = await runRoomsPageOp(r.deps as never, { vtaDid: VTA }, {
    op: "unreact",
    hostDid: HOST,
    roomId: OPEN_ROOM,
    member: MEMBER,
    target: "m1",
    value: "👍",
  });
  assert.deepEqual(out, { withdrawn: 0 });
  assert.deepEqual(putsOf(r.sent), []);
});

test("offscreen watch asks the member's VTA, as the wallet, naming the member and host", async () => {
  const asked: { type: string; payload: Record<string, unknown> }[] = [];
  const out = await runRoomsPageOp(
    {
      agent: async () => ({
        holderDid: "did:key:zWallet",
        sender: {
          async send<Res>(envelope: { type: string; payload: Record<string, unknown> }) {
            asked.push(envelope);
            return { member: MEMBER, host: HOST, watches: [{ roomId: ROOM, armed: true, expiresAt: "2030-01-01T00:00:00Z" }] } as Res;
          },
        } as never,
      }),
    },
    { vtaDid: VTA },
    { op: "watch", hostDid: HOST, member: MEMBER, rooms: [{ roomId: ROOM, sinceVersion: 3 }], leaseSeconds: 3600 },
  );
  assert.match(asked[0]!.type, /rooms\/keys\/watch\/0\.1/);
  assert.deepEqual(asked[0]!.payload, { member: MEMBER, host: HOST, rooms: [{ roomId: ROOM, sinceVersion: 3 }], leaseSeconds: 3600 });
  assert.deepEqual(out, [{ roomId: ROOM, armed: true, expiresAt: "2030-01-01T00:00:00Z" }]);
});
