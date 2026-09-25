// RP login over DIDComm: `auth/challenge`, then a signed `auth/authenticate`.
//
// This module used to authcrypt a bare `auth/authenticate` message with an
// empty body, and the RP issued a session to whoever the authcrypt layer said
// had sent it. affinidi-webvh-service #213 removes that route: the RP acts only
// on a proof inside the document. These tests pin what the RP now checks, by
// unpacking each request as the RP would and running the real verifier over
// the document it receives.

import { test } from "node:test";
import assert from "node:assert/strict";

import { signTrustTask } from "../dist/trust-tasks/sign.js";
import { loginViaDidcomm } from "../dist/rp-login/index.js";
import {
  Identity,
  InMemoryDidcommBridge,
  TRUST_TASK_ENVELOPE_TYPE,
  generateSigningIdentity,
  localTaskSigner,
  outboundProofPurpose,
  verifyTrustTaskProof,
} from "../dist/index.js";

const CHALLENGE = "https://trusttasks.org/spec/auth/challenge/0.1";
const AUTHENTICATE = "https://trusttasks.org/spec/auth/authenticate/0.1";
const ERROR = "https://trusttasks.org/spec/trust-task-error/0.1";

function endpointOf(identity) {
  return {
    did: identity.did,
    keyAgreementKid: identity.publicJwk().kid,
    keyAgreementPublicJwk: identity.publicJwk().jwk,
  };
}

/**
 * A holder and an RP that speak DIDComm to each other.
 *
 * The RP is a real `did:key` whose key signs its replies: the channel verifies
 * each reply's proof against the RP's DID, so a stub DID would not resolve.
 * `answer` decides the reply per request document (returning `undefined` falls
 * back to the default, which issues a challenge and then a session).
 */
function world({ answer } = {}) {
  const signing = generateSigningIdentity();
  const holder = Identity.generate(signing.did);
  const rpSigning = generateSigningIdentity();
  const rp = Identity.generate(rpSigning.did);

  const received = [];
  const reply = async (doc) => {
    const { sign = true, ...fields } = answer?.(doc) ?? defaultAnswer(doc);
    const document = {
      id: globalThis.crypto.randomUUID(),
      threadId: doc.id,
      issuer: rp.did,
      recipient: doc.issuer,
      issuedAt: new Date().toISOString(),
      ...fields,
    };
    if (sign) await signTrustTask({ envelope: document, signing: rpSigning });
    return document;
  };

  const bridge = new InMemoryDidcommBridge({
    vta: rp,
    holderPublicJwk: holder.publicJwk(),
    vtaHandlers: {
      [TRUST_TASK_ENVELOPE_TYPE]: async (req) => {
        received.push({ from: req.from, doc: req.body });
        return { type: TRUST_TASK_ENVELOPE_TYPE, body: await reply(req.body) };
      },
    },
  });

  return { signing, holder, rp, bridge, received };
}

function defaultAnswer(doc) {
  if (doc.type === CHALLENGE) {
    return {
      type: `${CHALLENGE}#response`,
      payload: {
        challenge: "nonce-xyz",
        sessionId: "sess-abc",
        expiresAt: new Date(Date.now() + 60_000).toISOString(),
      },
    };
  }
  if (doc.type === AUTHENTICATE) {
    return {
      type: `${AUTHENTICATE}#response`,
      payload: {
        session: { id: "sess-abc", subject: doc.issuer },
        tokens: { accessToken: "at", refreshToken: "rt", tokenType: "Bearer", expiresIn: 900 },
      },
    };
  }
  throw new Error(`unexpected task ${doc.type}`);
}

function opts(w, over = {}) {
  return {
    bridge: w.bridge,
    holder: w.holder,
    signing: w.signing,
    service: endpointOf(w.rp),
    ...over,
  };
}

test("sign-in is a challenge, then an authenticate spending it", async () => {
  const w = world();
  const session = await loginViaDidcomm(opts(w));

  assert.deepEqual(
    w.received.map((r) => r.doc.type),
    [CHALLENGE, AUTHENTICATE],
  );
  const [challenge, authenticate] = w.received.map((r) => r.doc);
  assert.equal(challenge.payload.purpose, "login");
  assert.equal(challenge.payload.subject, w.signing.did);
  // Echoed verbatim: the RP looks the binding up by exactly these.
  assert.equal(authenticate.payload.challenge, "nonce-xyz");
  assert.equal(authenticate.payload.sessionId, "sess-abc");

  assert.equal(session.accessToken, "at");
  assert.equal(session.refreshToken, "rt");
  assert.equal(session.sessionId, "sess-abc");
  assert.equal(session.expiresIn, 900);
});

