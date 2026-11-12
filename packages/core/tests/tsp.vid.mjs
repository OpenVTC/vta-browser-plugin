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

test("ed25519FromVerificationMethod reads Multikey and JWK forms, by type", () => {
  const pub = ed25519.getPublicKey(ed25519.utils.randomSecretKey());
  const mk = encodeMultikey(ED25519_PUB, pub);
  assert.deepEqual(ed25519FromVerificationMethod({ id: "#a", type: "Multikey", publicKeyMultibase: mk }), pub);
  assert.deepEqual(
    ed25519FromVerificationMethod({ id: "#a", type: "Ed25519VerificationKey2020", publicKeyMultibase: mk }),
    pub,
  );
  for (const type of ["JsonWebKey", "JsonWebKey2020"]) {
    assert.deepEqual(ed25519FromVerificationMethod({ id: "#a", type, publicKeyJwk: okpJwk("Ed25519", pub) }), pub);
  }

  // A non-Ed25519 Multikey (X25519) must be rejected.
  const xpub = x25519.getPublicKey(x25519.utils.randomSecretKey());
  assert.throws(() =>
    ed25519FromVerificationMethod({ id: "#x", type: "Multikey", publicKeyMultibase: encodeMultikey(X25519_PUB, xpub) }),
  );
  // Fail closed: no type, an unknown type, the encoding the type does not
  // carry, both encodings, a JWK with `d`, a revoked method.
  const fails = [
    { publicKeyMultibase: mk },
    { type: "EcdsaSecp256k1VerificationKey2019", publicKeyMultibase: mk },
    { type: "JsonWebKey", publicKeyMultibase: mk },
    { type: "Multikey", publicKeyJwk: okpJwk("Ed25519", pub) },
    { type: "Multikey", publicKeyMultibase: mk, publicKeyJwk: okpJwk("Ed25519", pub) },
    { type: "JsonWebKey", publicKeyJwk: { ...okpJwk("Ed25519", pub), d: b64url(new Uint8Array(32)) } },
    { type: "Multikey", publicKeyMultibase: mk, revoked: "2026-01-01T00:00:00Z" },
  ];
  for (const vm of fails) {
    assert.throws(() => ed25519FromVerificationMethod({ id: "#a", ...vm }), JSON.stringify(vm));
  }
});

test("rawFromOkpJwk refuses a JWK carrying private material", () => {
  const xpub = x25519.getPublicKey(x25519.utils.randomSecretKey());
  assert.throws(() => rawFromOkpJwk({ ...okpJwk("X25519", xpub), d: b64url(new Uint8Array(32)) }, "X25519"));
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

test("tspEndpointFromResolved: no authentication key means no endpoint — never any Ed25519 VM", () => {
  const edPub = ed25519.getPublicKey(ed25519.utils.randomSecretKey());
  const xPub = x25519.getPublicKey(x25519.utils.randomSecretKey());
  const did = "did:web:vta.example";
  const vms = [
    { id: "#x", type: "Multikey", publicKeyMultibase: encodeMultikey(X25519_PUB, xPub) },
    { id: "#e", type: "Multikey", publicKeyMultibase: encodeMultikey(ED25519_PUB, edPub) },
  ];
  // An Ed25519 key under no relationship, or only under assertionMethod, is
  // not the VID's signing key.
  assert.throws(() => tspEndpointFromResolved(did, okpJwk("X25519", xPub), { verificationMethod: vms }));
  assert.throws(() =>
    tspEndpointFromResolved(did, okpJwk("X25519", xPub), { verificationMethod: vms, assertionMethod: ["#e"] }),
  );
  // The same key under authentication, relative or absolute, is.
  for (const ref of ["#e", `${did}#e`]) {
    const ep = tspEndpointFromResolved(did, okpJwk("X25519", xPub), { verificationMethod: vms, authentication: [ref] });
    assert.deepEqual(ep.signingPublicKey, edPub);
  }
});

test("tspEndpointFromResolved dereferences an id exactly, never by fragment suffix", () => {
  const edPub = ed25519.getPublicKey(ed25519.utils.randomSecretKey());
  const xPub = x25519.getPublicKey(x25519.utils.randomSecretKey());
  const did = "did:web:vta.example";
  // `#e` must not match another DID's `#e`, nor `#key-e`.
  for (const id of ["did:web:other.example#e", `${did}#key-e`]) {
    const doc = {
      verificationMethod: [{ id, type: "Multikey", publicKeyMultibase: encodeMultikey(ED25519_PUB, edPub) }],
      authentication: ["#e"],
    };
    assert.throws(() => tspEndpointFromResolved(did, okpJwk("X25519", xPub), doc), id);
  }
});

test("tspEndpointFromResolved fails closed on an authentication key it cannot read", () => {
  const edPub = ed25519.getPublicKey(ed25519.utils.randomSecretKey());
  const xPub = x25519.getPublicKey(x25519.utils.randomSecretKey());
  const did = "did:web:vta.example";
  const mk = encodeMultikey(ED25519_PUB, edPub);
  for (const vm of [
    { publicKeyMultibase: mk },
    { type: "Multikey", publicKeyMultibase: mk, revoked: "2026-01-01T00:00:00Z" },
    { type: "JsonWebKey", publicKeyJwk: { ...okpJwk("Ed25519", edPub), d: b64url(new Uint8Array(32)) } },
  ]) {
    const doc = { verificationMethod: [{ id: `${did}#e`, ...vm }], authentication: ["#e"] };
    assert.throws(() => tspEndpointFromResolved(did, okpJwk("X25519", xPub), doc), JSON.stringify(vm));
  }
});

test("tspEndpointFromResolved throws when no Ed25519 key is present", () => {
  const xPub = x25519.getPublicKey(x25519.utils.randomSecretKey());
  const doc = {
    verificationMethod: [{ id: "#x", type: "Multikey", publicKeyMultibase: encodeMultikey(X25519_PUB, xPub) }],
    authentication: ["#x"],
  };
  assert.throws(() => tspEndpointFromResolved("did:web:x", okpJwk("X25519", xPub), doc));
});
