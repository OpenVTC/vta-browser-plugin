// A community's offers of its own rooms, read as the member for their names and
// what each is for (`vtc/rooms/offers/list/0.2`, completed by the VTA with
// `rooms/keys/act/0.4`), falling back to list 0.1 — through act 0.3 for a VTA
// without 0.4 — when either party does not serve the newer version.

import { test } from "node:test";
import assert from "node:assert/strict";

import {
  communityRoomOffers,
  readCommunityRoomOffers,
  roomDescriptionText,
  roomNamesFromOffers,
} from "../dist/rooms/index.js";

const WALLET = { did: "did:key:zWallet" };
const VTA = { did: "did:webvh:QmAgent:agent.example" };
const COMMUNITY = "did:webvh:QmCommunity:community.example";
const MEMBER = "did:webvh:QmAlice:people.example";
const BOARD = "did:webvh:QmBoard:community.example:room-dids:board";
const PICNIC = "did:webvh:QmPicnic:community.example:room-dids:picnic";
const OFFERS = "https://trusttasks.org/spec/vtc/rooms/offers/list/0.2";
const OFFERS_V1 = "https://trusttasks.org/spec/vtc/rooms/offers/list/0.1";
const ACT_V4 = "https://trusttasks.org/spec/rooms/keys/act/0.4";
const ACT_V3 = "https://trusttasks.org/spec/rooms/keys/act/0.3";

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

