// A portal page's `window.vtaWallet.rooms.*` (P7b; VTI `data-rooms-files.md` §8.5).
//
// The gates run here as they run in the background, against fakes for the
// browser and the offscreen document: the page must be the community's portal
// by its DID document, the room must have been shared with that origin by the
// member, every write is confirmed, and a download's bytes reach the page only
// after the whole file verified.

import test from "node:test";
import assert from "node:assert/strict";

import { RoomPageGates, type PortLike, type RoomPageBackgroundDeps } from "../src/room-page-background.ts";
import {
  ROOM_GRANT_TTL_MS,
  liveGrants,
  portalRefusal,
  roomFilesPageOpenRefusal,
  roomGrantRefusal,
  roomsPageParamsRefusal,
  shareRefusal,
  withGrants,
  type RoomGrant,
  type RoomShareConsentView,
  type RoomWriteConsentView,
} from "../src/room-page-policy.ts";
import { readView } from "../src/room-page-offscreen.ts";
import { signRecordBody } from "@openvtc/pnm-core/rooms/files";
import { signingIdentityFromSecret } from "@openvtc/pnm-core";

const PORTAL = "https://members.northwind.example";
const HOST = "did:webvh:QmHost:northwind.example";
const VTA = "did:webvh:QmAgent:agent.example";
const ROOM = "did:webvh:QmRoom:rooms.example";
const OTHER_ROOM = "did:webvh:QmOther:rooms.example";
const PRIVATE_ROOM = "did:webvh:QmPrivate:rooms.example";
const MEMBER = "did:webvh:QmAlice:people.example";
const NOW = 1_800_000_000_000;

// ── The policy ──────────────────────────────────────────────────────────────

test("a page call is checked for shape before anything else", () => {
  assert.equal(roomsPageParamsRefusal({ op: "list", hostDid: HOST }), null);
  assert.match(roomsPageParamsRefusal({ op: "list", hostDid: "https://x" })!, /hostDid must be a DID/);
  assert.match(roomsPageParamsRefusal({ op: "present", hostDid: HOST })!, /unknown operation present/);
  assert.match(roomsPageParamsRefusal({ op: "read", hostDid: HOST, roomId: ROOM })!, /key is required/);
  assert.match(roomsPageParamsRefusal({ op: "putNote", hostDid: HOST, roomId: ROOM, title: " " })!, /title is required/);
  assert.match(
    roomsPageParamsRefusal({ op: "putNote", hostDid: HOST, roomId: ROOM, title: "t", tags: new Array(33).fill("x") })!,
    /at most 32/,
  );
  assert.match(roomFilesPageOpenRefusal({ kind: "put", hostDid: HOST, roomId: ROOM, name: "a", size: 65 * 1024 * 1024 })!, /more than/);
  assert.equal(roomFilesPageOpenRefusal({ kind: "get", hostDid: HOST, roomId: ROOM, key: "k" }), null);
});

test("only the community's own portal origin, compared exactly", () => {
  assert.equal(portalRefusal(PORTAL, HOST, PORTAL), null);
  for (const o of ["http://members.northwind.example", "https://members.northwind.example:8443", "https://evil.example"]) {
    assert.match(portalRefusal(o, HOST, PORTAL)!, /is not .*portal/);
  }
});

test("a grant is for one origin, community, VTA and room, and lapses", () => {
  const at = { origin: PORTAL, hostDid: HOST, vtaDid: VTA };
  const grants = withGrants([], at, [ROOM], NOW);
  assert.equal(roomGrantRefusal(grants, at, ROOM, NOW), null);
  assert.ok(roomGrantRefusal(grants, at, OTHER_ROOM, NOW));
  assert.ok(roomGrantRefusal(grants, { ...at, origin: "https://evil.example" }, ROOM, NOW));
  assert.ok(roomGrantRefusal(grants, { ...at, vtaDid: "did:key:zOtherVta" }, ROOM, NOW));
  assert.ok(roomGrantRefusal(grants, at, ROOM, NOW + ROOM_GRANT_TTL_MS + 1), "a lapsed share is no share");
  // One sentence whatever the reason, so a page learns nothing about rooms it was not given.
  assert.equal(roomGrantRefusal([], at, OTHER_ROOM, NOW), roomGrantRefusal(grants, at, OTHER_ROOM, NOW));
});

