// A portal page's `window.vtaWallet.rooms.*` (P7b; VTI `data-rooms-files.md` §8.5).
//
// The gates run here as they run in the background, against fakes for the
// browser and the offscreen document: the page must be the community's portal
// by its DID document, the room must have been shared with that origin by the
// member, every write is confirmed, and a download's bytes reach the page only
// after the whole file verified.

import test from "node:test";
import assert from "node:assert/strict";

import {
  ROOM_NAMES_CACHE_MS,
  RoomPageGates,
  type PortLike,
  type RoomPageBackgroundDeps,
} from "../src/room-page-background.ts";
import {
  ROOM_GRANT_TTL_MS,
  ROOM_NAMES_MAX,
  liveGrants,
  mergeRoomNames,
  rememberedRoomLabels,
  roomNamesKey,
  membersAt,
  portalRefusal,
  roomFilesPageOpenRefusal,
  roomGrantRefusal,
  roomsPageParamsRefusal,
  selectedShares,
  shareButtonWords,
  shareRefusal,
  shareRows,
  toggleShareRow,
  withGrants,
  type RoomGrant,
  type RoomShareConsentView,
  type RoomWriteConsentView,
} from "../src/room-page-policy.ts";
import { readView, runRoomsPageOp } from "../src/room-page-offscreen.ts";
import { signRecordBody } from "@openvtc/pnm-core/rooms/files";
import { signingIdentityFromSecret } from "@openvtc/pnm-core";

const PORTAL = "https://members.northwind.example";
const HOST = "did:webvh:QmHost:northwind.example";
const VTA = "did:webvh:QmAgent:agent.example";
const ROOM = "did:webvh:QmRoom:rooms.example";
const OTHER_ROOM = "did:webvh:QmOther:rooms.example";
const PRIVATE_ROOM = "did:webvh:QmPrivate:rooms.example";
const MEMBER = "did:webvh:QmAlice:people.example";
/** A second identity the member signs in to this community with. */
const MEMBER_2 = "did:webvh:QmAliceWork:people.example";
/** A room the VTA holds only as the community itself. */
const COMMUNITY_ROOM = "did:webvh:QmCommunityOnly:rooms.example";
/** A share row's key: the room, as one member. */
const as = (roomId: string, member = MEMBER) => `${roomId}|${member}`;
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
  const grants = withGrants([], at, [{ roomId: ROOM, member: MEMBER }], NOW);
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
  /** The identities the member uses at HOST, as the wallet's vault says. */
  members: string[];
  /** What the VTA lists: one entry per (room, member). */
  held: { roomId: string; member?: string; actions?: string[] }[];
  /** The names the community's offers give its rooms, or a failed reading. */
  names: Record<string, { label: string; visibility?: string }> | "fail";
}

