import { test } from "node:test";
import assert from "node:assert/strict";

import { pack, unpack, packRouted, packNested, nextHop, MAX_HOPS } from "../dist/index.js";
import { ed25519, x25519 } from "@noble/curves/ed25519.js";

const enc = new TextEncoder();
const dec = new TextDecoder();

function party(vid) {
  const sign = ed25519.utils.randomSecretKey();
  const encr = x25519.utils.randomSecretKey();
  return {
    vid,
    signSk: sign,
    signPk: ed25519.getPublicKey(sign),
    encSk: encr,
    encPk: x25519.getPublicKey(encr),
  };
}
const packKeys = (sender, receiver) => ({
  senderSigningKey: sender.signSk,
  senderEncryptionKey: sender.encSk,
  receiverEncryptionKey: receiver.encPk,
});
const unpackKeys = (receiver, sender) => ({
  receiverDecryptionKey: receiver.encSk,
  senderEncryptionKey: sender.encPk,
  senderSigningKey: sender.signPk,
});

test("nextHop: forward until empty, then deliver", () => {
  const inner = enc.encode("payload");
  const s1 = nextHop(["hop2", "exit"], inner);
  assert.equal(s1.kind, "forward");
  assert.equal(s1.next, "hop2");
  assert.deepEqual(s1.remaining, ["exit"]);
  const s2 = nextHop([], inner);
  assert.equal(s2.kind, "deliver");
  assert.deepEqual(s2.inner, inner);
});

test("packRouted rejects empty and over-long routes", async () => {
  const alice = party("did:web:alice");
  const hop1 = party("did:web:hop1");
  await assert.rejects(packRouted(enc.encode("x"), [], alice.vid, hop1.vid, packKeys(alice, hop1)));
  const tooMany = Array.from({ length: MAX_HOPS + 1 }, (_, i) => `did:web:h${i}`);
  await assert.rejects(packRouted(enc.encode("x"), tooMany, alice.vid, hop1.vid, packKeys(alice, hop1)));
});

test("routed multi-hop round-trip: alice → hop1 → hop2 → final (inner opaque)", async () => {
  const alice = party("did:web:alice");
  const hop1 = party("did:web:hop1");
  const hop2 = party("did:web:hop2");
  const final = party("did:web:final");

  // 1. alice seals the inner end-to-end to final (Direct).
  const inner = await pack(enc.encode("the secret"), alice.vid, final.vid, packKeys(alice, final));

  // 2. alice packs a routed layer to hop1, route = [hop2, final].
  const layer1 = await packRouted(
    inner.bytes,
    ["did:web:hop2", "did:web:final"],
    alice.vid,
    hop1.vid,
    packKeys(alice, hop1),
  );

  // 3. hop1 opens its layer, reads the route.
  const atHop1 = await unpack(layer1.bytes, unpackKeys(hop1, alice));
  assert.equal(atHop1.messageType, "routed");
  const step1 = nextHop(atHop1.hops, atHop1.payload);
  assert.equal(step1.kind, "forward");
  assert.equal(step1.next, "did:web:hop2");
  assert.deepEqual(step1.remaining, ["did:web:final"]);
  assert.deepEqual(step1.inner, inner.bytes); // inner still opaque

  // 4. hop1 re-seals to hop2 (authenticating as hop1).
  const layer2 = await packRouted(step1.inner, step1.remaining, hop1.vid, hop2.vid, packKeys(hop1, hop2));

  // 5. hop2 opens, sees route [final].
  const atHop2 = await unpack(layer2.bytes, unpackKeys(hop2, hop1));
  const step2 = nextHop(atHop2.hops, atHop2.payload);
  assert.equal(step2.kind, "forward");
  assert.equal(step2.next, "did:web:final");
  assert.deepEqual(step2.remaining, []);

  // 6. hop2 forwards the opaque inner to final; final unpacks the original.
  const delivered = await unpack(step2.inner, unpackKeys(final, alice));
  assert.equal(dec.decode(delivered.payload), "the secret");
  assert.equal(delivered.sender, "did:web:alice");
  assert.equal(delivered.receiver, "did:web:final");
  assert.equal(delivered.messageType, "direct");
});

test("an intermediary cannot open a layer addressed to a different hop", async () => {
  const alice = party("did:web:alice");
  const hop1 = party("did:web:hop1");
  const hop2 = party("did:web:hop2");
  const layer = await packRouted(enc.encode("inner"), ["did:web:hop2"], alice.vid, hop1.vid, packKeys(alice, hop1));
  await assert.rejects(unpack(layer.bytes, unpackKeys(hop2, alice)));
});

test("nested wrapper: mediator forwards an opaque inner it can't read", async () => {
  const alice = party("did:web:alice");
  const mediator = party("did:web:mediator");
  const bob = party("did:web:bob");

  const inner = await pack(enc.encode("for bob only"), alice.vid, bob.vid, packKeys(alice, bob));
  const nested = await packNested(inner.bytes, alice.vid, mediator.vid, packKeys(alice, mediator));

  const atMediator = await unpack(nested.bytes, unpackKeys(mediator, alice));
  assert.equal(atMediator.messageType, "nested");
  assert.deepEqual(atMediator.payload, inner.bytes);
  // mediator can't open the inner (sealed to bob)
  await assert.rejects(unpack(atMediator.payload, unpackKeys(mediator, alice)));

  const atBob = await unpack(inner.bytes, unpackKeys(bob, alice));
  assert.equal(dec.decode(atBob.payload), "for bob only");
});

// The wallet → mediator → VTA shape used by the production TspTransport.
test("wallet→mediator→VTA: routed layer to the mediator carries a direct inner to the VTA", async () => {
  const holder = party("did:web:holder");
  const mediator = party("did:web:mediator");
  const vta = party("did:web:vta");

  const inner = await pack(enc.encode('{"type":"vault/list"}'), holder.vid, vta.vid, packKeys(holder, vta));
  const routed = await packRouted(inner.bytes, [vta.vid], holder.vid, mediator.vid, packKeys(holder, mediator));

  // Mediator opens the routing layer → next hop is the VTA, then deliver.
  const atMediator = await unpack(routed.bytes, unpackKeys(mediator, holder));
  const step = nextHop(atMediator.hops, atMediator.payload);
  assert.equal(step.kind, "forward");
  assert.equal(step.next, "did:web:vta");
  assert.deepEqual(step.remaining, []); // VTA is the exit

  // VTA opens the forwarded opaque inner.
  const atVta = await unpack(step.inner, unpackKeys(vta, holder));
  assert.equal(dec.decode(atVta.payload), '{"type":"vault/list"}');
  assert.equal(atVta.sender, "did:web:holder");
});
