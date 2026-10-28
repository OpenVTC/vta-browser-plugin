// The wallet's own window for accepting a community's offer, rendered: it shows
// what the room is for (the community's description, from
// `vtc/rooms/offers/list/0.4`) as text — never as markup — bounded like a
// label, and says nothing of it when the community said nothing.

import { test } from "node:test";
import assert from "node:assert/strict";
import { h, render } from "./harness/dom.mjs";
import { OfferConsent } from "../src/room-offer-consent.js";
import type { RoomOfferConsentView } from "../src/room-offers-policy.js";

const view = (over: Partial<RoomOfferConsentView> = {}): RoomOfferConsentView => ({
  kind: "offer",
  communityDid: "did:webvh:QmNorthwind:northwind.example",
  member: "did:webvh:QmAlice:people.example",
  roomId: "did:webvh:QmNorthwind:northwind.example:room-dids:board",
  label: "Board pack",
  visibility: "private",
  actions: ["read", "write"],
  validUntil: "2027-10-01T00:00:00Z",
  resume: false,
  ...over,
});

test("the window shows what the room is for, as text and never as markup", async () => {
  const screen = await render(
    h(OfferConsent, {
      view: view({ description: "Papers for the board <img src=x onerror=alert(1)>" }),
      decide: () => {},
    }),
  );
  await screen.settle();
  assert.match(screen.text(), /Papers for the board <img src=x onerror=alert\(1\)>/);
  assert.equal(screen.all("img").length, 0, "a text node, not an element");
  assert.match(screen.text(), /Board pack/);
  await screen.unmount();
});

test("a description longer than the schema allows is cut, and none is shown when there is none", async () => {
  const long = await render(h(OfferConsent, { view: view({ description: "y".repeat(3000) }), decide: () => {} }));
  await long.settle();
  assert.ok(!long.text().includes("y".repeat(1001)), "bounded at 1000 characters");
  assert.ok(long.text().includes("y".repeat(1000)));
  await long.unmount();

  const none = await render(h(OfferConsent, { view: view(), decide: () => {} }));
  await none.settle();
  assert.equal(none.all("div").some((d) => d.getAttribute("title") === "What the community says the room is for"), false);
  await none.unmount();
});
