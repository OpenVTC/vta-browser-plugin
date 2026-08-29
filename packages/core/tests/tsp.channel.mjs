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
    /** What the channel's predicate said about the last sealed reply. */
    lastClaim: undefined,
    async sendAndAwaitReply(packed, options = {}) {
      const req = await unpack(packed, {
        receiverDecryptionKey: vta.encSk,
        senderEncryptionKey: holder.encPk,
        senderSigningKey: holder.signPk,
      });
      assert.equal(req.sender, holder.vid);
      assert.equal(req.receiver, vta.vid);
      const reqDoc = JSON.parse(fromUtf8.decode(req.payload));
      const replyDoc = dispatch(reqDoc);
      // The real VTA threads its response to the request: `respond_with` sets
      // `thread_id = self.thread_id.or(self.id)`. The channel correlates on
      // exactly that, so a double that omitted it would let a broken predicate
      // pass. A dispatch that sets `threadId` itself keeps it — that is how the
      // mis-threaded case below is expressed.
      if (replyDoc.threadId === undefined) replyDoc.threadId = reqDoc.id;
      // Seal the reply under `replySenderVid` (defaults to the VTA's real VID),
      // still using the VTA's keys — so the channel's own sender-VID check is
      // what's exercised, not a crypto failure.
      const sealed = await pack(utf8.encode(JSON.stringify(replyDoc)), replySenderVid ?? vta.vid, holder.vid, {
        senderSigningKey: vta.signSk,
        senderEncryptionKey: vta.encSk,
        receiverEncryptionKey: holder.encPk,
      });
      // Honour the transport contract: the channel decides which frame is its
      // reply, and the connection only resolves a waiter whose predicate says
      // yes. A double that just returned the bytes would never exercise the
      // correlation this seam exists for.
      if (options.claims) {
        this.lastClaim = await options.claims(sealed.bytes);
        if (!this.lastClaim) {
          throw new Error("simulated VTA: the channel did not claim this reply");
        }
      }
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
    // The document proof (SPEC §7.2 item 7a), distinct from the outer TSP
    // signature above though it uses the same key — exactly as production
    // does, where both come from the holder's Ed25519 identity.
    signing: {
      did: holder.vid,
      kid: `${holder.vid}#key-2`,
      privateKey: holder.signSk,
      publicKey: holder.signPk,
    },
    vta: {
      vid: "did:web:vta.example", // what the channel expects as the reply sender
      encryptionPublicKey: vta.encPk,
      signingPublicKey: vta.signPk,
    },
  });
  return { channel, holder, vta, transport };
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

test("TspChannel never accepts a reply sealed by the wrong sender VID", async () => {
  // The simulated VTA seals as a *different* VID than the channel expects.
  const { channel, transport } = makeChannel(
    () => ({ type: LIST_RESP, payload: {} }),
    "did:web:imposter.example",
  );
  const env = buildTrustTask(LIST, {}, { issuer: "did:web:holder.example", recipient: "did:web:vta.example" });
  await assert.rejects(() => channel.send(env, { expectedResponseType: LIST_RESP }));

  // The property is unchanged — an imposter's frame is never this request's
  // answer — but where it is decided has moved, and that is the point. The
  // channel used to accept the frame and then throw `unauthorized`; it now
  // declines to claim it at all.
  //
  // That matters on a shared socket. A frame from someone else is not an error
  // for *this* request, it is simply not its reply: refusing it here would let
  // any peer with socket access fail an unrelated in-flight operation. Declined
  // instead, it falls through to the unsolicited-inbound path, where
  // `unpackInboundTsp` resolves the claimed sender's own keys and fails the
  // unpack — so an imposter is still refused, by the code whose job that is.
  assert.equal(transport.lastClaim, false, "an imposter's frame must not be claimed");
});

test("TspChannel does not claim a reply threaded to a different request", async () => {
  // Correlation, not just crypto: a document the VTA legitimately sealed to us
  // but threaded to some other request is not this request's reply. Under the
  // old FIFO waiter it would have been taken as one — which is exactly what an
  // executor-initiated push arriving mid-request looks like.
  const { channel, transport } = makeChannel(() => ({
    type: LIST_RESP,
    threadId: "urn:uuid:some-other-request",
    payload: { entries: [], truncated: false },
  }));
  const env = buildTrustTask(LIST, {}, { issuer: "did:web:holder.example", recipient: "did:web:vta.example" });
  await assert.rejects(() => channel.send(env, { expectedResponseType: LIST_RESP }));
  assert.equal(transport.lastClaim, false, "a mis-threaded document must not be claimed");
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
