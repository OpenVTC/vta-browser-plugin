// One unpack per inbound frame, however many requests are waiting on the socket.
//
// Each frame is offered to every outstanding request, and each used to unpack it
// itself before it could read the thread id. With ~80 requests waiting — a
// console switched between agents a few times a second — a burst of replies
// cost thousands of serial decryptions on the thread that also sends (gt-vta,
// 2026-10-11). `openReplyOnce` shares the result.

import { test } from "node:test";
import assert from "node:assert/strict";

import { openReplyOnce } from "../dist/vta/tsp-channel.js";
import { wrapTspEnvelope } from "../dist/vta/tsp-binding.js";
import { pack } from "@openvtc/vti-tsp-js";
import { ed25519, x25519 } from "@noble/curves/ed25519.js";

const utf8 = new TextEncoder();

function party(vid) {
  const signSk = ed25519.utils.randomSecretKey();
  const encSk = x25519.utils.randomSecretKey();
  return { vid, signSk, signPk: ed25519.getPublicKey(signSk), encSk, encPk: x25519.getPublicKey(encSk) };
}

const holderParty = party("did:key:z6Mkholder");
const vtaParty = party("did:webvh:Qm:host:vta");

const holder = {
  vid: holderParty.vid,
  signingPrivateKey: holderParty.signSk,
  encryptionPrivateKey: holderParty.encSk,
  encryptionPublicKey: holderParty.encPk,
};
const vta = { vid: vtaParty.vid, encryptionPublicKey: vtaParty.encPk, signingPublicKey: vtaParty.signPk };

async function replyFrame(threadId) {
  const doc = { id: `urn:uuid:${crypto.randomUUID()}`, type: "x#response", threadId, payload: {} };
  const out = await pack(utf8.encode(wrapTspEnvelope(doc)), vtaParty.vid, holderParty.vid, {
    senderSigningKey: vtaParty.signSk,
    receiverEncryptionKey: holderParty.encPk,
  });
  return out.bytes;
}

test("every request offered the same frame shares one unpack", async () => {
  const bytes = await replyFrame("req-1");
  const first = openReplyOnce(bytes, holder, vta);
  // The transport hands each waiter the same object; each gets the same answer
  // without unpacking again.
  for (let i = 0; i < 50; i++) assert.equal(openReplyOnce(bytes, holder, vta), first);
  const opened = await first;
  assert.equal(opened.ok, true);
  assert.equal(opened.sender, vta.vid);
  assert.equal(opened.doc.threadId, "req-1");
});

test("a waiter holding different keys does not read another's result", async () => {
  const bytes = await replyFrame("req-2");
  const other = party("did:webvh:Qm:host:other");
  const otherVta = { vid: other.vid, encryptionPublicKey: other.encPk, signingPublicKey: other.signPk };

  const ours = openReplyOnce(bytes, holder, vta);
  const theirs = openReplyOnce(bytes, holder, otherVta);
  assert.notEqual(ours, theirs);
  assert.equal((await ours).ok, true);
  // Signed by `vta`, so it does not verify as `other`.
  const declined = await theirs;
  assert.equal(declined.ok, false);
  assert.match(declined.decline, /unpack failed/);
});

test("a different frame is unpacked afresh, even with identical bytes", async () => {
  const bytes = await replyFrame("req-3");
  const copy = new Uint8Array(bytes);
  assert.notEqual(openReplyOnce(bytes, holder, vta), openReplyOnce(copy, holder, vta));
});
