import { test } from "node:test";
import assert from "node:assert/strict";

// hpke-js is a dev-dependency kept for exactly this file: it holds the shipped
// @noble implementation byte-identical to an independent RFC 9180
// implementation on every CI run. It needs WebCrypto, which Node has — the
// shipped code path never uses it.
import { CipherSuite, DhkemX25519HkdfSha256, HkdfSha256 } from "@hpke/core";
import { Chacha20Poly1305 } from "@hpke/chacha20poly1305";

import { hpke } from "../dist/index.js";
import { x25519 } from "@noble/curves/ed25519.js";

const enc = new TextEncoder();
const EMPTY = new Uint8Array(0);

const suite = () =>
  new CipherSuite({
    kem: new DhkemX25519HkdfSha256(),
    kdf: new HkdfSha256(),
    aead: new Chacha20Poly1305(),
  });

const ab = (u8) => u8.buffer.slice(u8.byteOffset, u8.byteOffset + u8.byteLength);

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

test("hpke-js opens what @noble seals", async () => {
  const k = keys();
  const pt = enc.encode("sealed by noble, opened by hpke-js");
  const info = enc.encode("tsp-equivalence-info");

  const sealed = await hpke.seal(pt, EMPTY, k.senderSk, k.recipientPk, info);

  const s = suite();
  const recipientKey = await s.kem.importKey("raw", ab(k.recipientSk), false);
  const senderPublicKey = await s.kem.importKey("raw", ab(k.senderPk), true);
  const recipient = await s.createRecipientContext({
    recipientKey,
    enc: ab(sealed.enc),
    senderPublicKey,
    info: ab(info),
  });
  const opened = new Uint8Array(await recipient.open(ab(sealed.ciphertext), ab(EMPTY)));
  assert.deepEqual(opened, pt);
});

test("@noble opens what hpke-js seals", async () => {
  const k = keys();
  const pt = enc.encode("sealed by hpke-js, opened by noble");
  const info = enc.encode("tsp-equivalence-info");

  const s = suite();
  const senderKey = await s.kem.importKey("raw", ab(k.senderSk), false);
  const recipientPublicKey = await s.kem.importKey("raw", ab(k.recipientPk), true);
  const sender = await s.createSenderContext({ recipientPublicKey, senderKey, info: ab(info) });
  const ciphertext = new Uint8Array(await sender.seal(ab(pt), ab(EMPTY)));

  const opened = await hpke.open(ciphertext, EMPTY, new Uint8Array(sender.enc), k.recipientSk, k.senderPk, info);
  assert.deepEqual(opened, pt);
});

// Base mode — the suite `@openvtc/pnm-core` uses for VTA sealed bundles. Same
// KEM/KDF/AEAD as auth mode, so a mistake in the shared key schedule would
// show up here too; the mode byte is what these two tests pin independently.

test("hpke-js opens what @noble seals (base mode)", async () => {
  const k = keys();
  const pt = enc.encode("base-mode: sealed by noble, opened by hpke-js");
  const info = enc.encode("vta-sealed-transfer/v1");
  const aad = enc.encode("chunk-header-aad");

  const sealed = await hpke.sealBase(pt, aad, k.recipientPk, info);

  const s = suite();
  const recipientKey = await s.kem.importKey("raw", ab(k.recipientSk), false);
  const recipient = await s.createRecipientContext({
    recipientKey,
    enc: ab(sealed.enc),
    info: ab(info),
  });
  const opened = new Uint8Array(await recipient.open(ab(sealed.ciphertext), ab(aad)));
  assert.deepEqual(opened, pt);
});

test("@noble opens what hpke-js seals (base mode)", async () => {
  const k = keys();
  const pt = enc.encode("base-mode: sealed by hpke-js, opened by noble");
  const info = enc.encode("vta-sealed-transfer/v1");
  const aad = enc.encode("chunk-header-aad");

  const s = suite();
  const recipientPublicKey = await s.kem.importKey("raw", ab(k.recipientPk), true);
  const sender = await s.createSenderContext({ recipientPublicKey, info: ab(info) });
  const ciphertext = new Uint8Array(await sender.seal(ab(pt), ab(aad)));

  const opened = await hpke.openBase(ciphertext, aad, new Uint8Array(sender.enc), k.recipientSk, info);
  assert.deepEqual(opened, pt);
});

test("base mode and auth mode are not interchangeable", async () => {
  const k = keys();
  const pt = enc.encode("mode separation");
  const info = enc.encode("same-info-both-modes");

  // Same suite, same keys, same info — only the mode byte differs, so opening
  // one with the other must fail the AEAD tag rather than return plaintext.
  const sealed = await hpke.sealBase(pt, EMPTY, k.recipientPk, info);
  await assert.rejects(() => hpke.open(sealed.ciphertext, EMPTY, sealed.enc, k.recipientSk, k.senderPk, info));
});
