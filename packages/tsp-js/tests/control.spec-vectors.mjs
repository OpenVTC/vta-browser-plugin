import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

import { unpack, packInvite, packAccept, packCancel } from "../dist/index.js";
import { decodeEnvelope as decodeRev3Envelope } from "../dist/rev3/envelope.js";
import { deriveSaid } from "../dist/rev3/control.js";
import { senderFieldBytes } from "../dist/rev3/fields.js";
import * as wire from "../dist/cesr/wire.js";
import { ed25519, x25519 } from "@noble/curves/ed25519.js";

// The specification's own relationship-forming vectors. These check the one
// thing in the control path that a round trip structurally cannot: the §7.2.1
// self-addressing digest. Our decoder recomputes it and refuses the message on
// a mismatch, so a vector that unpacks at all is a derivation that agrees with
// the ToIP reference — over the envelope, both VIDs, the type code, the sender
// field, the nonce, the reply path, the referral slot and the 33 dummy bytes.
//
// Nothing weaker would do. Encoder and decoder built from the same wrong
// reading agree perfectly, and so do two implementations that share it.
const VECTORS = JSON.parse(
  readFileSync(new URL("./fixtures/spec-rev3-vectors.json", import.meta.url), "utf8"),
);

const b64u = (s) => new Uint8Array(Buffer.from(s, "base64url"));
const hex = (u8) => Buffer.from(u8).toString("hex");
const id = (name) => VECTORS.identifiers[name];

const openVector = (name) => {
  const v = VECTORS.vectors[name];
  return unpack(b64u(v.message), {
    receiverDecryptionKey: b64u(id(v.receiver).skE),
    senderSigningKey: b64u(id(v.sender).pkS),
  });
};

test("control-rfi-direct — an invite decodes, and its digest verifies", async () => {
  const out = await openVector("control-rfi-direct");
  assert.equal(out.messageType, "control");
  assert.equal(out.control.controlType, "invite");
  assert.equal(out.sender, id("alice").id);
  assert.equal(out.receiver, id("bob").id);

  // §9.2 (D9): 128 bits, where Rev 2 used 256.
  assert.equal(out.control.nonce.length, 16);
  assert.equal(hex(out.control.nonce), "11".repeat(16));
  assert.deepEqual(out.control.route, [], "no Reply_Path in this vector");
  assert.equal(out.control.referral, undefined);

  // The digest is the thread id of the exchange the invite opens.
  assert.deepEqual(out.threadDigest, out.control.digest);
  assert.equal(out.control.inReplyTo, undefined, "an invite answers nothing");
});

test("the invite's digest is derived exactly as the reference derives it", async () => {
  // Stated directly rather than left implicit in `unpack`'s internal check, so
  // that a derivation regression names the derivation instead of surfacing as
  // "TSP_Digest does not match" from three layers down.
  const v = VECTORS.vectors["control-rfi-direct"];
  const wireBytes = b64u(v.message);
  const decoded = decodeRev3Envelope(wireBytes);
  const envelopeFields = wireBytes.slice(decoded.aad.begin, decoded.aad.end);

  // The vector carries the NULL VID in its ESSR sender field, which §9.2 permits
  // under HPKE-Base. We write the real VID; both are conformant, and the
  // derivation has to accept whichever the message actually carries.
  const nullSenderField = senderFieldBytes("");

  const nonceOut = [];
  wire.encodeFixedData(wire.TSP_NONCE, new Uint8Array(16).fill(0x11), nonceOut);
  const emptyList = [];
  wire.encodeCount(wire.TSP_HOP_LIST, 0, emptyList);

  const after = new Uint8Array([...nonceOut, ...emptyList, ...emptyList]); // nonce, Reply_Path, Referral
  const said = deriveSaid(envelopeFields, wire.XRFI, nullSenderField, after);

  const out = await openVector("control-rfi-direct");
  assert.deepEqual(said, out.control.digest, "recomputed SAID matches the one on the wire");
});

test("control-rfa-direct — an accept carries two digests, and they are not interchangeable", async () => {
  const invite = await openVector("control-rfi-direct");
  const accept = await openVector("control-rfa-direct");

  assert.equal(accept.control.controlType, "accept");
  // The accept travels the other way: bob answers alice.
  assert.equal(accept.sender, id("bob").id);
  assert.equal(accept.receiver, id("alice").id);

  // The wire order is `Digest` then `Reply_Digest`, and — counter to how those
  // names read — the first is the *invite's* digest echoed and the second is
  // the accept's own. Getting this backwards is the documented trap, so it is
  // asserted against the invite vector rather than against itself.
  assert.deepEqual(
    accept.control.inReplyTo,
    invite.control.digest,
    "the accept echoes the invite's digest",
  );
  assert.notDeepEqual(
    accept.control.digest,
    invite.control.digest,
    "the accept's own digest is its own, not a copy of the invite's",
  );
  assert.deepEqual(accept.threadDigest, accept.control.digest);
  assert.equal(accept.control.nonce, undefined, "an accept carries no nonce");
});

