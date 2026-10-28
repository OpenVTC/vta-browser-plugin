// Accepting a community's offer of a room (`vtc/rooms/offers/accept/0.1`), the
// CLI's `pnm rooms offers accept` step for step: credentials into the VTA, the
// KeyPackage the VTA gives (`rooms/keys/key-package/0.2`), the acceptance
// completed by the VTA as the member (`rooms/keys/act/0.8`), and the Welcome back
// to the VTA. No surface keeps an acceptance in progress: run again — here or from
// another surface — the VTA gives the SAME KeyPackage, the community answers with
// the same Welcome, and a Welcome already processed is joined
// (`vtc/rooms/memberships/list/0.1`, *One record, every surface*).

import { test } from "node:test";
import assert from "node:assert/strict";

import { acceptCommunityRoomOffer, RoomOfferError } from "../dist/rooms/index.js";
import { VtaClientError } from "../dist/index.js";

const WALLET = { did: "did:key:zWallet" };
const VTA = "did:webvh:QmAgent:agent.example";
const COMMUNITY = "did:webvh:QmCommunity:community.example";
const MEMBER = "did:webvh:QmAlice:people.example";
const BOARD = "did:webvh:QmBoard:community.example:room-dids:board";
const SPEC = "https://trusttasks.org/spec/";
const ACT8 = `${SPEC}rooms/keys/act/0.8`;
const LIST = `${SPEC}vtc/rooms/offers/list/0.4`;
const ACCEPT = `${SPEC}vtc/rooms/offers/accept/0.1`;
const KEY_PACKAGE = `${SPEC}rooms/keys/key-package/0.2`;
const WELCOME = `${SPEC}rooms/keys/welcome/0.1`;

const INVITATION = JSON.stringify({ id: "urn:vic:1", type: ["VerifiableCredential", "RoomInvitation"] });
const MEMBERSHIP = { id: "urn:vmc:1", type: ["VerifiableCredential", "RoomMembership"] };
const AUTHORITY = { id: "urn:vac:1", type: ["VerifiableCredential", "RoomAuthority"] };

function offer(over = {}) {
  return {
    roomId: BOARD,
    host: COMMUNITY,
    label: "Board pack",
    visibility: "private",
    actions: ["read", "write"],
    validUntil: "2027-10-01T00:00:00Z",
    offeredAt: "2026-10-14T10:00:00Z",
    state: "open",
    credentials: {
      invitation: INVITATION,
      membership: JSON.stringify(MEMBERSHIP),
      authority: JSON.stringify(AUTHORITY),
    },
    ...over,
  };
}

/**
 * A member's VTA: completes community documents as the member it is told, gives
 * the KeyPackage it holds for a room and invitation (minting only the first time,
 * key-package 0.2), joins from Welcomes. `over` replaces any one task's answer.
 * One VTA serves every surface, so tests share it between "surfaces".
 */
function memberVta(over = {}) {
  const sent = [];
  let minted = 0;
  const held = new Map();
  const joined = new Set();
  return {
    sent,
    joined,
    held,
    get minted() {
      return minted;
    },
    async send(envelope) {
      sent.push(envelope);
      if (over[envelope.type]) return over[envelope.type](envelope);
      switch (envelope.type) {
        case ACT8: {
          const doc = structuredClone(envelope.payload.document);
          doc.proof = { type: "DataIntegrityProof" };
          return { principal: doc.issuer, document: doc };
        }
        case KEY_PACKAGE: {
          const key = `${envelope.payload.roomId}|${envelope.payload.invitation}`;
          if (held.has(key)) return { keyPackage: held.get(key), expiresAt: "2099-01-01T00:00:00Z", alreadyMinted: true };
          minted += 1;
          held.set(key, `kp-${minted}`);
          return { keyPackage: `kp-${minted}`, expiresAt: "2099-01-01T00:00:00Z", alreadyMinted: false };
        }
        case WELCOME:
          if (joined.has(envelope.payload.roomId)) {
            throw new VtaClientError("e.p.msg.bad_request", "already", {
              details: { code: "rooms/keys/welcome:alreadyJoined" },
            });
          }
          joined.add(envelope.payload.roomId);
          held.clear();
          return { epoch: 1 };
      }
      throw new Error(`unexpected ${envelope.type}`);
    },
  };
}

