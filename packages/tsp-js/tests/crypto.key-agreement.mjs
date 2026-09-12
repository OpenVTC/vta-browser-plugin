// The capability-driven halves of HPKE-Auth and Ed25519 signing
// (`KeyAgreement` / `SigningKey`), for custody that never exports a private
// key. Three properties, and the second and third are the ones a type checker
// cannot see:
//
//   1. Equivalence — a capability wrapping a raw key must reproduce the
//      raw-key functions byte for byte, and the CFRG vector through the new
//      path, or "additive only" is a claim rather than a fact.
//   2. Validation — the raw path gets RFC 9180 §4.1's all-zero-DH abort from
//      `dh()`, and noble's key-length checks for free. A capability's output is
//      foreign bytes, so the same guards have to be applied explicitly; a
//      backend whose DH is opaque has no reason to reject a low-order peer key
//      on our behalf.
//   3. Reachability — `exports` in package.json names `.` and `./hpke` only,
//      so a seam that lives solely in `crypto/hpke-noble.ts` is one no
//      consumer can import. These tests reach it the way an adapter would.

import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

import { x25519, ed25519 } from "@noble/curves/ed25519.js";

import { hpke, sign } from "../dist/index.js";
import {
  authEncap,
  authDecap,
  authEncapWithKeyAgreement,
  authDecapWithKeyAgreement,
  sealWithKeyAgreement,
} from "../dist/crypto/hpke-noble.js";

const enc = new TextEncoder();
const EMPTY = new Uint8Array(0);

const vec = JSON.parse(
  readFileSync(fileURLToPath(new URL("./fixtures/cfrg-auth-x25519-chacha.json", import.meta.url)), "utf8"),
).vectors[0];

const fromHex = (s) => Uint8Array.from(s.match(/../g), (b) => parseInt(b, 16));
const toHex = (u) => Array.from(u, (b) => b.toString(16).padStart(2, "0")).join("");

/** The trivial capability: a raw key, wrapped. Equivalence is measured against
 *  this, because it is the one backend whose answers are known to be right. */
const rawKeyAgreement = (sk) => ({
  publicKey: x25519.getPublicKey(sk),
  agree: async (peerPk) => x25519.getSharedSecret(sk, peerPk),
});

const rawSigningKey = (sk) => ({
  publicKey: ed25519.getPublicKey(sk),
  sign: async (message) => ed25519.sign(message, sk),
});

function keys() {
  const senderSk = x25519.utils.randomSecretKey();
  const recipientSk = x25519.utils.randomSecretKey();
  return {
    senderSk,
    senderPk: x25519.getPublicKey(senderSk),
    recipientSk,
    recipientPk: x25519.getPublicKey(recipientSk),
  };
}

// ── 1. Equivalence with the raw-key path ──

test("AuthEncap via a capability is byte-identical to authEncap", async () => {
  const k = keys();
  const fixed = { __unsafeFixedEphemeralSk: x25519.utils.randomSecretKey() };

  const raw = authEncap(k.recipientPk, k.senderSk, fixed);
  const viaCapability = await authEncapWithKeyAgreement(k.recipientPk, rawKeyAgreement(k.senderSk), fixed);

  assert.equal(toHex(viaCapability.enc), toHex(raw.enc));
  assert.equal(toHex(viaCapability.sharedSecret), toHex(raw.sharedSecret));
});

test("AuthDecap via a capability is byte-identical to authDecap", async () => {
  const k = keys();
  const { enc: encapped } = authEncap(k.recipientPk, k.senderSk);

  const raw = authDecap(encapped, k.recipientSk, k.senderPk);
  const viaCapability = await authDecapWithKeyAgreement(encapped, rawKeyAgreement(k.recipientSk), k.senderPk);

  assert.equal(toHex(viaCapability), toHex(raw));
});

test("the capability path reproduces the CFRG vector's enc, shared_secret and ciphertext", async () => {
  const fixed = { __unsafeFixedEphemeralSk: fromHex(vec.skEm) };

  const encapped = await authEncapWithKeyAgreement(fromHex(vec.pkRm), rawKeyAgreement(fromHex(vec.skSm)), fixed);
  assert.equal(toHex(encapped.enc), vec.enc);
  assert.equal(toHex(encapped.sharedSecret), vec.shared_secret);

  const decapped = await authDecapWithKeyAgreement(
    fromHex(vec.enc),
    rawKeyAgreement(fromHex(vec.skRm)),
    fromHex(vec.pkSm),
  );
  assert.equal(toHex(decapped), vec.shared_secret);

  const e0 = vec.encryptions[0];
  const sealed = await sealWithKeyAgreement(
    fromHex(e0.pt),
    fromHex(e0.aad),
    rawKeyAgreement(fromHex(vec.skSm)),
    fromHex(vec.pkRm),
    fromHex(vec.info),
    fixed,
  );
  assert.equal(toHex(sealed.enc), vec.enc);
  assert.equal(toHex(sealed.ciphertext), e0.ct);
});

// ── 2. The guards the raw path gets from `dh()` and noble ──

