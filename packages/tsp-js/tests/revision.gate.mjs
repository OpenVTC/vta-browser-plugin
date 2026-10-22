import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

import { pack, unpack, peekRevision, isRevisionError, isTsp } from "../dist/index.js";
import { decodePayloadFrame, encodePayloadFrame } from "../dist/v1/payload.js";
import { encodeFields } from "../dist/v1/envelope.js";
import { ed25519, x25519 } from "@noble/curves/ed25519.js";

const enc = new TextEncoder();
const dec = new TextDecoder();
const b64u = (s) => new Uint8Array(Buffer.from(s, "base64url"));

const VECTORS = JSON.parse(
  readFileSync(new URL("./fixtures/spec-v1-vectors.json", import.meta.url), "utf8"),
);

// Draft-revision messages, every one of which 1.0 refuses on MAJOR.
//
// Rev 2 (`YTSP-AAB`, 0.1): packed by affinidi-tsp 0.1.x with fixed keys,
// alice.example → bob.example. This package read it until 1.0.
const REV2 = new Uint8Array(
  Buffer.from(
    "f8401361348ff80001e010076469643a7765623a616c6963652e6578616d706c65e8100700006469643a7765623a626f622e6578616d706c655c0000e0601a5795132915e698a115677334d13dd7154f717eda8791473ccbb360671313f40544e2ae9153559a01d6aa33b93261dd0ab610231bad47e059d0eaa46038cf872ba82a282a431fd391e10f4d3c0603f82016f8a016d0100d308cdcf413984d884ff81ac2308da9d3afc9a0601e9393f664d54f9c37892897e996a0c8949ca8afa643ed39f888312094f6c34c55a1f4c3c0032f969cb707",
    "hex",
  ),
);

// Rev 3 (`YTSP-AAC`, 0.2): Appendix A's `direct-hpke-base` as the merged Rev 3
// specification printed it (spec commit f5b8668). Same published keys as the
// 1.0 fixture, and an ESSR sender field of `4BAA` that 1.0 would refuse anyway.
const REV3_AAC = b64u(
  "-EBFYTSP-AAC4BATZGlkOnBlZXI6NHpRbVVMNjFOYzFGN2lvaUt4SE5xd25KWFg0c3JoRnNLS1BvNlRyQ21oTTNkZnBx4BATZGlkOnBlZXI6NHpRbVptQ0FzRzdqMWV3VGpYanRkZHd1amlrMzNDRTJjTWJZU1BhZ3BNaVludDFB4FAa1T4oA1pSbehBiIwnoXFGA24kgHowT34VdE95wF9qjStBsok4fIkbu8IKODF2nsZMUAmS5BqxDbbYrvl_TNFj6rHuLymWkvlrkt54-cOq-CAX-KAWBADw48mquyWI0O40nsbcI7jRugSJko0JMZR-4S07YFJq3Mzy6jvAkEsDGAecW9jCUVDdwZScckWUaAzSSGbNunMN",
);

// The same message as the pre-merge Rev 3 drafts printed it (spec commit
// 66a1580), `YTSP-ABA`: MINOR 64 under the MAJOR.MINOR reading.
const REV3_ABA = b64u(
  "-EBFYTSP-ABA4BATZGlkOnBlZXI6NHpRbVVMNjFOYzFGN2lvaUt4SE5xd25KWFg0c3JoRnNLS1BvNlRyQ21oTTNkZnBx4BATZGlkOnBlZXI6NHpRbVptQ0FzRzdqMWV3VGpYanRkZHd1amlrMzNDRTJjTWJZU1BhZ3BNaVludDFB4FAa1T4oA1pSbehBiIwnoXFGA24kgHowT34VdE95wF9qjStBsok4fIkbu8IKODF2nsZMUAmS5BqxDbbYrvl_TNGpz2omwJgYX4bSYoTeKse4-CAX-KAWBADHuTmj_7jyUCkkalySPOFiy5pTbNtjEODiwwJZlI5DqMk5Wutx4LIOWkAAa3uee2b_0Kh5SXaFq65MedyO5VYJ",
);

const V1 = b64u(VECTORS.vectors["direct-hpke-base"].message);
const v1Keys = {
  receiverDecryptionKey: b64u(VECTORS.identifiers.bob.skE),
  senderSigningKey: b64u(VECTORS.identifiers.alice.pkS),
};

const party = (vid) => {
  const sk = ed25519.utils.randomSecretKey();
  const xsk = ed25519.utils.toMontgomerySecret(sk);
  return { vid, sk, pk: ed25519.getPublicKey(sk), xsk, xpk: x25519.getPublicKey(xsk) };
};

// ── peekRevision: the keyless version gate ──

test("peekRevision reads 1.0 from the version marker alone", () => {
  const peeked = peekRevision(V1);
  assert.deepEqual([peeked.major, peeked.minor, peeked.recognised], [1, 0, true]);
});

