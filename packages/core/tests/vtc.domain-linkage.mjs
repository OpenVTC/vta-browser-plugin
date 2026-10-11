// Route B: the portal origin's DIF Well-Known DID Configuration
// (dtgwg-vti-spec #58). A domain-linked contact is accepted only when the
// portal publishes a Domain Linkage Credential the DID signed, for exactly
// that origin, valid now, with a key under `assertionMethod` — in either
// format, JWT (EdDSA, ES256) or JSON-LD with an `eddsa-jcs-2022` proof.

import { test } from "node:test";
import assert from "node:assert/strict";
import { ed25519 } from "@noble/curves/ed25519.js";
import { p256 } from "@noble/curves/nist.js";
import { multibase } from "@openvtc/vti-didcomm-js";
import {
  verifyDomainLinkage,
  DID_CONFIGURATION_CONTEXT,
  DID_CONFIGURATION_MAX_BYTES,
} from "../dist/vtc/index.js";
import { signTrustTask } from "../dist/trust-tasks/index.js";
import { bytesToBase64url } from "../dist/util/index.js";

const DID = "did:test:QmLinked";
const ORIGIN = "https://portal.example.org";
const NOW = 1_791_460_900_000;
const DAY = 86_400_000;

const edSk = ed25519.utils.randomSecretKey();
const edPk = ed25519.getPublicKey(edSk);
const pSk = p256.utils.randomSecretKey();
const pPk = p256.getPublicKey(pSk); // compressed
const authSk = ed25519.utils.randomSecretKey();
const authPk = ed25519.getPublicKey(authSk);

const vm = (frag, codec, pk) => ({
  id: `${DID}#${frag}`,
  type: "Multikey",
  controller: DID,
  publicKeyMultibase: multibase.encodeMultikey(codec, pk),
});
const DOC = {
  id: DID,
  verificationMethod: [
    vm("ed", multibase.MULTICODEC.ED25519_PUB, edPk),
    vm("p", multibase.MULTICODEC.P256_PUB, pPk),
    vm("auth", multibase.MULTICODEC.ED25519_PUB, authPk),
  ],
  assertionMethod: ["#ed", `${DID}#p`],
  authentication: ["#auth"],
};

const iso = (ms) => new Date(ms).toISOString();
const vcBody = (over = {}) => ({
  "@context": ["https://www.w3.org/2018/credentials/v1", DID_CONFIGURATION_CONTEXT],
  type: ["VerifiableCredential", "DomainLinkageCredential"],
  issuer: DID,
  issuanceDate: iso(NOW - DAY),
  expirationDate: iso(NOW + DAY),
  credentialSubject: { id: DID, origin: ORIGIN },
  ...over,
});

const enc = (o) => bytesToBase64url(new TextEncoder().encode(JSON.stringify(o)));

function jwt({ alg = "EdDSA", kid = `${DID}#ed`, sk, payload = {}, vc = {} } = {}) {
  const h = enc({ alg, kid, typ: "JWT" });
  const p = enc({
    iss: DID,
    sub: DID,
    nbf: Math.floor((NOW - DAY) / 1000),
    exp: Math.floor((NOW + DAY) / 1000),
    vc: vcBody(vc),
    ...payload,
  });
  const input = new TextEncoder().encode(`${h}.${p}`);
  const sig =
    alg === "ES256" ? p256.sign(input, sk ?? pSk, { prehash: true }) : ed25519.sign(input, sk ?? edSk);
  return `${h}.${p}.${bytesToBase64url(sig)}`;
}

async function jsonld({ over = {}, frag = "ed", sk = edSk, pk = edPk, purpose = "assertionMethod" } = {}) {
  const cred = vcBody(over);
  await signTrustTask({
    envelope: cred,
    signing: { did: DID, kid: `${DID}#${frag}`, privateKey: sk, publicKey: pk },
    proofPurpose: purpose,
  });
  return cred;
}

const config = (linked, ctx = DID_CONFIGURATION_CONTEXT) => ({ "@context": ctx, linked_dids: linked });

/** A fake portal: serves `body` and records every request. */
function portal(body, { status = 200, headers = {}, url } = {}) {
  const calls = [];
  const fetch = async (u, init) => {
    calls.push({ url: String(u), init });
    const res = new Response(typeof body === "string" ? body : JSON.stringify(body), { status, headers });
    if (url) Object.defineProperty(res, "url", { value: url });
    return res;
  };
  return { fetch, calls };
}

const verify = (fetch, over = {}) =>
  verifyDomainLinkage({ did: DID, didDocument: DOC, origin: ORIGIN, now: NOW, fetch, ...over });

const notLinked = (r, detail) => {
  assert.equal(r.ok, false, `expected domain-not-linked (${detail}), got ${JSON.stringify(r)}`);
  assert.equal(r.reason, "domain-not-linked");
  if (detail) assert.equal(r.detail, detail);
};