test("a private room is never shared with a portal page", () => {
  assert.match(shareRefusal("private")!, /private room/);
  assert.equal(shareRefusal("attributed"), null);
});

// ── The gates ───────────────────────────────────────────────────────────────

interface Harness {
  gates: RoomPageGates;
  grants: Map<string, RoomGrant[]>;
  prompts: (RoomShareConsentView | RoomWriteConsentView)[];
  asked: { op: string; [k: string]: unknown }[];
  answer: { approved: boolean; selectedRooms?: string[] };
  inner: FakePort[];
}

function harness(over: Partial<RoomPageBackgroundDeps> = {}): Harness {
  const h: Harness = {
    gates: undefined as never,
    grants: new Map(),
    prompts: [],
    asked: [],
    answer: { approved: true },
    inner: [],
  };
  const deps: RoomPageBackgroundDeps = {
    active: async () => ({ ok: true, vta: { vtaDid: VTA } }),
    async offscreen(_vta, op) {
      h.asked.push(op as never);
      switch (op.op) {
        case "portal":
          return { ok: true, result: { portalOrigin: PORTAL, endpoint: `${PORTAL}/v1/trust-tasks` } };
        case "held":
          return {
            ok: true,
            result: [ROOM, OTHER_ROOM, PRIVATE_ROOM].map((roomId) => ({ roomId, epoch: 3, earliestReadableEpoch: 1 })),
          };
        case "info":
          if (op.roomId === OTHER_ROOM) return { ok: false, error: "rooms/info: notFound" };
          return {
            ok: true,
            result: {
              roomId: op.roomId,
              visibility: op.roomId === PRIVATE_ROOM ? "private" : "attributed",
              epoch: 3,
              member: MEMBER,
              limits: {},
              usage: {},
            },
          };
        default:
          return { ok: true, result: { did: op.op } };
      }
    },
    canReach: async () => true,
    loadGrants: async (origin, vtaDid) => h.grants.get(`${origin}|${vtaDid}`) ?? [],
    saveGrants: async (origin, vtaDid, g) => void h.grants.set(`${origin}|${vtaDid}`, g),
    prompt: async (view) => {
      h.prompts.push(view);
      return h.answer;
    },
    openTransfer: async () => {
      const p = new FakePort();
      h.inner.push(p);
      return p;
    },
    now: () => NOW,
    ...over,
  };
  h.gates = new RoomPageGates(deps);
  return h;
}

test("a page that is not the community's portal gets nothing, and no prompt", async () => {
  const h = harness();
  const res = await h.gates.handle("https://evil.example", { op: "choose", hostDid: HOST });
  assert.equal(res.ok, false);
  assert.equal(h.prompts.length, 0);
  assert.ok(!h.asked.some((a) => a.op === "held"), "the member's rooms were not even listed");
});

test("choose shares what the member ticks, checked with the host, and never a private room", async () => {
  const h = harness();
  h.answer = { approved: true, selectedRooms: [ROOM, OTHER_ROOM, PRIVATE_ROOM, "did:key:zNotOffered"] };
  const res = await h.gates.handle(PORTAL, { op: "choose", hostDid: HOST, suggest: ROOM });
  assert.ok(res.ok);
  const { rooms, refused } = res.result as { rooms: { roomId: string }[]; refused: { roomId: string; reason: string }[] };
  assert.deepEqual(rooms.map((r) => r.roomId), [ROOM]);
  assert.deepEqual(refused.map((r) => r.roomId).sort(), [OTHER_ROOM, PRIVATE_ROOM].sort());
  const view = h.prompts[0] as RoomShareConsentView;
  assert.equal(view.kind, "share");
  assert.ok(view.rooms.find((r) => r.roomId === ROOM)!.suggested);

  // Unticking a shared room unshares it.
  h.answer = { approved: true, selectedRooms: [] };
  const again = await h.gates.handle(PORTAL, { op: "choose", hostDid: HOST });
  assert.ok(again.ok);
  assert.deepEqual((again.result as { rooms: unknown[] }).rooms, []);
});

