// The egress policy on a VTA's REST base URL.
//
// `baseUrl` is the wallet's own configuration rather than a document endpoint,
// which is exactly why it is easy to leave unchecked — and it is written from a
// DID document (or a QR code) at onboarding, so it is no more chosen by this
// wallet than a mediator's endpoints are. It also matters more per request:
// REST is the one channel that carries a bearer token, so a base URL pointing
// at the user's own network is a token handed to whatever answers there.
//
// These drive `getVtaBearer`, which every REST request runs through before it
// dispatches anything.

import { test } from "node:test";
import assert from "node:assert/strict";

import { Identity } from "../dist/didcomm/index.js";
import { getVtaBearer } from "../dist/vta/auth.js";
import { generateSigningIdentity, signTrustTask, verifyTrustTaskProof } from "../dist/index.js";

const BLOCKED_ENDPOINT = "E_BLOCKED_ENDPOINT";
const DEV_POLICY = { allowInsecure: true, allowPrivate: true };

const TT = "https://trusttasks.org/spec/";
const CHALLENGE = `${TT}auth/challenge/0.1`;
const AUTHENTICATE = `${TT}auth/authenticate/0.2`;

/** The VTA: its replies are signed with this key, as the real one signs them. */
const VTA = generateSigningIdentity();
const vtaEndpoint = () => ({ did: VTA.did });

/** A holder whose DIDComm identity and signing key share one DID, as a
 *  wallet's do: the documents are issued by the one and signed by the other. */
function holderPair() {
  const signing = generateSigningIdentity();
  return { signing, holder: Identity.generate(signing.did) };
}

/** The VTA's answer to a pre-session document, signed and threaded the way the
 *  VTA's `sign_response` sends it. */
async function vtaReply(req) {
  const payload =
    req.type === CHALLENGE
      ? { challenge: "c".repeat(32), sessionId: "s-1", expiresAt: "2099-01-01T00:00:00Z" }
      : {
          session: {
            id: "s-1",
            subject: req.issuer,
            issuedAt: new Date().toISOString(),
            expiresAt: new Date(Date.now() + 900_000).toISOString(),
          },
          tokens: { accessToken: "vta.jwt", tokenType: "Bearer", expiresIn: 900 },
        };
  const doc = {
    id: `urn:uuid:${crypto.randomUUID()}`,
    threadId: req.id,
    type: `${req.type}#response`,
    issuer: VTA.did,
    recipient: req.issuer,
    issuedAt: new Date().toISOString(),
    payload,
  };
  await signTrustTask({ envelope: doc, signing: VTA, proofPurpose: "authentication" });
  return doc;
}

/** Records every URL and document it is sent, and answers with real
 *  `Response`s (a hand-rolled `{ ok, json }` stub stops representing one the
 *  moment the code reads the body differently — see CLAUDE.md). */
function spyFetch() {
  const calls = [];
  const docs = [];
  const impl = async (url, init) => {
    calls.push(String(url));
    const doc = JSON.parse(init.body);
    docs.push(doc);
    return new Response(JSON.stringify(await vtaReply(doc)), {
      status: 200,
      headers: { "content-type": "application/json" },
    });
  };
  return { calls, docs, impl };
}

test("a loopback VTA base URL is refused before any request is made", async () => {
  const { holder, signing } = holderPair();
  const spy = spyFetch();
  try {
    await assert.rejects(
      () =>
        getVtaBearer({
          baseUrl: "https://127.0.0.1:8100",
          holder,
          service: vtaEndpoint(),
          signing,
          fetch: spy.impl,
        }),
      (err) => {
        assert.equal(err.code, BLOCKED_ENDPOINT);
        assert.equal(err.reason, "private_address");
        return true;
      },
    );
    // The point of checking the base URL rather than the response: the bearer
    // handshake begins with an anonymous POST naming the holder's DID, so
    // "it failed" is not the same as "it never spoke".
    assert.deepEqual(spy.calls, []);
  } finally {
    holder.dispose();
  }
});

test("a local-only name is refused as well, not just an address", async () => {
  const { holder, signing } = holderPair();
  const spy = spyFetch();
  try {
    await assert.rejects(
      () =>
        getVtaBearer({
          baseUrl: "https://vta.internal",
          holder,
          service: vtaEndpoint(),
          signing,
          fetch: spy.impl,
        }),
      (err) => err.code === BLOCKED_ENDPOINT && err.reason === "private_name",
    );
    assert.deepEqual(spy.calls, []);
  } finally {
    holder.dispose();
  }
});