test("the authenticate document is what the RP now requires of it", async () => {
  const w = world();
  await loginViaDidcomm(opts(w));
  const { doc, from } = w.received[1];

  // Issued by the signing DID, addressed to the RP, placed in time, and
  // uniquely identified — the RP keys its replay window on (issuer, id).
  assert.equal(doc.issuer, w.signing.did);
  assert.equal(doc.recipient, w.rp.did);
  assert.ok(!Number.isNaN(Date.parse(doc.issuedAt)), `issuedAt ${doc.issuedAt}`);
  assert.equal(typeof doc.id, "string");
  assert.notEqual(doc.id, w.received[0].doc.id, "each document has its own id");
  // The transport's sender agrees with the proof, as the RP requires.
  assert.equal(from, w.holder.did);

  // The proof verifies over the document as the RP received it, as the issuer,
  // and declares that it is an authentication.
  const res = await verifyTrustTaskProof(doc, { expectedProofPurpose: "authentication" });
  assert.equal(res.verified, true, `proof did not verify: ${res.reason}`);
  assert.equal(res.signer, w.signing.did);
});

test("only the authenticate is signed for authentication", async () => {
  // The challenge request attests to nothing; its proof keeps the purpose
  // every other outbound document declares.
  assert.equal(outboundProofPurpose(AUTHENTICATE), "authentication");
  assert.equal(outboundProofPurpose(CHALLENGE), "assertionMethod");
  assert.equal(outboundProofPurpose("https://trusttasks.org/spec/vault/delete/0.1"), "assertionMethod");

  const w = world();
  await loginViaDidcomm(opts(w));
  assert.equal(w.received[0].doc.proof.proofPurpose, "assertionMethod");
  assert.equal(w.received[1].doc.proof.proofPurpose, "authentication");
});

test("the signer's DID is who signs in, on both documents", async () => {
  // A persona signs with its own key; the challenge is requested for it and the
  // authenticate is issued by it, or the RP refuses on its subject check.
  const w = world();
  const persona = generateSigningIdentity();
  await loginViaDidcomm(opts(w, { signing: localTaskSigner(persona) }));

  const [challenge, authenticate] = w.received.map((r) => r.doc);
  assert.equal(challenge.issuer, persona.did);
  assert.equal(challenge.payload.subject, persona.did);
  assert.equal(authenticate.issuer, persona.did);
  const res = await verifyTrustTaskProof(authenticate, { expectedProofPurpose: "authentication" });
  assert.equal(res.signer, persona.did);
});

test("the reply is awaited from the RP alone", async () => {
  // A thread id is the id of a message this wallet sent, not a secret, so the
  // bridge is told whose answer it is.
  const w = world();
  const seen = [];
  const bridge = {
    sendAndAwaitReply(packed, requestId, o) {
      seen.push(o.from);
      return w.bridge.sendAndAwaitReply(packed, requestId, o);
    },
    send: (packed) => w.bridge.send(packed),
  };
  await loginViaDidcomm(opts(w, { bridge }));
  assert.deepEqual(seen, [[w.rp.did], [w.rp.did]]);
});

test("a reply sent by anyone other than the RP is refused", async () => {
  const w = world();
  const bridge = {
    async sendAndAwaitReply(packed, requestId, o) {
      const reply = await w.bridge.sendAndAwaitReply(packed, requestId, o);
      return { ...reply, from: "did:web:imposter.example" };
    },
    send: (packed) => w.bridge.send(packed),
  };
  await assert.rejects(
    () => loginViaDidcomm(opts(w, { bridge })),
    (e) => e.code === "e.p.msg.unauthorized",
  );
  assert.equal(w.received.length, 1, "it must not go on to authenticate");
});

test("an unsigned answer is refused", async () => {
  const w = world({
    answer: (doc) => (doc.type === CHALLENGE ? { ...defaultAnswer(doc), sign: false } : undefined),
  });
  await assert.rejects(() => loginViaDidcomm(opts(w)), /unsigned or its proof does not verify/);
  assert.equal(w.received.length, 1);
});

test("a refused challenge surfaces as the RP's own code", async () => {
  const w = world({
    answer: (doc) =>
      doc.type === CHALLENGE
        ? { type: ERROR, payload: { code: "permission_denied", message: "not in the ACL" } }
        : undefined,
  });
  await assert.rejects(
    () => loginViaDidcomm(opts(w)),
    (e) => e.details?.code === "permission_denied",
  );
  assert.equal(w.received.length, 1, "it must not go on to authenticate");
});

test("a refused authenticate surfaces as the RP's own code", async () => {
  const w = world({
    answer: (doc) =>
      doc.type === AUTHENTICATE
        ? { type: ERROR, payload: { code: "auth/authenticate:challengeMismatch", message: "no" } }
        : undefined,
  });
  await assert.rejects(
    () => loginViaDidcomm(opts(w)),
    (e) => e.details?.code === "auth/authenticate:challengeMismatch",
  );
});
