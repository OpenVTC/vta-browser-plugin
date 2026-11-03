// Notifications held for the principal: the VTA tasks the wallet asks, the
// receipt a sender is answered with, and an election notification shown only
// as notified (VTI-NTF-050 – 056, VTI-NTF-063).

import { test } from "node:test";
import assert from "node:assert/strict";

import {
  ELECTION_KIND,
  NOTIFICATIONS_DEPOSIT_TYPE,
  NOTIFICATIONS_NOTIFY_TYPE,
  NOTIFICATIONS_RELAY_TYPE,
  inboundNotificationOf,
  notificationReceiptOf,
  notificationsDeposit,
  notificationsDismiss,
  notificationsList,
  notificationsListAll,
  notificationsShow,
  notifiedElectionOf,
} from "../dist/notifications/index.js";

const AGENT = { holder: { did: "did:key:zWallet" }, service: { did: "did:webvh:QmAgent:agent.example" } };
const COMMUNITY = "did:webvh:QmCommunity:community.example";
const PARTY = "did:webvh:QmParty:party.example";
const MEMBER = "did:webvh:QmAlice:people.example";

function recordingSender(replies) {
  const sent = [];
  const queue = Array.isArray(replies) ? [...replies] : null;
  return {
    sent,
    async send(envelope, opts) {
      sent.push({ envelope, opts });
      return queue ? queue.shift() : replies;
    },
  };
}

const notification = {
  notificationId: "n-7f3a",
  revision: 2,
  kind: ELECTION_KIND,
  subject: { heldBy: COMMUNITY, id: "agm-2027", openWith: "https://trusttasks.org/spec/vtc/elections/show/0.6" },
  audience: PARTY,
  status: "available",
  relayable: true,
  validFrom: "2027-03-01T09:00:00Z",
  validUntil: "2027-03-08T09:00:00Z",
};

// Timestamps written the way a sender wrote them, not the way `Date` would:
// the deposit must carry these exact strings (VTI-NTF-054).
const notify = {
  id: "urn:uuid:1",
  type: NOTIFICATIONS_NOTIFY_TYPE,
  issuer: COMMUNITY,
  recipient: PARTY,
  issuedAt: "2027-02-28T09:00:00.000000Z",
  payload: { notification },
  proof: { type: "DataIntegrityProof", proofValue: "z1" },
};
const relay = {
  id: "urn:uuid:2",
  type: NOTIFICATIONS_RELAY_TYPE,
  issuer: PARTY,
  recipient: MEMBER,
  issuedAt: "2027-02-28T10:00:00+00:00",
  payload: { forwarded: notify },
  proof: { type: "DataIntegrityProof", proofValue: "z2" },
};

test("list asks the VTA for one context, with only the filters given", async () => {
  const s = recordingSender({ items: [] });
  await notificationsList(s, AGENT, "vtc-party", { kind: ELECTION_KIND, heldBy: COMMUNITY });
  const { envelope, opts } = s.sent[0];
  assert.equal(envelope.type, "https://trusttasks.org/spec/vta/notifications/list/0.1");
  assert.deepEqual(envelope.payload, { contextId: "vtc-party", kind: ELECTION_KIND, heldBy: COMMUNITY });
  assert.equal(envelope.issuer, AGENT.holder.did);
  assert.equal(envelope.recipient, AGENT.service.did);
  assert.equal(opts.expectedResponseType, "https://trusttasks.org/spec/vta/notifications/list/0.1#response");
});

test("listAll follows the cursor, and stops on a cursor it was given before", async () => {
  const held = (id) => ({ recordId: id });
  const s = recordingSender([
    { items: [held("a")], nextCursor: "c1" },
    { items: [held("b")], nextCursor: "c2" },
    { items: [held("c")], nextCursor: "c1" },
  ]);
  const all = await notificationsListAll(s, AGENT, "ctx");
  assert.deepEqual(all.map((h) => h.recordId), ["a", "b", "c"]);
  assert.equal(s.sent[1].envelope.payload.cursor, "c1");
  assert.equal(s.sent.length, 3);
});

test("show and dismiss name the record in its context", async () => {
  const s = recordingSender({});
  await notificationsShow(s, AGENT, "ctx", "hn-0123456789abcdef");
  await notificationsDismiss(s, AGENT, "ctx", "hn-0123456789abcdef");
  assert.deepEqual(s.sent[0].envelope.payload, { contextId: "ctx", recordId: "hn-0123456789abcdef" });
  assert.equal(s.sent[1].envelope.type, "https://trusttasks.org/spec/vta/notifications/dismiss/0.1");
});

test("a deposit carries the received document itself, unaltered (VTI-NTF-054)", async () => {
  const received = JSON.parse(JSON.stringify(relay));
  const before = JSON.stringify(received);
  const s = recordingSender({ notificationId: "n-7f3a", revision: 2 });
  await notificationsDeposit(s, AGENT, "vtc-member", received);
  const { envelope } = s.sent[0];
  assert.equal(envelope.type, NOTIFICATIONS_DEPOSIT_TYPE);
  assert.equal(envelope.payload.document, received, "the same object, not a copy rebuilt from a typed form");
  assert.equal(JSON.stringify(envelope.payload.document), before);
  assert.equal(envelope.payload.contextId, "vtc-member");
});

test("a notify or relay is recognised by its type, and nothing else is", () => {
  assert.equal(inboundNotificationOf(notify)?.recipient, PARTY);
  assert.equal(inboundNotificationOf(relay)?.document, relay);
  assert.equal(inboundNotificationOf({ ...notify, type: "https://trusttasks.org/spec/notifications/notify/0.2" }), null);
  assert.equal(inboundNotificationOf({ ...notify, recipient: undefined }), null);
  assert.equal(inboundNotificationOf("not a document"), null);
});

test("the receipt is the innermost notification's id and revision", () => {
  assert.deepEqual(notificationReceiptOf(notify), { notificationId: "n-7f3a", revision: 2 });
  assert.deepEqual(notificationReceiptOf(relay), { notificationId: "n-7f3a", revision: 2 });
  let deep = notify;
  for (let i = 0; i < 5; i++) deep = { ...relay, payload: { forwarded: deep } };
  assert.equal(notificationReceiptOf(deep), null, "more than four relays carries no receipt");
  assert.equal(notificationReceiptOf({ type: NOTIFICATIONS_NOTIFY_TYPE, payload: {} }), null);
});

test("an election notification is shown as notified: community, id, audience, period (VTI-NTF-063)", () => {
  const held = {
    recordId: "hn-0123456789abcdef",
    contextId: "vtc-member",
    addressee: MEMBER,
    originator: COMMUNITY,
    relayedBy: [PARTY],
    notification,
    state: "active",
    receivedAt: "2027-02-28T10:00:01Z",
  };
  assert.deepEqual(notifiedElectionOf(held), {
    recordId: held.recordId,
    contextId: "vtc-member",
    community: COMMUNITY,
    electionId: "agm-2027",
    audience: PARTY,
    addressee: MEMBER,
    originator: COMMUNITY,
    relayedBy: [PARTY],
    status: "available",
    votingOpensAt: "2027-03-01T09:00:00Z",
    votingClosesAt: "2027-03-08T09:00:00Z",
    openWith: "https://trusttasks.org/spec/vtc/elections/show/0.6",
    dismissed: false,
  });
  assert.equal(notifiedElectionOf({ ...held, notification: { ...notification, kind: "org.example:meetingInvite" } }), null);
});