test("offers are read as the member, at list 0.2 through act 0.4, page by page, with each room's description", async () => {
  const agent = vta();
  const community = [];
  const pages = [
    { items: [{ ...offer(BOARD, "Board pack"), description: "Papers for the board." }], nextCursor: "p2" },
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
  assert.equal(offers[0].description, "Papers for the board.");
  assert.equal(offers[1].description, undefined);

  assert.equal(agent.sent[0].type, ACT_V4);
  assert.equal(agent.sent[1].type, ACT_V4, "every page at the version that answered");
  assert.equal(agent.sent[0].issuer, WALLET.did, "the wallet asks its VTA");
  const asked = agent.sent[0].payload.document;
  assert.equal(asked.type, OFFERS);
  assert.equal(asked.issuer, MEMBER, "the VTA is told whom to sign as");
  assert.equal(asked.recipient, COMMUNITY);
  assert.deepEqual(asked.payload, {});
  assert.deepEqual(agent.sent[1].payload.document.payload, { cursor: "p2" });
  assert.equal(agent.sent[1].payload.document.type, OFFERS);

  assert.equal(community[0].doc.issuer, MEMBER, "the community sees the member, never the wallet");
  assert.equal(community[0].opts.expectedResponseType, `${OFFERS}#response`);
});

const unsupported = (code) => {
  const e = new Error(`refused: ${code}`);
  e.details = { code };
  return e;
};

test("a VTA without act 0.4 reads at list 0.1 through act 0.3, and the offers carry no description", async () => {
  const asked = [];
  const agent = {
    async send(envelope) {
      asked.push([envelope.type, envelope.payload.document.type]);
      if (envelope.type === ACT_V4) throw unsupported("unsupportedType");
      const doc = structuredClone(envelope.payload.document);
      doc.proof = { type: "DataIntegrityProof" };
      return { principal: doc.issuer, document: doc };
    },
  };
  const toCommunity = [];
  const read = await readCommunityRoomOffers({
    holder: WALLET,
    vta: { did: VTA.did, sender: agent },
    community: {
      did: COMMUNITY,
      sender: {
        async sendCompleted(doc, opts) {
          toCommunity.push([doc.type, opts.expectedResponseType]);
          return { items: [offer(BOARD, "Board pack")] };
        },
      },
    },
    member: MEMBER,
  });
  assert.deepEqual(asked, [
    [ACT_V4, OFFERS],
    [ACT_V3, OFFERS_V1],
  ]);
  assert.deepEqual(toCommunity, [[OFFERS_V1, `${OFFERS_V1}#response`]], "list 0.2 never reached the community");
  assert.equal(read.act, "0.3");
  assert.equal(read.list, "0.1");
  assert.equal(read.offers[0].description, undefined);
});

for (const code of ["unsupportedType", "vtc/rooms/offers/list:unsupportedVersion"]) {
  test(`a community answering ${code} to list 0.2 is read at list 0.1, still through act 0.4`, async () => {
    const agent = vta();
    const toCommunity = [];
    const read = await readCommunityRoomOffers({
      holder: WALLET,
      vta: { did: VTA.did, sender: agent },
      community: {
        did: COMMUNITY,
        sender: {
          async sendCompleted(doc) {
            toCommunity.push(doc.type);
            if (doc.type === OFFERS) throw unsupported(code);
            return { items: [offer(BOARD, "Board pack")] };
          },
        },
      },
      member: MEMBER,
    });
    assert.deepEqual(toCommunity, [OFFERS, OFFERS_V1]);
    assert.deepEqual(
      agent.sent.map((e) => [e.type, e.payload.document.type]),
      [
        [ACT_V4, OFFERS],
        [ACT_V4, OFFERS_V1],
      ],
    );
    assert.equal(read.act, "0.4");
    assert.equal(read.list, "0.1");
    assert.deepEqual(read.offers.map((o) => o.roomId), [BOARD]);
  });
}

test("a refusal other than unsupported is not a reason to read an older version", async () => {
  const agent = vta();
  let calls = 0;
  await assert.rejects(
    readCommunityRoomOffers({
      holder: WALLET,
      vta: { did: VTA.did, sender: agent },
      community: {
        did: COMMUNITY,
        sender: {
          async sendCompleted() {
            calls++;
            throw unsupported("vtc/rooms/offers/list:notAMember");
          },
        },
      },
      member: MEMBER,
    }),
    (e) => e.stage === "community",
  );
  assert.equal(calls, 1);
  assert.equal(agent.sent.length, 1);
});

test("a description is text, trimmed and bounded", () => {
  assert.equal(roomDescriptionText("  Papers <b>here</b>  "), "Papers <b>here</b>");
  assert.equal(roomDescriptionText("x".repeat(5000)).length, 1000);
  assert.equal(roomDescriptionText(42), "");
  assert.equal(roomDescriptionText(undefined), "");
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
// request (`rooms/keys/act/0.4`, else 0.3), then the community answers it. The same
// refusal code means different things from each, so it is mapped by the party
// that produced it — a DID-hosting service the member signs in to, which has
// no rooms, must not read as the member's agent lacking act 0.3.

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
  test(`a community answering ${code} to offers/list makes no room offers — it is not the agent lacking act 0.3`, async () => {
    const asked = [];
    const reader = readerWith({ communitySend: async (doc) => { asked.push(doc.type); throw refusal(code); } });
    const { raw, mapped } = await failedRead(reader);
    assert.deepEqual(asked, [OFFERS, OFFERS_V1], "list 0.2, then 0.1, before it is called no offers");
    assert.ok(raw instanceof OfferReadError && raw.stage === "community", "the read names the community as the source");
    assert.equal(mapped.code, "noRoomOffers");
    assert.doesNotMatch(mapped.message, /act 0\.3|Your agent/);
    assert.match(mapped.message, /QmCommunity/);
  });
}

test("the VTA refusing act 0.4 and 0.3 with unsupportedType is still the agent lacking act 0.3", async () => {
  let reached = false;
  const acts = [];
  const reader = readerWith({
    vtaSend: async (envelope) => { acts.push(envelope.type); throw refusal("unsupportedType"); },
    communitySend: async () => { reached = true; return { items: [] }; },
  });
  const { raw, mapped } = await failedRead(reader);
  assert.equal(raw.stage, "act");
  assert.equal(mapped.code, "actUnsupported");
  assert.match(mapped.message, /rooms\/keys\/act 0\.3/);
  assert.deepEqual(acts, [ACT_V4, ACT_V3]);
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
