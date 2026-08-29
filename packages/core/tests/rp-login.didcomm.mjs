// The RP login's wire contract, pinned.
//
// This had drifted: the package sent `affinidi.com/webvh/1.0/authenticate` to a
// control plane whose DIDComm router binds
// `trusttasks.org/spec/auth/authenticate/0.1`, so the request did not route and
// login could not succeed at all. Nothing caught it because nothing tested this
// module — the type URIs were two string constants no assertion ever read.
//
// The values below are the RP's own, from `did-hosting-common`'s
// `didcomm_types.rs`:
//
//     pub const MSG_AUTHENTICATE:  &str = "https://trusttasks.org/spec/auth/authenticate/0.1";
//     pub const MSG_AUTH_RESPONSE: &str = "https://trusttasks.org/spec/auth/authenticate/0.1#response";

import { test } from "node:test";
import assert from "node:assert/strict";

import { loginViaDidcomm } from "../dist/rp-login/index.js";
import { unpack } from "@openvtc/vti-didcomm-js/unpack";
import { Identity } from "../dist/didcomm/index.js";
import { x25519 } from "@noble/curves/ed25519.js";

const AUTHENTICATE = "https://trusttasks.org/spec/auth/authenticate/0.1";
const AUTH_RESPONSE = `${AUTHENTICATE}#response`;
const RP_DID = "did:web:rp.example";

function party(did) {
  const sk = x25519.utils.randomSecretKey();
  const pk = x25519.getPublicKey(sk);
  return {
    did,
    kid: `${did}#key-1`,
    secretJwk: {
      kty: "OKP",
      crv: "X25519",
      d: Buffer.from(sk).toString("base64url"),
      x: Buffer.from(pk).toString("base64url"),
    },
    publicJwk: { kty: "OKP", crv: "X25519", x: Buffer.from(pk).toString("base64url") },
  };
}

const holderParty = party("did:peer:2holder");
const rpParty = party(RP_DID);

/** A bridge that unpacks nothing — it reports what was asked of it and replies
 *  with whatever the test supplies. The crypto is covered elsewhere; what is
 *  under test here is the contract. */
function bridge(reply) {
  const calls = [];
  return {
    calls,
    async sendAndAwaitReply(packed, requestId) {
      calls.push({ packed, requestId });
      return typeof reply === "function" ? reply(requestId) : { ...reply, thid: requestId };
    },
  };
}

function opts(b) {
  return {
    bridge: b,
    holder: Identity.fromSecretJwk({
      did: holderParty.did,
      kid: holderParty.kid,
      jwk: holderParty.secretJwk,
    }),
    service: {
      did: RP_DID,
      keyAgreementKid: rpParty.kid,
      keyAgreementPublicJwk: rpParty.publicJwk,
    },
  };
}

test("a canonical authenticate-response yields the RP's session tokens", async () => {
  const b = bridge({
    from: RP_DID,
    type: AUTH_RESPONSE,
    body: {
      session_id: "s1",
      access_token: "at",
      refresh_token: "rt",
      access_expires_at: 111,
      refresh_expires_at: 222,
    },
  });

  const out = await loginViaDidcomm(opts(b));
  assert.equal(out.sessionId, "s1");
  assert.equal(out.accessToken, "at");
  assert.equal(out.refreshToken, "rt");
  assert.equal(out.accessExpiresAt, 111);
  assert.equal(out.refreshExpiresAt, 222);
});

test("the retired response type is refused — no both-spellings fold", async () => {
  const b = bridge({
    from: RP_DID,
    type: "https://affinidi.com/webvh/1.0/authenticate-response",
    body: { session_id: "s", access_token: "a", refresh_token: "r" },
  });
  await assert.rejects(
    () => loginViaDidcomm(opts(b)),
    /authenticate-response/,
    "the legacy type must not be accepted alongside the canonical one",
  );
});

test("a reply from someone other than the RP is refused", async () => {
  const b = bridge({
    from: "did:web:imposter.example",
    type: AUTH_RESPONSE,
    body: { session_id: "s", access_token: "a", refresh_token: "r" },
  });
  await assert.rejects(() => loginViaDidcomm(opts(b)), /!= RP/);
});

test("a response missing a token is refused rather than half-returned", async () => {
  const b = bridge({ from: RP_DID, type: AUTH_RESPONSE, body: { session_id: "s" } });
  await assert.rejects(() => loginViaDidcomm(opts(b)), /malformed/);
});

test("the request goes out under the canonical authenticate type", async () => {
  // The assertion that would have caught the drift. Everything above tests the
  // reply; the request type is what the RP's router binds, and sending the
  // retired one meant the message never reached a handler at all.
  const b = bridge({
    from: RP_DID,
    type: AUTH_RESPONSE,
    body: { session_id: "s", access_token: "a", refresh_token: "r" },
  });
  await loginViaDidcomm(opts(b));

  // Unpack as the RP would: the authcrypt recipient, with the holder as the
  // verified sender.
  const opened = await unpack(
    b.calls[0].packed,
    { kid: rpParty.kid, privateJwk: rpParty.secretJwk },
    { publicJwk: holderParty.publicJwk },
  );
  assert.equal(opened.message.type, AUTHENTICATE);
  assert.equal(opened.message.from, holderParty.did);
  assert.deepEqual(opened.message.to, [RP_DID]);
  // Empty by contract: the RP's DIDComm handler authenticates on the authcrypt
  // sender and reads nothing here. See the note in didcomm.ts about the
  // conformance gap this leaves against the canonical schema.
  assert.deepEqual(opened.message.body, {});
});
