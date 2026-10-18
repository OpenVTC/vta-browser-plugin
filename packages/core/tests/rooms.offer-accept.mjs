// Accepting a community's offer of a room (`vtc/rooms/offers/accept/0.1`), the
// CLI's `pnm rooms offers accept` step for step: credentials into the VTA, a
// KeyPackage the VTA mints, the acceptance completed by the VTA as the member
// (`rooms/keys/act/0.4`, or 0.3 from a VTA without it — the version that read
// the offers), and the Welcome back to the VTA. A lost answer is
// retried with the SAME KeyPackage, so the community answers with the same
// Welcome (accept 0.1 "Repeating an accept"; group/add 0.2 item 8).

import { test } from "node:test";
import assert from "node:assert/strict";

import {
  acceptCommunityRoomOffer,
  offerAcceptKey,
  RoomOfferError,
} from "../dist/rooms/index.js";
import { InMemoryKVStore, VtaClientError } from "../dist/index.js";

const WALLET = { did: "did:key:zWallet" };
const VTA = "did:webvh:QmAgent:agent.example";
const COMMUNITY = "did:webvh:QmCommunity:community.example";
const MEMBER = "did:webvh:QmAlice:people.example";
const BOARD = "did:webvh:QmBoard:community.example:room-dids:board";
const SPEC = "https://trusttasks.org/spec/";
const ACT3 = `${SPEC}rooms/keys/act/0.3`;
const ACT4 = `${SPEC}rooms/keys/act/0.4`;
const LIST = `${SPEC}vtc/rooms/offers/list/0.1`;
const LIST2 = `${SPEC}vtc/rooms/offers/list/0.2`;
const ACCEPT = `${SPEC}vtc/rooms/offers/accept/0.1`;
const KEY_PACKAGE = `${SPEC}rooms/keys/key-package/0.1`;
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
 * A member's VTA: completes offer documents as the member it is told, mints
 * KeyPackages, joins from Welcomes. `over` replaces any one task's answer.
 */
function memberVta(over = {}) {
  const sent = [];
  let minted = 0;
  const joined = new Set();
  return {
    sent,
    joined,
    get minted() {
      return minted;
    },
    async send(envelope) {
      sent.push(envelope);
      if (over[envelope.type]) return over[envelope.type](envelope);
      switch (envelope.type) {
        case ACT3:
        case ACT4: {
          const doc = structuredClone(envelope.payload.document);
          doc.proof = { type: "DataIntegrityProof" };
          return { principal: doc.issuer, document: doc };
        }
        case KEY_PACKAGE:
          minted += 1;
          return { keyPackage: `kp-${minted}`, expiresAt: "2099-01-01T00:00:00Z" };
        case WELCOME:
          if (joined.has(envelope.payload.roomId)) {
            throw new VtaClientError("e.p.msg.bad_request", "already", {
              details: { code: "rooms/keys/welcome:alreadyJoined" },
            });
          }
          joined.add(envelope.payload.roomId);
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
        if (doc.type === LIST || doc.type === LIST2) return { items: offers };
        if (doc.type === ACCEPT) {
          if (accept) return accept(doc);
          const kp = doc.payload.keyPackage;
          if (!welcomes.has(kp)) welcomes.set(kp, `welcome-for-${kp}`);
          return { roomId: doc.payload.roomId, state: "admitted", epoch: 2, welcome: welcomes.get(kp), ratchetTree: "tree" };
        }
        throw new Error(`unexpected ${doc.type}`);
      },
    },
  };
}

function setup({ vta = memberVta(), vtc = community(), journal = new InMemoryKVStore(), joined } = {}) {
  const received = [];
  const reader = {
    holder: WALLET,
    vta: { did: VTA, sender: vta },
    community: { did: COMMUNITY, sender: vtc.sender },
    member: MEMBER,
  };
  const deps = {
    journal,
    async receive(c) {
      received.push(c);
    },
    joined: joined ?? (async (roomId) => vta.joined?.has(roomId) ?? false),
  };
  return { vta, vtc, journal, received, reader, deps };
}

