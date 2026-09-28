// `login()` as Trust Tasks over the relying party's HTTPS binding:
// `auth/challenge/0.1` then `auth/authenticate/0.2`, both POSTed to
// `{base}/trust-tasks`, with an optional `sessionKey` bound to the session.
//
// The RP here is a fake that answers the way the control plane does. Every
// reply is signed by the RP's key, threaded to the request, and addressed back
// to the requester.

import { test } from "node:test";
import assert from "node:assert/strict";

import {
  generateSigningIdentity,
  isDidKey,
  loginViaTrustTask,
  rpHttpsSender,
  signTrustTask,
  verifyTrustTaskProof,
} from "../dist/index.js";

const TT = "https://trusttasks.org/spec/";
const CHALLENGE = `${TT}auth/challenge/0.1`;
const AUTHENTICATE = `${TT}auth/authenticate/0.2`;

const RP = generateSigningIdentity();
const STRANGER = generateSigningIdentity();
const HOLDER = generateSigningIdentity();
const BASE = "https://rp.example/api";
const SESSION_KEY = "did:key:z6MkpTHR8VNsBxYAAWHut2Geadd9jSwuBV8xRoAnwWsdvktH";

const json = (body, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });

async function reply(req, payload, { as = RP } = {}) {
  const doc = {
    id: `urn:uuid:${crypto.randomUUID()}`,
    threadId: req.id,
    type: `${req.type}#response`,
    issuer: as.did,
    recipient: req.issuer,
    issuedAt: new Date().toISOString(),
    payload,
  };
  await signTrustTask({ envelope: doc, signing: as, proofPurpose: "authentication" });
  return doc;
}

/** A fake RP. `bind` decides what `session.sessionKey` the authenticate reply
 *  carries; the default echoes the request, as a conforming RP does. */
function fakeRp({ bind = (asked) => asked, as = RP } = {}) {
  const calls = [];
  const fetchFn = async (url, init) => {
    assert.equal(String(url), `${BASE}/trust-tasks`);
    const doc = JSON.parse(init.body);
    calls.push({ doc, headers: init.headers });
    if (doc.type === CHALLENGE) {
      return json(
        await reply(doc, { challenge: "c".repeat(32), sessionId: "sess-1", expiresAt: "2099-01-01T00:00:00Z" }, { as }),
      );
    }
    if (doc.type === AUTHENTICATE) {
      const bound = bind(doc.payload.sessionKey);
      return json(
        await reply(
          doc,
          {
            session: {
              id: "sess-1",
              subject: doc.issuer,
              issuedAt: new Date().toISOString(),
              expiresAt: new Date(Date.now() + 900_000).toISOString(),
              amr: ["did"],
              acr: "aal1",
              ...(bound !== undefined ? { sessionKey: bound } : {}),
            },
            tokens: { accessToken: "AT", refreshToken: "RT", tokenType: "Bearer", expiresIn: 900 },
          },
          { as },
        ),
      );
    }
    throw new Error(`unexpected ${doc.type}`);
  };
  return { fetchFn, calls };
}

function login(rp, over = {}) {
  return loginViaTrustTask({
    sender: rpHttpsSender({ baseUrl: BASE, rpDid: RP.did, signing: HOLDER, fetch: rp.fetchFn }),
    holder: { did: HOLDER.did },
    service: { did: RP.did },
    ...over,
  });
}

test("a login binds the session key inside the document the subject signs", async () => {
  const rp = fakeRp();
  const s = await login(rp, { sessionKey: SESSION_KEY });

  assert.equal(s.accessToken, "AT");
  assert.equal(s.sessionKey, SESSION_KEY);
  assert.equal(rp.calls.length, 2);
  const [ch, auth] = rp.calls.map((c) => c.doc);
  assert.equal(ch.type, CHALLENGE);
  assert.equal(auth.type, AUTHENTICATE);
  assert.equal(auth.payload.sessionKey, SESSION_KEY);
  // Both addressed to the RP, both signed by the subject. The subject's
  // proof is what covers the session key.
  for (const doc of [ch, auth]) {
    assert.equal(doc.recipient, RP.did);
    assert.equal(doc.issuer, HOLDER.did);
    assert.equal(doc.proof.proofPurpose, "authentication");
    assert.ok(doc.proof.verificationMethod.startsWith(`${HOLDER.did}#`));
    assert.equal((await verifyTrustTaskProof(doc)).verified, true);
  }
});

test("no bearer travels: the proof is the authorisation", async () => {
  const rp = fakeRp();
  await login(rp);
  for (const { headers } of rp.calls) {
    assert.equal(headers.authorization, undefined);
  }
});

test("a login without a session key sends none and reports none", async () => {
  const rp = fakeRp();
  const s = await login(rp);
  assert.equal(rp.calls[1].doc.payload.sessionKey, undefined);
  assert.equal(s.sessionKey, undefined);
});

test("a session key that is not a did:key is refused before anything is signed", async () => {
  for (const bad of [
    "did:web:attacker.example",
    `${SESSION_KEY}#key-1`,
    "z6MkpTHR8VNsBxYAAWHut2Geadd9jSwuBV8xRoAnwWsdvktH",
    "did:key:0OIl",
    `did:key:z${"1".repeat(600)}`,
  ]) {
    assert.equal(isDidKey(bad), false, bad);
    const rp = fakeRp();
    await assert.rejects(() => login(rp, { sessionKey: bad }), (e) => e.code === "e.client.invalid_session_key");
    assert.equal(rp.calls.length, 0, `${bad}: nothing may reach the RP`);
  }
});

test("an RP that signs in without binding the requested key fails the login", async () => {
  for (const bind of [() => undefined, () => "did:key:z6MkOtherOtherOtherOtherOtherOtherOtherOther"]) {
    const rp = fakeRp({ bind });
    await assert.rejects(
      () => login(rp, { sessionKey: SESSION_KEY }),
      (e) => e.code === "e.client.session_key_not_bound",
    );
  }
});

test("a reply signed by anyone but the pinned RP is refused", async () => {
  const rp = fakeRp({ as: STRANGER });
  await assert.rejects(() => login(rp, { sessionKey: SESSION_KEY }));
  assert.equal(rp.calls.length, 1, "it must not go on to authenticate");
});

test("the sender refuses a document addressed to another party", async () => {
  const rp = fakeRp();
  const sender = rpHttpsSender({ baseUrl: BASE, rpDid: RP.did, signing: HOLDER, fetch: rp.fetchFn });
  await assert.rejects(
    () =>
      sender.send({
        id: `urn:uuid:${crypto.randomUUID()}`,
        type: CHALLENGE,
        issuer: HOLDER.did,
        recipient: STRANGER.did,
        issuedAt: new Date().toISOString(),
        payload: {},
      }),
    (e) => e.code === "e.client.identity",
  );
  assert.equal(rp.calls.length, 0);
});
