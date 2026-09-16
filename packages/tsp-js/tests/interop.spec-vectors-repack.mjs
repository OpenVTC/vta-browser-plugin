import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

import { decodeEnvelope, unpack } from "../dist/index.js";
import * as wire from "../dist/cesr/wire.js";
import { deriveKeyPair } from "../dist/crypto/hpke-noble.js";
import { decodeDigest, decodeNonce, decodeVidList } from "../dist/rev3/fields.js";
import {
  __unsafeDeterministicPack,
  __unsafeDeterministicPackAccept,
  __unsafeDeterministicPackCancel,
  __unsafeDeterministicPackInvite,
  __unsafeDeterministicPackNested,
  __unsafeDeterministicPackRouted,
} from "../dist/unsafe-testing.js";

// ── Re-packing the specification's Appendix A vectors byte for byte ──
//
// `interop.spec-vectors.mjs` proves we can *read* the published messages. This
// proves we *write* them: given the vector's keys, its `ikmE` and the fields its
// printed payload spells out, the packer emits exactly the published bytes. It
// is the stronger claim — a reader tolerates whatever it tolerates, whereas an
// exact writer has had to agree with the reference on every code, count, field
// order, AAD boundary, signature input and HPKE-Base derivation.
//
// Ed25519 is deterministic, so the only randomness is the HPKE ephemeral and the
// invite nonce. Both come from the vector here, through the test-only
// `./unsafe-testing` subpath, whose fixed ephemeral must never be used outside a
// test (see that module).
//
// Every input is derived from the vector, never hard-coded: the NULL-vs-present
// ESSR sender field and the padding from the printed `payload`, the nonce and
// digests and the inner message of a nesting from that same payload.
//
// Of the ten vectors, six are HPKE-Base and all six re-pack. The other four
// cannot, for reasons that are about what this package packs, not about the
// vectors — named below rather than silently skipped.

const VECTORS = JSON.parse(
  readFileSync(new URL("./fixtures/spec-rev3-vectors.json", import.meta.url), "utf8"),
);

const b64u = (s) => new Uint8Array(Buffer.from(s, "base64url"));
const qb64 = (u8) => Buffer.from(u8).toString("base64url");
const id = (name) => VECTORS.identifiers[name];
const eq = (a, b) => a.length === b.length && a.every((x, i) => x === b[i]);

/**
 * Read the printed payload frame far enough to recover what a packer has to be
 * told: the type code, whether the ESSR sender field is the NULL VID, the
 * type-specific fields, and the padding. Parsed with the wire primitives rather
 * than `decodePayloadFrame`, so a mis-reading there cannot hide one here.
 */
function readPrintedPayload(printed) {
  const frame = b64u(printed);
  const cur = { pos: 0 };
  const quadlets = wire.decodeCount(wire.TSP_PAYLOAD, frame, cur);
  assert.equal(cur.pos + quadlets * 3, frame.length, "the -Z count covers the printed payload");
  const typeCode = frame.slice(cur.pos, cur.pos + 3);
  cur.pos += 3;
  const sender = new TextDecoder().decode(wire.decodeVariableData(wire.TSP_VID, frame, cur));
  const out = { sender };
  const padding = () => wire.decodeVariableData(wire.TSP_PLAINTEXT, frame, cur);

  if (eq(typeCode, wire.XSCS)) {
    out.type = "scs";
    out.padding = padding();
    const streamQuadlets = wire.decodeCount(wire.TSP_GENERIC_STREAM, frame, cur);
    assert.equal(cur.pos + streamQuadlets * 3, frame.length);
    out.body = wire.decodeVariableData(wire.TSP_PLAINTEXT, frame, cur);
  } else if (eq(typeCode, wire.XHOP)) {
    out.type = "hop";
    out.hops = decodeVidList(frame, cur);
    out.padding = padding();
    out.inner = frame.slice(cur.pos);
  } else if (eq(typeCode, wire.XRFI)) {
    out.type = "rfi";
    out.digest = decodeDigest(frame, cur);
    out.nonce = decodeNonce(frame, cur);
    out.replyPath = decodeVidList(frame, cur);
    out.referralQuadlets = wire.decodeCount(wire.TSP_HOP_LIST, frame, cur);
    cur.pos += out.referralQuadlets * 3;
    out.padding = padding();
  } else if (eq(typeCode, wire.XRFA)) {
    out.type = "rfa";
    out.digest = decodeDigest(frame, cur);
    out.replyDigest = decodeDigest(frame, cur);
    out.padding = padding();
  } else if (eq(typeCode, wire.XRFD)) {
    out.type = "rfd";
    out.digest = decodeDigest(frame, cur);
    out.padding = padding();
  } else {
    throw new Error("unexpected type code in a printed payload");
  }
  if (out.type !== "scs" && out.type !== "hop") {
    assert.equal(cur.pos, frame.length, "nothing follows the padding field");
  }
  return out;
}

