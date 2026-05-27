// Regression test for ciborium-flavoured byte fields. ciborium emits
// `Vec<u8>` and `[u8; N]` through serde's `serialize_seq` /
// `serialize_tuple`, producing CBOR arrays of integers (major type 4)
// rather than CBOR byte strings (major type 2). cbor-x decodes major
// type 4 to a JS `Array<number>`, not `Uint8Array`.
//
// The wallet's decoder MUST handle both shapes — the canonical
// array-of-integers shape that the deployed VTA emits today, and the
// future byte-string shape if Rust types ever grow
// `#[serde(with = "serde_bytes")]` annotations. This test exercises
// the array-of-integers path end-to-end through `decodeHpkeSealed`-
// equivalent paths to catch a regression if the helper ever changes.

import { test } from "node:test";
import assert from "node:assert/strict";

import { Encoder } from "cbor-x";

import { openBundle } from "../dist/index.js";

// We can't easily round-trip the full HPKE bundle without a Rust-side
// fixture, but we CAN verify that an "HpkeSealed" CBOR encoded as
// arrays-of-ints (the ciborium wire shape) decodes correctly into the
// pipeline. The decoder will fail at HPKE-open later (we're feeding
// garbage bytes), but the byte-extraction step we just hardened must
// succeed BEFORE that failure mode.

test("decoder accepts ciborium-style array-of-u8 for kem_encap + aead_ciphertext", async () => {
  // Build a synthetic sealed-bytes payload encoded the way ciborium
  // would emit it: HpkeSealed is a CBOR map whose `kem_encap` value
  // is a CBOR array of 32 small integers, and `aead_ciphertext` is a
  // CBOR array of bytes.
  const encoder = new Encoder({ mapsAsObjects: true });
  const kemEncap = Array.from({ length: 32 }, (_, i) => i);
  const aeadCiphertext = Array.from({ length: 64 }, (_, i) => i & 0xff);
  const sealedBytes = encoder.encode({
    kem_encap: kemEncap,
    aead_ciphertext: aeadCiphertext,
  });

  // Build a minimal SealedBundle with that as the chunk's sealed_bytes.
  // openBundle reaches into the HPKE open which will fail (garbage
  // ciphertext + wrong recipient secret), but the failure mode MUST be
  // an HPKE/AEAD error — NOT "kem_encap missing or not bytes". If the
  // decoder regresses, the error would surface from `asBytes` instead.
  const bundle = {
    bundleId: new Uint8Array(16),
    digestAlgo: "sha256",
    chunks: [{ chunkIndex: 0, totalChunks: 1, sealedBytes }],
  };
  const fakeSecret = new Uint8Array(32); // bogus but well-shaped

  await assert.rejects(
    openBundle(bundle, fakeSecret),
    (err) => {
      // The new decoder must extract kem_encap successfully and let HPKE
      // fail downstream. Any "HpkeSealed.kem_encap" error means the
      // decoder regressed to rejecting array-of-int form.
      assert.ok(
        !String(err.message).includes("HpkeSealed.kem_encap"),
        `decoder regressed: ${err.message}`,
      );
      return true;
    },
  );
});

test("decoder also accepts CBOR byte-string form (forward-compat)", async () => {
  // Same as above but using CBOR byte strings (cbor-x's Encoder
  // produces these for Uint8Array input). This is the wire shape
  // we'd see if the Rust types gained `#[serde(with = "serde_bytes")]`
  // annotations — the decoder must still accept it.
  const encoder = new Encoder({ mapsAsObjects: true });
  const sealedBytes = encoder.encode({
    kem_encap: new Uint8Array(32),
    aead_ciphertext: new Uint8Array(64),
  });

  const bundle = {
    bundleId: new Uint8Array(16),
    digestAlgo: "sha256",
    chunks: [{ chunkIndex: 0, totalChunks: 1, sealedBytes }],
  };
  const fakeSecret = new Uint8Array(32);

  await assert.rejects(
    openBundle(bundle, fakeSecret),
    (err) => {
      assert.ok(
        !String(err.message).includes("HpkeSealed.kem_encap"),
        `decoder regressed: ${err.message}`,
      );
      return true;
    },
  );
});

test("decoder rejects non-byte values with a clear field-named error", async () => {
  const encoder = new Encoder({ mapsAsObjects: true });
  const sealedBytes = encoder.encode({
    kem_encap: "not bytes",
    aead_ciphertext: new Uint8Array(8),
  });

  const bundle = {
    bundleId: new Uint8Array(16),
    digestAlgo: "sha256",
    chunks: [{ chunkIndex: 0, totalChunks: 1, sealedBytes }],
  };
  const fakeSecret = new Uint8Array(32);

  await assert.rejects(openBundle(bundle, fakeSecret), /HpkeSealed\.kem_encap/);
});
