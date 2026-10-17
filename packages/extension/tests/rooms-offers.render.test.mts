// The console's Communities view, rendered: a party that makes no room offers
// (a DID-hosting service the member signs in to, a community without rooms)
// shows no red error; a community that does serve offers and fails says so,
// named as itself; and a VTA without act 0.3 is still told it must be updated.
//
// And the lane itself: each room's path from offer to held room to portal
// share, with every gap drawn as the state it is.

import { test } from "node:test";
import assert from "node:assert/strict";
import { h, render } from "./harness/dom.mjs";
import { useRoomOffers } from "../src/manager/panes/rooms-offers.js";
import { useRoomShares } from "../src/manager/panes/rooms-shares.js";
import { RoomCommunities } from "../src/manager/panes/rooms-communities.js";
import { RUNTIME_ROOM_OFFERS, type OffersOverview } from "../src/bridge-protocol.js";
import { ROOM_GRANTS_PREFIX } from "../src/room-page-policy.js";

const VTA = "did:webvh:QmAgent:agent.example";
const COMMUNITY = "did:webvh:QmNorthwind:northwind.example";
const HOSTING = "did:webvh:QmHosting:webvh.example";
const MEMBER = "did:webvh:QmAlice:people.example";

/** The view as the pane mounts it: the two hooks own the reading. */
function Communities({ entries = [] }: { entries?: unknown[] }) {
  const offers = useRoomOffers();
  const shares = useRoomShares();
  return h(RoomCommunities, {
    agentDid: VTA,
    offers,
    shares,
    entries,
    hosts: {},
    names: {},
    profiles: {},
    onOpen: () => {},
  } as never);
}

const mount = async (overview: OffersOverview, { entries = [], stored = {} }: { entries?: unknown[]; stored?: Record<string, unknown> } = {}) => {
  const screen = await render(h(Communities, { entries } as never), {
    chrome: {
      runtime: {
        sendMessage: async (msg: { type: string }) =>
          msg.type === RUNTIME_ROOM_OFFERS ? { ok: true, result: overview } : { ok: false, error: "unexpected" },
      },
      storage: { local: { get: async () => stored } },
    } as never,
  });
  await screen.settle();
  return screen;
};

const base = { vtaDid: VTA, openCount: 0, readAt: "2026-10-17T00:00:00Z" };

test("parties that make no room offers are not on the card, and nothing is red", async () => {
  const screen = await mount({
    ...base,
    communities: [{ communityDid: COMMUNITY, endpointOrigin: "https://northwind.example", reachable: true, members: [{ member: MEMBER, offers: [] }] }],
    noOffers: [HOSTING],
  });
  assert.doesNotMatch(screen.text(), /QmHosting/);
  assert.doesNotMatch(screen.text(), /could not|does not serve|TrustTaskHTTPS/);
  assert.match(screen.text(), /No offers from this community/);
  await screen.unmount();
});

test("when no place the member signs in to offers rooms, one muted line says so", async () => {
  const screen = await mount({ ...base, communities: [], noOffers: [HOSTING] });
  assert.match(screen.text(), /None of the places you sign in to with this wallet offers rooms/);
  assert.doesNotMatch(screen.text(), /do not sign in to any community/);
  await screen.unmount();
});

test("a community that fails still shows its error, named as the community", async () => {
  const screen = await mount({
    ...base,
    communities: [
      {
        communityDid: COMMUNITY,
        endpointOrigin: "https://northwind.example",
        reachable: true,
        members: [{ member: MEMBER, offers: [], error: `${COMMUNITY} refused to list its offers to ${MEMBER}: denied`, code: "communityRefused" }],
      },
    ],
    noOffers: [],
  });
  assert.match(screen.text(), /QmNorthwind:northwind\.example refused to list its offers/);
  await screen.unmount();
});

// ── The lane ────────────────────────────────────────────────────────────────

const ROOM = "did:webvh:QmNorthwind:northwind.example:room-dids:pricing";

const offer = (state: "open" | "accepted", inProgress = false) => ({
  communityDid: COMMUNITY,
  member: MEMBER,
  roomId: ROOM,
  label: "Pricing",
  visibility: "private",
  actions: ["read", "write"],
  validUntil: "2027-01-01T00:00:00Z",
  offeredAt: "2026-10-01T00:00:00Z",
  state,
  inProgress,
});

const withOffer = (o: ReturnType<typeof offer>): OffersOverview => ({
  ...base,
  communities: [{ communityDid: COMMUNITY, endpointOrigin: "https://northwind.example", reachable: true, members: [{ member: MEMBER, offers: [o as never] }] }],
  noOffers: [],
});

test("a new offer is marked new, can be accepted, and is not yet a room", async () => {
  const screen = await mount(withOffer(offer("open")));
  const text = screen.text();
  assert.match(text, /Pricing/);
  assert.ok(screen.all("span").some((el) => el.textContent === "new"), "marked new");
  assert.ok(screen.button("Accept"));
  assert.match(text, /Joined\s*not yet/);
  assert.match(text, /On its website\s*not shared/);
  await screen.unmount();
});

// Accepted is not the same as held: the keys arrive with the Welcome, and until
// they do the room is not in the member's rooms. Saying "accepted" alone would
// let them look for it there and conclude it was lost.
test("accepted with no keys yet says the keys have not arrived", async () => {
  const screen = await mount(withOffer(offer("accepted")));
  assert.match(screen.text(), /accepted/);
  assert.match(screen.text(), /keys have not reached your agent yet/);
  assert.equal(screen.all("button").filter((b) => /Accept/.test(b.textContent ?? "")).length, 0);
  await screen.unmount();
});

test("offered, held and shared is one row across the lane, with the share revocable", async () => {
  const grant = { origin: "https://portal.northwind.example", hostDid: COMMUNITY, vtaDid: VTA, roomId: ROOM, member: MEMBER, grantedAt: 1, expiresAt: Date.now() + 86_400_000 };
  const other = { ...grant, vtaDid: "did:webvh:QmOther:other.example", roomId: "did:webvh:elsewhere" };
  const screen = await mount(withOffer(offer("accepted")), {
    entries: [{ roomId: ROOM, places: [{ roomId: ROOM, member: MEMBER, epoch: 3, earliestReadableEpoch: 1, actions: ["read", "write"] }] }],
    stored: { [`${ROOM_GRANTS_PREFIX}portal`]: [grant, other] },
  });
  const text = screen.text();
  assert.match(text, /whole history/);
  assert.match(text, /portal\.northwind\.example · until/);
  assert.ok(screen.button("Stop sharing"));
  // Titled by the site a member signs in to, not the DID's own host; the room
  // is named once, not once per step.
  assert.equal(screen.all("h3")[0]!.textContent, "portal.northwind.example");
  assert.equal((text.match(/Pricing/g) ?? []).length, 1);
  assert.doesNotMatch(text, /elsewhere/, "a share made through another agent is not this agent's");
  await screen.unmount();
});