test("list never prompts, and reads need a share", async () => {
  const h = harness();
  const list = await h.gates.handle(PORTAL, { op: "list", hostDid: HOST });
  assert.deepEqual(list, { ok: true, result: { rooms: [] } });
  const read = await h.gates.handle(PORTAL, { op: "read", hostDid: HOST, roomId: ROOM, key: "k" });
  assert.equal(read.ok, false);
  assert.ok(!h.asked.some((a) => a.op === "read"));

  h.answer = { approved: true, selectedRooms: [ROOM] };
  await h.gates.handle(PORTAL, { op: "choose", hostDid: HOST });
  const prompts = h.prompts.length;
  const ok = await h.gates.handle(PORTAL, { op: "read", hostDid: HOST, roomId: ROOM, key: "k" });
  assert.ok(ok.ok);
  assert.equal(h.prompts.length, prompts, "a read rides the share, with no prompt");
});

test("every note is confirmed, showing who signs and what is written", async () => {
  const h = harness();
  h.answer = { approved: true, selectedRooms: [ROOM] };
  await h.gates.handle(PORTAL, { op: "choose", hostDid: HOST });

  h.answer = { approved: false };
  const denied = await h.gates.handle(PORTAL, { op: "putNote", hostDid: HOST, roomId: ROOM, title: "Pricing", body: "Hold." });
  assert.deepEqual(denied, { ok: false, error: "the member declined to add this note" });
  assert.ok(!h.asked.some((a) => a.op === "putNote"), "nothing was written");
  const view = h.prompts.at(-1) as RoomWriteConsentView;
  assert.equal(view.kind, "write");
  assert.equal(view.member, MEMBER);
  assert.deepEqual(view.what, { note: true, title: "Pricing", excerpt: "Hold.", bodyChars: 5 });

  h.answer = { approved: true };
  const ok = await h.gates.handle(PORTAL, { op: "putNote", hostDid: HOST, roomId: ROOM, title: "Pricing", body: "Hold." });
  assert.ok(ok.ok);
  assert.ok(h.asked.some((a) => a.op === "putNote"));
});

// ── Files ───────────────────────────────────────────────────────────────────

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
  /** Deliver `m` as if from the other end. */
  receive(m: unknown) {
    for (const f of this.onMsg) f(m);
  }
}

const settle = () => new Promise((r) => setTimeout(r, 0));

async function sharedHarness(): Promise<Harness> {
  const h = harness();
  h.answer = { approved: true, selectedRooms: [ROOM] };
  await h.gates.handle(PORTAL, { op: "choose", hostDid: HOST });
  return h;
}

test("a download's bytes reach the page only after the whole file verified", async () => {
  const h = await sharedHarness();
  const page = new FakePort();
  h.gates.servePort(page, PORTAL);
  page.receive({ kind: "get", hostDid: HOST, roomId: ROOM, key: "k" });
  await settle();
  const inner = h.inner[0]!;
  assert.deepEqual(inner.posted[0], { kind: "get", vtaDid: VTA, roomId: ROOM, hostDid: HOST, key: "k" });

  inner.receive({ kind: "provisional", data: "AAAA" });
  inner.receive({ kind: "progress", stage: "downloading", done: 1, total: 2 });
  assert.ok(!page.posted.some((m) => (m as { kind: string }).kind === "data"), "nothing provisional is posted");
  inner.receive({ kind: "provisional", data: "BBBB" });
  inner.receive({ kind: "got", file: { name: "a.pdf", size: 6 }, author: MEMBER, version: 2 });
  const kinds = page.posted.map((m) => (m as { kind: string }).kind);
  assert.deepEqual(kinds, ["progress", "got", "data", "data", "done"]);
  assert.equal(page.connected, false);
});

test("a download that fails releases nothing to the page", async () => {
  const h = await sharedHarness();
  const page = new FakePort();
  h.gates.servePort(page, PORTAL);
  page.receive({ kind: "get", hostDid: HOST, roomId: ROOM, key: "k" });
  await settle();
  h.inner[0]!.receive({ kind: "provisional", data: "AAAA" });
  h.inner[0]!.receive({ kind: "failed", error: "chunk 1 does not match the manifest" });
  assert.deepEqual(page.posted.map((m) => (m as { kind: string }).kind), ["failed"]);
});

test("a file from a room not shared, or another origin, is refused before the offscreen document is asked", async () => {
  const h = await sharedHarness();
  for (const [origin, roomId] of [["https://evil.example", ROOM], [PORTAL, OTHER_ROOM]] as const) {
    const page = new FakePort();
    h.gates.servePort(page, origin);
    page.receive({ kind: "get", hostDid: HOST, roomId, key: "k" });
    await settle();
    assert.equal((page.posted[0] as { kind: string }).kind, "failed");
  }
  assert.equal(h.inner.length, 0);
});

