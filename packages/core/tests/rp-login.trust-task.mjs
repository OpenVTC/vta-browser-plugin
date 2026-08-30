// Login as two Trust Tasks: the wire contract, and the refusals.
//
// The bespoke DIDComm login this replaces authenticated on the authcrypt
// sender and read nothing from the body, which made the `challenge` the
// canonical task declares REQUIRED a field nobody checked. These tests pin
// that the pair actually travels: the challenge comes back, and the exact
// values it carried go out on the authenticate.

import { test } from "node:test";
import assert from "node:assert/strict";

import { loginViaTrustTask } from "../dist/rp-login/index.js";
import { VtaClientError } from "../dist/vta/index.js";

const HOLDER = "did:key:z6MkHolderExampleExampleExampleExampleExample";
const RP = "did:web:rp.example";
const CHALLENGE = "https://trusttasks.org/spec/auth/challenge/0.1";
const AUTHENTICATE = "https://trusttasks.org/spec/auth/authenticate/0.1";

function opts(sender, over = {}) {
  return {
    sender,
    holder: { did: HOLDER, kid: `${HOLDER}#key-1` },
    signing: { did: HOLDER, kid: `${HOLDER}#key-2`, privateKey: new Uint8Array(32) },
    service: { did: RP, keyAgreementKid: `${RP}#key-1`, keyAgreementPublicJwk: {} },
    ...over,
  };
}

/** Replies per task type; records everything sent. */
function rp({ challenge = {}, authenticate = {} } = {}) {
  const sent = [];
  return {
    sent,
    async send(envelope, o) {
      sent.push({ envelope, opts: o });
      if (envelope.type === CHALLENGE) {
        return { challenge: "nonce-1", sessionId: "sess-1", expiresAt: "2026-01-01T00:00:00Z", ...challenge };
      }
      if (envelope.type === AUTHENTICATE) {
        return {
          session: { id: "sess-1" },
          tokens: { accessToken: "at", tokenType: "Bearer", expiresIn: 900, ...authenticate },
        };
      }
      throw new Error(`unexpected task ${envelope.type}`);
    },
  };
}

test("the challenge's values are the ones spent on the authenticate", async () => {
  const sender = rp({ challenge: { challenge: "nonce-xyz", sessionId: "sess-abc" } });
  await loginViaTrustTask(opts(sender));

  assert.equal(sender.sent.length, 2);
  const [ch, auth] = sender.sent;

  assert.equal(ch.envelope.type, CHALLENGE);
  assert.equal(ch.envelope.issuer, HOLDER);
  assert.equal(ch.envelope.recipient, RP);
  assert.equal(ch.envelope.payload.purpose, "login");

  assert.equal(auth.envelope.type, AUTHENTICATE);
  assert.equal(auth.opts.expectedResponseType, `${AUTHENTICATE}#response`);
  // Echoed verbatim — the RP looks the binding up by exactly these.
  assert.equal(auth.envelope.payload.challenge, "nonce-xyz");
  assert.equal(auth.envelope.payload.sessionId, "sess-abc");
});

test("the session comes back from the tokens the RP issued", async () => {
  const sender = rp({
    authenticate: { accessToken: "AT", refreshToken: "RT", expiresIn: 1800, scope: ["read"] },
  });
  const s = await loginViaTrustTask(opts(sender, { scope: ["read", "write"] }));

  assert.equal(s.accessToken, "AT");
  assert.equal(s.refreshToken, "RT");
  assert.equal(s.expiresIn, 1800);
  // What the RP granted, not what was asked — the task declares the issued
  // scope MAY be a subset, so echoing the request would misreport it.
  assert.deepEqual(s.scope, ["read"]);
  assert.deepEqual(sender.sent[1].envelope.payload.scope, ["read", "write"]);
});

test("a refresh token is omitted rather than invented when the RP sends none", async () => {
  const s = await loginViaTrustTask(opts(rp()));
  assert.equal(s.refreshToken, undefined);
  assert.ok(!("refreshToken" in s) || s.refreshToken === undefined);
});

test("both auth documents are issued by the holder when no subject is named", async () => {
  // The guard this replaces asserted "the signing identity must be the
  // holder", checked inside `loginViaTrustTask`. It could not survive a
  // channel that signs as a per-site persona, and it was checking the wrong
  // thing anyway: `loginViaTrustTask` never signs. `signOutboundTask` compares
  // the envelope's issuer against the signer's DID on every outbound document,
  // which is the same rule enforced where the signature actually happens.
  //
  // What still has to hold here is that both steps name ONE identity. The RP
  // refuses unless the DID it issued the challenge to is the one that signed
  // (`session.did != input.signer_did`), so a challenge for A spent by a
  // document issued by B fails remotely with nothing pointing here.
  const sender = rp();
  await loginViaTrustTask(opts(sender));
  assert.equal(sender.sent.length, 2);
  assert.equal(sender.sent[0].envelope.issuer, HOLDER);
  assert.equal(sender.sent[1].envelope.issuer, HOLDER);
  assert.equal(sender.sent[0].envelope.payload.subject, HOLDER);
});

test("a named subject issues BOTH documents, not just the challenge", async () => {
  // The half that would break silently: request the challenge for the persona
  // but issue the authenticate as the holder, and the RP rejects on the signer
  // check — after the operator has already approved the sign-in.
  const PERSONA = "did:webvh:zScid:agent.example:contexts:personal";
  const sender = rp();
  await loginViaTrustTask(opts(sender, { subject: PERSONA }));
  assert.equal(sender.sent[0].envelope.issuer, PERSONA);
  assert.equal(sender.sent[0].envelope.payload.subject, PERSONA);
  assert.equal(sender.sent[1].envelope.issuer, PERSONA);
});

test("a refused challenge surfaces as itself, not as a login failure", async () => {
  // No ACL entry, or rate limited: the RP will not talk to this DID at all.
  // Distinct from a rejected challenge, which means the second step failed.
  const sender = {
    sent: [],
    async send(envelope) {
      this.sent.push(envelope);
      throw new VtaClientError("e.p.msg.permission_denied", "not in the ACL");
    },
  };
  await assert.rejects(() => loginViaTrustTask(opts(sender)), (e) => e.code === "e.p.msg.permission_denied");
  assert.equal(sender.sent.length, 1, "it must not go on to authenticate");
});