test("an all-zero DH is refused, exactly as the raw path refuses a low-order key", async () => {
  const k = keys();
  const zeroMessage = /all-zero shared secret/;

  // The raw path never reaches the zero check for this input — noble rejects
  // the low-order point first — but it does refuse, and that is the behaviour
  // the capability path has to match rather than diverge from.
  assert.throws(() => authEncap(new Uint8Array(32), k.senderSk));
  assert.throws(() => authDecap(new Uint8Array(32), k.recipientSk, k.senderPk));

  const zeroAgreement = (pk) => ({ publicKey: pk, agree: async () => new Uint8Array(32) });

  await assert.rejects(
    () => authEncapWithKeyAgreement(k.recipientPk, zeroAgreement(k.senderPk)),
    zeroMessage,
  );
  await assert.rejects(
    () => authDecapWithKeyAgreement(new Uint8Array(32), zeroAgreement(k.recipientPk), k.senderPk),
    zeroMessage,
  );
});

test("a wrong-length agree() is refused rather than reshaping the KEM input", async () => {
  const k = keys();
  const shortAgreement = {
    publicKey: k.senderPk,
    agree: async () => new Uint8Array(16).fill(7),
  };

  await assert.rejects(
    () => authEncapWithKeyAgreement(k.recipientPk, shortAgreement),
    /returned 16 bytes, expected 32/,
  );
  await assert.rejects(
    () => authDecapWithKeyAgreement(new Uint8Array(32), { ...shortAgreement, publicKey: k.recipientPk }, k.senderPk),
    /returned 16 bytes, expected 32/,
  );
});

test("a wrong-length publicKey is refused — it goes into kem_context verbatim", async () => {
  const k = keys();
  const badPk = { publicKey: EMPTY, agree: async (peerPk) => x25519.getSharedSecret(k.senderSk, peerPk) };

  await assert.rejects(
    () => authEncapWithKeyAgreement(k.recipientPk, badPk),
    /publicKey is 0 bytes, expected 32/,
  );
  await assert.rejects(
    () => authDecapWithKeyAgreement(new Uint8Array(32), badPk, k.senderPk),
    /publicKey is 0 bytes, expected 32/,
  );
});

// ── 3. Reachable from the package's public surface ──

test("hpke.sealWithKeyAgreement / openWithKeyAgreement round-trip, and interop with the raw path", async () => {
  const k = keys();
  const pt = enc.encode("Hello from custody that does not export keys");
  const info = enc.encode("-E envelope stand-in");

  assert.equal(typeof hpke.sealWithKeyAgreement, "function");
  assert.equal(typeof hpke.openWithKeyAgreement, "function");

  // Sealed through a capability, opened with a raw key: proves the wire bytes
  // are the same protocol, not merely a self-consistent second one.
  const sealed = await hpke.sealWithKeyAgreement(pt, EMPTY, rawKeyAgreement(k.senderSk), k.recipientPk, info);
  assert.equal(sealed.enc.length, hpke.ENC_LEN);
  assert.equal(toHex(await hpke.open(sealed.ciphertext, EMPTY, sealed.enc, k.recipientSk, k.senderPk, info)), toHex(pt));

  // And the mirror: sealed raw, opened through a capability.
  const rawSealed = await hpke.seal(pt, EMPTY, k.senderSk, k.recipientPk, info);
  const opened = await hpke.openWithKeyAgreement(
    rawSealed.ciphertext,
    EMPTY,
    rawSealed.enc,
    rawKeyAgreement(k.recipientSk),
    k.senderPk,
    info,
  );
  assert.equal(toHex(opened), toHex(pt));
});

test("openWithKeyAgreement still rejects a tampered ciphertext", async () => {
  const k = keys();
  const info = enc.encode("info");
  const sealed = await hpke.seal(enc.encode("secret"), EMPTY, k.senderSk, k.recipientPk, info);
  sealed.ciphertext[0] ^= 0xff;

  await assert.rejects(() =>
    hpke.openWithKeyAgreement(sealed.ciphertext, EMPTY, sealed.enc, rawKeyAgreement(k.recipientSk), k.senderPk, info),
  );
});

// ── SigningKey ──

test("signWithSigningKey matches sign() for the same key", async () => {
  const sk = ed25519.utils.randomSecretKey();
  const data = enc.encode("outer frame bytes");

  const viaCapability = await sign.signWithSigningKey(data, rawSigningKey(sk));
  assert.equal(toHex(viaCapability), toHex(sign.sign(data, sk)));
  assert.equal(sign.verify(data, viaCapability, sign.ed25519PublicKey(sk)), true);
});

test("an oracle signing under a different key is caught locally, not by every recipient", async () => {
  const data = enc.encode("outer frame bytes");
  const wrongKey = ed25519.utils.randomSecretKey();
  const mismatched = {
    publicKey: ed25519.getPublicKey(ed25519.utils.randomSecretKey()),
    sign: async (message) => ed25519.sign(message, wrongKey),
  };

  await assert.rejects(() => sign.signWithSigningKey(data, mismatched), /does not verify under its own publicKey/);
});

test("a wrong-length signature is refused", async () => {
  const sk = ed25519.utils.randomSecretKey();
  const truncating = {
    publicKey: ed25519.getPublicKey(sk),
    sign: async (message) => ed25519.sign(message, sk).slice(0, 32),
  };

  await assert.rejects(
    () => sign.signWithSigningKey(enc.encode("x"), truncating),
    /returned 32 bytes, expected 64/,
  );
});