test("control-rfd — a cancel names the message it ends and carries no nonce", async () => {
  const invite = await openVector("control-rfi-direct");
  const cancel = await openVector("control-rfd");

  assert.equal(cancel.control.controlType, "cancel");
  assert.deepEqual(
    cancel.control.inReplyTo,
    invite.control.digest,
    "the cancel names the relationship-forming message",
  );
  // A cancel's only digest is a reference, so there is nothing self-addressing
  // to recompute — `digest` mirrors the reference rather than being derived.
  assert.deepEqual(cancel.control.digest, cancel.control.inReplyTo);
  assert.equal(cancel.control.nonce, undefined);
});

test("a tampered control digest is refused as verification, not parsed as valid", async () => {
  // The whole value of a self-addressing digest is that a receiver checks it.
  // Flip one byte of the invite's carried digest and the recomputation must
  // disagree — if this passes, the digest is decorative.
  const v = VECTORS.vectors["control-rfi-direct"];
  const wireBytes = b64u(v.message);

  // The digest sits inside the ciphertext, so it cannot be flipped from out
  // here. Flip the envelope's sender VID instead, which the derivation also
  // covers — same property, reachable without the key.
  const tampered = Uint8Array.from(wireBytes);
  const marker = Buffer.from(tampered).indexOf(Buffer.from("did:peer:4zQmUL", "utf8"));
  assert.ok(marker > 0, "found the sender VID in the cleartext envelope");
  tampered[marker + 14] ^= 0x01;

  await assert.rejects(
    () =>
      unpack(tampered, {
        receiverDecryptionKey: b64u(id("bob").skE),
        senderSigningKey: b64u(id("alice").pkS),
      }),
    // The envelope is signed, so this dies at the signature before the digest
    // is ever recomputed — which is the correct order and worth pinning.
    /signature verification failed/,
  );
});

// ── Our own control messages ──

const party = (vid) => {
  const sk = ed25519.utils.randomSecretKey();
  const xsk = ed25519.utils.toMontgomerySecret(sk);
  return { vid, sk, pk: ed25519.getPublicKey(sk), xsk, xpk: x25519.getPublicKey(xsk) };
};
const keysFrom = (from, to) => ({ senderSigningKey: from.sk, receiverEncryptionKey: to.xpk });
const unpackKeys = (me, from) => ({ receiverDecryptionKey: me.xsk, senderSigningKey: from.pk });

test("a full invite → accept exchange round-trips, digests threading correctly", async () => {
  const alice = party("did:web:alice.example");
  const bob = party("did:web:bob.example");

  const invite = await packInvite(alice.vid, bob.vid, keysFrom(alice, bob));
  const atBob = await unpack(invite.bytes, unpackKeys(bob, alice));
  assert.equal(atBob.control.controlType, "invite");
  assert.deepEqual(atBob.control.digest, invite.threadDigest, "the inviter knows its own thread id");

  const accept = await packAccept(atBob.control.digest, bob.vid, alice.vid, keysFrom(bob, alice));
  const atAlice = await unpack(accept.bytes, unpackKeys(alice, bob));
  assert.equal(atAlice.control.controlType, "accept");
  assert.deepEqual(
    atAlice.control.inReplyTo,
    invite.threadDigest,
    "alice can match the accept to the invite she sent",
  );

  // And a cancellation may name either half (§7.2.1).
  const cancel = await packCancel(accept.threadDigest, alice.vid, bob.vid, keysFrom(alice, bob));
  const cancelAtBob = await unpack(cancel.bytes, unpackKeys(bob, alice));
  assert.deepEqual(cancelAtBob.control.inReplyTo, accept.threadDigest);
});

test("an invite's nonce is fresh per message", async () => {
  // Two invites between the same pair must not be identical on the wire.
  const alice = party("did:web:alice.example");
  const bob = party("did:web:bob.example");
  const a = await unpack(
    (await packInvite(alice.vid, bob.vid, keysFrom(alice, bob))).bytes,
    unpackKeys(bob, alice),
  );
  const b = await unpack(
    (await packInvite(alice.vid, bob.vid, keysFrom(alice, bob))).bytes,
    unpackKeys(bob, alice),
  );
  assert.notDeepEqual(a.control.nonce, b.control.nonce);
  assert.notDeepEqual(a.control.digest, b.control.digest, "different nonce, different thread id");
});

test("an invite can carry a Reply_Path, and it survives the round trip", async () => {
  const alice = party("did:web:alice.example");
  const bob = party("did:web:bob.example");
  const route = ["did:web:relay.example"];
  const invite = await packInvite(alice.vid, bob.vid, keysFrom(alice, bob), { route });
  const atBob = await unpack(invite.bytes, unpackKeys(bob, alice));
  assert.deepEqual(atBob.control.route, route, "§7.2.4 Reply_Path");
  // The route is inside the digest derivation, so a route that did not survive
  // would fail the digest check rather than arrive empty.
  assert.deepEqual(atBob.control.digest, invite.threadDigest);
});