const KEY = offerAcceptKey(VTA, COMMUNITY, MEMBER, BOARD);

test("a sealed room: credentials stored, a KeyPackage the VTA minted, accepted as the member, joined from the Welcome", async () => {
  const s = setup();
  const journalAtAccept = [];
  s.vtc.sender.sendCompleted = ((inner) => async (doc, opts) => {
    if (doc.type === ACCEPT) journalAtAccept.push(await s.journal.get(KEY));
    return inner(doc, opts);
  })(s.vtc.sender.sendCompleted.bind(s.vtc.sender));

  const r = await acceptCommunityRoomOffer(s.reader, BOARD, s.deps);
  assert.deepEqual(r, { roomId: BOARD, member: MEMBER, communityDid: COMMUNITY, visibility: "private", joined: true, epoch: 2, resumed: false });

  assert.deepEqual(s.received, [MEMBERSHIP, AUTHORITY], "both credentials go into the VTA's vault");
  const kp = s.vta.sent.find((e) => e.type === KEY_PACKAGE);
  assert.equal(kp.recipient, VTA, "the KeyPackage is minted by the member's VTA, never the wallet");
  assert.deepEqual(kp.payload, { roomId: BOARD, invitation: INVITATION });

  const accept = s.vtc.docs.find((d) => d.doc.type === ACCEPT).doc;
  assert.equal(accept.issuer, MEMBER, "the community sees the member");
  assert.equal(accept.recipient, COMMUNITY);
  assert.deepEqual(accept.payload, { roomId: BOARD, keyPackage: "kp-1" });
  const asked = s.vta.sent.filter((e) => e.type === ACT4).map((e) => e.payload.document.type);
  assert.deepEqual(asked, [LIST2, ACCEPT], "both requests are completed by the VTA at act 0.4");
  assert.equal(s.vta.sent.some((e) => e.type === ACT3), false);

  assert.equal(journalAtAccept[0]?.keyPackage, "kp-1", "the KeyPackage is journaled before the acceptance leaves");
  const welcome = s.vta.sent.find((e) => e.type === WELCOME);
  assert.deepEqual(welcome.payload, { roomId: BOARD, invitation: INVITATION, welcome: "welcome-for-kp-1", ratchetTree: "tree" });
  assert.equal(await s.journal.get(KEY), undefined, "a finished accept leaves nothing behind");
});

test("an open room: no KeyPackage, no Welcome, nothing journaled", async () => {
  const s = setup({ vtc: community({ offers: [offer({ visibility: "open" })], accept: (doc) => ({ roomId: doc.payload.roomId, state: "admitted", epoch: 4 }) }) });
  const r = await acceptCommunityRoomOffer(s.reader, BOARD, s.deps);
  assert.equal(r.joined, false);
  assert.equal(r.epoch, 4);
  assert.equal(s.vta.minted, 0);
  assert.deepEqual(s.vtc.docs.find((d) => d.doc.type === ACCEPT).doc.payload, { roomId: BOARD });
  assert.equal(s.vta.sent.some((e) => e.type === WELCOME), false);
});

