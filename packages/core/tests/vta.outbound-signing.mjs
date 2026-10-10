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
import { verifyTrustTaskReply } from "../dist/vta/trust-task.js";

import {
  DidcommVtaTransport,
  Identity,
  InMemoryDidcommBridge,
  TspChannel,
  TRUST_TASK_ENVELOPE_TYPE,
  buildTrustTask,
  generateSigningIdentity,
  localTaskSigner,
  proofPurposeForDocumentType,
  signOutboundTask,
  verifyTrustTaskProof,
} from "../dist/index.js";

// `vault/delete/0.1` is one of the 93 — a mutation, and proof REQUIRED.
const VAULT_DELETE = "https://trusttasks.org/spec/vault/delete/0.1";

import { openTspEnvelope, wrapTspEnvelope } from "../dist/vta/tsp-binding.js";

const utf8 = new TextEncoder();
const fromUtf8 = new TextDecoder();

/**
 * Assert `doc` carries a proof that verifies as its own `issuer`, declaring
 * `authentication`: the purpose of an operational document, which the VTA, the
 * VTC and the RPs now check (VTI #1740, affinidi-webvh-service #213).
 */
async function assertSignedBy(doc, expectedIssuer) {
  assert.ok(doc, "no document reached the counterparty");
  // What the consumers bind the proof to: an id to key the replay window on,
  // a time inside the freshness window, and an audience.
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
  await signTrustTask({ envelope: signedReply, signing: vtaSigning, proofPurpose: "authentication" });

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
      await signTrustTask({ envelope: replyDoc, signing: vtaSigning, proofPurpose: "authentication" });
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

// ── the purpose each document declares ──────────────────────────────────────

test("an operational document declares authentication; an attestation declares assertionMethod", async () => {
  // One policy, decided by the document's type (`proofPurposeForDocumentType`),
  // so every channel and every signer gives a document the same purpose.
  const S = "https://trusttasks.org/spec/";
  for (const [type, purpose] of [
    [VAULT_DELETE, "authentication"],
    [`${S}auth/challenge/0.1`, "authentication"],
    [`${S}auth/authenticate/0.2`, "authentication"],
    [`${S}auth/step-up/approve-response/0.6`, "assertionMethod"],
    [`${S}task-consent/decision/0.1`, "assertionMethod"],
    [`${S}auth/oob/grant/0.1`, "assertionMethod"],
  ]) {
    assert.equal(proofPurposeForDocumentType(type), purpose, type);
    const signing = generateSigningIdentity();
    const envelope = buildTrustTask(type, {}, { issuer: signing.did, recipient: "did:key:zRp" });
    await signOutboundTask(envelope, localTaskSigner(signing));
    assert.equal(envelope.proof.proofPurpose, purpose, type);
    const res = await verifyTrustTaskProof(envelope, { expectedProofPurpose: purpose });
    assert.equal(res.verified, true, `${type}: ${res.reason}`);
  }
});

test("a signer is told the purpose, and one written for the one-argument form still works", async () => {
  const signing = generateSigningIdentity();
  const seen = [];
  const local = localTaskSigner(signing);
  const recording = {
    did: signing.did,
    sign: async (envelope, opts) => {
      seen.push(opts?.proofPurpose);
      await local.sign(envelope, opts);
    },
  };
  const envelope = buildTrustTask(VAULT_DELETE, { id: "e-p" }, { issuer: signing.did, recipient: "did:key:zVta" });
  await signOutboundTask(envelope, recording);
  assert.deepEqual(seen, ["authentication"]);

  // Called directly, with no options, the local signer still picks by type.
  const direct = buildTrustTask(VAULT_DELETE, { id: "e-q" }, { issuer: signing.did, recipient: "did:key:zVta" });
  await local.sign(direct);
  assert.equal(direct.proof.proofPurpose, "authentication");
});

// ── what the signer fills and refuses ───────────────────────────────────────

test("a document with no issuer is issued by the signer", async () => {
  // The consumers refuse an issuer-less document over DIDComm and TSP, so the
  // signer names itself rather than letting one go out bare.
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

test("a DIDComm or TSP channel refuses a signer that is not its sender", async () => {
  // The consumers bind the proven signer to the transport sender (VTI #1739).
  // REST passes no sender and is not checked here: the consumer binds the
  // issuer to the bearer.
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

  // The same signer as the sender passes, and so does no sender at all.
  const ok = buildTrustTask(VAULT_DELETE, { id: "e-9" }, { issuer: signing.did, recipient: "did:key:zVta" });
  await signOutboundTask(ok, localTaskSigner(signing), signing.did);
  await assertSignedBy(ok, signing.did);
});

test("a DIDComm channel whose signer is not its holder sends nothing", async () => {
  const signing = generateSigningIdentity();
  const holder = Identity.generate(signing.did);
  const vta = Identity.generate(generateSigningIdentity().did);
  const persona = generateSigningIdentity();
  let sent = 0;
  const bridge = {
    async sendAndAwaitReply() {
      sent += 1;
      throw new Error("must not be reached");
    },
    async send() {
      sent += 1;
    },
  };
  const channel = new DidcommVtaTransport({
    bridge,
    holder,
    signing: localTaskSigner(persona),
    vta: {
      did: vta.did,
      keyAgreementKid: vta.publicJwk().kid,
      keyAgreementPublicJwk: vta.publicJwk().jwk,
    },
  });
  const envelope = buildTrustTask(VAULT_DELETE, { id: "e-10" }, { issuer: persona.did, recipient: vta.did });
  await assert.rejects(() => channel.send(envelope), (err) => err.code === "e.client.identity");
  await assert.rejects(() => channel.notify(envelope), (err) => err.code === "e.client.identity");
  assert.equal(sent, 0);
});

// ── purpose and relationship on what the wallet verifies ────────────────────

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
  const envelope = buildTrustTask(VAULT_DELETE, { id: "e-11" }, { issuer: did, recipient: "did:key:zRp" });
  await signTrustTask({ envelope, signing, proofPurpose: "authentication" });

  for (const listed of [["#k1"], [vm], [{ id: vm, type: "Multikey", controller: did, publicKeyMultibase }]]) {
    const res = await verifyTrustTaskProof(envelope, {
      expectedProofPurpose: "authentication",
      resolveDid: docFor({ authentication: listed }),
    });
    assert.equal(res.verified, true, res.reason);
  }

  const assertionOnly = await verifyTrustTaskProof(envelope, {
    expectedProofPurpose: "authentication",
    resolveDid: docFor({ assertionMethod: [vm] }),
  });
  assert.equal(assertionOnly.verified, false);
  assert.match(assertionOnly.reason, /not listed under authentication/);

  // Without a required purpose nothing about relationships is asked, as before.
  const any = await verifyTrustTaskProof(envelope, { resolveDid: docFor({ assertionMethod: [vm] }) });
  assert.equal(any.verified, true, any.reason);
});

test("a reply is evidence only under authentication, unless the channel says otherwise", async () => {
  // The VTA, the VTC and the did-hosting RP sign every reply with their
  // operational key under `authentication` (VTI #1740; affinidi-webvh-service
  // #213). A reply signed for `assertionMethod` is refused. A mediator signs its
  // own `messaging/*` replies for a purpose of its choosing, so the lens
  // channel asks only that the proof verifies as the mediator.
  const agent = generateSigningIdentity();
  const reply = async (purpose) => {
    const doc = buildTrustTask(`${VAULT_DELETE}#response`, {}, { issuer: agent.did, recipient: "did:key:zMe" });
    await signTrustTask({ envelope: doc, signing: agent, proofPurpose: purpose });
    return doc;
  };
  await verifyTrustTaskReply(await reply("authentication"), agent.did);
  await assert.rejects(verifyTrustTaskReply(await reply("assertionMethod"), agent.did), /authentication/);
  await verifyTrustTaskReply(await reply("assertionMethod"), agent.did, { proofPurpose: "any" });
  // `any` still requires the proof, by the expected signer.
  await assert.rejects(
    verifyTrustTaskReply(await reply("assertionMethod"), generateSigningIdentity().did, { proofPurpose: "any" }),
    /signed by/,
  );
});
