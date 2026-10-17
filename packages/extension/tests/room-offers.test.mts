// A community's offers of its rooms, from the wallet: listed per community and
// per identity the member signs in there with (never the community's own DID),
// accepted only after the member confirms in the wallet's window, and exposed
// to a community's own portal — and to no other page.

import test from "node:test";
import assert from "node:assert/strict";

import { RoomOffers, OFFERS_LIST_INTERVAL_MS, type RoomOffersDeps } from "../src/room-offers-background.ts";
import { runRoomOffersOp } from "../src/room-offers-offscreen.ts";
import {
  acceptWords,
  offerSources,
  openOfferCount,
  pickOffer,
  type OfferView,
  type RoomOfferConsentView,
} from "../src/room-offers-policy.ts";
import { RoomPageGates, type RoomPageBackgroundDeps } from "../src/room-page-background.ts";
import { pageTaskRefusal } from "../src/page-task-policy.ts";
import { InMemoryKVStore } from "@openvtc/pnm-core";
import { offerAcceptKey } from "@openvtc/pnm-core/rooms";

const VTA = "did:webvh:QmAgent:agent.example";
const COMMUNITY = "did:webvh:QmNorthwind:northwind.example";
const OTHER_COMMUNITY = "did:webvh:QmSouthwind:southwind.example";
const PORTAL = "https://members.northwind.example";
const ENDPOINT = "https://northwind.example/v1/trust-tasks";
const MEMBER = "did:webvh:QmAlice:people.example";
const MEMBER_2 = "did:webvh:QmAliceWork:people.example";
const BOARD = "did:webvh:QmBoard:northwind.example:room-dids:board";
const NOW = 1_800_000_000_000;

const ENTRIES = [
  { secretKind: "didSelfIssued", principalDid: MEMBER, targets: [{ kind: "did", did: COMMUNITY }] },
  { secretKind: "didSelfIssued", principalDid: MEMBER_2, targets: [{ kind: "did", did: COMMUNITY }] },
  // An administrator's agent also signs in as the community itself: never a member.
  { secretKind: "didSelfIssued", principalDid: COMMUNITY, targets: [{ kind: "did", did: COMMUNITY }] },
  { secretKind: "didSelfIssued", principalDid: MEMBER, targets: [{ kind: "did", did: OTHER_COMMUNITY }, { kind: "url" }] },
  { secretKind: "password", principalDid: MEMBER, targets: [{ kind: "did", did: "did:key:zSite" }] },
];

function view(over: Partial<OfferView> = {}): OfferView {
  return {
    communityDid: COMMUNITY,
    member: MEMBER,
    roomId: BOARD,
    label: "Board pack",
    visibility: "private",
    actions: ["read", "write"],
    validUntil: "2027-10-01T00:00:00Z",
    offeredAt: "2026-10-14T10:00:00Z",
    state: "open",
    inProgress: false,
    ...over,
  };
}

// ── The rules ───────────────────────────────────────────────────────────────

test("offers are asked of each community the member signs in to, as each identity used there — never as the community", () => {
  assert.deepEqual(offerSources(ENTRIES), [
    { communityDid: COMMUNITY, members: [MEMBER, MEMBER_2] },
    { communityDid: OTHER_COMMUNITY, members: [MEMBER] },
  ]);
});

test("one room offered to two identities: the portal must name which one joins", () => {
  const offers = [view(), view({ member: MEMBER_2 })];
  assert.equal(pickOffer(offers, BOARD).ok, false);
  const picked = pickOffer(offers, BOARD, MEMBER_2);
  assert.ok(picked.ok && picked.offer.member === MEMBER_2);
  assert.equal(pickOffer([view({ state: "accepted" })], BOARD).ok, false, "an accepted offer is not accepted again");
  assert.ok(pickOffer([view({ state: "accepted", inProgress: true })], BOARD).ok, "…unless its accept began here");
  assert.equal(openOfferCount([view(), view({ state: "accepted" }), view({ state: "accepted", inProgress: true })]), 2);
});

test("the window says what accepting does, by tier", () => {
  assert.match(acceptWords("private"), /key package/);
  assert.match(acceptWords("open"), /open/);
});

test("a page may not have the wallet sign or request an offer task", () => {
  assert.match(pageTaskRefusal("https://trusttasks.org/spec/vtc/rooms/offers/accept/0.1")!, /acceptOffer/);
});

// ── The background ──────────────────────────────────────────────────────────

interface Harness {
  offers: RoomOffers;
  asked: { op: string; [k: string]: unknown }[];
  prompts: RoomOfferConsentView[];
  answer: { approved: boolean };
  reach: boolean;
  listed: Record<string, OfferView[] | string>;
  counts: number[];
  names: Record<string, unknown>[];
  now: number;
}

