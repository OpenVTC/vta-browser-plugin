import { test } from "node:test";
import assert from "node:assert/strict";

import { hpke, sign } from "../dist/index.js";
import { ed25519, x25519 } from "@noble/curves/ed25519.js";

const enc = new TextEncoder();
const EMPTY = new Uint8Array(0);

// ── Ed25519 (mirrors affinidi-tsp src/crypto/signing.rs tests) ──

test("sign/verify round-trips", () => {
  const sk = ed25519.utils.randomSecretKey();
  const pk = sign.ed25519PublicKey(sk);
  const data = enc.encode("test message for TSP signing");
  const sig = sign.sign(data, sk);
  assert.equal(sig.length, 64);
  assert.equal(sign.verify(data, sig, pk), true);
});

test("wrong key fails to verify", () => {
  const sk = ed25519.utils.randomSecretKey();
  const wrongPk = sign.ed25519PublicKey(ed25519.utils.randomSecretKey());
  const sig = sign.sign(enc.encode("test"), sk);
  assert.equal(sign.verify(enc.encode("test"), sig, wrongPk), false);
});

test("tampered data fails to verify", () => {
  const sk = ed25519.utils.randomSecretKey();
  const pk = sign.ed25519PublicKey(sk);
  const sig = sign.sign(enc.encode("original"), sk);
  assert.equal(sign.verify(enc.encode("tampered"), sig, pk), false);
});

// ── HPKE-Auth (mirrors affinidi-tsp src/crypto/hpke.rs tests) ──

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

test("hpke seal/open round-trips (ciphertext = pt + 16 tag, enc = 32)", async () => {
  const k = keys();
  const pt = enc.encode("Hello, TSP!");
  const aad = enc.encode("envelope-data");
  const info = enc.encode("TSP-v1");

  const sealed = await hpke.seal(pt, aad, k.senderSk, k.recipientPk, info);
  assert.equal(sealed.ciphertext.length, pt.length + 16);
  assert.equal(sealed.enc.length, 32);

  const opened = await hpke.open(sealed.ciphertext, aad, sealed.enc, k.recipientSk, k.senderPk, info);
  assert.deepEqual(opened, pt);
});

test("hpke wrong recipient key fails", async () => {
  const k = keys();
  const wrongSk = x25519.utils.randomSecretKey();
  const sealed = await hpke.seal(enc.encode("secret"), EMPTY, k.senderSk, k.recipientPk, EMPTY);
  await assert.rejects(
    hpke.open(sealed.ciphertext, EMPTY, sealed.enc, wrongSk, k.senderPk, EMPTY),
  );
});

test("hpke wrong sender key fails (auth mode)", async () => {
  const k = keys();
  const wrongPk = x25519.getPublicKey(x25519.utils.randomSecretKey());
  const sealed = await hpke.seal(enc.encode("secret"), EMPTY, k.senderSk, k.recipientPk, EMPTY);
  await assert.rejects(
    hpke.open(sealed.ciphertext, EMPTY, sealed.enc, k.recipientSk, wrongPk, EMPTY),
  );
});

test("hpke tampered aad fails", async () => {
  const k = keys();
  const sealed = await hpke.seal(enc.encode("secret"), enc.encode("original-aad"), k.senderSk, k.recipientPk, EMPTY);
  await assert.rejects(
    hpke.open(sealed.ciphertext, enc.encode("tampered-aad"), sealed.enc, k.recipientSk, k.senderPk, EMPTY),
  );
});

test("hpke tampered ciphertext fails", async () => {
  const k = keys();
  const sealed = await hpke.seal(enc.encode("secret"), EMPTY, k.senderSk, k.recipientPk, EMPTY);
  sealed.ciphertext[0] ^= 0xff;
  await assert.rejects(
    hpke.open(sealed.ciphertext, EMPTY, sealed.enc, k.recipientSk, k.senderPk, EMPTY),
  );
});

test("hpke empty plaintext -> ciphertext is just the 16-byte tag", async () => {
  const k = keys();
  const info = enc.encode("info");
  const sealed = await hpke.seal(EMPTY, EMPTY, k.senderSk, k.recipientPk, info);
  assert.equal(sealed.ciphertext.length, 16);
  const opened = await hpke.open(sealed.ciphertext, EMPTY, sealed.enc, k.recipientSk, k.senderPk, info);
  assert.equal(opened.length, 0);
});

test("hpke different info fails to open (info binding)", async () => {
  const k = keys();
  const sealed = await hpke.seal(enc.encode("x"), EMPTY, k.senderSk, k.recipientPk, enc.encode("info-a"));
  await assert.rejects(
    hpke.open(sealed.ciphertext, EMPTY, sealed.enc, k.recipientSk, k.senderPk, enc.encode("info-b")),
  );
});
