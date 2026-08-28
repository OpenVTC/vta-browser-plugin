// Every outbound Trust-Task document carries a verifiable proof.
//
// SPEC §7.2 item 7a lets a specification declare `proof` REQUIRED, and 93 of
// the 141 task types this wallet speaks do. Item 7 admits **no transport
// substitute**: the REST bearer, the TSP outer signature and the DIDComm
// authcrypt all authenticate the connection or the frame, and none of them
// says the party named in `issuer` vouched for this payload. A consumer
// enforcing the rule refuses the document with `proofRequired` before a
// handler sees it — which is what every mutating operation in this wallet did
// when the check was first turned on.
//
// These tests run the **real verifier** over the document as the counterparty
// receives it, rather than asserting a `proof` member exists: a signature
// copied from another document, or one taken over different bytes than the
// ones sent, satisfies the weaker check and fails the real one. That is the
// same reason the fixtures unpack with real crypto instead of inspecting the
// envelope before it is packed.

import { test } from "node:test";
import assert from "node:assert/strict";

import { ed25519, x25519 } from "@noble/curves/ed25519.js";
import { pack, unpack } from "@openvtc/vti-tsp-js";

import {
  DidcommVtaTransport,
  Identity,
  InMemoryDidcommBridge,
  TspChannel,
  TRUST_TASK_ENVELOPE_TYPE,
  buildTrustTask,
  generateSigningIdentity,
  signOutboundTask,
  verifyTrustTaskProof,
} from "../dist/index.js";

// `vault/delete/0.1` is one of the 93 — a mutation, and proof REQUIRED.
const VAULT_DELETE = "https://trusttasks.org/spec/vault/delete/0.1";

const utf8 = new TextEncoder();
const fromUtf8 = new TextDecoder();

/** Assert `doc` carries a proof that verifies as its own `issuer`. */
async function assertSignedBy(doc, expectedIssuer) {
  assert.ok(doc, "no document reached the counterparty");
  const res = await verifyTrustTaskProof(doc, {
    expectedProofPurpose: "assertionMethod",
  });
  assert.equal(res.verified, true, `proof did not verify: ${res.reason}`);
  // SPEC §7.2 item 6 — a valid proof by some *other* DID establishes only that
  // somebody signed something.
  assert.equal(res.signer, expectedIssuer);
  assert.equal(doc.issuer, expectedIssuer);
}

// ── DIDComm ─────────────────────────────────────────────────────────────────

test("DIDComm: the document the VTA unpacks carries a proof that verifies", async () => {
  const signing = generateSigningIdentity();
  const holder = Identity.generate(signing.did);
  const vta = Identity.generate("did:key:zVtaStub");

  let received;
  const bridge = new InMemoryDidcommBridge({
    vta,
    holderPublicJwk: holder.publicJwk(),
    vtaHandlers: {
      [TRUST_TASK_ENVELOPE_TYPE]: (req) => {
        received = req.body;
        return {
          type: TRUST_TASK_ENVELOPE_TYPE,
          body: { type: `${VAULT_DELETE}#response`, payload: { deleted: true } },
        };
      },
    },
  });

  const channel = new DidcommVtaTransport({
    bridge,
    holder,
    signing,
    vta: {
      did: vta.did,
      keyAgreementKid: vta.publicJwk().kid,
      keyAgreementPublicJwk: vta.publicJwk().jwk,
    },
  });

  await channel.send(
    buildTrustTask(VAULT_DELETE, { id: "e-1" }, {
      issuer: signing.did,
      recipient: vta.did,
    }),
    { expectedResponseType: `${VAULT_DELETE}#response` },
  );

  await assertSignedBy(received, signing.did);
});

test("DIDComm: the passkey convenience surface signs, and names its audience", async () => {
  // `buildOutbound` built an envelope with an `issuer` and no `recipient`,
  // which item 5b makes REQUIRED on every dispatched specification and item 8
  // audience-binds the proof to. An unaddressed signed document is replayable
  // at a different VTA, which is most of what signing was meant to buy.
  const signing = generateSigningIdentity();
  const holder = Identity.generate(signing.did);
  const vta = Identity.generate("did:key:zVtaStub2");

  let received;
  const bridge = new InMemoryDidcommBridge({
    vta,
    holderPublicJwk: holder.publicJwk(),
    vtaHandlers: {
      [TRUST_TASK_ENVELOPE_TYPE]: (req) => {
        received = req.body;
        return { type: TRUST_TASK_ENVELOPE_TYPE, body: { type: "x#response", payload: {} } };
      },
    },
  });

  const channel = new DidcommVtaTransport({
    bridge,
    holder,
    signing,
    vta: {
      did: vta.did,
      keyAgreementKid: vta.publicJwk().kid,
      keyAgreementPublicJwk: vta.publicJwk().jwk,
    },
  });

  await channel.listPasskeys(signing.did).catch(() => {});

  await assertSignedBy(received, signing.did);
  assert.equal(received.recipient, vta.did, "item 5b: recipient is REQUIRED");
});

