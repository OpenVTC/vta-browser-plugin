// Smoke tests for `packages/core/src/provision/` — CRC24 spot-checks and a
// hand-built armor block end-to-end. Does NOT exercise HPKE / CBOR open
// because that requires a Rust-generated bundle; the wallet-side integration
// test (M2C-C) covers that path end-to-end against a real VTA.
//
// Run with: `node --test packages/core/tests/provision.smoke.mjs`
// (Node 20+. Imports compiled output from `packages/core/dist/`.)

import { test } from "node:test";
import assert from "node:assert/strict";

import { crc24, crc24ToBytes, decodeArmor, buildChunkAad } from "../dist/provision/index.js";

// CRC24 init value is 0xB704CE. Empty input → no bytes XOR'd → result = init.
test("crc24: empty input returns init", () => {
  assert.equal(crc24(new Uint8Array()), 0xb704ce);
});

// Cross-check against canonical Rust impl at vta-sdk/src/sealed_transfer/armor.rs.
// Reference values produced by running the same algorithm in Rust:
//   crc24([0x00]) = 0x6169d3
//   crc24([0xff]) = 0xbceceb
test("crc24: pinned values match the Rust reference", () => {
  assert.equal(crc24(new Uint8Array([0x00])), 0x61_69d3);
  assert.equal(crc24(new Uint8Array([0xff])), 0xbc_eceb);
});

test("crc24ToBytes: round-trips back through MSB-first decode", () => {
  const crc = 0x12_3456;
  const bytes = crc24ToBytes(crc);
  assert.equal(bytes.length, 3);
  const back = (bytes[0] << 16) | (bytes[1] << 8) | bytes[2];
  assert.equal(back, crc);
});

// Hand-build a minimal armor block (no real HPKE — we're testing the framing
// only). The body is 16 raw bytes base64-encoded; the CRC line is the
// base64-encoded crc24 of those raw bytes.
function buildArmorBlock(rawPayload, bundleIdHex) {
  // STANDARD base64 (with padding) — matches the Rust armor encoder.
  const b64 = Buffer.from(rawPayload).toString("base64");
  const crc = crc24(new Uint8Array(rawPayload));
  const crcBytes = crc24ToBytes(crc);
  const crcB64 = Buffer.from(crcBytes).toString("base64");
  return [
    "-----BEGIN VTA SEALED BUNDLE-----",
    "Version: 1",
    `Bundle-Id: ${bundleIdHex}`,
    "Chunk: 1/1",
    "Digest-Algo: sha256",
    "",
    b64,
    `=${crcB64}`,
    "-----END VTA SEALED BUNDLE-----",
    "",
  ].join("\n");
}

test("decodeArmor: valid single-chunk block round-trips", () => {
  const raw = new Uint8Array([1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15, 16]);
  const bundleIdHex = "0102030405060708090a0b0c0d0e0f10";
  const armored = buildArmorBlock(raw, bundleIdHex);

  const bundles = decodeArmor(armored);
  assert.equal(bundles.length, 1);
  const b = bundles[0];
  assert.equal(b.digestAlgo, "sha256");
  assert.equal(b.chunks.length, 1);
  assert.deepEqual(Array.from(b.bundleId), [
    0x01, 0x02, 0x03, 0x04, 0x05, 0x06, 0x07, 0x08, 0x09, 0x0a, 0x0b, 0x0c, 0x0d, 0x0e, 0x0f, 0x10,
  ]);
  assert.equal(b.chunks[0].chunkIndex, 0);
  assert.equal(b.chunks[0].totalChunks, 1);
  assert.deepEqual(Array.from(b.chunks[0].sealedBytes), Array.from(raw));
});

test("decodeArmor: CRC mismatch is rejected", () => {
  const raw = new Uint8Array([1, 2, 3, 4]);
  const armored = buildArmorBlock(raw, "00000000000000000000000000000000");
  // Flip the CRC line. Find `=` at column 0 and corrupt its base64.
  const lines = armored.split("\n");
  const crcLineIdx = lines.findIndex((l) => l.startsWith("="));
  // Toggle one base64 char of the CRC payload.
  const orig = lines[crcLineIdx];
  lines[crcLineIdx] = orig[0] + (orig[1] === "A" ? "B" : "A") + orig.slice(2);
  const corrupted = lines.join("\n");
  assert.throws(() => decodeArmor(corrupted), /CRC24 mismatch/);
});

test("decodeArmor: unknown header is rejected (forward-compat hazard)", () => {
  const raw = new Uint8Array([42]);
  const ok = buildArmorBlock(raw, "00000000000000000000000000000000");
  const bad = ok.replace("Version: 1\n", "Version: 1\nX-Trust-Me: yes\n");
  assert.throws(() => decodeArmor(bad), /unknown header/);
});

test("decodeArmor: unsupported version is rejected", () => {
  const raw = new Uint8Array([42]);
  const ok = buildArmorBlock(raw, "00000000000000000000000000000000");
  const bad = ok.replace("Version: 1", "Version: 2");
  assert.throws(() => decodeArmor(bad), /unsupported version/);
});

test("decodeArmor: missing Bundle-Id is rejected", () => {
  const raw = new Uint8Array([42]);
  const ok = buildArmorBlock(raw, "00000000000000000000000000000000");
  const bad = ok.replace(/Bundle-Id:[^\n]+\n/, "");
  assert.throws(() => decodeArmor(bad), /missing Bundle-Id/);
});

test("buildChunkAad: stable serialisation matches Rust ChunkPlaintext::aad", () => {
  // Reference value computed manually from the Rust serialisation:
  //   version(1)=0x01, bundle_id(16)=0x00..0x0f, chunk_index_be(2)=0x00_05,
  //   total_chunks_be(2)=0x00_2a, algo_len(1)=0x06, algo="sha256"=0x73,0x68,0x61,0x32,0x35,0x36
  const bundleId = new Uint8Array([
    0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15,
  ]);
  const aad = buildChunkAad({
    version: 1,
    bundleId,
    chunkIndex: 5,
    totalChunks: 42,
    digestAlgo: "sha256",
  });
  const expected = [
    0x01,
    0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15,
    0x00, 0x05,
    0x00, 0x2a,
    0x06,
    0x73, 0x68, 0x61, 0x32, 0x35, 0x36,
  ];
  assert.deepEqual(Array.from(aad), expected);
});
