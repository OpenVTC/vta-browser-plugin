import { test } from "node:test";
import assert from "node:assert/strict";

import { TspChannel, buildTrustTask, MemoryRelationshipStore } from "../dist/index.js";
import { pack, packAccept, unpack } from "@openvtc/vti-tsp-js";
import { ed25519, x25519 } from "@noble/curves/ed25519.js";
import { generateSigningIdentity } from "../dist/siop/self-issued.js";
import { openTspEnvelope, wrapTspEnvelope } from "../dist/vta/tsp-binding.js";
import { signTrustTask } from "../dist/trust-tasks/sign.js";

const fromUtf8 = new TextDecoder();
const utf8 = new TextEncoder();

const VTA_SIGNING = generateSigningIdentity();
const VTA_VID = VTA_SIGNING.did;

const LIST = "https://trusttasks.org/spec/vault/list/0.2";
const LIST_RESP = `${LIST}#response`;

function tspIdentity(vid) {
  const sign = ed25519.utils.randomSecretKey();
  const encr = x25519.utils.randomSecretKey();
  return { vid, signSk: sign, signPk: ed25519.getPublicKey(sign), encSk: encr, encPk: x25519.getPublicKey(encr) };
}

/**
 * A VTA that speaks Rev 3 relationship control messages.
 *
 * `gating` mirrors the specification's default (§7.2.2) and the Rust SDK's:
 * an application message from a VID it holds no relationship with is **dropped
 * silently**, which on this transport means the reply never resolves.
 */
function relationshipVta(vta, holder, { gating = true, answerInvites = true } = {}) {
  const sent = [];
  let related = false;
  return {
    sent,
    get related() {
      return related;
    },
    /** Simulate the VTA process restarting: its store is in-memory by default. */
    restart() {
      related = false;
    },
    async sendAndAwaitReply(packed, options = {}) {
      const req = await unpack(packed, {
        receiverDecryptionKey: vta.encSk,
        senderSigningKey: holder.signPk,
      });
      sent.push(req);

      if (req.messageType === "control") {
        if (req.control.controlType !== "invite") throw new Error("unexpected control message");
        if (!answerInvites) throw new Error("timeout: this VTA does not answer invites");
        related = true;
        const accept = await packAccept(req.control.digest, vta.vid, holder.vid, {
          senderSigningKey: vta.signSk,
          receiverEncryptionKey: holder.encPk,
        });
        if (options.claims && !(await options.claims(accept.bytes))) {
          throw new Error("the channel declined our accept");
        }
        return accept.bytes;
      }

      // An application message. §7.2.2: drop it if no relationship is held.
      if (gating && !related) {
        throw new Error("timeout: dropped, no relationship");
      }
      const reqDoc = openTspEnvelope(fromUtf8.decode(req.payload));
      const replyDoc = { type: LIST_RESP, payload: { entries: [], truncated: false }, threadId: reqDoc.id };
      await signTrustTask({ envelope: replyDoc, signing: VTA_SIGNING });
      const reply = await pack(utf8.encode(wrapTspEnvelope(replyDoc)), vta.vid, holder.vid, {
        senderSigningKey: vta.signSk,
        receiverEncryptionKey: holder.encPk,
      });
      if (options.claims && !(await options.claims(reply.bytes))) {
        throw new Error("the channel declined our reply");
      }
      return reply.bytes;
    },
  };
}

function makeChannel(opts = {}) {
  const holder = tspIdentity("did:web:holder.example");
  const vta = { ...tspIdentity(VTA_VID), signSk: VTA_SIGNING.privateKey, signPk: VTA_SIGNING.publicKey };
  const transport = relationshipVta(vta, holder, opts);
  const outcomes = [];
  const store = new MemoryRelationshipStore();
  const channel = new TspChannel({
    transport,
    holder: {
      vid: holder.vid,
      signingPrivateKey: holder.signSk,
      encryptionPrivateKey: holder.encSk,
      encryptionPublicKey: holder.encPk,
    },
    signing: {
      did: holder.vid,
      kid: `${holder.vid}#key-2`,
      privateKey: holder.signSk,
      publicKey: holder.signPk,
    },
    vta: { vid: vta.vid, encryptionPublicKey: vta.encPk, signingPublicKey: vta.signPk },
    relationships: store,
    handshakeTimeoutMs: 200,
    onRelationship: (o) => outcomes.push(o),
  });
  return { channel, transport, outcomes, store, holder };
}

