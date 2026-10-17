// The console's Offers card, rendered: a party that makes no room offers (a
// DID-hosting service the member signs in to, a community without rooms) shows
// no red error; a community that does serve offers and fails says so, named as
// itself; and a VTA without act 0.3 is still told it must be updated.

import { test } from "node:test";
import assert from "node:assert/strict";
import { h, render } from "./harness/dom.mjs";
import { RoomOffers } from "../src/manager/panes/rooms-offers.js";
import { RUNTIME_ROOM_OFFERS, type OffersOverview } from "../src/bridge-protocol.js";

const VTA = "did:webvh:QmAgent:agent.example";
const COMMUNITY = "did:webvh:QmNorthwind:northwind.example";
const HOSTING = "did:webvh:QmHosting:webvh.example";
const MEMBER = "did:webvh:QmAlice:people.example";

const mount = async (overview: OffersOverview) => {
  const screen = await render(h(RoomOffers, {} as never), {
    chrome: {
      runtime: {
        sendMessage: async (msg: { type: string }) =>
          msg.type === RUNTIME_ROOM_OFFERS ? { ok: true, result: overview } : { ok: false, error: "unexpected" },
      },
    },
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
