import { test } from "node:test";
import assert from "node:assert/strict";

import { TspChannel, VtaSession, buildTrustTask } from "../dist/index.js";
import { pack, unpack } from "@openvtc/vti-tsp-js";
import { ed25519, x25519 } from "@noble/curves/ed25519.js";

const utf8 = new TextEncoder();
const fromUtf8 = new TextDecoder();

function tspIdentity(vid) {
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

/**
 * An in-memory TspTransport that plays the VTA: unpacks the request with real
 * TSP crypto, hands the decoded trust-task to `dispatch`, and seals the reply
 * document back to the holder over TSP. Exercises the full round-trip both
 * directions with real HPKE-Auth + Ed25519 + CESR.
 */
function simulatedVtaTransport(vta, holder, dispatch, replySenderVid) {
  return {
    async sendAndAwaitReply(packed) {
      const req = await unpack(packed, {
        receiverDecryptionKey: vta.encSk,
        senderEncryptionKey: holder.encPk,
        senderSigningKey: holder.signPk,
      });
      assert.equal(req.sender, holder.vid);
      assert.equal(req.receiver, vta.vid);
      const reqDoc = JSON.parse(fromUtf8.decode(req.payload));
      const replyDoc = dispatch(reqDoc);
      // Seal the reply under `replySenderVid` (defaults to the VTA's real VID),
      // still using the VTA's keys — so the channel's own sender-VID check is
      // what's exercised, not a crypto failure.
      const sealed = await pack(utf8.encode(JSON.stringify(replyDoc)), replySenderVid ?? vta.vid, holder.vid, {
        senderSigningKey: vta.signSk,
        senderEncryptionKey: vta.encSk,
        receiverEncryptionKey: holder.encPk,
      });
      return sealed.bytes;
    },
  };
}

function makeChannel(dispatch, replySenderVid) {
  const holder = tspIdentity("did:web:holder.example");
  const vta = tspIdentity("did:web:vta.example");
  const transport = simulatedVtaTransport(vta, holder, dispatch, replySenderVid);
  const channel = new TspChannel({
    transport,
    holder: {
      vid: holder.vid,
      signingPrivateKey: holder.signSk,
      encryptionPrivateKey: holder.encSk,
      encryptionPublicKey: holder.encPk,
    },
    vta: {
      vid: "did:web:vta.example", // what the channel expects as the reply sender
      encryptionPublicKey: vta.encPk,
      signingPublicKey: vta.signPk,
    },
  });
  return { channel, holder, vta };
}

const LIST = "https://trusttasks.org/spec/vault/list/0.2";
const LIST_RESP = `${LIST}#response`;

test("TspChannel round-trips a trust task through a simulated VTA (real TSP crypto both ways)", async () => {
  let seenType;
  const { channel } = makeChannel((reqDoc) => {
    seenType = reqDoc.type;
    return { type: LIST_RESP, payload: { entries: [{ id: "e1" }], truncated: false } };
  });

  const env = buildTrustTask(LIST, { contextId: "work" }, {
    issuer: "did:web:holder.example",
    recipient: "did:web:vta.example",
  });
  const res = await channel.send(env, { expectedResponseType: LIST_RESP });

  assert.equal(seenType, LIST); // the VTA received the exact task type
  assert.deepEqual(res, { entries: [{ id: "e1" }], truncated: false });
});

test("TspChannel decodes a trust-task-error reply into a typed VtaClientError", async () => {
  const { channel } = makeChannel(() => ({
    type: "https://trusttasks.org/spec/trust-task-error/0.2",
    payload: { code: "vault/list:permissionDenied", message: "nope", retryable: false },
  }));
  const env = buildTrustTask(LIST, {}, { issuer: "did:web:holder.example", recipient: "did:web:vta.example" });
  await assert.rejects(
    () => channel.send(env, { expectedResponseType: LIST_RESP }),
    (e) => e.code === "e.p.msg.forbidden" && /nope/.test(e.message),
  );
});

test("TspChannel rejects a reply from the wrong sender VID", async () => {
  // The simulated VTA seals as a *different* VID than the channel expects.
  const { channel } = makeChannel(
    () => ({ type: LIST_RESP, payload: {} }),
    "did:web:imposter.example",
  );
  const env = buildTrustTask(LIST, {}, { issuer: "did:web:holder.example", recipient: "did:web:vta.example" });
  await assert.rejects(
    () => channel.send(env, { expectedResponseType: LIST_RESP }),
    (e) => e.code === "e.p.msg.unauthorized",
  );
});

test("VtaSession routes over TSP when present (TSP > DIDComm > REST)", async () => {
  const { channel } = makeChannel(() => ({ type: LIST_RESP, payload: { entries: [], truncated: false } }));
  const restStub = { kind: "rest", async send() { throw new Error("REST should not be used"); } };
  const session = new VtaSession([restStub, channel]);
  assert.equal(session.primaryKind, "tsp");
  const env = buildTrustTask(LIST, {}, { issuer: "did:web:holder.example", recipient: "did:web:vta.example" });
  const res = await session.send(env, { expectedResponseType: LIST_RESP });
  assert.deepEqual(res, { entries: [], truncated: false });
});