function harness(over: Partial<RoomOffersDeps> = {}): Harness {
  const h: Harness = {
    offers: undefined as never,
    asked: [],
    prompts: [],
    answer: { approved: true },
    reach: true,
    listed: { [MEMBER]: [view()], [MEMBER_2]: [] },
    counts: [],
    names: [],
    now: NOW,
  };
  h.offers = new RoomOffers({
    active: async () => ({ ok: true, vta: { vtaDid: VTA } }),
    async offscreen(_vta, op) {
      h.asked.push(op as never);
      switch (op.op) {
        case "sources":
          return { ok: true, result: offerSources(ENTRIES).filter((s) => s.communityDid === COMMUNITY) };
        case "endpoint":
          return { ok: true, result: { endpoint: ENDPOINT } };
        case "list": {
          const l = h.listed[op.member];
          return typeof l === "string" ? { ok: false, error: l, code: "actUnsupported" } : { ok: true, result: l ?? [] };
        }
        case "accept":
          return {
            ok: true,
            result: { communityDid: op.communityDid, member: op.member, roomId: op.roomId, visibility: "private", joined: true, epoch: 2, resumed: false },
          };
      }
    },
    canReach: async () => h.reach,
    async prompt(v) {
      h.prompts.push(v);
      return h.answer;
    },
    rememberNames: async (_vta, _community, names) => void h.names.push(names),
    setOpenCount: async (_vta, n) => void h.counts.push(n),
    now: () => h.now,
    ...over,
  });
  return h;
}

test("the overview lists each identity's offers, remembers the names, and counts what waits", async () => {
  const h = harness();
  const o = await h.offers.overview();
  assert.equal(o.communities.length, 1);
  assert.deepEqual(o.communities[0]!.members.map((m) => m.member), [MEMBER, MEMBER_2]);
  assert.equal(o.openCount, 1);
  assert.deepEqual(h.counts, [1]);
  assert.deepEqual(h.names, [{ [BOARD]: { label: "Board pack", visibility: "private" } }]);
  const lists = h.asked.filter((a) => a.op === "list").map((a) => a.member);
  assert.deepEqual(lists, [MEMBER, MEMBER_2]);
  assert.ok(!lists.includes(COMMUNITY), "the community's own DID is never asked as a member");
});

test("one community's offers to one identity are read at most once a minute", async () => {
  const h = harness();
  await h.offers.overview();
  await h.offers.overview();
  await h.offers.overview({ force: true });
  assert.equal(h.asked.filter((a) => a.op === "list").length, 2, "inside the floor, nothing is read again");
  h.now += OFFERS_LIST_INTERVAL_MS;
  await h.offers.overview();
  assert.equal(h.asked.filter((a) => a.op === "list").length, 4);
});

test("a community the wallet may not reach is not asked; a failed identity says why", async () => {
  const h = harness();
  h.reach = false;
  const o = await h.offers.overview();
  assert.equal(o.communities[0]!.reachable, false);
  assert.equal(o.communities[0]!.endpointOrigin, "https://northwind.example");
  assert.ok(!h.asked.some((a) => a.op === "list"));

  const g = harness();
  g.listed[MEMBER] = "Your agent does not serve rooms/keys/act 0.3";
  const failed = await g.offers.overview();
  const alice = failed.communities[0]!.members.find((m) => m.member === MEMBER)!;
  assert.match(alice.error!, /act 0.3/);
  assert.equal(alice.code, "actUnsupported");
});

test("an accept is confirmed in the wallet's window, naming the community, the room and who joins", async () => {
  const h = harness();
  h.answer = { approved: false };
  await assert.rejects(h.offers.accept({ communityDid: COMMUNITY, member: MEMBER, roomId: BOARD }), (e: Error & { code?: string }) => e.code === "declined");
  assert.ok(!h.asked.some((a) => a.op === "accept"), "declined: nothing is accepted");
  const v = h.prompts[0]!;
  assert.equal(v.kind, "offer");
  assert.equal(v.communityDid, COMMUNITY);
  assert.equal(v.roomId, BOARD);
  assert.equal(v.member, MEMBER);
  assert.equal(v.label, "Board pack");
  assert.equal(v.origin, undefined, "the console asked, not a page");

  h.answer = { approved: true };
  const r = await h.offers.accept({ communityDid: COMMUNITY, member: MEMBER, roomId: BOARD });
  assert.equal(r.joined, true);
  const accepts = h.asked.filter((a) => a.op === "accept");
  assert.deepEqual(accepts, [{ op: "accept", communityDid: COMMUNITY, member: MEMBER, roomId: BOARD }]);
});

test("the console cannot accept as the community, or as an identity not used there", async () => {
  const h = harness();
  for (const member of [COMMUNITY, "did:key:zStranger"]) {
    await assert.rejects(h.offers.accept({ communityDid: COMMUNITY, member, roomId: BOARD }), /not an identity you sign in to/);
  }
  assert.equal(h.prompts.length, 0);
});

// ── The portal ──────────────────────────────────────────────────────────────

