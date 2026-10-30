// A community's offers of its own rooms, read as the member for their names
// (`vtc/rooms/offers/list/0.4`, completed by the VTA with `rooms/keys/act/0.9`).

import { test } from "node:test";
import assert from "node:assert/strict";

import { communityRoomMemberships, communityRoomOffers, roomNamesFromOffers, roomStanding, isAcceptable } from "../dist/rooms/index.js";

const WALLET = { did: "did:key:zWallet" };
const VTA = { did: "did:webvh:QmAgent:agent.example" };
const COMMUNITY = "did:webvh:QmCommunity:community.example";
const MEMBER = "did:webvh:QmAlice:people.example";
const BOARD = "did:webvh:QmBoard:community.example:room-dids:board";
const PICNIC = "did:webvh:QmPicnic:community.example:room-dids:picnic";
const OFFERS = "https://trusttasks.org/spec/vtc/rooms/offers/list/0.4";

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

test("offers are read as the member, through act 0.9, page by page", async () => {
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

  assert.equal(agent.sent[0].type, "https://trusttasks.org/spec/rooms/keys/act/0.9");
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

test("the community's record of the member's rooms is read as the member, through act 0.9, page by page", async () => {
  const agent = vta();
  const pages = [
    { items: [{ roomId: BOARD, host: COMMUNITY, label: "Board pack", visibility: "private", actions: ["read"], validUntil: "2027-10-01T00:00:00Z", state: "admitted", offeredAt: "2026-10-14T10:00:00Z", admittedAt: "2026-10-14T11:00:00Z", repeatAcceptUntil: "2026-10-21T11:00:00Z" }], nextCursor: "m2" },
    { items: [{ roomId: PICNIC, host: COMMUNITY, label: "Summer picnic", visibility: "open", actions: ["read"], validUntil: "2027-10-01T00:00:00Z", state: "removed", offeredAt: "2026-06-01T10:00:00Z", admittedAt: "2026-06-01T11:00:00Z", removedAt: "2026-09-01T00:00:00Z" }] },
  ];
  const seen = [];
  const rooms = await communityRoomMemberships({
    holder: WALLET,
    vta: { did: VTA.did, sender: agent },
    community: { did: COMMUNITY, sender: { async sendCompleted(doc, opts) { seen.push({ doc, opts }); return pages.shift(); } } },
    member: MEMBER,
  });
  assert.deepEqual(rooms.map((r) => r.state), ["admitted", "removed"]);
  assert.equal(agent.sent[0].type, "https://trusttasks.org/spec/rooms/keys/act/0.9");
  assert.equal(seen[0].doc.type, "https://trusttasks.org/spec/vtc/rooms/memberships/list/0.1");
  assert.equal(seen[0].doc.issuer, MEMBER);
  assert.deepEqual(seen[1].doc.payload, { cursor: "m2" });
});

test("every surface reads one standing from the community's state and the VTA's custody", () => {
  const sealed = { visibility: "private" };
  assert.equal(roomStanding({ ...sealed, state: "offered" }, false), "offered");
  assert.equal(roomStanding({ visibility: "open", state: "admitted" }, false), "joined");
  assert.equal(roomStanding({ ...sealed, state: "admitted", repeatAcceptUntil: "x" }, true), "joined");
  assert.equal(roomStanding({ ...sealed, state: "admitted", repeatAcceptUntil: "x" }, false), "unfinished");
  assert.equal(roomStanding({ ...sealed, state: "admitted" }, false), "needsReadmission");
  assert.equal(roomStanding({ ...sealed, state: "removed" }, true), "removed");
  assert.ok(isAcceptable("unfinished") && isAcceptable("offered"));
  assert.ok(!isAcceptable("joined") && !isAcceptable("needsReadmission"));
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

// ── Who a failed read is blamed on ──────────────────────────────────────────
//
// Reading offers asks two parties in turn: the member's VTA completes the
// request (`rooms/keys/act/0.9`), then the community answers it. The same
// refusal code means different things from each, so it is mapped by the party
// that produced it — a DID-hosting service the member signs in to, which has
// no rooms, must not read as the member's agent lacking act 0.9.

import { offerListRefusal, OfferReadError } from "../dist/rooms/index.js";
import { isNoTrustTaskService, NoTrustTaskServiceError, roomHostEndpoint } from "../dist/rooms/files.js";
import { VtaClientError } from "../dist/index.js";

const refusal = (code) => new VtaClientError("e.p.msg.bad_request", `refused: ${code}`, { details: { code } });

function readerWith({ vtaSend, communitySend }) {
  return {
    holder: WALLET,
    vta: { did: VTA.did, sender: vtaSend ? { send: vtaSend } : vta() },
    community: { did: COMMUNITY, sender: { sendCompleted: communitySend ?? (async () => ({ items: [] })) } },
    member: MEMBER,
  };
}

async function failedRead(reader) {
  try {
    await communityRoomOffers(reader);
  } catch (e) {
    return { raw: e, mapped: offerListRefusal(e, reader) };
  }
  assert.fail("the read did not fail");
}

for (const code of ["unsupportedType", "vtc/rooms/offers/list:unsupportedVersion"]) {
  test(`a community answering ${code} to offers/list makes no room offers — it is not the agent lacking act 0.9`, async () => {
    const reader = readerWith({ communitySend: async () => { throw refusal(code); } });
    const { raw, mapped } = await failedRead(reader);
    assert.ok(raw instanceof OfferReadError && raw.stage === "community", "the read names the community as the source");
    assert.equal(mapped.code, "noRoomOffers");
    assert.doesNotMatch(mapped.message, /act 0\.3|Your agent/);
    assert.match(mapped.message, /QmCommunity/);
  });
}

test("the VTA refusing act with unsupportedType is still the agent lacking act 0.9", async () => {
  let reached = false;
  const reader = readerWith({
    vtaSend: async () => { throw refusal("unsupportedType"); },
    communitySend: async () => { reached = true; return { items: [] }; },
  });
  const { raw, mapped } = await failedRead(reader);
  assert.equal(raw.stage, "act");
  assert.equal(mapped.code, "actUnsupported");
  assert.match(mapped.message, /rooms\/keys\/act 0\.9/);
  assert.equal(reached, false, "nothing reached the community");
});

test("a community refusing the member, or not answering, is a real failure — and it is the community's", async () => {
  const denied = await failedRead(readerWith({ communitySend: async () => { throw refusal("permissionDenied"); } }));
  assert.equal(denied.mapped.code, "communityRefused");
  assert.match(denied.mapped.message, /QmCommunity/);
  assert.doesNotMatch(denied.mapped.message, /Your agent|room-present/, "never blamed on the member's VTA");

  const down = await failedRead(
    readerWith({ communitySend: async () => { throw new VtaClientError("e.client.network", "room host could not be reached"); } }),
  );
  assert.equal(down.mapped.code, "noAnswer");
  assert.equal(down.mapped.retryable, true);
  assert.match(down.mapped.message, /community\.example did not answer/);

  const notMember = await failedRead(readerWith({ communitySend: async () => { throw refusal("notAMember"); } }));
  assert.equal(notMember.mapped.code, "notAMember");

  const vtaDenied = await failedRead(readerWith({ vtaSend: async () => { throw refusal("permissionDenied"); } }));
  assert.equal(vtaDenied.mapped.code, "capability", "the VTA's own refusal is still the agent's");
});

test("a party advertising no TrustTaskHTTPS service is told apart by type, not by its words", async () => {
  const doc = { id: COMMUNITY, service: [{ id: "#didcomm", type: "DIDCommMessaging", serviceEndpoint: "did:web:mediator.example" }] };
  await assert.rejects(roomHostEndpoint(COMMUNITY, async () => doc), (e) => {
    assert.ok(e instanceof NoTrustTaskServiceError);
    assert.ok(isNoTrustTaskService(e));
    assert.equal(e.code, "e.client.parse");
    return true;
  });
  assert.equal(isNoTrustTaskService(new VtaClientError("e.client.parse", "advertises no TrustTaskHTTPS service")), false);
});