const task = () =>
  buildTrustTask(LIST, { contextId: "work" }, { issuer: "did:web:holder.example", recipient: VTA_VID });

test("a gating VTA is invited before the first application message, and then answers", async () => {
  // Without the invite this send is dropped in silence — which is the whole
  // reason the handshake exists, and why this test asserts on the *order* of
  // what reached the VTA rather than only on the result.
  const { channel, transport, outcomes } = makeChannel({ gating: true });

  const res = await channel.send(task(), { expectedResponseType: LIST_RESP });
  assert.deepEqual(res, { entries: [], truncated: false });

  assert.equal(transport.sent.length, 2);
  assert.equal(transport.sent[0].messageType, "control", "the invite goes first");
  assert.equal(transport.sent[0].control.controlType, "invite");
  assert.equal(transport.sent[1].messageType, "direct", "then the trust task");
  assert.deepEqual(outcomes, [{ kind: "established", threadDigest: outcomes[0].threadDigest }]);
});

test("the relationship is formed once, not once per request", async () => {
  const { channel, transport } = makeChannel({ gating: true });
  await channel.send(task(), { expectedResponseType: LIST_RESP });
  await channel.send(task(), { expectedResponseType: LIST_RESP });
  await channel.send(task(), { expectedResponseType: LIST_RESP });

  const invites = transport.sent.filter((m) => m.messageType === "control");
  assert.equal(invites.length, 1, "three sends, one invite");
});

test("concurrent sends produce one invite, not one each", async () => {
  // A peer's state machine refuses `sendInvite` from `pending`, so N parallel
  // first-requests inviting N times would fail every one after the first.
  const { channel, transport } = makeChannel({ gating: true });
  await Promise.all([
    channel.send(task(), { expectedResponseType: LIST_RESP }),
    channel.send(task(), { expectedResponseType: LIST_RESP }),
    channel.send(task(), { expectedResponseType: LIST_RESP }),
  ]);
  const invites = transport.sent.filter((m) => m.messageType === "control");
  assert.equal(invites.length, 1);
});

test("a VTA that never answers an invite still gets the application message", async () => {
  // The mirror risk. A wallet that refused to send until an accept arrived
  // would have broken itself against every peer that does not gate — which is
  // every peer running today.
  const { channel, transport, outcomes } = makeChannel({ gating: false, answerInvites: false });

  const res = await channel.send(task(), { expectedResponseType: LIST_RESP });
  assert.deepEqual(res, { entries: [], truncated: false });

  assert.equal(outcomes[0].kind, "notAnswered");
  assert.equal(transport.sent[1].messageType, "direct", "sent anyway");
});

test("a VTA restart is recovered from by re-inviting, not by failing forever", async () => {
  // The far side's relationship store is in-memory by default, so it forgets
  // every relationship when it restarts. A wallet that kept believing its own
  // record would post into silence indefinitely.
  const { channel, transport } = makeChannel({ gating: true });
  await channel.send(task(), { expectedResponseType: LIST_RESP });
  assert.equal(transport.sent.filter((m) => m.messageType === "control").length, 1);

  transport.restart();

  // The next send is dropped (the VTA no longer knows us) and must clear our
  // cached record so the attempt after it re-invites.
  await assert.rejects(() => channel.send(task(), { expectedResponseType: LIST_RESP }));

  await channel.send(task(), { expectedResponseType: LIST_RESP });
  assert.equal(
    transport.sent.filter((m) => m.messageType === "control").length,
    2,
    "re-invited after the restart",
  );
});

test("the invite names the holder and the VTA, and carries a fresh 128-bit nonce", async () => {
  const { channel, transport, holder } = makeChannel({ gating: true });
  await channel.send(task(), { expectedResponseType: LIST_RESP });
  const invite = transport.sent[0];
  assert.equal(invite.sender, holder.vid);
  assert.equal(invite.receiver, VTA_VID);
  assert.equal(invite.control.nonce.length, 16);
  assert.deepEqual(invite.control.route, [], "no Reply_Path: the accept comes back directly");
});