test("peekRevision refuses what is not a TSP frame, with a matchable code", () => {
  for (const junk of [enc.encode('{"protected":"..."}'), enc.encode("eyJhbGciOiJ"), new Uint8Array(0)]) {
    assert.throws(
      () => peekRevision(junk),
      (err) => isRevisionError(err) && err.code === "E_TSP_REVISION",
    );
  }
});

test("every pre-1.0 draft is refused on MAJOR, named, before a key is touched", async () => {
  // MAJOR is the only component that gates processability (§9.1). The drafts
  // are MAJOR 0; refusing them here, keyless, is what keeps a Rev 3 frame from
  // being read under 1.0's payload rule — or a Rev 2 one from dying at the
  // ciphertext selector with an error about crypto.
  for (const [frame, minor, name] of [
    [REV2, 1, "Rev 2 (YTSP-AAB)"],
    [REV3_AAC, 2, "Rev 3 (YTSP-AAC)"],
    [REV3_ABA, 64, "Rev 3 pre-merge draft (YTSP-ABA)"],
  ]) {
    const isDraft = (err) =>
      isRevisionError(err) &&
      err.major === 0 &&
      err.minor === minor &&
      err.message.includes(name) &&
      err.message.includes("TSP 1.0 (YTSP-BAA)");
    assert.throws(() => peekRevision(frame), isDraft, name);
    // Keys that would open the message are not enough: the gate comes first.
    await assert.rejects(() => unpack(frame, v1Keys), isDraft, name);
  }
});

test("a MAJOR from the future is refused the same way", () => {
  const frame = Uint8Array.from(V1);
  frame[7] = 0x20; // version count code: MAJOR 1 → 2
  assert.throws(
    () => peekRevision(frame),
    (err) => isRevisionError(err) && err.major === 2,
  );
});

test("an unrecognised MINOR at MAJOR 1 is carried, not refused", () => {
  // A future `YTSP-BAB` must not be refused — §9.1 makes MINOR a field no
  // implementation may reject on, and the reference discards it entirely.
  const frame = Uint8Array.from(V1);
  frame[8] = 0x0d; // MINOR 0 → 13, a value nothing has ever shipped
  const peeked = peekRevision(frame);
  assert.deepEqual([peeked.major, peeked.minor], [1, 13]);
  assert.equal(peeked.recognised, false, "unrecognised, but not refused");
});

// ── The 1.0 payload rule ──

test("a confidential payload whose ESSR sender is the NULL VID is refused", () => {
  // Rev 3 let HPKE-Base write `4BAA` there; 1.0 requires the sender's VID in
  // every confidential payload (§3.2, §3.7 step 7). Every payload this package
  // reads is confidential. Checked at the payload decoder because nothing here
  // packs the NULL form — which is itself the send-side half of the rule.
  const fields = encodeFields("did:web:alice", "did:web:bob");
  const nulled = encodePayloadFrame(enc.encode("x"), "direct", [], "").frame;
  assert.throws(() => decodePayloadFrame(nulled, "did:web:alice", fields), /NULL VID/);

  const named = encodePayloadFrame(enc.encode("x"), "direct", [], "did:web:alice").frame;
  assert.equal(dec.decode(decodePayloadFrame(named, "did:web:alice", fields).body), "x");
  assert.throws(
    () => decodePayloadFrame(named, "did:web:mallory", fields),
    /does not match the envelope sender/,
  );
});

// ── pack ──

test("what we pack is 1.0, and it round-trips", async () => {
  const alice = party("did:web:alice");
  const bob = party("did:web:bob");
  const packed = await pack(enc.encode("hello"), alice.vid, bob.vid, {
    senderSigningKey: alice.sk,
    receiverEncryptionKey: bob.xpk,
  });
  const peeked = peekRevision(packed.bytes);
  assert.deepEqual([peeked.major, peeked.minor], [1, 0], "we emit YTSP-BAA");
  const out = await unpack(packed.bytes, {
    receiverDecryptionKey: bob.xsk,
    senderSigningKey: alice.pk,
  });
  assert.equal(dec.decode(out.payload), "hello");
});

// ── The long-framed path ──

test("a message past ~12 KB is long-framed, and still peeks and round-trips", async () => {
  // Rev 2 could never produce this: its `-E` count covered only the header.
  // Since Rev 3 the count covers the ciphertext, so a large message leads with
  // 0xFB and its count is a six-byte long form — the exact header whose decode
  // used to fold the identifier bits into the length.
  const alice = party("did:web:alice");
  const bob = party("did:web:bob");
  const body = new Uint8Array(20_000).map((_, i) => (i * 31 + 7) & 0xff);

  const packed = await pack(body, alice.vid, bob.vid, {
    senderSigningKey: alice.sk,
    receiverEncryptionKey: bob.xpk,
  });

  assert.equal(packed.bytes[0], 0xfb, "long -E framing");
  assert.equal(isTsp(packed.bytes), true, "an 0xF8-only classifier would drop this");
  assert.equal(peekRevision(packed.bytes).major, 1, "the version is at offset 6, not 3");

  const out = await unpack(packed.bytes, {
    receiverDecryptionKey: bob.xsk,
    senderSigningKey: alice.pk,
  });
  assert.deepEqual(out.payload, body);
});
