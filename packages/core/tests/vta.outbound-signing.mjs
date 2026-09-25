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
import { signTrustTask } from "../dist/trust-tasks/sign.js";

import {
  DidcommVtaTransport,
  Identity,
  InMemoryDidcommBridge,
  TspChannel,
  TRUST_TASK_ENVELOPE_TYPE,
  buildTrustTask,
  generateSigningIdentity,
  localTaskSigner,
  outboundProofPurpose,
  signOutboundTask,
  verifyTrustTaskProof,
} from "../dist/index.js";
import { verifyTrustTaskReply } from "../dist/vta/trust-task.js";

// `vault/delete/0.1` is one of the 93 — a mutation, and proof REQUIRED.
const VAULT_DELETE = "https://trusttasks.org/spec/vault/delete/0.1";

import { openTspEnvelope, wrapTspEnvelope } from "../dist/vta/tsp-binding.js";

const utf8 = new TextEncoder();
const fromUtf8 = new TextDecoder();

/**
 * Assert `doc` is what the VTA, the VTC and the RPs now require of a document
 * arriving over DIDComm or TSP: a proof that verifies as its own `issuer`,
 * declaring `authentication`, over a document that names its audience, is
 * placed in time and has an id to key the replay window on.
 */
async function assertSignedBy(doc, expectedIssuer) {
  assert.ok(doc, "no document reached the counterparty");
  assert.equal(typeof doc.id, "string");
  assert.ok(doc.id.length > 0, "the document has an id");
  assert.ok(!Number.isNaN(Date.parse(doc.issuedAt)), `issuedAt ${doc.issuedAt}`);
  assert.equal(typeof doc.recipient, "string", "the document names its audience");
  const res = await verifyTrustTaskProof(doc, {
    expectedProofPurpose: "authentication",
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
  // A real `did:key` for the agent, whose key also signs the reply document —
  // the channel verifies that proof now, and a stub DID would not resolve.
  const vtaSigning = generateSigningIdentity();
  const vta = Identity.generate(vtaSigning.did);
  const signedReply = { type: `${VAULT_DELETE}#response`, payload: { deleted: true } };
  await signTrustTask({ envelope: signedReply, signing: vtaSigning });

  let received;
  const bridge = new InMemoryDidcommBridge({
    vta,
    holderPublicJwk: holder.publicJwk(),
    vtaHandlers: {
      [TRUST_TASK_ENVELOPE_TYPE]: (req) => {
        received = req.body;
        // Signed, because a real VTA signs its responses and the channel
        // refuses an unsigned one. Pre-signed rather than signed here: the
        // handler is synchronous, and the reply carries no per-request member
        // that would need to be set after signing.
        return { type: TRUST_TASK_ENVELOPE_TYPE, body: signedReply };
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
  // The agent's identity is a real `did:key` and its signing key is the one
  // that signs the reply document: the channel verifies that proof now, and a
  // `did:web` VID would need the network to resolve.
  const vtaSigning = generateSigningIdentity();
  const vtaSignSk = vtaSigning.privateKey;
  const vtaEncSk = x25519.utils.randomSecretKey();
  const holderVid = signing.did;
  const vtaVid = vtaSigning.did;

  let received;
  const transport = {
    async sendAndAwaitReply(bytes, options = {}) {
      const opened = await unpack(bytes, {
        receiverDecryptionKey: vtaEncSk,
        senderEncryptionKey: x25519.getPublicKey(holderEncSk),
        senderSigningKey: ed25519.getPublicKey(holderSignSk),
      });
      // Opened through the binding: what the wallet seals is the envelope, and
      // the document under test is inside it.
      received = openTspEnvelope(fromUtf8.decode(opened.payload));
      // Signed, because a real VTA signs its responses and the channel refuses
      // an unsigned one. Built fully first: a proof covers the document it was
      // made over, so anything added after it would invalidate it.
      const replyDoc = {
        type: `${VAULT_DELETE}#response`,
        // `threadId` threads to the request, as the VTA's `respond_with` does —
        // the channel will not claim a reply without it.
        threadId: received.id,
        payload: { deleted: true },
      };
      await signTrustTask({ envelope: replyDoc, signing: vtaSigning });
      const reply = await pack(
        utf8.encode(wrapTspEnvelope(replyDoc)),
        vtaVid,
        holderVid,
        {
          senderSigningKey: vtaSignSk,
          senderEncryptionKey: vtaEncSk,
          receiverEncryptionKey: x25519.getPublicKey(holderEncSk),
        },
      );
      if (options.claims && !(await options.claims(reply.bytes))) {
        throw new Error("the channel did not claim this reply");
      }
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
    () => signOutboundTask(envelope, localTaskSigner(signing)),
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
  await signOutboundTask(envelope, localTaskSigner(signing));

  await assertSignedBy(envelope, signing.did);
});

// ── what the signer fills, refuses and declares ─────────────────────────────

test("a document with no issuer is issued by the signer", async () => {
  // The consumers refuse an issuer-less document outright over DIDComm and
  // TSP, so the signer names itself rather than letting one go out bare.
  const signing = generateSigningIdentity();
  const envelope = buildTrustTask(VAULT_DELETE, { id: "e-5" }, { recipient: "did:key:zVta" });
  await signOutboundTask(envelope, localTaskSigner(signing));
  assert.equal(envelope.issuer, signing.did);
  await assertSignedBy(envelope, signing.did);
});

test("a document with no recipient is refused before it is signed", async () => {
  const signing = generateSigningIdentity();
  const envelope = buildTrustTask(VAULT_DELETE, { id: "e-6" }, { issuer: signing.did });
  await assert.rejects(
    () => signOutboundTask(envelope, localTaskSigner(signing)),
    (err) => err.code === "e.client.identity" && /no recipient/.test(err.message),
  );
  assert.equal(envelope.proof, undefined);
});

test("a document missing its id or issuedAt gets both before the proof covers them", async () => {
  const signing = generateSigningIdentity();
  const envelope = {
    type: VAULT_DELETE,
    issuer: signing.did,
    recipient: "did:key:zVta",
    payload: { id: "e-7" },
  };
  await signOutboundTask(envelope, localTaskSigner(signing));
  await assertSignedBy(envelope, signing.did);
});

test("every request declares authentication; the approver's own decisions are assertions", async () => {
  assert.equal(outboundProofPurpose(VAULT_DELETE), "authentication");
  assert.equal(outboundProofPurpose("https://trusttasks.org/spec/auth/authenticate/0.1"), "authentication");
  // The approve-response specs pin `assertionMethod`, and the did-hosting RP
  // (affinidi-webvh-service #213) refuses a consent decision or approve-response
  // under any other purpose.
  for (const type of [
    "https://trusttasks.org/spec/auth/step-up/approve-response/0.2",
    "https://trusttasks.org/spec/auth/step-up/approve-response/0.3",
    "https://trusttasks.org/spec/task-consent/decision/0.1",
  ]) {
    assert.equal(outboundProofPurpose(type), "assertionMethod", type);

    const signing = generateSigningIdentity();
    const envelope = buildTrustTask(type, {}, { issuer: signing.did, recipient: "did:key:zRp" });
    await signOutboundTask(envelope, localTaskSigner(signing));
    const res = await verifyTrustTaskProof(envelope, { expectedProofPurpose: "assertionMethod" });
    assert.equal(res.verified, true, `${type}: ${res.reason}`);
  }
});

test("a DIDComm or TSP channel refuses a signer that is not its sender", async () => {
  // The consumers bind the proven signer to the transport sender. REST passes
  // no sender and is not checked here: the consumer binds it to the bearer.
  const signing = generateSigningIdentity();
  const other = generateSigningIdentity();
  const envelope = buildTrustTask(VAULT_DELETE, { id: "e-8" }, {
    issuer: other.did,
    recipient: "did:key:zVta",
  });
  await assert.rejects(
    () => signOutboundTask(envelope, localTaskSigner(other), signing.did),
    (err) => err.code === "e.client.identity" && /must be sent by its signer/.test(err.message),
  );
  assert.equal(envelope.proof, undefined);

  // And the same signer as the sender passes.
  const ok = buildTrustTask(VAULT_DELETE, { id: "e-9" }, { issuer: signing.did, recipient: "did:key:zVta" });
  await signOutboundTask(ok, localTaskSigner(signing), signing.did);
  await assertSignedBy(ok, signing.did);
});

// ── Purpose and relationship on what the wallet verifies ──────────────────

test("a proof counts for a purpose only when the signer lists the key under it", async () => {
  // The resolver finds a key under either relationship, so the relationship is
  // the verifier's to check: an `authentication` proof by a key its DID lists
  // only under `assertionMethod` is not an authentication by that DID.
  const key = generateSigningIdentity();
  const did = "did:web:agent.example";
  const vm = `${did}#k1`;
  const signing = { ...key, did, kid: vm };
  const publicKeyMultibase = key.kid.slice(key.kid.indexOf("#") + 1);
  const docFor = (relationships) => async () => ({
    id: did,
    verificationMethod: [{ id: vm, type: "Multikey", controller: did, publicKeyMultibase }],
    ...relationships,
  });
  const envelope = buildTrustTask(VAULT_DELETE, { id: "e-9" }, { issuer: did, recipient: "did:key:zRp" });
  await signTrustTask({ envelope, signing, proofPurpose: "authentication" });

  const listed = await verifyTrustTaskProof(envelope, {
    expectedProofPurpose: "authentication",
    resolveDid: docFor({ authentication: ["#k1"] }),
  });
  assert.equal(listed.verified, true, listed.reason);

  const assertionOnly = await verifyTrustTaskProof(envelope, {
    expectedProofPurpose: "authentication",
    resolveDid: docFor({ assertionMethod: [vm] }),
  });
  assert.equal(assertionOnly.verified, false);
  assert.match(assertionOnly.reason, /not listed under authentication/);
});

test("a reply is evidence only under authentication", async () => {
  // The VTA, the VTC and the did-hosting RP sign every reply with their
  // operational key under `authentication` (VTI #1740; affinidi-webvh-service
  // #213). A reply signed for `assertionMethod` is refused.
  const agent = generateSigningIdentity();
  const reply = (purpose) => {
    const doc = buildTrustTask(`${VAULT_DELETE}#response`, {}, { issuer: agent.did, recipient: "did:key:zMe" });
    return signTrustTask({ envelope: doc, signing: agent, proofPurpose: purpose }).then(() => doc);
  };
  await verifyTrustTaskReply(await reply("authentication"), agent.did);
  await assert.rejects(verifyTrustTaskReply(await reply("assertionMethod"), agent.did), /authentication/);
});

test("a persona signer that cannot sign for the purpose a document needs sends nothing", async () => {
  // `vault/sign-trust-task/0.2` signs `assertionMethod` only. An operational
  // document needs `authentication`, so the persona signer refuses it rather
  // than hand the consumer a proof it will refuse.
  const { vaultTaskSigner } = await import("../dist/vault/task-signer.js");
  const persona = "did:webvh:zPersona:vta.example:shop";
  const channel = {
    async send(request) {
      const unsigned = request.payload.unsignedEnvelope;
      return { signedEnvelope: { ...unsigned, proof: { proofPurpose: "assertionMethod" } } };
    },
  };
  const signer = vaultTaskSigner({
    session: channel,
    holder: { did: "did:key:zHolder" },
    service: { did: "did:key:zVta" },
    entryId: "entry-1",
    did: persona,
  });
  const operational = buildTrustTask(VAULT_DELETE, { id: "e-10" }, { issuer: persona, recipient: "did:key:zRp" });
  await assert.rejects(signOutboundTask(operational, signer), /needs authentication/);
  assert.equal(operational.proof, undefined);

  const approval = buildTrustTask(
    "https://trusttasks.org/spec/auth/step-up/approve-response/0.3",
    {},
    { issuer: persona, recipient: "did:key:zRp" },
  );
  await signOutboundTask(approval, signer);
  assert.equal(approval.proof.proofPurpose, "assertionMethod");
});
