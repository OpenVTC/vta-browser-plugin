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

import * as x25519 from "@openvtc/vti-didcomm-js/x25519";
import * as jwk from "@openvtc/vti-didcomm-js/jwk";
import * as multibase from "@openvtc/vti-didcomm-js/multibase";

import { Identity } from "../dist/didcomm/index.js";
import { getVtaBearer } from "../dist/vta/auth.js";

const BLOCKED_ENDPOINT = "E_BLOCKED_ENDPOINT";
const DEV_POLICY = { allowInsecure: true, allowPrivate: true };

/** A VTA keyAgreement endpoint the handshake can authcrypt to. */
function vtaEndpoint() {
  const kp = x25519.generateKeyPair();
  const mb = multibase.encodeMultikey(multibase.MULTICODEC.X25519_PUB, kp.publicKey);
  return {
    did: `did:key:${mb}`,
    keyAgreementKid: `did:key:${mb}#${mb}`,
    keyAgreementPublicJwk: jwk.publicJwk("X25519", kp.publicKey),
  };
}

/** Records every URL it is asked for, and answers with real `Response`s (a
 *  hand-rolled `{ ok, json }` stub stops representing one the moment the code
 *  reads the body differently — see CLAUDE.md). */
function spyFetch(bodies) {
  const calls = [];
  const impl = async (url) => {
    calls.push(String(url));
    return new Response(JSON.stringify(bodies[calls.length - 1] ?? {}), {
      status: 200,
      headers: { "content-type": "application/json" },
    });
  };
  return { calls, impl };
}

test("a loopback VTA base URL is refused before any request is made", async () => {
  const holder = Identity.generate("did:example:holder-loopback");
  const spy = spyFetch([]);
  try {
    await assert.rejects(
      () =>
        getVtaBearer({
          baseUrl: "https://127.0.0.1:8100",
          holder,
          service: vtaEndpoint(),
          fetch: spy.impl,
        }),
      (err) => {
        assert.equal(err.code, BLOCKED_ENDPOINT);
        assert.equal(err.reason, "private_address");
        return true;
      },
    );
    // The point of checking the base URL rather than the response: the bearer
    // handshake begins with an unauthenticated POST naming the holder's DID, so
    // "it failed" is not the same as "it never spoke".
    assert.deepEqual(spy.calls, []);
  } finally {
    holder.dispose();
  }
});

test("a local-only name is refused as well, not just an address", async () => {
  const holder = Identity.generate("did:example:holder-name");
  const spy = spyFetch([]);
  try {
    await assert.rejects(
      () =>
        getVtaBearer({
          baseUrl: "https://vta.internal",
          holder,
          service: vtaEndpoint(),
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
  const holder = Identity.generate("did:example:holder-plaintext");
  const spy = spyFetch([]);
  try {
    await assert.rejects(
      () =>
        getVtaBearer({
          baseUrl: "http://vta.example",
          holder,
          service: vtaEndpoint(),
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
  const holder = Identity.generate("did:example:holder-dev");
  const spy = spyFetch([
    { sessionId: "s-1", challenge: "c-1" },
    { tokens: { accessToken: "vta.jwt" } },
  ]);
  try {
    const token = await getVtaBearer({
      baseUrl: "http://localhost:8100",
      holder,
      service: vtaEndpoint(),
      fetch: spy.impl,
      netPolicy: DEV_POLICY,
    });
    assert.equal(token, "vta.jwt");
    assert.deepEqual(spy.calls, [
      "http://localhost:8100/auth/challenge",
      "http://localhost:8100/auth/",
    ]);
  } finally {
    holder.dispose();
  }
});

test("allowPrivate alone does not admit a plaintext local VTA", async () => {
  // The 0.8 split, from the other side: a dev config that sets one flag gets a
  // refusal that names the scheme, not silence.
  const holder = Identity.generate("did:example:holder-half");
  const spy = spyFetch([]);
  try {
    await assert.rejects(() =>
      getVtaBearer({
        baseUrl: "http://localhost:8100",
        holder,
        service: vtaEndpoint(),
        fetch: spy.impl,
        netPolicy: { allowPrivate: true },
      }),
    );
    assert.deepEqual(spy.calls, []);
  } finally {
    holder.dispose();
  }
});
