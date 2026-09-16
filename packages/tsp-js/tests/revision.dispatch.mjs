import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

import { pack, unpack, peekRevision, isRevisionError, isTsp } from "../dist/index.js";
import { ed25519, x25519 } from "@noble/curves/ed25519.js";

const enc = new TextEncoder();
const dec = new TextDecoder();
const b64u = (s) => new Uint8Array(Buffer.from(s, "base64url"));

const VECTORS = JSON.parse(
  readFileSync(new URL("./fixtures/spec-rev3-vectors.json", import.meta.url), "utf8"),
);

// The Rev 2 golden message from `interop.rust-vector.mjs`: packed by
// affinidi-tsp 0.1.x with fixed keys, alice.example → bob.example.
const REV2 = {
  wire: new Uint8Array(
    Buffer.from(
      "f8401361348ff80001e010076469643a7765623a616c6963652e6578616d706c65e8100700006469643a7765623a626f622e6578616d706c655c0000e0601a5795132915e698a115677334d13dd7154f717eda8791473ccbb360671313f40544e2ae9153559a01d6aa33b93261dd0ab610231bad47e059d0eaa46038cf872ba82a282a431fd391e10f4d3c0603f82016f8a016d0100d308cdcf413984d884ff81ac2308da9d3afc9a0601e9393f664d54f9c37892897e996a0c8949ca8afa643ed39f888312094f6c34c55a1f4c3c0032f969cb707",
      "hex",
    ),
  ),
  senderEncryptionKey: new Uint8Array(
    Buffer.from("0faa684ed28867b97f4a6a2dee5df8ce974e76b7018e3f22a1c4cf2678570f20", "hex"),
  ),
  senderSigningKey: new Uint8Array(
    Buffer.from("d04ab232742bb4ab3a1368bd4615e4e6d0224ab71a016baf8520a332c9778737", "hex"),
  ),
  receiverDecryptionKey: new Uint8Array(
    Buffer.from("3333333333333333333333333333333333333333333333333333333333333333", "hex"),
  ),
};

const party = (vid) => {
  const sk = ed25519.utils.randomSecretKey();
  const xsk = ed25519.utils.toMontgomerySecret(sk);
  return { vid, sk, pk: ed25519.getPublicKey(sk), xsk, xpk: x25519.getPublicKey(xsk) };
};

// ── peekRevision: the keyless discriminator ──

test("peekRevision reads Rev 2 and Rev 3 from the version marker alone", () => {
  assert.equal(peekRevision(REV2.wire).revision, "rev2");
  assert.equal(peekRevision(REV2.wire).minor, 1);
  assert.equal(peekRevision(b64u(VECTORS.vectors["direct-hpke-base"].message)).revision, "rev3");
});

test("peekRevision refuses what is not a TSP frame, with a matchable code", () => {
  for (const junk of [enc.encode('{"protected":"..."}'), enc.encode("eyJhbGciOiJ"), new Uint8Array(0)]) {
    assert.throws(
      () => peekRevision(junk),
      (err) => isRevisionError(err) && err.code === "E_TSP_REVISION",
    );
  }
});

test("peekRevision refuses an unknown MAJOR and carries it on the error", () => {
  // MAJOR is the only component that gates processability (§9.1), so this is
  // the one version check that is allowed to refuse a message.
  const frame = Uint8Array.from(REV2.wire);
  frame[7] = 0x10; // version count code: MAJOR 0 → 1
  assert.throws(
    () => peekRevision(frame),
    (err) => isRevisionError(err) && err.major === 1,
  );
});

test("an unrecognised MINOR at MAJOR 0 still reads as Rev 3", () => {
  // Rev 2 is the only MINOR matched exactly; everything else at MAJOR 0 is
  // current-generation. A future `YTSP-AAD` must not be refused — §9.1 makes
  // MINOR a field no implementation may reject on, and the reference discards
  // it entirely.
  const frame = Uint8Array.from(b64u(VECTORS.vectors["direct-hpke-base"].message));
  frame[8] = 0x0d; // MINOR 2 → 13, a value nothing has ever shipped
  const peeked = peekRevision(frame);
  assert.equal(peeked.revision, "rev3");
  assert.equal(peeked.recognised, false, "unrecognised, but not refused");
});

// ── unpack: dispatch ──

test("unpack routes a Rev 2 message to the Rev 2 reader and says so", async () => {
  const out = await unpack(REV2.wire, {
    receiverDecryptionKey: REV2.receiverDecryptionKey,
    senderEncryptionKey: REV2.senderEncryptionKey,
    senderSigningKey: REV2.senderSigningKey,
  });
  assert.equal(out.revision, "rev2");
  assert.equal(dec.decode(out.payload), "hello from rust tsp");
  assert.equal(out.sender, "did:web:alice.example");
});