// ── Accepted ─────────────────────────────────────────────────────────────────

test("a JWT signed with EdDSA is accepted, fetched the way the rule says", async () => {
  const p = portal(config([jwt()]));
  assert.deepEqual(await verify(p.fetch), { ok: true, format: "jwt" });
  assert.equal(p.calls.length, 1);
  const { url, init } = p.calls[0];
  assert.equal(url, `${ORIGIN}/.well-known/did-configuration.json`);
  assert.equal(init.method, "GET");
  assert.equal(init.credentials, "omit");
  assert.equal(init.redirect, "error");
  assert.ok(init.signal instanceof AbortSignal, "a timeout signal");
});

test("a JWT signed with ES256 (P-256) is accepted", async () => {
  const p = portal(config([jwt({ alg: "ES256", kid: `${DID}#p` })]));
  assert.deepEqual(await verify(p.fetch), { ok: true, format: "jwt" });
});

test("a JWT with a relative kid is accepted", async () => {
  const p = portal(config([jwt({ kid: "#ed" })]));
  assert.deepEqual(await verify(p.fetch), { ok: true, format: "jwt" });
});

test("a JSON-LD credential with an eddsa-jcs-2022 proof is accepted", async () => {
  const p = portal(config([await jsonld()]));
  assert.deepEqual(await verify(p.fetch), { ok: true, format: "jsonld" });
});

test("one good entry among bad ones is enough", async () => {
  const p = portal(config(["not-a-jwt", jwt({ vc: { credentialSubject: { id: DID, origin: "https://x.example" } } }), jwt()]));
  assert.deepEqual(await verify(p.fetch), { ok: true, format: "jwt" });
});

test("within the 60 s clock allowance either side", async () => {
  const early = portal(config([jwt({ payload: { nbf: Math.floor(NOW / 1000) + 30 }, vc: { issuanceDate: iso(NOW + 30_000) } })]));
  assert.equal((await verify(early.fetch)).ok, true);
  const late = portal(config([jwt({ payload: { exp: Math.floor(NOW / 1000) - 30 }, vc: { expirationDate: iso(NOW - 30_000) } })]));
  assert.equal((await verify(late.fetch)).ok, true);
});

// ── Refused: the credential ──────────────────────────────────────────────────

test("a wrong origin is refused, in both formats", async () => {
  const other = { credentialSubject: { id: DID, origin: "https://other.example.org" } };
  notLinked(await verify(portal(config([jwt({ vc: other })])).fetch), "wrong origin");
  notLinked(await verify(portal(config([await jsonld({ over: other })])).fetch), "wrong origin");
  // The origin is compared exactly: a trailing slash or a port is another one.
  const slash = { credentialSubject: { id: DID, origin: `${ORIGIN}/` } };
  notLinked(await verify(portal(config([jwt({ vc: slash })])).fetch), "wrong origin");
});

test("a wrong DID is refused: issuer, subject, or credentialSubject.id", async () => {
  notLinked(await verify(portal(config([jwt({ payload: { iss: "did:test:other" } })])).fetch), "wrong issuer");
  notLinked(await verify(portal(config([jwt({ payload: { sub: "did:test:other" } })])).fetch), "wrong subject DID");
  notLinked(
    await verify(portal(config([jwt({ vc: { credentialSubject: { id: "did:test:other", origin: ORIGIN } } })])).fetch),
    "wrong subject DID",
  );
  notLinked(await verify(portal(config([await jsonld({ over: { issuer: "did:test:other" } })])).fetch), "wrong issuer");
  // A valid configuration, for another DID than the contact.
  notLinked(await verify(portal(config([jwt()])).fetch, { did: "did:test:other", didDocument: { ...DOC, id: "did:test:other" } }));
});

test("an expired credential is refused, past the allowance", async () => {
  notLinked(
    await verify(portal(config([jwt({ payload: { exp: Math.floor(NOW / 1000) - 61 } })])).fetch),
    "expired",
  );
  notLinked(
    await verify(portal(config([await jsonld({ over: { expirationDate: iso(NOW - 61_000) } })])).fetch),
    "expired",
  );
  notLinked(
    await verify(portal(config([jwt({ payload: { nbf: Math.floor(NOW / 1000) + 120 } })])).fetch),
    "not yet valid",
  );
});

test("a credential with no expiry is refused", async () => {
  notLinked(
    await verify(portal(config([jwt({ payload: { exp: undefined }, vc: { expirationDate: undefined } })])).fetch),
    "no expiry",
  );
});