/** Re-pack one vector from its own material; returns the qb2 bytes. */
async function repack(name) {
  const v = VECTORS.vectors[name];
  const sender = id(v.sender);
  const receiver = id(v.receiver);
  const p = readPrintedPayload(v.payload);

  // The two fields this packer has fixed behaviour for. Neither is a guess: if
  // a vector used either differently, re-packing it would be a different claim
  // and this says so instead of producing bytes that merely fail to match.
  assert.equal(p.padding.length, 0, `${name}: the packer writes an empty padding field`);
  assert.ok(p.sender === "" || p.sender === sender.id, `${name}: ESSR sender is NULL or the sender`);

  const keys = { senderSigningKey: b64u(sender.skS), receiverEncryptionKey: b64u(receiver.pkE) };
  const unsafe = { __unsafeIkmE: b64u(v.ikmE), nullPayloadSender: p.sender === "" };

  switch (p.type) {
    case "scs":
      return (await __unsafeDeterministicPack(p.body, sender.id, receiver.id, keys, unsafe)).bytes;
    case "rfi": {
      assert.equal(p.referralQuadlets, 0, `${name}: referrals are decode-only here`);
      const packed = await __unsafeDeterministicPackInvite(
        sender.id,
        receiver.id,
        keys,
        { route: p.replyPath, nonce: p.nonce },
        unsafe,
      );
      assert.deepEqual(packed.threadDigest, p.digest, `${name}: the SAID we derive is the printed one`);
      return packed.bytes;
    }
    case "rfa": {
      const packed = await __unsafeDeterministicPackAccept(p.digest, sender.id, receiver.id, keys, unsafe);
      assert.deepEqual(packed.threadDigest, p.replyDigest, `${name}: the Reply_Digest we derive is the printed one`);
      return packed.bytes;
    }
    case "rfd":
      return (await __unsafeDeterministicPackCancel(p.digest, sender.id, receiver.id, keys, unsafe)).bytes;
    case "hop":
      return p.hops.length === 0
        ? (await __unsafeDeterministicPackNested(p.inner, sender.id, receiver.id, keys, unsafe)).bytes
        : (await __unsafeDeterministicPackRouted(p.inner, p.hops, sender.id, receiver.id, keys, unsafe)).bytes;
    default:
      throw new Error(`no packer for ${p.type}`);
  }
}

const REPACKED = [
  "direct-hpke-base",
  "control-rfi-direct",
  "control-rfa-direct",
  "control-rfd",
  "nested-direct",
  "routed",
];

for (const name of REPACKED) {
  test(`${name} — re-packs byte for byte from its published ikmE`, async () => {
    const v = VECTORS.vectors[name];
    const got = await repack(name);
    // Compare in the text domain the specification prints, so a failure names
    // the qb64 offset a reader can find in Appendix A; then in qb2, the bytes on
    // the wire.
    assert.equal(qb64(got), v.message);
    assert.deepEqual(got, b64u(v.message));
  });
}

test("each vector's ikmE derives the pkEm it publishes, and that key is in the message", () => {
  for (const name of REPACKED) {
    const v = VECTORS.vectors[name];
    const { pk } = deriveKeyPair(b64u(v.ikmE));
    assert.equal(qb64(pk), v.pkEm, `${name}: DeriveKeyPair(ikmE)`);
    assert.ok(Buffer.from(b64u(v.message)).includes(Buffer.from(pk)), `${name}: enc leads the F field`);
  }
});