test("plaintext is refused even on a public host", async () => {
  // The bearer is the reason: `http:` would put it on the wire in clear.
  const { holder, signing } = holderPair();
  const spy = spyFetch();
  try {
    await assert.rejects(
      () =>
        getVtaBearer({
          baseUrl: "http://vta.example",
          holder,
          service: vtaEndpoint(),
          signing,
          fetch: spy.impl,
        }),
      (err) => err.code === BLOCKED_ENDPOINT && err.reason === "scheme",
    );
    assert.deepEqual(spy.calls, []);
  } finally {
    holder.dispose();
  }
});

test("the dev policy reaches a VTA on localhost", async () => {
  // Both flags, and the positive control for the two tests above: the handshake
  // completes, so the refusals are the policy rather than a broken fixture.
  const { holder, signing } = holderPair();
  const spy = spyFetch();
  try {
    const token = await getVtaBearer({
      baseUrl: "http://localhost:8100",
      holder,
      service: vtaEndpoint(),
      signing,
      fetch: spy.impl,
      netPolicy: DEV_POLICY,
    });
    assert.equal(token, "vta.jwt");
    assert.deepEqual(spy.calls, [
      "http://localhost:8100/trust-tasks",
      "http://localhost:8100/trust-tasks",
    ]);
  } finally {
    holder.dispose();
  }
});

test("the sign-in is two Trust Tasks, and the second is signed by the holder", async () => {
  // vti #1858 deleted `POST /auth/challenge` and `POST /auth/`; a wallet still
  // using them got a 405 from every VTA on that release. What replaced them is
  // these two documents, the second of which authenticates by its proof.
  const { holder, signing } = holderPair();
  const spy = spyFetch();
  try {
    await getVtaBearer({
      baseUrl: "https://vta.example",
      holder,
      service: vtaEndpoint(),
      signing,
      fetch: spy.impl,
    });
    const [challenge, authenticate] = spy.docs;
    assert.equal(challenge.type, CHALLENGE);
    // The VTA's handler refuses a challenge without a subject.
    assert.equal(challenge.payload.subject, holder.did);
    assert.equal(challenge.recipient, VTA.did);
    assert.equal(authenticate.type, AUTHENTICATE);
    assert.deepEqual(authenticate.payload, { challenge: "c".repeat(32), sessionId: "s-1" });
    assert.equal(authenticate.issuer, holder.did);
    const verified = await verifyTrustTaskProof(authenticate, { expectedProofPurpose: "authentication" });
    assert.equal(verified.verified, true, `the authenticate proof must verify: ${verified.reason}`);
    assert.equal(verified.signer, holder.did, "and as the holder");
  } finally {
    holder.dispose();
  }
});

test("a reply the VTA did not sign is refused, so a token cannot be planted", async () => {
  const { holder, signing } = holderPair();
  const impl = async (_url, init) => {
    const doc = await vtaReply(JSON.parse(init.body));
    delete doc.proof;
    return new Response(JSON.stringify(doc), { status: 200, headers: { "content-type": "application/json" } });
  };
  try {
    await assert.rejects(() =>
      getVtaBearer({ baseUrl: "https://vta-unsigned.example", holder, service: vtaEndpoint(), signing, fetch: impl }),
    );
  } finally {
    holder.dispose();
  }
});

test("a refusal is read from the body, with the agent's code", async () => {
  // R3.7: a trust-task-error document carries the code a caller matches on.
  const { holder, signing } = holderPair();
  const impl = async (_url, init) => {
    const req = JSON.parse(init.body);
    const doc = {
      id: `urn:uuid:${crypto.randomUUID()}`,
      threadId: req.id,
      type: "https://trusttasks.org/spec/trust-task-error/0.1",
      issuer: VTA.did,
      recipient: req.issuer,
      issuedAt: new Date().toISOString(),
      payload: { code: "rateLimited", message: "slow down", retryable: true },
    };
    await signTrustTask({ envelope: doc, signing: VTA, proofPurpose: "authentication" });
    return new Response(JSON.stringify(doc), { status: 429, headers: { "content-type": "application/json" } });
  };
  try {
    await assert.rejects(
      () => getVtaBearer({ baseUrl: "https://vta-busy.example", holder, service: vtaEndpoint(), signing, fetch: impl }),
      (err) => {
        assert.match(JSON.stringify(err.details ?? {}) + String(err.code) + err.message, /rateLimited/);
        return true;
      },
    );
  } finally {
    holder.dispose();
  }
});

test("allowPrivate alone does not admit a plaintext local VTA", async () => {
  // The 0.8 split, from the other side: a dev config that sets one flag gets a
  // refusal that names the scheme, not silence.
  const { holder, signing } = holderPair();
  const spy = spyFetch();
  try {
    await assert.rejects(() =>
      getVtaBearer({
        baseUrl: "http://localhost:8100",
        holder,
        service: vtaEndpoint(),
        signing,
        fetch: spy.impl,
        netPolicy: { allowPrivate: true },
      }),
    );
    assert.deepEqual(spy.calls, []);
  } finally {
    holder.dispose();
  }
});