test("a bad signature is refused, in both formats", async () => {
  const good = jwt();
  const [h, p, s] = good.split(".");
  const flipped = s[0] === "A" ? `B${s.slice(1)}` : `A${s.slice(1)}`;
  notLinked(await verify(portal(config([`${h}.${p}.${flipped}`])).fetch), "bad signature");
  // Signed by a key that is not the one `kid` names.
  notLinked(await verify(portal(config([jwt({ sk: authSk })])).fetch), "bad signature");
  // A payload changed after signing.
  const tampered = enc({ ...JSON.parse(Buffer.from(p, "base64url").toString()), exp: Math.floor((NOW + 2 * DAY) / 1000) });
  notLinked(await verify(portal(config([`${h}.${tampered}.${s}`])).fetch), "bad signature");
  const cred = await jsonld();
  cred.credentialSubject = { ...cred.credentialSubject };
  cred.expirationDate = iso(NOW + 2 * DAY);
  notLinked(await verify(portal(config([cred])).fetch), "bad signature");
});

test("a key not under assertionMethod is refused, in both formats", async () => {
  notLinked(await verify(portal(config([jwt({ kid: `${DID}#auth`, sk: authSk })])).fetch), "a key not under assertionMethod");
  notLinked(
    await verify(portal(config([await jsonld({ frag: "auth", sk: authSk, pk: authPk })])).fetch),
    "a key not under assertionMethod",
  );
  // A key of another DID altogether.
  notLinked(await verify(portal(config([jwt({ kid: "did:test:other#ed" })])).fetch), "a key of another DID");
});

test("an alg that does not match the key, or an unsupported alg, is refused", async () => {
  notLinked(await verify(portal(config([jwt({ alg: "ES256", kid: `${DID}#ed`, sk: pSk })])).fetch), "the alg does not match the key");
  const h = enc({ alg: "none", kid: `${DID}#ed` });
  notLinked(await verify(portal(config([`${h}.${jwt().split(".")[1]}.`])).fetch), "an unsupported JWT alg");
});

test("a JSON-LD proof for another purpose or suite is refused", async () => {
  notLinked(await verify(portal(config([await jsonld({ purpose: "authentication" })])).fetch), "a proof not for assertionMethod");
  const cred = await jsonld();
  cred.proof = { ...cred.proof, cryptosuite: "eddsa-rdfc-2022" };
  notLinked(await verify(portal(config([cred])).fetch), "an unsupported proof");
});

// ── Refused: the resource ────────────────────────────────────────────────────

test("a bad @context is refused", async () => {
  notLinked(await verify(portal(config([jwt()], "https://example.org/other")).fetch), "wrong @context");
  notLinked(await verify(portal(config([jwt()], [DID_CONFIGURATION_CONTEXT])).fetch), "wrong @context");
  notLinked(await verify(portal({ "@context": DID_CONFIGURATION_CONTEXT }).fetch), "no linked_dids");
});

test("a redirect is refused: the fetch refuses to follow, and a followed one is caught", async () => {
  // What a browser does with `redirect: "error"` and a 3xx.
  const refusing = async (_u, init) => {
    assert.equal(init.redirect, "error");
    throw new TypeError("Failed to fetch");
  };
  notLinked(await verify(refusing), "unreachable");
  // A fetch that followed anyway, to another origin.
  notLinked(
    await verify(portal(config([jwt()]), { url: "https://evil.example/.well-known/did-configuration.json" }).fetch),
    "redirected",
  );
  // The same origin is fine.
  const same = portal(config([jwt()]), { url: `${ORIGIN}/.well-known/did-configuration.json` });
  assert.equal((await verify(same.fetch)).ok, true);
});

test("a body over 64 KiB is refused, declared or not", async () => {
  const big = JSON.stringify(config([jwt(), "x".repeat(DID_CONFIGURATION_MAX_BYTES)]));
  notLinked(await verify(portal(big).fetch), "too large");
  notLinked(await verify(portal(config([jwt()]), { headers: { "content-length": String(DID_CONFIGURATION_MAX_BYTES + 1) } }).fetch), "too large");
});

test("a portal that does not answer in time is refused", async () => {
  const keepAlive = setTimeout(() => {}, 5_000);
  try {
    const hanging = (_u, init) =>
      new Promise((_resolve, reject) => {
        init.signal.addEventListener("abort", () => reject(init.signal.reason));
      });
    notLinked(await verify(hanging, { timeoutMs: 50 }), "timeout");
  } finally {
    clearTimeout(keepAlive);
  }
});

test("a non-200, a non-JSON body, or a non-https origin is refused", async () => {
  notLinked(await verify(portal(config([jwt()]), { status: 404 }).fetch), "status 404");
  notLinked(await verify(portal("<html>").fetch), "not JSON");
  let called = false;
  notLinked(
    await verify(async () => ((called = true), new Response("{}")), { origin: "http://portal.example.org" }),
    "the portal origin is not an https origin",
  );
  assert.equal(called, false);
});