test("DeriveKeyPair reproduces the CFRG RFC 9180 vector's skEm and pkEm", () => {
  const cfrg = JSON.parse(
    readFileSync(new URL("./fixtures/cfrg-auth-x25519-chacha.json", import.meta.url), "utf8"),
  ).vectors[0];
  const hex = (u8) => Buffer.from(u8).toString("hex");
  const { sk, pk } = deriveKeyPair(new Uint8Array(Buffer.from(cfrg.ikmE, "hex")));
  assert.equal(hex(sk), cfrg.skEm);
  assert.equal(hex(pk), cfrg.pkEm);
});

test("the re-packed nested and routed vectors carry the published inner message, which also opens", async () => {
  // The inner message is opaque to the outer packer, so re-packing it proves
  // nothing about it. Opening it closes that gap: it is the vectors' own
  // direct message between the nested identities, and it must verify too.
  for (const name of ["nested-direct", "routed"]) {
    const v = VECTORS.vectors[name];
    const outer = await unpack(b64u(v.message), {
      receiverDecryptionKey: b64u(id(v.receiver).skE),
      senderSigningKey: b64u(id(v.sender).pkS),
    });
    assert.deepEqual(outer.payload, readPrintedPayload(v.payload).inner, `${name}: inner as printed`);

    const { envelope } = decodeEnvelope(outer.payload);
    const party = (vid) => Object.values(VECTORS.identifiers).find((i) => i.id === vid);
    const inner = await unpack(outer.payload, {
      receiverDecryptionKey: b64u(party(envelope.receiver).skE),
      senderSigningKey: b64u(party(envelope.sender).pkS),
    });
    assert.deepEqual(inner.payload, readPrintedPayload(v.innerPayload).body, `${name}: inner body`);
  }
});

test("a pack without the unsafe material is not deterministic — the hook is the only way in", async () => {
  const { pack } = await import("../dist/index.js");
  const v = VECTORS.vectors["direct-hpke-base"];
  const keys = { senderSigningKey: b64u(id("alice").skS), receiverEncryptionKey: b64u(id("bob").pkE) };
  const body = new TextEncoder().encode("hello world");
  const a = await pack(body, id("alice").id, id("bob").id, keys);
  const b = await pack(body, id("alice").id, id("bob").id, keys);
  assert.notDeepEqual(a.bytes, b.bytes, "a fresh ephemeral per message");
  assert.notEqual(qb64(a.bytes), v.message);
  await assert.rejects(
    () => __unsafeDeterministicPack(body, id("alice").id, id("bob").id, keys, {}),
    /__unsafeIkmE/,
    "an unsafe packer without its ikmE refuses rather than falling back to random",
  );
});

test("vectors that cannot be re-packed here are named, with the reason", () => {
  const notRepacked = {
    // The packer has no sealed box (§8.3) — it cannot even open one.
    "direct-sealed-box": "libsodium sealed box (§8.3): not implemented",
    "control-rfi-sealed-box": "libsodium sealed box (§8.3): not implemented",
    // Deterministic anyway (no encryption), but there is no packer that emits
    // an unencrypted `-E` frame; every pack here is HPKE-Base.
    "direct-signed-only": "no signed-only packer",
    // The hybrid KEM draws its own encapsulation randomness and the vector
    // publishes no ephemeral material; nor does this package pack ML-KEM/ML-DSA.
    "direct-hpke-base-pq": "ML-KEM-768/X25519 + ML-DSA-65: not implemented, and no published ephemeral",
  };
  assert.deepEqual(
    new Set([...REPACKED, ...Object.keys(notRepacked)]),
    new Set(Object.keys(VECTORS.vectors)),
    "every published vector is either re-packed or named",
  );
  for (const name of Object.keys(notRepacked)) assert.equal(VECTORS.vectors[name].ikmE, undefined, name);
});