/** The community: answers its offers and remembers the Welcome per KeyPackage. */
function community({ offers = [offer()], accept } = {}) {
  const docs = [];
  const welcomes = new Map();
  return {
    docs,
    sender: {
      async sendCompleted(doc, opts) {
        docs.push({ doc, opts });
        if (doc.type === LIST) return { items: offers };
        if (doc.type === ACCEPT) {
          if (accept) return accept(doc);
          const kp = doc.payload.keyPackage;
          if (welcomes.size > 0 && !welcomes.has(kp)) {
            throw new VtaClientError("e.p.msg.bad_request", "accepted", {
              details: { code: "vtc/rooms/offers/accept:alreadyAccepted" },
            });
          }
          if (!welcomes.has(kp)) welcomes.set(kp, `welcome-for-${kp}`);
          return { roomId: doc.payload.roomId, state: "admitted", epoch: 2, welcome: welcomes.get(kp), ratchetTree: "tree" };
        }
        throw new Error(`unexpected ${doc.type}`);
      },
    },
  };
}

/** One surface: a fresh caller with no state of its own, reaching the shared VTA and community. */
function setup({ vta = memberVta(), vtc = community(), joined } = {}) {
  const received = [];
  const reader = {
    holder: WALLET,
    vta: { did: VTA, sender: vta },
    community: { did: COMMUNITY, sender: vtc.sender },
    member: MEMBER,
  };
  const deps = {
    async receive(c) {
      received.push(c);
    },
    joined: joined ?? (async (roomId) => vta.joined?.has(roomId) ?? false),
  };
  return { vta, vtc, received, reader, deps };
}

test("a sealed room: credentials stored, the VTA's KeyPackage, accepted as the member, joined from the Welcome", async () => {
  const s = setup();
  const r = await acceptCommunityRoomOffer(s.reader, BOARD, s.deps);
  assert.deepEqual(r, { roomId: BOARD, member: MEMBER, communityDid: COMMUNITY, visibility: "private", joined: true, epoch: 2, resumed: false });

  assert.deepEqual(s.received, [MEMBERSHIP, AUTHORITY], "both credentials go into the VTA's vault");
  const kp = s.vta.sent.find((e) => e.type === KEY_PACKAGE);
  assert.equal(kp.recipient, VTA, "the KeyPackage comes from the member's VTA, never the wallet");
  assert.deepEqual(kp.payload, { roomId: BOARD, invitation: INVITATION });

  const accept = s.vtc.docs.find((d) => d.doc.type === ACCEPT).doc;
  assert.equal(accept.issuer, MEMBER, "the community sees the member");
  assert.equal(accept.recipient, COMMUNITY);
  assert.deepEqual(accept.payload, { roomId: BOARD, keyPackage: "kp-1" });
  const asked = s.vta.sent.filter((e) => e.type === ACT8).map((e) => e.payload.document.type);
  assert.deepEqual(asked, [LIST, ACCEPT], "both requests are completed by the VTA at act 0.8");

  const welcome = s.vta.sent.find((e) => e.type === WELCOME);
  assert.deepEqual(welcome.payload, { roomId: BOARD, invitation: INVITATION, welcome: "welcome-for-kp-1", ratchetTree: "tree" });
});

test("an open room: no KeyPackage, no Welcome", async () => {
  const s = setup({ vtc: community({ offers: [offer({ visibility: "open" })], accept: (doc) => ({ roomId: doc.payload.roomId, state: "admitted", epoch: 4 }) }) });
  const r = await acceptCommunityRoomOffer(s.reader, BOARD, s.deps);
  assert.equal(r.joined, false);
  assert.equal(r.epoch, 4);
  assert.equal(s.vta.minted, 0);
  assert.deepEqual(s.vtc.docs.find((d) => d.doc.type === ACCEPT).doc.payload, { roomId: BOARD });
  assert.equal(s.vta.sent.some((e) => e.type === WELCOME), false);
});

