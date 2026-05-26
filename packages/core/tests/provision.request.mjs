// Round-trip test for `buildBootstrapRequest`: build a VP, then verify the
// Data Integrity proof against the holder's did:key public key. If the
// proof verifies the wallet's signing pipeline matches what the VTA's
// `BootstrapRequest::verify` expects.
//
// The signature primitive (eddsa-jcs-2022) is the same one
// `signTrustTask` already uses, so this test is also a regression guard
// for that path under `proofPurpose: "authentication"`.

import { test } from "node:test";
import assert from "node:assert/strict";

import { ed25519 } from "@noble/curves/ed25519.js";

import {
  buildBootstrapRequest,
  generateSigningIdentity,
} from "../dist/index.js";

// JCS — same algorithm as `trust-tasks/sign.ts::jcsCanonicalize`. Re-inlined
// here because the lib doesn't export it; if the signer changes algorithms,
// the existing signTrustTask tests would catch it, not this one.
function jcs(value) {
  const seen = new WeakSet();
  function enc(v) {
    if (v === null) return "null";
    if (v === true) return "true";
    if (v === false) return "false";
    if (typeof v === "number") {
      if (!Number.isFinite(v)) throw new Error("JCS rejects non-finite numbers");
      if (Object.is(v, -0)) return "0";
      return String(v);
    }
    if (typeof v === "string") return encString(v);
    if (Array.isArray(v)) {
      if (seen.has(v)) throw new Error("circular");
      seen.add(v);
      const out = "[" + v.map(enc).join(",") + "]";
      seen.delete(v);
      return out;
    }
    if (typeof v === "object") {
      if (seen.has(v)) throw new Error("circular");
      seen.add(v);
      const keys = Object.keys(v).sort();
      const parts = keys.map((k) => encString(k) + ":" + enc(v[k]));
      seen.delete(v);
      return "{" + parts.join(",") + "}";
    }
    throw new Error(`cannot encode ${typeof v}`);
  }
  function encString(s) {
    let out = '"';
    for (let i = 0; i < s.length; i++) {
      const ch = s.charCodeAt(i);
      if (ch === 0x22) out += '\\"';
      else if (ch === 0x5c) out += "\\\\";
      else if (ch === 0x08) out += "\\b";
      else if (ch === 0x0c) out += "\\f";
      else if (ch === 0x0a) out += "\\n";
      else if (ch === 0x0d) out += "\\r";
      else if (ch === 0x09) out += "\\t";
      else if (ch < 0x20) out += "\\u" + ch.toString(16).padStart(4, "0");
      else out += s[i];
    }
    return out + '"';
  }
  return enc(value);
}

async function sha256(s) {
  const buf = new TextEncoder().encode(s);
  return new Uint8Array(await crypto.subtle.digest("SHA-256", buf));
}

// Multibase base58btc decoder for the proofValue (`z`-prefixed).
const B58 = "123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz";
function b58decode(s) {
  let n = 0n;
  for (const ch of s) {
    const idx = B58.indexOf(ch);
    if (idx < 0) throw new Error(`bad base58 char: ${ch}`);
    n = n * 58n + BigInt(idx);
  }
  let hex = n.toString(16);
  if (hex.length % 2) hex = "0" + hex;
  const out = [];
  for (let i = 0; i < hex.length; i += 2) out.push(parseInt(hex.slice(i, i + 2), 16));
  for (const ch of s) {
    if (ch === "1") out.unshift(0);
    else break;
  }
  return new Uint8Array(out);
}

test("buildBootstrapRequest: produces VP with expected fields", async () => {
  const eph = generateSigningIdentity();
  const { vp, nonce } = await buildBootstrapRequest({
    ephemeral: eph,
    ask: {
      type: "AdminRotation",
      contextHint: "default",
      adminTemplate: { name: "vta-admin", vars: {} },
    },
    label: "smoke-test",
  });

  assert.deepEqual(vp["@context"], [
    "https://www.w3.org/ns/credentials/v2",
    "https://openvtc.org/contexts/bootstrap-v1",
  ]);
  assert.deepEqual(vp.type, ["VerifiablePresentation", "BootstrapRequest"]);
  assert.ok(vp.id.startsWith("urn:uuid:"));
  assert.equal(vp.holder, eph.did);
  assert.match(vp.nonce, /^[A-Za-z0-9_-]{22}$/);
  assert.equal(nonce.length, 16);
  assert.ok(vp.validUntil);
  assert.equal(vp.label, "smoke-test");
  assert.equal(vp.ask.type, "AdminRotation");

  // Proof must be DataIntegrityProof / eddsa-jcs-2022 / authentication.
  const proof = vp.proof;
  assert.equal(proof.type, "DataIntegrityProof");
  assert.equal(proof.cryptosuite, "eddsa-jcs-2022");
  assert.equal(proof.proofPurpose, "authentication");
  assert.equal(proof.verificationMethod, eph.kid);
  assert.ok(typeof proof.proofValue === "string" && proof.proofValue.startsWith("z"));
});

test("buildBootstrapRequest: proof verifies under the holder's pubkey", async () => {
  const eph = generateSigningIdentity();
  const { vp } = await buildBootstrapRequest({
    ephemeral: eph,
    ask: {
      type: "AdminRotation",
      adminTemplate: { name: "vta-admin" },
    },
  });

  // Reconstruct the signed bytes the same way the verifier does:
  //   transformedData = SHA-256(JCS(proofConfig - proofValue))
  //                      || SHA-256(JCS(doc - proof))
  // Then Ed25519.verify(sig, transformedData, holderPub).
  const docCopy = { ...vp };
  delete docCopy.proof;
  const proofConfig = { ...vp.proof };
  delete proofConfig.proofValue;

  const proofHash = await sha256(jcs(proofConfig));
  const docHash = await sha256(jcs(docCopy));
  const signed = new Uint8Array(proofHash.length + docHash.length);
  signed.set(proofHash, 0);
  signed.set(docHash, proofHash.length);

  const sigMb = vp.proof.proofValue;
  assert.ok(sigMb.startsWith("z"), "proofValue must be `z`-prefixed multibase");
  const sig = b58decode(sigMb.slice(1));
  assert.equal(sig.length, 64);

  const ok = ed25519.verify(sig, signed, eph.publicKey);
  assert.ok(ok, "proof must verify against the holder's Ed25519 pubkey");
});

test("buildBootstrapRequest: validity window matches default", async () => {
  const eph = generateSigningIdentity();
  const before = Date.now();
  const { vp } = await buildBootstrapRequest({
    ephemeral: eph,
    ask: { type: "AdminRotation", adminTemplate: { name: "vta-admin" } },
  });
  const after = Date.now();

  const validUntil = Date.parse(vp.validUntil);
  // 15 min default ± clock-drift while the test ran. Use a generous range
  // so this doesn't flake on a slow CI runner.
  assert.ok(validUntil >= before + 14 * 60_000);
  assert.ok(validUntil <= after + 16 * 60_000);
});