test("a Rev 2 message without the sender's X25519 key is refused by name", async () => {
  // HPKE-Auth puts the sender's static key in the KEM, so this is not "we could
  // not verify the sender" — the message cannot be *opened* at all. Saying that
  // beats an AEAD failure, which reads like tampering.
  await assert.rejects(
    () =>
      unpack(REV2.wire, {
        receiverDecryptionKey: REV2.receiverDecryptionKey,
        senderSigningKey: REV2.senderSigningKey,
      }),
    (err) => isRevisionError(err) && /Rev 2/.test(err.message),
  );
});

test("a pre-merge `YTSP-ABA` message still reads as Rev 3, and opens", async () => {
  // Appendix A's `direct-hpke-base` as it stood before the specification merged
  // (spec commit 66a1580), when the vectors carried `ABA` — MINOR 64 under the
  // MAJOR.MINOR reading. The merged vectors moved to `AAC`, so this is pinned
  // here: messages packed against the draft exist, and MINOR must never gate
  // processing. Same published keys as the current fixture.
  const aba = b64u(
    "-EBFYTSP-ABA4BATZGlkOnBlZXI6NHpRbVVMNjFOYzFGN2lvaUt4SE5xd25KWFg0c3JoRnNLS1BvNlRyQ21oTTNkZnBx4BATZGlkOnBlZXI6NHpRbVptQ0FzRzdqMWV3VGpYanRkZHd1amlrMzNDRTJjTWJZU1BhZ3BNaVludDFB4FAa1T4oA1pSbehBiIwnoXFGA24kgHowT34VdE95wF9qjStBsok4fIkbu8IKODF2nsZMUAmS5BqxDbbYrvl_TNGpz2omwJgYX4bSYoTeKse4-CAX-KAWBADHuTmj_7jyUCkkalySPOFiy5pTbNtjEODiwwJZlI5DqMk5Wutx4LIOWkAAa3uee2b_0Kh5SXaFq65MedyO5VYJ",
  );
  const peeked = peekRevision(aba);
  assert.equal(peeked.revision, "rev3");
  assert.equal(peeked.minor, 64);
  assert.equal(peeked.recognised, true);
  const out = await unpack(aba, {
    receiverDecryptionKey: b64u(VECTORS.identifiers.bob.skE),
    senderSigningKey: b64u(VECTORS.identifiers.alice.pkS),
  });
  assert.equal(out.revision, "rev3");
  assert.equal(dec.decode(out.payload), "hello world");
});

test("a Rev 3 message needs no sender encryption key at all", async () => {
  // The clearest statement that HPKE-Base moved sender authenticity out of the
  // KEM: the key Rev 2 could not open a message without is simply not passed.
  const out = await unpack(b64u(VECTORS.vectors["direct-hpke-base"].message), {
    receiverDecryptionKey: b64u(VECTORS.identifiers.bob.skE),
    senderSigningKey: b64u(VECTORS.identifiers.alice.pkS),
  });
  assert.equal(out.revision, "rev3");
  assert.equal(dec.decode(out.payload), "hello world");
});

test("what we pack is Rev 3, and it round-trips as Rev 3", async () => {
  const alice = party("did:web:alice");
  const bob = party("did:web:bob");
  const packed = await pack(enc.encode("hello"), alice.vid, bob.vid, {
    senderSigningKey: alice.sk,
    receiverEncryptionKey: bob.xpk,
  });
  assert.equal(peekRevision(packed.bytes).minor, 2, "we emit YTSP-AAC");
  const out = await unpack(packed.bytes, {
    receiverDecryptionKey: bob.xsk,
    senderSigningKey: alice.pk,
  });
  assert.equal(out.revision, "rev3");
  assert.equal(dec.decode(out.payload), "hello");
});

// ── The long-framed path ──

test("a message past ~12 KB is long-framed, and still peeks and round-trips", async () => {
  // This is the case Rev 2 could never produce: its `-E` count covered only the
  // header. Rev 3's covers the ciphertext, so a large message leads with 0xFB
  // and its count is a six-byte long form — the exact header whose decode used
  // to fold the identifier bits into the length.
  const alice = party("did:web:alice");
  const bob = party("did:web:bob");
  const body = new Uint8Array(20_000).map((_, i) => (i * 31 + 7) & 0xff);

  const packed = await pack(body, alice.vid, bob.vid, {
    senderSigningKey: alice.sk,
    receiverEncryptionKey: bob.xpk,
  });

  assert.equal(packed.bytes[0], 0xfb, "long -E framing");
  assert.equal(isTsp(packed.bytes), true, "an 0xF8-only classifier would drop this");
  assert.equal(peekRevision(packed.bytes).revision, "rev3", "the version is at offset 6, not 3");

  const out = await unpack(packed.bytes, {
    receiverDecryptionKey: bob.xsk,
    senderSigningKey: alice.pk,
  });
  assert.deepEqual(out.payload, body);
});