// ── TSP ─────────────────────────────────────────────────────────────────────

test("TSP: the sealed document carries a proof, distinct from the outer signature", async () => {
  const signing = generateSigningIdentity();
  const holderSignSk = ed25519.utils.randomSecretKey();
  const holderEncSk = x25519.utils.randomSecretKey();
  const vtaSignSk = ed25519.utils.randomSecretKey();
  const vtaEncSk = x25519.utils.randomSecretKey();
  const holderVid = signing.did;
  const vtaVid = "did:web:vta.example";

  let received;
  const transport = {
    async sendAndAwaitReply(bytes) {
      const opened = await unpack(bytes, {
        receiverDecryptionKey: vtaEncSk,
        senderEncryptionKey: x25519.getPublicKey(holderEncSk),
        senderSigningKey: ed25519.getPublicKey(holderSignSk),
      });
      received = JSON.parse(fromUtf8.decode(opened.payload));
      const reply = await pack(
        utf8.encode(
          JSON.stringify({ type: `${VAULT_DELETE}#response`, payload: { deleted: true } }),
        ),
        vtaVid,
        holderVid,
        {
          senderSigningKey: vtaSignSk,
          senderEncryptionKey: vtaEncSk,
          receiverEncryptionKey: x25519.getPublicKey(holderEncSk),
        },
      );
      return reply.bytes;
    },
  };

  const channel = new TspChannel({
    transport,
    holder: {
      vid: holderVid,
      signingPrivateKey: holderSignSk,
      encryptionPrivateKey: holderEncSk,
      encryptionPublicKey: x25519.getPublicKey(holderEncSk),
    },
    signing,
    vta: {
      vid: vtaVid,
      encryptionPublicKey: x25519.getPublicKey(vtaEncSk),
      signingPublicKey: ed25519.getPublicKey(vtaSignSk),
    },
  });

  await channel.send(
    buildTrustTask(VAULT_DELETE, { id: "e-2" }, {
      issuer: holderVid,
      recipient: vtaVid,
    }),
    { expectedResponseType: `${VAULT_DELETE}#response` },
  );

  // The TSP seal already authenticated the sender of the frame; this asserts
  // the *document* is signed too, which is the half item 7 will not let a
  // transport supply.
  await assertSignedBy(received, holderVid);
});

// ── the item 6 guard, and re-signing ────────────────────────────────────────

test("an envelope whose issuer is not the signer is refused before it is sent", async () => {
  const signing = generateSigningIdentity();
  const envelope = buildTrustTask(VAULT_DELETE, { id: "e-3" }, {
    issuer: "did:key:zSomeoneElse",
    recipient: "did:key:zVta",
  });

  await assert.rejects(
    () => signOutboundTask(envelope, signing),
    (err) => {
      assert.equal(err.code, "e.client.identity");
      return true;
    },
  );
  // Refused, not signed anyway: a document carrying a proof by a DID its
  // issuer does not control is the exact shape a consumer rejects.
  assert.equal(envelope.proof, undefined);
});

test("re-signing a document that already carries a proof does not sign over it", async () => {
  // `VtaSession` hands the same envelope to the next channel when the first
  // refuses it as unsupported, so a document reaching the signer with a proof
  // already on it is normal. Signing over that proof would yield a signature
  // covering bytes no verifier reconstructs — the verifier strips `proof`
  // before hashing, and the signer must too.
  //
  // The stale proof is deliberately junk: if it reached the hashed bytes, the
  // signature would cover something the verifier cannot rebuild and the
  // assertion below fails. Comparing the two `proofValue`s instead would prove
  // nothing and flake — eddsa-jcs-2022 is deterministic, so two signatures
  // over the same document within the same millisecond (the resolution of the
  // proof's `created`) are byte-identical.
  const signing = generateSigningIdentity();
  const envelope = buildTrustTask(VAULT_DELETE, { id: "e-4" }, {
    issuer: signing.did,
    recipient: "did:key:zVta",
  });

  envelope.proof = { type: "DataIntegrityProof", proofValue: "zStaleGarbage" };
  await signOutboundTask(envelope, signing);

  await assertSignedBy(envelope, signing.did);
});