test("a lost answer is retried with the SAME KeyPackage, and the community answers with the same Welcome", async () => {
  const journal = new InMemoryKVStore();
  const vta = memberVta();
  let lose = true;
  const vtc = community();
  const inner = vtc.sender.sendCompleted.bind(vtc.sender);
  vtc.sender.sendCompleted = async (doc, opts) => {
    const reply = await inner(doc, opts);
    if (doc.type === ACCEPT && lose) {
      lose = false;
      // Admitted at the community; the answer never reached the wallet.
      throw new VtaClientError("e.client.timeout", "the room host did not respond within 30s");
    }
    return reply;
  };
  const s = setup({ vta, vtc, journal });

  await assert.rejects(acceptCommunityRoomOffer(s.reader, BOARD, s.deps), (e) => {
    assert.ok(e instanceof RoomOfferError);
    assert.equal(e.code, "noAnswer");
    assert.equal(e.retryable, true);
    assert.match(e.message, /same key package/);
    return true;
  });
  assert.equal((await journal.get(KEY))?.keyPackage, "kp-1", "kept for the retry");

  // The community now lists the offer as accepted; the retry must not mint.
  vtc.sender.sendCompleted = ((prev) => async (doc, opts) =>
    doc.type === LIST ? { items: [offer({ state: "accepted" })] } : prev(doc, opts))(vtc.sender.sendCompleted);
  const r = await acceptCommunityRoomOffer(s.reader, BOARD, s.deps);
  assert.equal(vta.minted, 1, "one KeyPackage for the whole accept");
  const accepts = vtc.docs.filter((d) => d.doc.type === ACCEPT).map((d) => d.doc.payload.keyPackage);
  assert.deepEqual(accepts, ["kp-1", "kp-1"]);
  assert.equal(r.joined, true);
  assert.equal(r.resumed, true);
  assert.equal(vta.sent.filter((e) => e.type === WELCOME)[0].payload.welcome, "welcome-for-kp-1");
  assert.equal(await journal.get(KEY), undefined);
});

test("a Welcome the VTA already joined from (an earlier answer lost after the join) finishes the accept", async () => {
  const vta = memberVta();
  vta.joined.add(BOARD);
  const s = setup({ vta });
  const r = await acceptCommunityRoomOffer(s.reader, BOARD, s.deps);
  assert.equal(r.joined, true);
  assert.equal(await s.journal.get(KEY), undefined);
});

test("community still settling (admissionPending): retryable, and the KeyPackage is kept", async () => {
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
  assert.equal((await s.journal.get(KEY))?.keyPackage, "kp-1");
});