function harness(over: Partial<RoomPageBackgroundDeps> = {}): Harness {
  const h: Harness = {
    gates: undefined as never,
    grants: new Map(),
    prompts: [],
    asked: [],
    answer: { approved: true },
    inner: [],
    members: [MEMBER],
    // The live case: the VTA also holds the community's own place in ROOM, and
    // a room only the community holds.
    held: [
      { roomId: ROOM, member: HOST, actions: ["read", "write", "curate", "admin"] },
      { roomId: ROOM, member: MEMBER, actions: ["read", "write"] },
      { roomId: OTHER_ROOM, member: MEMBER },
      { roomId: PRIVATE_ROOM, member: MEMBER },
      { roomId: COMMUNITY_ROOM, member: HOST, actions: ["admin"] },
    ],
    names: {},
  };
  const deps: RoomPageBackgroundDeps = {
    active: async () => ({ ok: true, vta: { vtaDid: VTA } }),
    async offscreen(_vta, op) {
      h.asked.push(op as never);
      switch (op.op) {
        case "portal":
          return { ok: true, result: { portalOrigin: PORTAL, endpoint: `${PORTAL}/v1/trust-tasks` } };
        case "held":
          return { ok: true, result: h.held.map((r) => ({ ...r, epoch: 3, earliestReadableEpoch: 1 })) };
        case "members":
          return { ok: true, result: h.members };
        case "roomNames":
          return h.names === "fail" ? { ok: false, error: "offers: notAMember" } : { ok: true, result: h.names };
        case "info":
          if (op.roomId === OTHER_ROOM) return { ok: false, error: "rooms/info: notFound" };
          return {
            ok: true,
            result: {
              roomId: op.roomId,
              visibility: op.roomId === PRIVATE_ROOM ? "private" : "attributed",
              epoch: 3,
              member: op.member,
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
  h.answer = {
    approved: true,
    selectedRooms: [as(ROOM), as(OTHER_ROOM), as(PRIVATE_ROOM), as(ROOM, HOST), "did:key:zNotOffered|did:key:z"],
  };
  const res = await h.gates.handle(PORTAL, { op: "choose", hostDid: HOST, suggest: ROOM });
  assert.ok(res.ok);
  const { rooms, refused } = res.result as {
    rooms: { roomId: string; member: string }[];
    refused: { roomId: string; reason: string }[];
  };
  assert.deepEqual(rooms.map((r) => [r.roomId, r.member]), [[ROOM, MEMBER]]);
  assert.deepEqual(refused.map((r) => r.roomId).sort(), [OTHER_ROOM, PRIVATE_ROOM].sort());
  const view = h.prompts[0] as RoomShareConsentView;
  assert.equal(view.kind, "share");
  assert.ok(view.rooms.find((r) => r.roomId === ROOM)!.ticked);

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

  h.answer = { approved: true, selectedRooms: [as(ROOM)] };
  await h.gates.handle(PORTAL, { op: "choose", hostDid: HOST });
  const prompts = h.prompts.length;
  const ok = await h.gates.handle(PORTAL, { op: "read", hostDid: HOST, roomId: ROOM, key: "k" });
  assert.ok(ok.ok);
  assert.equal(h.prompts.length, prompts, "a read rides the share, with no prompt");
});

test("every note is confirmed, showing who signs and what is written", async () => {
  const h = harness();
  h.answer = { approved: true, selectedRooms: [as(ROOM)] };
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
  h.answer = { approved: true, selectedRooms: [as(ROOM)] };
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
  assert.deepEqual(inner.posted[0], { kind: "get", vtaDid: VTA, roomId: ROOM, hostDid: HOST, member: MEMBER, key: "k" });

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
  const g = withGrants([], { ...at, hostDid: "did:web:other.example" }, [{ roomId: ROOM, member: MEMBER }], NOW);
  assert.deepEqual(liveGrants(g, at, NOW), []);
});

test("nothing a page adds to a call reaches the offscreen document", async () => {
  const h = await sharedHarness();
  await h.gates.handle(PORTAL, { op: "read", hostDid: HOST, roomId: ROOM, key: "k", host: "did:key:zElsewhere", extra: 1 });
  const read = h.asked.find((a) => a.op === "read")!;
  assert.deepEqual(read, { op: "read", hostDid: HOST, roomId: ROOM, member: MEMBER, key: "k" });
});

// ── Two members of one room ─────────────────────────────────────────────────
//
// One VTA holding two members of a room — the community's own place in a room
// the community owns, and an administrator's own membership — lists the room
// twice. The share prompt offers it only as the identity the member uses at
// this community, never as the community; the count says what is ticked; and
// every request for the page names the member, so the VTA never has to choose.

test("two members of one room: offered only as the member signed in here, never as the community", async () => {
  const h = harness();
  h.answer = { approved: false };
  await h.gates.handle(PORTAL, { op: "choose", hostDid: HOST, suggest: ROOM });
  const view = h.prompts[0] as RoomShareConsentView;
  assert.deepEqual(view.members, [MEMBER]);
  assert.deepEqual(
    view.rooms.filter((r) => r.roomId === ROOM).map((r) => [r.member, r.role]),
    [[MEMBER, "member"]],
    "one row for the room, as the member; the community's own place is not offered",
  );
  assert.ok(!view.rooms.some((r) => r.member === HOST));
  assert.equal(view.others, 1, "the room only the community holds is counted, not offered");
  const ticked = view.rooms.filter((r) => r.ticked);
  assert.deepEqual(ticked.map((r) => r.key), [as(ROOM)]);
  assert.equal(shareButtonWords(ticked.length), "Share 1 room");
});

test("a share names its member, and every request for the page carries it", async () => {
  const h = harness();
  h.answer = { approved: true, selectedRooms: [as(ROOM)] };
  await h.gates.handle(PORTAL, { op: "choose", hostDid: HOST });
  const confirm = h.asked.find((a) => a.op === "info")!;
  assert.equal(confirm.member, MEMBER, "the host confirms the room as the member, not as whoever the VTA picks");
  const saved = h.grants.get(`${PORTAL}|${VTA}`)!;
  assert.deepEqual(saved.map((g) => [g.roomId, g.member]), [[ROOM, MEMBER]]);

  await h.gates.handle(PORTAL, { op: "info", hostDid: HOST, roomId: ROOM });
  await h.gates.handle(PORTAL, { op: "browse", hostDid: HOST, roomId: ROOM });
  await h.gates.handle(PORTAL, { op: "read", hostDid: HOST, roomId: ROOM, key: "k" });
  h.answer = { approved: true };
  await h.gates.handle(PORTAL, { op: "putNote", hostDid: HOST, roomId: ROOM, title: "t" });
  for (const op of ["info", "browse", "read", "putNote"]) {
    const asked = h.asked.filter((a) => a.op === op);
    assert.ok(asked.length > 0, op);
    assert.ok(asked.every((a) => a.member === MEMBER), `${op} names the member`);
  }
  const list = await h.gates.handle(PORTAL, { op: "list", hostDid: HOST });
  assert.ok(list.ok);
  const [view] = (list.result as { rooms: { member: string; held: boolean }[] }).rooms;
  assert.equal(view!.member, MEMBER);
  assert.equal(view!.held, true, "held as the member it is shared as");
});

test("two identities used here: the member picks, the page's word only chooses among them", () => {
  const held = [
    { roomId: ROOM, member: MEMBER },
    { roomId: ROOM, member: MEMBER_2 },
    { roomId: ROOM, member: HOST },
  ];
  const plain = shareRows(held, [MEMBER, MEMBER_2, HOST], HOST, [], { suggest: ROOM });
  assert.deepEqual(plain.rows.map((r) => r.member), [MEMBER, MEMBER_2], "the community's DID is never an identity here");
  assert.ok(!plain.rows.some((r) => r.ticked), "two candidates and no word on which: nothing is picked");

  const hinted = shareRows(held, [MEMBER, MEMBER_2], HOST, [], { suggest: ROOM, member: MEMBER_2 });
  assert.deepEqual(hinted.rows.filter((r) => r.ticked).map((r) => r.member), [MEMBER_2]);

  const stranger = shareRows(held, [MEMBER, MEMBER_2], HOST, [], { suggest: ROOM, member: "did:key:zStranger" });
  assert.ok(!stranger.rows.some((r) => r.ticked), "a page naming someone else picks nobody");
  assert.ok(!stranger.rows.some((r) => r.member === "did:key:zStranger"), "and adds nobody");

  // Ticking a room as one identity unticks it as the other; the count follows the ticks.
  let ticked = toggleShareRow(plain.rows, new Set(), as(ROOM, MEMBER));
  ticked = toggleShareRow(plain.rows, ticked, as(ROOM, MEMBER_2));
  assert.deepEqual([...ticked], [as(ROOM, MEMBER_2)]);
  assert.equal(shareButtonWords(ticked.size), "Share 1 room");

  // An answer naming the room as both is refused rather than resolved.
  const both = selectedShares(plain.rows, [as(ROOM, MEMBER), as(ROOM, MEMBER_2)]);
  assert.equal(both.ok, false);
  const one = selectedShares(plain.rows, [as(ROOM, MEMBER_2), as(ROOM, HOST)]);
  assert.deepEqual(one, { ok: true, shares: [{ roomId: ROOM, member: MEMBER_2 }] });
});

test("no identity used here: nothing is offered", async () => {
  const h = harness();
  h.members = [];
  h.answer = { approved: true, selectedRooms: [as(ROOM)] };
  const res = await h.gates.handle(PORTAL, { op: "choose", hostDid: HOST });
  assert.ok(res.ok);
  const view = h.prompts[0] as RoomShareConsentView;
  assert.deepEqual(view.rooms, []);
  assert.deepEqual((res.result as { rooms: unknown[] }).rooms, []);
});

test("the identities used at a community are its vault entries' principals, never the community", () => {
  const entries = [
    { secretKind: "didSelfIssued", principalDid: MEMBER, targets: [{ kind: "did", did: HOST }] },
    { secretKind: "didSelfIssued", principalDid: HOST, targets: [{ kind: "did", did: HOST }] },
    { secretKind: "didSelfIssued", principalDid: MEMBER_2, targets: [{ kind: "did", did: "did:web:elsewhere.example" }] },
    { secretKind: "password", principalDid: MEMBER_2, targets: [{ kind: "did", did: HOST }] },
  ];
  assert.deepEqual(membersAt(entries, HOST), [MEMBER]);
});

test("a share made before shares named a member is asked for again", () => {
  const at = { origin: PORTAL, hostDid: HOST, vtaDid: VTA };
  const old = [{ ...at, roomId: ROOM, grantedAt: NOW, expiresAt: NOW + 1000 }] as unknown as RoomGrant[];
  assert.deepEqual(liveGrants(old, at, NOW), []);
  assert.ok(roomGrantRefusal(old, at, ROOM, NOW));
});

// ── The names of the community's own rooms ──────────────────────────────────

/** A harness that remembers room names, with a clock the test moves. */
function namingHarness() {
  const store = new Map<string, unknown>();
  const clock = { now: NOW };
  const h = harness({
    now: () => clock.now,
    loadRoomNames: async (vtaDid, hostDid) => store.get(roomNamesKey(vtaDid, hostDid)),
    saveRoomNames: async (vtaDid, hostDid, names) => void store.set(roomNamesKey(vtaDid, hostDid), names),
  });
  return { h, store, clock };
}

async function shareAndList(h: Harness) {
  h.answer = { approved: true, selectedRooms: [as(ROOM)] };
  await h.gates.handle(PORTAL, { op: "choose", hostDid: HOST });
  const list = await h.gates.handle(PORTAL, { op: "list", hostDid: HOST });
  assert.ok(list.ok);
  return (list.result as { rooms: { roomId: string; label?: string; visibility?: string }[] }).rooms;
}

test("a community's own room is listed by its name, read from the community's offers to the member", async () => {
  const { h } = namingHarness();
  h.names = { [ROOM]: { label: "Board pack", visibility: "attributed" } };
  const [room] = await shareAndList(h);
  assert.equal(room!.label, "Board pack");
  assert.equal(room!.visibility, "attributed");
  const asked = h.asked.filter((a) => a.op === "roomNames");
  assert.ok(asked.length > 0);
  assert.ok(
    asked.every((a) => a.hostDid === HOST && (a.members as string[]).every((m) => m === MEMBER)),
    "read at this portal's community, as the member, never as the community",
  );
  // The share prompt names it too.
  h.answer = { approved: false };
  await h.gates.handle(PORTAL, { op: "choose", hostDid: HOST });
  const view = h.prompts.at(-1) as RoomShareConsentView;
  assert.equal(view.rooms.find((r) => r.roomId === ROOM)!.label, "Board pack");
  assert.equal(view.rooms.find((r) => r.roomId === OTHER_ROOM)!.label, undefined, "a member's own room has no name here");
});

test("a failed reading leaves rooms unnamed, and the list still answers", async () => {
  const { h } = namingHarness();
  h.names = "fail";
  const [room] = await shareAndList(h);
  assert.equal(room!.roomId, ROOM);
  assert.equal(room!.label, undefined);
});

test("offers are read at most once a minute per member, and a name outlives its offer", async () => {
  const { h, clock } = namingHarness();
  h.names = { [ROOM]: { label: "Board pack" } };
  await shareAndList(h);
  const reads = () => h.asked.filter((a) => a.op === "roomNames").length;
  const before = reads();
  await h.gates.handle(PORTAL, { op: "list", hostDid: HOST });
  assert.equal(reads(), before, "inside the minute: no new reading");

  // The community stops listing the accepted offer: the room keeps its name.
  h.names = {};
  clock.now += ROOM_NAMES_CACHE_MS;
  const later = await h.gates.handle(PORTAL, { op: "list", hostDid: HOST });
  assert.equal(reads(), before + 1);
  assert.equal((later.result as { rooms: { label?: string }[] }).rooms[0]!.label, "Board pack");

  // Renamed and offered again: the new name replaces the old.
  h.names = { [ROOM]: { label: "Board papers" } };
  clock.now += ROOM_NAMES_CACHE_MS;
  const renamed = await h.gates.handle(PORTAL, { op: "list", hostDid: HOST });
  assert.equal((renamed.result as { rooms: { label?: string }[] }).rooms[0]!.label, "Board papers");
});

test("remembered names: fresh over old, bounded, and read back for the console by VTA", () => {
  const merged = mergeRoomNames(
    { [ROOM]: { label: "Old", seenAt: 1 }, junk: { label: 3 }, [OTHER_ROOM]: { label: "Kept", seenAt: 2 } },
    { [ROOM]: { label: "New", visibility: "private" } },
    NOW,
  );
  assert.deepEqual(merged[ROOM], { label: "New", visibility: "private", seenAt: NOW });
  assert.equal(merged[OTHER_ROOM]!.label, "Kept");
  assert.equal(merged.junk, undefined);
  assert.deepEqual(mergeRoomNames("not a record", {}, NOW), {});

  const many = Object.fromEntries(
    Array.from({ length: ROOM_NAMES_MAX + 5 }, (_, i) => [`did:key:z${i}`, { label: `r${i}`, seenAt: i }]),
  );
  const bounded = mergeRoomNames(many, {}, NOW);
  assert.equal(Object.keys(bounded).length, ROOM_NAMES_MAX);
  assert.equal(bounded["did:key:z0"], undefined, "the least recently seen go first");

  const all = {
    [roomNamesKey(VTA, HOST)]: { [ROOM]: { label: "Board pack", seenAt: 5 } },
    [roomNamesKey(VTA, "did:web:other.example")]: { [ROOM]: { label: "Newer", seenAt: 9 } },
    [roomNamesKey("did:key:zOtherVta", HOST)]: { [OTHER_ROOM]: { label: "Not this agent's", seenAt: 1 } },
    "room-grants:x": [],
  };
  assert.deepEqual(rememberedRoomLabels(all, VTA), { [ROOM]: "Newer" });
});

test("the offscreen reading: each member's offers, signed as that member, at the community; one failing costs only its own", async () => {
  const actedAs: string[] = [];
  const sentTo: string[] = [];
  const names = await runRoomsPageOp(
    {
      agent: async () => ({
        holderDid: "did:key:zWallet",
        sender: {
          async send<Res>(envelope: { type: string; payload: { document: Record<string, unknown> } }) {
            const doc = structuredClone(envelope.payload.document);
            actedAs.push(String(doc.issuer));
            if (doc.issuer === MEMBER_2) throw new Error("rooms/keys/act:issuerNotPrincipal");
            doc.proof = { type: "DataIntegrityProof" };
            return { principal: doc.issuer, document: doc } as Res;
          },
        } as never,
      }),
      portal: async () => ({ portalOrigin: PORTAL, endpoint: `${PORTAL}/v1/trust-tasks` }),
      completed: (hostDid, endpoint) => ({
        async sendCompleted<Res>(doc: Record<string, unknown>) {
          sentTo.push(`${hostDid} ${endpoint} ${String(doc.recipient)}`);
          return {
            items: [{ roomId: ROOM, host: HOST, label: "Board pack", visibility: "attributed", state: "accepted" }],
          } as Res;
        },
      }),
    },
    { vtaDid: VTA },
    { op: "roomNames", hostDid: HOST, members: [MEMBER, MEMBER_2, MEMBER] },
  );
  assert.deepEqual(names, { [ROOM]: { label: "Board pack", visibility: "attributed" } });
  assert.deepEqual(actedAs, [MEMBER, MEMBER_2], "each member once");
  assert.deepEqual(sentTo, [`${HOST} ${PORTAL}/v1/trust-tasks ${HOST}`]);
});
