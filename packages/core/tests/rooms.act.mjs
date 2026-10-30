// Acting in a room as the member: what the wallet hands its VTA, and what it
// accepts back before it sends anything to a host.

import { test } from "node:test";
import assert from "node:assert/strict";

import {
  roomsKeysAct,
  unsignedRoomRequest,
  actAndSend,
  RoomActError,
  roomsKeysList,
  roomsKeysBrowse,
  roomsKeysRead,
  roomsKeysOpen,
  roomsKeysBackfill,
  heldRoomKey,
} from "../dist/rooms/index.js";
import { roomsKeysFileKey } from "../dist/rooms/files.js";

const WALLET = { did: "did:key:zWallet" };
const VTA = { did: "did:webvh:QmAgent:agent.example" };
const HOST = "did:webvh:QmHost:host.example";
const PERSONA = "did:webvh:QmAlice:people.example";
const ROOM = "did:webvh:QmRoom:rooms.example";
const INFO = "https://trusttasks.org/spec/rooms/info/0.3";

/** A VTA that completes the document, then lets `tamper` change what it returns. */
function vta(tamper = (d) => d) {
  const sent = [];
  return {
    sent,
    async send(envelope) {
      sent.push(envelope);
      const doc = structuredClone(envelope.payload.document);
      doc.issuer = PERSONA;
      doc.payload.presentation = { membership: "vmc", authority: ["leaf-read"] };
      doc.proof = { type: "DataIntegrityProof" };
      return { principal: PERSONA, document: tamper(doc) };
    },
  };
}

test("the request the VTA completes names the host, and not the wallet", () => {
  const doc = unsignedRoomRequest(INFO, HOST, { roomId: ROOM });
  assert.equal(doc.recipient, HOST);
  assert.equal(doc.issuer, undefined, "the VTA sets the member as issuer");
  assert.equal(doc.proof, undefined);
  assert.ok(doc.id.startsWith("urn:uuid:"));
  assert.equal(unsignedRoomRequest(INFO, HOST, {}, PERSONA).issuer, PERSONA);
});