test("a VTA answer made as anyone but the member is refused, and nothing reaches the community", async () => {
  const vta = memberVta({
    [ACT4]: (envelope) => {
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

test("a VTA without act 0.3 is told it must be updated", async () => {
  const unsupported = () => {
    throw new VtaClientError("e.p.msg.bad_request", "no such task", { details: { code: "unsupportedType" } });
  };
  const vta = memberVta({ [ACT4]: unsupported, [ACT3]: unsupported });
  const s = setup({ vta });
  await assert.rejects(acceptCommunityRoomOffer(s.reader, BOARD, s.deps), (e) => {
    assert.equal(e.code, "actUnsupported");
    assert.match(e.message, /must be updated/);
    return true;
  });
});

test("a missing capability names the command that restores it", async () => {
  const vta = memberVta({
    [ACT4]: () => {
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

test("accepted elsewhere: done if the VTA is in, otherwise the member is told who can undo it", async () => {
  const accepted = () => community({ offers: [offer({ state: "accepted" })] });
  const inAlready = setup({ vtc: accepted(), joined: async () => true });
  const r = await acceptCommunityRoomOffer(inAlready.reader, BOARD, inAlready.deps);
  assert.equal(r.resumed, true);
  assert.equal(inAlready.vtc.docs.some((d) => d.doc.type === ACCEPT), false, "no second acceptance");

  const out = setup({ vtc: accepted(), joined: async () => false });
  await assert.rejects(acceptCommunityRoomOffer(out.reader, BOARD, out.deps), (e) => e.code === "alreadyAccepted");
  assert.equal(out.vta.minted, 0, "a second KeyPackage would be refused, so none is minted");
});

test("no offer of the room and nothing in progress is notFound", async () => {
  const s = setup({ vtc: community({ offers: [] }) });
  await assert.rejects(acceptCommunityRoomOffer(s.reader, BOARD, s.deps), (e) => e.code === "notFound");
});

test("a KeyPackage the VTA has let go is dropped, so the next attempt mints afresh", async () => {
  const journal = new InMemoryKVStore();
  await journal.put(KEY, {
    v: 1, vtaDid: VTA, communityDid: COMMUNITY, member: MEMBER, roomId: BOARD,
    visibility: "private", invitation: INVITATION, keyPackage: "kp-old", startedAt: "2026-10-14T10:00:00Z",
  });
  let refuse = true;
  const vta = memberVta({
    [ACT4]: (envelope) => {
      if (envelope.payload.document.type === ACCEPT && refuse) {
        refuse = false;
        throw new VtaClientError("e.p.msg.bad_request", "not held", { details: { code: "rooms/keys/act:keyPackageNotHeld" } });
      }
      const doc = structuredClone(envelope.payload.document);
      doc.proof = { type: "DataIntegrityProof" };
      return { principal: doc.issuer, document: doc };
    },
  });
  const s = setup({ vta, journal });
  await assert.rejects(acceptCommunityRoomOffer(s.reader, BOARD, s.deps), (e) => e.code === "keyPackageNotHeld");
  assert.equal(await journal.get(KEY), undefined);
  const r = await acceptCommunityRoomOffer(s.reader, BOARD, s.deps);
  assert.equal(r.joined, true);
  assert.equal(vta.minted, 1);
});

test("the community refusing the offer read during an accept is the community's refusal, not the agent's", async () => {
  for (const [code, want] of [["unsupportedType", "noRoomOffers"], ["permissionDenied", "communityRefused"]]) {
    const vtc = community();
    const inner = vtc.sender.sendCompleted;
    vtc.sender.sendCompleted = async (doc, opts) => {
      if (doc.type === LIST || doc.type === LIST2) {
        throw new VtaClientError("e.p.msg.bad_request", "refused", { details: { code } });
      }
      return inner(doc, opts);
    };
    const s = setup({ vtc });
    await assert.rejects(acceptCommunityRoomOffer(s.reader, BOARD, s.deps), (e) => {
      assert.equal(e.code, want);
      assert.doesNotMatch(e.message, /Your agent|act 0\.3/);
      return true;
    });
  }
});

// ── Members and communities upgrade on their own schedules ──────────────────

test("a VTA without act 0.4: the offers are read at list 0.1 and the acceptance signed at act 0.3", async () => {
  const vta = memberVta({
    [ACT4]: () => {
      throw new VtaClientError("e.p.msg.bad_request", "no such task", { details: { code: "unsupportedType" } });
    },
  });
  const s = setup({ vta });
  const r = await acceptCommunityRoomOffer(s.reader, BOARD, s.deps);
  assert.equal(r.joined, true);
  const at3 = s.vta.sent.filter((e) => e.type === ACT3).map((e) => e.payload.document.type);
  assert.deepEqual(at3, [LIST, ACCEPT]);
  const at4 = s.vta.sent.filter((e) => e.type === ACT4).map((e) => e.payload.document.type);
  assert.deepEqual(at4, [LIST2], "act 0.4 was asked once, for the listing, and not again");
  assert.deepEqual(s.vtc.docs.map((d) => d.doc.type), [LIST, ACCEPT]);
});

test("a community without list 0.2: the offers are read at list 0.1, still through act 0.4, and accepted there", async () => {
  const vtc = community();
  const inner = vtc.sender.sendCompleted;
  vtc.sender.sendCompleted = async (doc, opts) => {
    if (doc.type === LIST2) {
      throw new VtaClientError("e.p.msg.bad_request", "no such version", {
        details: { code: "unsupportedVersion" },
      });
    }
    return inner(doc, opts);
  };
  const s = setup({ vtc });
  const r = await acceptCommunityRoomOffer(s.reader, BOARD, s.deps);
  assert.equal(r.joined, true);
  assert.deepEqual(
    s.vta.sent.filter((e) => e.type === ACT4 || e.type === ACT3).map((e) => [e.type, e.payload.document.type]),
    [
      [ACT4, LIST2],
      [ACT4, LIST],
      [ACT4, ACCEPT],
    ],
  );
});
