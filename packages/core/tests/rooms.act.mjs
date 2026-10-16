// Acting in a room as the member: what the wallet hands its VTA, and what it
// accepts back before it sends anything to a host.

import { test } from "node:test";
import assert from "node:assert/strict";

import { roomsKeysAct, unsignedRoomRequest, actAndSend, RoomActError } from "../dist/rooms/index.js";

const WALLET = { did: "did:key:zWallet" };
const VTA = { did: "did:webvh:QmAgent:agent.example" };
const HOST = "did:webvh:QmHost:host.example";
const PERSONA = "did:webvh:QmAlice:people.example";
const ROOM = "did:webvh:QmRoom:rooms.example";
const INFO = "https://trusttasks.org/spec/rooms/info/0.1";

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
    [(d) => ({ ...d, type: "https://trusttasks.org/spec/rooms/records/put/0.1" }), /not the one it was asked/],
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
    (e) => e instanceof RoomActError && e.code === "principalAmbiguous" && /context of the one you mean/.test(e.message),
  );
});