test("a completed document is accepted only when it is the request that was asked for", async () => {
  const parties = { holder: WALLET, service: VTA };
  const ok = await roomsKeysAct(vta(), parties, unsignedRoomRequest(INFO, HOST, { roomId: ROOM }));
  assert.equal(ok.principal, PERSONA);
  assert.ok(ok.document.payload.presentation);

  const cases = [
    [(d) => ({ ...d, recipient: "did:key:zElsewhere" }), /not the one it was asked/],
    [(d) => ({ ...d, type: "https://trusttasks.org/spec/rooms/records/put/0.4" }), /not the one it was asked/],
    [(d) => ({ ...d, payload: { ...d.payload, roomId: "did:key:zOther" } }), /changed the payload's roomId/],
    [(d) => ({ ...d, payload: { ...d.payload, extra: 1 } }), /added extra/],
    [(d) => ({ ...d, issuer: "did:key:zSomeoneElse" }), /issued by did:key:zSomeoneElse/],
    [(d) => ({ ...d, proof: undefined }), /no proof/],
  ];
  for (const [tamper, why] of cases) {
    await assert.rejects(roomsKeysAct(vta(tamper), parties, unsignedRoomRequest(INFO, HOST, { roomId: ROOM })), why);
  }
});

test("the host receives the completed document, and a VTA refusal says what to do", async () => {
  const sent = [];
  const room = {
    roomId: ROOM,
    holder: WALLET,
    vta: { did: VTA.did, sender: vta() },
    host: { did: HOST, sender: { async sendCompleted(doc) { sent.push(doc); return { roomId: ROOM }; } } },
  };
  const { principal } = await actAndSend(room, INFO, `${INFO}#response`, { roomId: ROOM });
  assert.equal(principal, PERSONA);
  assert.equal(sent[0].issuer, PERSONA);

  const refusing = { ...room, vta: { did: VTA.did, sender: { send: () => Promise.reject(new Error("rooms/keys/act:principalAmbiguous")) } } };
  await assert.rejects(
    actAndSend(refusing, INFO, `${INFO}#response`, { roomId: ROOM }),
    (e) => e instanceof RoomActError && e.code === "principalAmbiguous" && /more than one member/.test(e.message),
  );
});

// ── Two members of one room on one VTA ──────────────────────────────────────

const COMMUNITY = "did:webvh:QmCommunity:community.example";

test("a room's member is named in every act, and an answer as anyone else is refused", async () => {
  const sent = [];
  const agent = vta();
  const room = {
    roomId: ROOM,
    member: PERSONA,
    holder: WALLET,
    vta: { did: VTA.did, sender: agent },
    host: { did: HOST, sender: { async sendCompleted(doc) { sent.push(doc); return { roomId: ROOM }; } } },
  };
  await actAndSend(room, INFO, `${INFO}#response`, { roomId: ROOM });
  assert.equal(agent.sent[0].payload.document.issuer, PERSONA, "the VTA is told whom to act as");

  // A VTA that acts as the community when the member was named is not believed.
  const wrong = {
    async send(envelope) {
      const doc = structuredClone(envelope.payload.document);
      doc.issuer = COMMUNITY;
      doc.proof = { type: "DataIntegrityProof" };
      return { principal: COMMUNITY, document: doc };
    },
  };
  await assert.rejects(
    roomsKeysAct(wrong, { holder: WALLET, service: VTA }, unsignedRoomRequest(INFO, HOST, { roomId: ROOM }, PERSONA)),
    /acted as did:webvh:QmCommunity/,
  );
});

test("each listed entry names its member (list 0.2), and two members of one room are two rows", async () => {
  const sender = {
    async send() {
      return {
        rooms: [
          { roomId: ROOM, member: COMMUNITY, epoch: 3, earliestReadableEpoch: 1 },
          { roomId: ROOM, member: PERSONA, epoch: 3, earliestReadableEpoch: 3 },
        ],
        ext: {
          "org.openvtc.rooms": {
            held: [
              { member: COMMUNITY, context: "vtc-test", actions: ["read", "write", "curate", "admin"] },
              { member: PERSONA, context: "default", actions: ["read", "write"] },
            ],
          },
        },
      };
    },
  };
  const rooms = await roomsKeysList(sender, { holder: WALLET, service: VTA });
  assert.deepEqual(
    rooms.map((r) => [r.member, r.context, r.actions?.includes("admin")]),
    [
      [COMMUNITY, "vtc-test", true],
      [PERSONA, "default", false],
    ],
  );
  assert.notEqual(heldRoomKey(rooms[0]), heldRoomKey(rooms[1]), "two rows, two keys");
});

test("every custody task names the member it acts as", async () => {
  const sent = [];
  const sender = {
    async send(envelope) {
      sent.push(envelope);
      return { key: "A".repeat(43), epoch: 1, plaintext: "", records: [], complete: true };
    },
  };
  const parties = { holder: WALLET, service: VTA };
  const member = PERSONA;
  await roomsKeysBrowse(sender, { ...parties, roomId: ROOM, host: HOST, member });
  await roomsKeysRead(sender, { ...parties, roomId: ROOM, host: HOST, key: "k", member });
  await roomsKeysOpen(sender, { ...parties, roomId: ROOM, key: "k", version: 1, sealed: { ciphertext: "c", nonce: "n", epoch: 1 }, member });
  await roomsKeysBackfill(sender, { ...parties, roomId: ROOM, host: HOST, member });
  await roomsKeysFileKey(sender, { ...parties, roomId: ROOM, fileId: "f", purpose: "seal", member });
  assert.equal(sent.length, 5);
  for (const e of sent) {
    assert.deepEqual(e.payload.ext, { "org.openvtc.rooms": { member: PERSONA } }, e.type);
  }
  // No member named: no ext, as before.
  await roomsKeysBrowse(sender, { ...parties, roomId: ROOM, host: HOST });
  assert.equal(sent.at(-1).payload.ext, undefined);
});