test("an upload is confirmed, then its bytes are sent, and the record comes back", async () => {
  const h = await sharedHarness();
  const page = new FakePort();
  h.gates.servePort(page, PORTAL);
  page.receive({ kind: "put", hostDid: HOST, roomId: ROOM, name: "terms.pdf", size: 3, mediaType: "application/pdf" });
  await settle();
  const view = h.prompts.at(-1) as RoomWriteConsentView;
  assert.deepEqual(view.what, { file: true, name: "terms.pdf", size: 3, mediaType: "application/pdf" });
  assert.deepEqual(page.posted.at(-1), { kind: "ready" });
  const inner = h.inner[0]!;
  assert.equal((inner.posted[0] as { kind: string; size: number }).size, 3);
  page.receive({ kind: "data", data: "AAEC" });
  page.receive({ kind: "end" });
  assert.deepEqual(inner.posted.slice(1), [{ kind: "data", data: "AAEC" }, { kind: "end" }]);
  inner.receive({ kind: "put", key: "rk", version: 4, blobRef: "zRef", size: 3, author: MEMBER });
  assert.deepEqual(page.posted.at(-1), { kind: "put", key: "rk", version: 4, size: 3 });
});

test("a declined upload opens no transfer, and data sent early is refused", async () => {
  const h = await sharedHarness();
  h.answer = { approved: false };
  const page = new FakePort();
  h.gates.servePort(page, PORTAL);
  page.receive({ kind: "put", hostDid: HOST, roomId: ROOM, name: "a", size: 1 });
  page.receive({ kind: "data", data: "AA" });
  await settle();
  assert.equal(h.inner.length, 0);
  assert.equal((page.posted[0] as { kind: string }).kind, "failed");
});

// ── What a record looks like to a page ──────────────────────────────────────

test("a sealed record's body is verified before the page sees a word of it", async () => {
  const author = signingIdentityFromSecret(new Uint8Array(32).fill(4));
  const body = { roomId: ROOM, key: "k", version: 2, author: author.did, title: "Pricing", body: "Hold." };
  const plaintext = Buffer.from(await signRecordBody(body, author)).toString("base64url");
  const read = { key: "k", version: 2, status: "active", updatedAt: "2026-10-16T00:00:00Z", author: author.did, plaintext, verification: {} };
  const view = await readView(ROOM, "k", read);
  assert.equal(view.title, "Pricing");
  assert.equal(view.body, "Hold.");
  assert.equal(view.sealed, true);

  await assert.rejects(readView(ROOM, "k", { ...read, version: 3 }), /signed for/, "a relocated body is refused");
  await assert.rejects(readView(ROOM, "k", { ...read, author: MEMBER }), /host recorded/);
  await assert.rejects(readView(ROOM, "other", read), /answered for record/);
});

test("a retracted record is its tombstone, and an open room's cleartext says it is not sealed", async () => {
  const tomb = await readView(ROOM, "k", { key: "k", version: 3, status: "retracted", updatedAt: "x", verification: {} });
  assert.equal(tomb.status, "retracted");
  assert.equal(tomb.body, undefined);
  const open = await readView(ROOM, "k", {
    key: "k", version: 1, status: "active", updatedAt: "x", verification: {},
    cleartext: { title: "Hello", body: "World", extra: { nested: true } },
  });
  assert.equal(open.sealed, false);
  assert.equal(open.title, "Hello");
  assert.ok(!("extra" in open));
});

test("liveGrants drops other communities", () => {
  const at = { origin: PORTAL, hostDid: HOST, vtaDid: VTA };
  const g = withGrants([], { ...at, hostDid: "did:web:other.example" }, [ROOM], NOW);
  assert.deepEqual(liveGrants(g, at, NOW), []);
});

test("nothing a page adds to a call reaches the offscreen document", async () => {
  const h = await sharedHarness();
  await h.gates.handle(PORTAL, { op: "read", hostDid: HOST, roomId: ROOM, key: "k", host: "did:key:zElsewhere", extra: 1 });
  const read = h.asked.find((a) => a.op === "read")!;
  assert.deepEqual(read, { op: "read", hostDid: HOST, roomId: ROOM, key: "k" });
});