function gates(offers: RoomOffers, members = [MEMBER, COMMUNITY]) {
  const asked: { op: string }[] = [];
  const deps: RoomPageBackgroundDeps = {
    active: async () => ({ ok: true, vta: { vtaDid: VTA } }),
    async offscreen(_vta, op) {
      asked.push(op);
      if (op.op === "portal") return { ok: true, result: { portalOrigin: PORTAL, endpoint: ENDPOINT } };
      if (op.op === "members") return { ok: true, result: members };
      return { ok: false, error: `unexpected ${op.op}` };
    },
    canReach: async () => true,
    loadGrants: async () => [],
    saveGrants: async () => {},
    prompt: async () => ({ approved: false }),
    openTransfer: async () => {
      throw new Error("no transfers here");
    },
    now: () => NOW,
    offers,
  };
  return { g: new RoomPageGates(deps), asked };
}

test("only the community's own portal sees its offers, as views with no credential", async () => {
  const h = harness();
  const { g } = gates(h.offers);
  const evil = await g.handle("https://evil.example", { op: "offers", hostDid: COMMUNITY });
  assert.equal(evil.ok, false);
  assert.ok(!h.asked.some((a) => a.op === "list"), "nothing was read for another page");

  const res = await g.handle(PORTAL, { op: "offers", hostDid: COMMUNITY });
  assert.ok(res.ok);
  const { offers } = res.result as { offers: Record<string, unknown>[] };
  assert.deepEqual(offers.map((o) => [o.roomId, o.member]), [[BOARD, MEMBER]]);
  assert.equal("credentials" in offers[0]!, false);
  assert.ok(!h.asked.some((a) => a.op === "list" && a.member === COMMUNITY), "never as the community");
});

test("a portal's accept is the member's decision in the wallet's window, and names the page", async () => {
  const h = harness();
  const { g } = gates(h.offers);
  const res = await g.handle(PORTAL, { op: "acceptOffer", hostDid: COMMUNITY, roomId: BOARD });
  assert.ok(res.ok, JSON.stringify(res));
  assert.equal(h.prompts[0]!.origin, PORTAL);
  assert.equal(h.prompts[0]!.member, MEMBER);

  const other = await g.handle(PORTAL, { op: "acceptOffer", hostDid: COMMUNITY, roomId: BOARD, member: MEMBER_2 });
  assert.equal(other.ok, false, "an identity the member does not use here is not joined");
  const elsewhere = await g.handle("https://evil.example", { op: "acceptOffer", hostDid: COMMUNITY, roomId: BOARD });
  assert.equal(elsewhere.ok, false);
  assert.equal(h.prompts.length, 1, "no window for a refused page");
});

// ── The offscreen document ──────────────────────────────────────────────────

test("the offscreen listing builds views with no credential, and flags an accept in progress", async () => {
  const journal = new InMemoryKVStore();
  await journal.put(offerAcceptKey(VTA, COMMUNITY, MEMBER, BOARD), {
    v: 1, vtaDid: VTA, communityDid: COMMUNITY, member: MEMBER, roomId: BOARD,
    visibility: "private", invitation: "i", keyPackage: "kp", startedAt: "2026-10-14T10:00:00Z",
  });
  const sent: Record<string, unknown>[] = [];
  const deps = {
    agent: async () => ({
      holderDid: "did:key:zWallet",
      sender: {
        async send<Res>(envelope: { payload: { document: Record<string, unknown> } }): Promise<Res> {
          const doc = structuredClone(envelope.payload.document);
          doc.proof = { type: "DataIntegrityProof" };
          return { principal: doc.issuer, document: doc } as Res;
        },
      },
    }),
    identities: async () => ENTRIES,
    journal,
    endpoint: async () => ENDPOINT,
    completed: () => ({
      async sendCompleted<Res>(doc: Record<string, unknown>): Promise<Res> {
        sent.push(doc);
        return {
          items: [
            {
              roomId: BOARD, host: COMMUNITY, label: "  Board pack ", visibility: "private", actions: ["read"],
              validUntil: "2027-10-01T00:00:00Z", offeredAt: "2026-10-14T10:00:00Z", state: "accepted",
              credentials: { invitation: "i", membership: "{}", authority: "{}" },
            },
            {
              roomId: "did:key:zElsewhere", host: "did:key:zOtherHost", label: "x", visibility: "open", actions: ["read"],
              validUntil: "2027-10-01T00:00:00Z", offeredAt: "2026-10-14T10:00:00Z", state: "open",
              credentials: { invitation: "i", membership: "{}", authority: "{}" },
            },
          ],
        } as Res;
      },
    }),
  };
  const views = (await runRoomOffersOp(deps, { vtaDid: VTA }, { op: "list", communityDid: COMMUNITY, member: MEMBER })) as OfferView[];
  assert.equal(views.length, 1, "an offer naming another host is not shown");
  assert.equal(views[0]!.label, "Board pack");
  assert.equal(views[0]!.inProgress, true);
  assert.equal("credentials" in views[0]!, false);
  assert.equal(sent[0]!.issuer, MEMBER);

  await assert.rejects(
    runRoomOffersOp(deps, { vtaDid: VTA }, { op: "list", communityDid: COMMUNITY, member: COMMUNITY }),
    /not an identity you sign in to/,
  );
});