test("an acceptance one surface began and lost the answer to is finished by ANOTHER: same KeyPackage, same Welcome", async () => {
  const vta = memberVta();
  let lose = true;
  const vtc = community();
  const inner = vtc.sender.sendCompleted.bind(vtc.sender);
  vtc.sender.sendCompleted = async (doc, opts) => {
    const reply = await inner(doc, opts);
    if (doc.type === ACCEPT && lose) {
      lose = false;
      // Admitted at the community; the answer never reached the portal.
      throw new VtaClientError("e.client.timeout", "the room host did not respond within 30s");
    }
    return reply;
  };
  const portal = setup({ vta, vtc });
  await assert.rejects(acceptCommunityRoomOffer(portal.reader, BOARD, portal.deps), (e) => {
    assert.ok(e instanceof RoomOfferError);
    assert.equal(e.code, "noAnswer");
    assert.equal(e.retryable, true);
    assert.match(e.message, /anywhere else/);
    return true;
  });

  // The community now lists the offer as accepted; another surface, holding nothing, finishes it.
  vtc.sender.sendCompleted = ((prev) => async (doc, opts) =>
    doc.type === LIST ? { items: [offer({ state: "accepted" })] } : prev(doc, opts))(vtc.sender.sendCompleted);
  const console_ = setup({ vta, vtc });
  const r = await acceptCommunityRoomOffer(console_.reader, BOARD, console_.deps);
  assert.equal(vta.minted, 1, "one KeyPackage for the whole accept, whoever finishes it");
  const accepts = vtc.docs.filter((d) => d.doc.type === ACCEPT).map((d) => d.doc.payload.keyPackage);
  assert.deepEqual(accepts, ["kp-1", "kp-1"]);
  assert.equal(r.joined, true);
  assert.equal(r.resumed, true);
  assert.equal(vta.sent.filter((e) => e.type === WELCOME)[0].payload.welcome, "welcome-for-kp-1");
});

test("a Welcome another surface already handed the VTA is joined, not a failure", async () => {
  const vta = memberVta();
  const vtc = community();
  // Another surface got as far as the join; this one sees the offer still open.
  vta.joined.add(BOARD);
  const s = setup({ vta, vtc, joined: async () => false });
  const r = await acceptCommunityRoomOffer(s.reader, BOARD, s.deps);
  assert.equal(r.joined, true);
  assert.equal(r.resumed, true);
});

test("community still settling (admissionPending): retryable from any surface", async () => {
  const s = setup({
    vtc: community({
      accept: () => {
        throw new VtaClientError("e.p.msg.bad_request", "pending", {
          details: { code: "vtc/rooms/offers/accept:admissionPending" },
        });
      },
    }),
  });
  await assert.rejects(acceptCommunityRoomOffer(s.reader, BOARD, s.deps), (e) => e.code === "admissionPending" && e.retryable);
  assert.equal(s.vta.held.size, 1, "the VTA keeps the KeyPackage for the retry");
});

test("a VTA answer made as anyone but the member is refused, and nothing reaches the community", async () => {
  const vta = memberVta({
    [ACT8]: (envelope) => {
      const doc = structuredClone(envelope.payload.document);
      doc.issuer = COMMUNITY;
      doc.proof = { type: "DataIntegrityProof" };
      return { principal: COMMUNITY, document: doc };
    },
  });
  const s = setup({ vta });
  await assert.rejects(acceptCommunityRoomOffer(s.reader, BOARD, s.deps), /acted as did:webvh:QmCommunity/);
  assert.equal(s.vtc.docs.length, 0, "not even the listing went out");
  assert.deepEqual(s.received, []);
});

test("a VTA without act 0.8, or without key-package 0.2, is told it must be updated", async () => {
  const unsupported = () => {
    throw new VtaClientError("e.p.msg.bad_request", "no such task", { details: { code: "unsupportedType" } });
  };
  for (const [task, named] of [[ACT8, /act 0\.8/], [KEY_PACKAGE, /key-package 0\.2/]]) {
    const s = setup({ vta: memberVta({ [task]: unsupported }) });
    await assert.rejects(acceptCommunityRoomOffer(s.reader, BOARD, s.deps), (e) => {
      assert.equal(e.code, "actUnsupported");
      assert.match(e.message, /must be updated/);
      assert.match(e.message, named);
      return true;
    });
  }
});

