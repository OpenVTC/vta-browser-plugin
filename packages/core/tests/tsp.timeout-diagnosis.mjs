// A TSP request that times out says whether anything arrived while it waited.
//
// Field case: a wallet's requests reached the agent, which dispatched them, and
// every one timed out. The error read only "timed out awaiting reply frame",
// which fits "the reply came and was refused" as well as "the reply never came".
// Telling them apart took screenshots of a console that happened to log no
// inbound frames. The error now says which.

import { test } from "node:test";
import assert from "node:assert/strict";

import { TspChannel, buildTrustTask, MemoryRelationshipStore } from "../dist/index.js";
import { ed25519, x25519 } from "@noble/curves/ed25519.js";
import { generateSigningIdentity } from "../dist/siop/self-issued.js";

const VTA_SIGNING = generateSigningIdentity();
const LIST = "https://trusttasks.org/spec/vault/list/0.2";

function tspIdentity(vid) {
  const sign = ed25519.utils.randomSecretKey();
  const encr = x25519.utils.randomSecretKey();
  return { vid, signSk: sign, signPk: ed25519.getPublicKey(sign), encSk: encr, encPk: x25519.getPublicKey(encr) };
}

/** A transport whose replies never resolve. With `junk`, one unreadable frame
 *  is offered to the request before it times out, as a frame from another peer
 *  would be on a shared socket. */
function silentTransport({ junk = false } = {}) {
  return {
    async sendAndAwaitReply(_bytes, { claims }) {
      if (junk) await claims(new Uint8Array([0xf8, 1, 2, 3]));
      throw new Error("timed out awaiting reply frame");
    },
  };
}

function channel(transport) {
  const holder = tspIdentity("did:web:holder.example");
  const vta = tspIdentity(VTA_SIGNING.did);
  return new TspChannel({
    transport,
    holder: {
      vid: holder.vid,
      signingPrivateKey: holder.signSk,
      encryptionPrivateKey: holder.encSk,
      encryptionPublicKey: holder.encPk,
    },
    signing: { did: holder.vid, kid: `${holder.vid}#key-2`, privateKey: holder.signSk, publicKey: holder.signPk },
    vta: { vid: vta.vid, encryptionPublicKey: vta.encPk, signingPublicKey: VTA_SIGNING.publicKey },
    relationships: new MemoryRelationshipStore(),
    handshakeTimeoutMs: 50,
  });
}

const task = () =>
  buildTrustTask(LIST, { contextId: "work" }, { issuer: "did:web:holder.example", recipient: VTA_SIGNING.did });

test("a timeout with nothing on the socket says the reply never reached the wallet", async () => {
  await assert.rejects(channel(silentTransport()).send(task()), (err) => {
    assert.match(err.message, /no frame arrived on this socket while waiting/);
    assert.equal(err.details?.framesSeen, 0);
    return true;
  });
});

test("a timeout after a frame was turned down names why, and is not called a lost reply", async () => {
  await assert.rejects(channel(silentTransport({ junk: true })).send(task()), (err) => {
    assert.match(err.message, /last inbound frame declined: unpack failed/);
    assert.doesNotMatch(err.message, /no frame arrived/);
    assert.equal(err.details?.framesSeen, 1);
    return true;
  });
});
