import { test } from "node:test";
import assert from "node:assert/strict";

import {
  rawFromMultikey,
  rawFromOkpJwk,
  ed25519FromVerificationMethod,
  tspEndpointFromResolved,
  encodeMultikey,
} from "../dist/index.js";
import { ed25519, x25519 } from "@noble/curves/ed25519.js";

const b64url = (u8) => Buffer.from(u8).toString("base64url");
const okpJwk = (crv, pub) => ({ kty: "OKP", crv, x: b64url(pub) });

// Multicodec: ed25519-pub = 0xed, x25519-pub = 0xec.
const ED25519_PUB = 0xed;
const X25519_PUB = 0xec;

test("rawFromOkpJwk extracts the 32-byte key and checks the curve", () => {
  const pub = ed25519.getPublicKey(ed25519.utils.randomSecretKey());
  assert.deepEqual(rawFromOkpJwk(okpJwk("Ed25519", pub), "Ed25519"), pub);

  const xpub = x25519.getPublicKey(x25519.utils.randomSecretKey());
  assert.deepEqual(rawFromOkpJwk(okpJwk("X25519", xpub), "X25519"), xpub);

  assert.throws(() => rawFromOkpJwk(okpJwk("Ed25519", pub), "X25519")); // wrong crv
  assert.throws(() => rawFromOkpJwk({ kty: "EC", crv: "P-256", x: "aa" }, "Ed25519"));
});

test("rawFromMultikey decodes the multicodec + raw key (round-trips encodeMultikey)", () => {
  const pub = ed25519.getPublicKey(ed25519.utils.randomSecretKey());
  const mk = encodeMultikey(ED25519_PUB, pub); // "z…"
  const { codec, key } = rawFromMultikey(mk);
  assert.equal(codec, ED25519_PUB);
  assert.deepEqual(key, pub);

  const xpub = x25519.getPublicKey(x25519.utils.randomSecretKey());
  const xmk = encodeMultikey(X25519_PUB, xpub);
  assert.equal(rawFromMultikey(xmk).codec, X25519_PUB);
  assert.deepEqual(rawFromMultikey(xmk).key, xpub);

  assert.throws(() => rawFromMultikey("Qnot-base58btc")); // no 'z' prefix
});

test("ed25519FromVerificationMethod reads Multikey and JWK forms", () => {
  const pub = ed25519.getPublicKey(ed25519.utils.randomSecretKey());
  assert.deepEqual(
    ed25519FromVerificationMethod({ publicKeyMultibase: encodeMultikey(ED25519_PUB, pub) }),
    pub,
  );
  assert.deepEqual(ed25519FromVerificationMethod({ publicKeyJwk: okpJwk("Ed25519", pub) }), pub);

  // A non-Ed25519 Multikey (X25519) must be rejected.
  const xpub = x25519.getPublicKey(x25519.utils.randomSecretKey());
  assert.throws(() =>
    ed25519FromVerificationMethod({ publicKeyMultibase: encodeMultikey(X25519_PUB, xpub) }),
  );
});

test("tspEndpointFromResolved: X25519 from JWK + Ed25519 via authentication VM", () => {
  const edPub = ed25519.getPublicKey(ed25519.utils.randomSecretKey());
  const xPub = x25519.getPublicKey(x25519.utils.randomSecretKey());
  const did = "did:web:vta.example";

  const doc = {
    verificationMethod: [
      { id: `${did}#key-agreement-1`, type: "X25519KeyAgreementKey2020" },
      { id: `${did}#auth-1`, type: "Multikey", publicKeyMultibase: encodeMultikey(ED25519_PUB, edPub) },
    ],
    authentication: [`${did}#auth-1`],
  };

  const ep = tspEndpointFromResolved(did, okpJwk("X25519", xPub), doc);
  assert.equal(ep.vid, did);
  assert.deepEqual(ep.encryptionPublicKey, xPub);
  assert.deepEqual(ep.signingPublicKey, edPub);
});

test("tspEndpointFromResolved: falls back to any Ed25519 VM when no auth ref", () => {
  const edPub = ed25519.getPublicKey(ed25519.utils.randomSecretKey());
  const xPub = x25519.getPublicKey(x25519.utils.randomSecretKey());
  const doc = {
    verificationMethod: [
      { id: "#x", type: "Multikey", publicKeyMultibase: encodeMultikey(X25519_PUB, xPub) },
      { id: "#e", type: "Multikey", publicKeyMultibase: encodeMultikey(ED25519_PUB, edPub) },
    ],
  };
  const ep = tspEndpointFromResolved("did:key:z", okpJwk("X25519", xPub), doc);
  assert.deepEqual(ep.signingPublicKey, edPub);
});

test("tspEndpointFromResolved throws when no Ed25519 key is present", () => {
  const xPub = x25519.getPublicKey(x25519.utils.randomSecretKey());
  const doc = {
    verificationMethod: [{ id: "#x", type: "Multikey", publicKeyMultibase: encodeMultikey(X25519_PUB, xPub) }],
  };
  assert.throws(() => tspEndpointFromResolved("did:web:x", okpJwk("X25519", xPub), doc));
});