test("a missing capability names the command that restores it", async () => {
  const vta = memberVta({
    [ACT8]: () => {
      throw new VtaClientError("e.p.msg.forbidden", "denied", { details: { code: "permissionDenied" } });
    },
  });
  const s = setup({ vta });
  await assert.rejects(acceptCommunityRoomOffer(s.reader, BOARD, s.deps), (e) => {
    assert.equal(e.code, "capability");
    assert.match(e.message, /room-present/);
    assert.match(e.message, /pnm acl update did:key:zWallet --capabilities-all/);
    return true;
  });

  const refusing = setup();
  refusing.deps.receive = async () => {
    throw new VtaClientError("e.p.msg.forbidden", "denied", { details: { code: "permissionDenied" } });
  };
  await assert.rejects(acceptCommunityRoomOffer(refusing.reader, BOARD, refusing.deps), (e) => e.code === "capability" && /vault-write/.test(e.message));
});

test("accepted elsewhere: done if the VTA is in; otherwise finished here with the VTA's KeyPackage", async () => {
  const accepted = () => community({ offers: [offer({ state: "accepted" })] });
  const inAlready = setup({ vtc: accepted(), joined: async () => true });
  const r = await acceptCommunityRoomOffer(inAlready.reader, BOARD, inAlready.deps);
  assert.equal(r.resumed, true);
  assert.equal(inAlready.vtc.docs.some((d) => d.doc.type === ACCEPT), false, "no second acceptance");

  // pnm accepted and stopped before the Welcome: its KeyPackage is held at the VTA.
  const vta = memberVta();
  vta.held.set(`${BOARD}|${INVITATION}`, "kp-from-pnm");
  const vtc = accepted();
  const out = setup({ vta, vtc });
  const finished = await acceptCommunityRoomOffer(out.reader, BOARD, out.deps);
  assert.equal(finished.joined, true);
  assert.equal(finished.resumed, true);
  assert.equal(vta.minted, 0, "the KeyPackage pnm sent, not a second one");
  assert.equal(vtc.docs.find((d) => d.doc.type === ACCEPT).doc.payload.keyPackage, "kp-from-pnm");
});

test("no offer of the room is notFound, and says who can help", async () => {
  const s = setup({ vtc: community({ offers: [] }) });
  await assert.rejects(acceptCommunityRoomOffer(s.reader, BOARD, s.deps), (e) => e.code === "notFound" && /administrator/.test(e.message));
});

test("a KeyPackage the VTA has let go is refused, and the next attempt gets a fresh one", async () => {
  let refuse = true;
  const vta = memberVta({
    [ACT8]: (envelope) => {
      if (envelope.payload.document.type === ACCEPT && refuse) {
        refuse = false;
        vta.held.clear();
        throw new VtaClientError("e.p.msg.bad_request", "not held", { details: { code: "rooms/keys/act:keyPackageNotHeld" } });
      }
      const doc = structuredClone(envelope.payload.document);
      doc.proof = { type: "DataIntegrityProof" };
      return { principal: doc.issuer, document: doc };
    },
  });
  const s = setup({ vta });
  await assert.rejects(acceptCommunityRoomOffer(s.reader, BOARD, s.deps), (e) => e.code === "keyPackageNotHeld");
  const r = await acceptCommunityRoomOffer(s.reader, BOARD, s.deps);
  assert.equal(r.joined, true);
  assert.equal(vta.minted, 2);
});

test("the community refusing the offer read during an accept is the community's refusal, not the agent's", async () => {
  for (const [code, want] of [["unsupportedType", "noRoomOffers"], ["permissionDenied", "communityRefused"]]) {
    const vtc = community();
    const inner = vtc.sender.sendCompleted;
    vtc.sender.sendCompleted = async (doc, opts) => {
      if (doc.type === LIST) throw new VtaClientError("e.p.msg.bad_request", "refused", { details: { code } });
      return inner(doc, opts);
    };
    const s = setup({ vtc });
    await assert.rejects(acceptCommunityRoomOffer(s.reader, BOARD, s.deps), (e) => {
      assert.equal(e.code, want);
      assert.doesNotMatch(e.message, /Your agent|act 0\.8/);
      return true;
    });
  }
});
