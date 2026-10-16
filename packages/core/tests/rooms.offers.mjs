// A community's offers of its own rooms, read as the member for their names
// (`vtc/rooms/offers/list/0.1`, completed by the VTA with `rooms/keys/act/0.3`).

import { test } from "node:test";
import assert from "node:assert/strict";

import { communityRoomOffers, roomNamesFromOffers } from "../dist/rooms/index.js";

const WALLET = { did: "did:key:zWallet" };
const VTA = { did: "did:webvh:QmAgent:agent.example" };
const COMMUNITY = "did:webvh:QmCommunity:community.example";
const MEMBER = "did:webvh:QmAlice:people.example";
const BOARD = "did:webvh:QmBoard:community.example:room-dids:board";
const PICNIC = "did:webvh:QmPicnic:community.example:room-dids:picnic";
const OFFERS = "https://trusttasks.org/spec/vtc/rooms/offers/list/0.1";

function offer(roomId, label, state = "open") {
  return {
    roomId,
    host: COMMUNITY,
    label,
    visibility: "attributed",
    actions: ["read", "write"],
    offeredAt: "2026-10-14T10:00:00Z",
    state,
    credentials: { invitation: "i", membership: "m", authority: "a" },
  };
}

/** A VTA that completes the document as the member it names, and no presentation. */
function vta() {
  const sent = [];
  return {
    sent,
    async send(envelope) {
      sent.push(envelope);
      const doc = structuredClone(envelope.payload.document);
      doc.proof = { type: "DataIntegrityProof" };
      return { principal: doc.issuer, document: doc };
    },
  };
}

test("offers are read as the member, through act 0.3, page by page", async () => {
  const agent = vta();
  const community = [];
  const pages = [
    { items: [offer(BOARD, "Board pack")], nextCursor: "p2" },
    { items: [offer(PICNIC, "Summer picnic", "accepted")] },
  ];
  const offers = await communityRoomOffers({
    holder: WALLET,
    vta: { did: VTA.did, sender: agent },
    community: {
      did: COMMUNITY,
      sender: {
        async sendCompleted(doc, opts) {
          community.push({ doc, opts });
          return pages.shift();
        },
      },
    },
    member: MEMBER,
  });
  assert.deepEqual(offers.map((o) => o.roomId), [BOARD, PICNIC]);

  assert.equal(agent.sent[0].type, "https://trusttasks.org/spec/rooms/keys/act/0.3");
  assert.equal(agent.sent[0].issuer, WALLET.did, "the wallet asks its VTA");
  const asked = agent.sent[0].payload.document;
  assert.equal(asked.type, OFFERS);
  assert.equal(asked.issuer, MEMBER, "the VTA is told whom to sign as");
  assert.equal(asked.recipient, COMMUNITY);
  assert.deepEqual(asked.payload, {});
  assert.deepEqual(agent.sent[1].payload.document.payload, { cursor: "p2" });

  assert.equal(community[0].doc.issuer, MEMBER, "the community sees the member, never the wallet");
  assert.equal(community[0].opts.expectedResponseType, `${OFFERS}#response`);
});

test("a VTA that signs as someone else is not believed", async () => {
  const wrong = {
    async send(envelope) {
      const doc = structuredClone(envelope.payload.document);
      doc.issuer = COMMUNITY;
      doc.proof = { type: "DataIntegrityProof" };
      return { principal: COMMUNITY, document: doc };
    },
  };
  let sent = false;
  await assert.rejects(
    communityRoomOffers({
      holder: WALLET,
      vta: { did: VTA.did, sender: wrong },
      community: { did: COMMUNITY, sender: { async sendCompleted() { sent = true; return { items: [] }; } } },
      member: MEMBER,
    }),
    /acted as did:webvh:QmCommunity/,
  );
  assert.equal(sent, false, "nothing reached the community");
});

test("names are taken from offers that carry a label, trimmed and bounded", () => {
  const names = roomNamesFromOffers([
    offer(BOARD, "  Board pack  "),
    offer(PICNIC, ""),
    { ...offer("not-a-did", "x") },
    { ...offer("did:key:zLong", "a".repeat(500)) },
    null,
    { roomId: "did:key:zNoLabel" },
  ]);
  assert.deepEqual(names[BOARD], { label: "Board pack", visibility: "attributed" });
  assert.equal(names[PICNIC], undefined, "an empty label names nothing");
  assert.equal(names["not-a-did"], undefined);
  assert.equal(names["did:key:zLong"].label.length, 200);
  assert.equal(names["did:key:zNoLabel"], undefined);
});
