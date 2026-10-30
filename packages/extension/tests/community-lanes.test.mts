// One community's lane: offers, held rooms and portal shares joined by room.
//
// The join is what the view exists for, so the model is asserted directly:
// every offer and every share of this agent lands in exactly one row, a held
// room joins the lane it came from, and a lane with something to act on comes
// first.

import { test } from "node:test";
import assert from "node:assert/strict";
import { communityLanes, joinedOpen, rowStage } from "../src/manager/community-lanes.js";
import type { OfferStanding } from "../src/room-offers-policy.js";

const AGENT = "did:webvh:QmAgent:agent.example";
const A = "did:webvh:QmA:a.example";
const B = "did:webvh:QmB:b.example";

const offer = (communityDid: string, roomId: string, state: OfferStanding, label = "") => ({
  communityDid,
  member: "did:example:me",
  roomId,
  label,
  visibility: "private",
  actions: ["read"],
  validUntil: "2027-01-01T00:00:00Z",
  offeredAt: "2026-01-01T00:00:00Z",
  state,
});
const community = (did: string, offers: ReturnType<typeof offer>[]) => ({
  communityDid: did,
  reachable: true,
  members: [{ member: "did:example:me", offers }],
});
const share = (hostDid: string, roomId: string, vtaDid = AGENT) => ({
  key: "room-grants:x",
  grant: { origin: "https://portal.example", hostDid, vtaDid, roomId, member: "did:example:me", grantedAt: 1, expiresAt: 2 },
});
const held = (roomId: string) => ({ roomId, places: [{ roomId, member: "did:example:me", epoch: 2, earliestReadableEpoch: 1 }] });

test("offers, holdings and shares of one room are one row", () => {
  const lanes = communityLanes({
    communities: [community(A, [offer(A, "r1", "joined", "One")])],
    shares: [share(A, "r1")],
    entries: [held("r1")],
    hosts: {},
    agentDid: AGENT,
  });
  assert.equal(lanes.length, 1);
  const [row] = lanes[0]!.rows;
  assert.equal(row!.label, "One");
  assert.equal(row!.offers.length, 1);
  assert.equal(row!.shares.length, 1);
  assert.ok(row!.held);
  assert.equal(rowStage(row!), "shared");
  assert.deepEqual(lanes[0]!.portals, ["https://portal.example"]);
});

test("each gap is its own stage", () => {
  const lanes = communityLanes({
    communities: [community(A, [offer(A, "open", "offered"), offer(A, "waiting", "unfinished")])],
    shares: [],
    entries: [],
    hosts: {},
    agentDid: AGENT,
  });
  const stage = Object.fromEntries(lanes[0]!.rows.map((r) => [r.roomId, rowStage(r)]));
  assert.deepEqual(stage, { open: "offered", waiting: "awaiting-keys" });
});

test("an open room joined is held with no keys, and shared once its portal may show it", () => {
  const joined = { ...offer(A, "pub", "joined", "Public"), visibility: "open" };
  const lanes = communityLanes({
    communities: [community(A, [joined])],
    shares: [share(A, "pub")],
    entries: [],
    hosts: {},
    agentDid: AGENT,
  });
  const [row] = lanes[0]!.rows;
  assert.equal(row!.held, undefined, "the agent holds nothing for an open room");
  assert.equal(joinedOpen(row!)?.roomId, "pub");
  assert.equal(rowStage(row!), "shared");
  assert.equal(rowStage({ ...row!, shares: [] }), "held");
  // A sealed room joined is not an open one, whatever the agent holds.
  assert.equal(joinedOpen({ ...row!, offers: [offer(A, "pub", "joined")] }), undefined);
});

test("a share made through another agent is not this agent's", () => {
  const lanes = communityLanes({ communities: [], shares: [share(A, "r1", "did:webvh:QmOther:o.example")], entries: [], hosts: {}, agentDid: AGENT });
  assert.equal(lanes.length, 0);
});

test("a held room joins the community it was last found at", () => {
  const lanes = communityLanes({
    communities: [],
    shares: [],
    entries: [held("r1"), held("r2")],
    hosts: { r1: { host: B, source: "community" }, r2: { host: B, source: "used" } },
    agentDid: AGENT,
  });
  assert.deepEqual(lanes.map((l) => [l.communityDid, l.rows.map((r) => r.roomId)]), [[B, ["r1"]]]);
});

test("a community with an offer waiting comes first, and its waiting rows lead", () => {
  const lanes = communityLanes({
    communities: [community(A, [offer(A, "done", "joined")]), community(B, [offer(B, "x", "joined"), offer(B, "y", "offered")])],
    shares: [],
    entries: [],
    hosts: {},
    agentDid: AGENT,
  });
  assert.deepEqual(lanes.map((l) => l.communityDid), [B, A]);
  assert.equal(lanes[0]!.rows[0]!.roomId, "y");
});
