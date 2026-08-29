// An executor-initiated TSP frame becomes a verified inbound message — or is
// refused before anything downstream could act on it.
//
// The refusals matter more than the happy path here. This is the entry point
// for `task-consent` and step-up requests arriving over TSP, which are the
// documents a human is shown and asked to authorise: a frame that reaches the
// pipeline having only *claimed* an identity is a prompt attributed to an
// executor that did not send it.

import { test } from "node:test";
import assert from "node:assert/strict";

import { unpackInboundTsp, TRUST_TASK_ENVELOPE_TYPE } from "../dist/index.js";
import { pack } from "@openvtc/vti-tsp-js";
import { ed25519, x25519 } from "@noble/curves/ed25519.js";

const utf8 = new TextEncoder();


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

const holder = tspIdentity("did:peer:2holder");
const executor = tspIdentity("did:web:vta.example");

function holderIdentity() {
  return {
    vid: holder.vid,
    signingPrivateKey: holder.signSk,
    encryptionPrivateKey: holder.encSk,
    encryptionPublicKey: holder.encPk,
  };
}

/** Resolves whatever VID it is given to `endpoint`'s keys. */
function resolverFor(endpoint) {
  return async (vid) => ({
    vid,
    encryptionPublicKey: endpoint.encPk,
    signingPublicKey: endpoint.signPk,
  });
}

async function sealed(payload, { from = executor, senderVid = from.vid } = {}) {
  const out = await pack(
    utf8.encode(typeof payload === "string" ? payload : JSON.stringify(payload)),
    senderVid,
    holder.vid,
    {
      senderSigningKey: from.signSk,
      senderEncryptionKey: from.encSk,
      receiverEncryptionKey: holder.encPk,
    },
  );
  return out.bytes;
}

const DOC = {
  id: "urn:uuid:doc-1",
  type: "https://trusttasks.org/spec/task-consent/request/0.1",
  issuer: executor.vid,
  payload: { challenge: "c", payloadDigest: "zQm…" },
};

test("a verified frame becomes the message shape the inbound pipeline consumes", async () => {
  const message = await unpackInboundTsp(await sealed(DOC), {
    holder: holderIdentity(),
    resolveSender: resolverFor(executor),
  });

  // The document is the body, exactly as the DIDComm binding envelope carries
  // it — so the proof check, the enrolled-executor check and the §7.2 item 11
  // dedup claim all see what they already expect.
  assert.deepEqual(message.body, DOC);
  assert.equal(message.type, TRUST_TASK_ENVELOPE_TYPE);
  // `id` is the DOCUMENT's id, not a transport id. TSP has none to borrow, and
  // §7.2 item 11 says a transport identifier must not substitute for it anyway.
  assert.equal(message.id, DOC.id);
  // `from` is the PROVEN sender, established by unpack — not the VID the frame
  // named on the way in.
  assert.equal(message.from, executor.vid);
  assert.deepEqual(message.to, [holder.vid]);
  assert.equal(message.transport, "tsp");
});

test("a frame naming a sender whose keys do not verify it is refused", async () => {
  // The frame claims to come from the executor, but is signed and sender-bound
  // by someone else's keys. The cleartext VID is the routing hint; the crypto
  // is what decides, and it says no.
  const imposter = tspIdentity("did:web:imposter.example");
  const bytes = await sealed(DOC, { from: imposter, senderVid: executor.vid });

  await assert.rejects(
    () =>
      unpackInboundTsp(bytes, {
        holder: holderIdentity(),
        // Resolves the *claimed* sender to the real executor's keys, which is
        // exactly what production does.
        resolveSender: resolverFor(executor),
      }),
    (e) => e.code === "e.p.msg.unauthorized",
  );
});

test("a sender whose DID will not resolve is refused, not assumed", async () => {
  const bytes = await sealed(DOC);
  await assert.rejects(
    () =>
      unpackInboundTsp(bytes, {
        holder: holderIdentity(),
        resolveSender: async () => {
          throw new Error("did document unreachable");
        },
      }),
    (e) => e.code === "e.client.parse" && /cannot resolve sender/.test(e.message),
  );
});

test("a payload that is not JSON is refused", async () => {
  const bytes = await sealed("not json at all");
  await assert.rejects(
    () =>
      unpackInboundTsp(bytes, {
        holder: holderIdentity(),
        resolveSender: resolverFor(executor),
      }),
    (e) => e.code === "e.client.parse",
  );
});

test("a payload that is not a Trust-Task document is refused", async () => {
  // No `id`, so nothing downstream could de-duplicate or recover it: the dedup
  // claim and the pending-inbound record are both keyed on the document id, and
  // an inbound with no stable identity would re-prompt on every redelivery.
  const bytes = await sealed({ type: "something", payload: {} });
  await assert.rejects(
    () =>
      unpackInboundTsp(bytes, {
        holder: holderIdentity(),
        resolveSender: resolverFor(executor),
      }),
    (e) => e.code === "e.client.parse" && /not a Trust-Task document/.test(e.message),
  );
});

test("bytes that are not a TSP envelope are refused", async () => {
  await assert.rejects(
    () =>
      unpackInboundTsp(new Uint8Array([1, 2, 3, 4]), {
        holder: holderIdentity(),
        resolveSender: resolverFor(executor),
      }),
    (e) => e.code === "e.client.parse" && /unreadable envelope/.test(e.message),
  );
});
