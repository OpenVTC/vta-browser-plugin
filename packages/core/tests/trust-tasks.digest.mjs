import { test } from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";

import {
  decodeDigestMultibase,
  decodeMultibase,
  matchCodeFromDigest,
  MATCH_CODE_LEN,
  DigestMultibaseError,
} from "../dist/trust-tasks/digest.js";
import { base58btcEncode } from "../dist/trust-tasks/canonical.js";

// The exact fixture the VTA pins in `vta-mobile-core::consent` (OpenVTC/
// verifiable-trust-infrastructure#911). Both approver surfaces must derive the
// same six characters from it, so this value is the contract between the two
// repositories — not an arbitrary example.
const VTA_FIXTURE = "zQmSK9pGKFnmc77pqyNAPJyPKt8rMqctngfg3vwuMArwGYZ";
const VTA_FIXTURE_HEX = "3b0c7f1d9e2a5648c1f30b7ae4d2986153ca0f7b8d41e6295af03c8bd71e4a62";

function multihash(digestBytes) {
  return Uint8Array.from([0x12, 0x20, ...digestBytes]);
}

function digestMultibase(input) {
  return "z" + base58btcEncode(multihash(createHash("sha256").update(input).digest()));
}

test("the shared fixture decodes to the digest the VTA hex-encoded before 0.4", () => {
  assert.equal(Buffer.from(decodeDigestMultibase(VTA_FIXTURE)).toString("hex"), VTA_FIXTURE_HEX);
});

test("the match code comes from the digest bytes, not the encoding", () => {
  const code = matchCodeFromDigest(VTA_FIXTURE);
  // Character-for-character what vta-mobile-core asserts.
  assert.equal(code, "3b0c7f");
  assert.equal(code.length, MATCH_CODE_LEN);
  assert.ok(!code.startsWith("zQm"), `derived from the encoding, not the bytes: ${code}`);
});

test("the code is unchanged from what this surface rendered under bare hex", () => {
  // The property that lets the two repositories cut over without the human
  // noticing: hex(digest)[..6] either way.
  assert.equal(matchCodeFromDigest(VTA_FIXTURE), VTA_FIXTURE_HEX.slice(0, MATCH_CODE_LEN));
});

test("every sha2-256 digestMultibase shares the constant zQm prefix", () => {
  // The regression the decode exists to prevent. If this ever fails, slicing
  // the encoded string became safe and this module could be simplified — far
  // more likely, the encoding changed and the match code needs rechecking.
  for (let i = 0; i < 16; i++) {
    assert.ok(digestMultibase(`payload-${i}`).startsWith("zQm"));
  }
});

test("distinct payloads yield distinct match codes", () => {
  const codes = new Set();
  for (let i = 0; i < 64; i++) codes.add(matchCodeFromDigest(digestMultibase(`payload-${i}`)));
  assert.equal(codes.size, 64, `codes collided: ${[...codes].join(", ")}`);
});

test("a bare hex digest is refused", () => {
  // What the wire carried before the migration. It must fail here rather than
  // on the executor, which would reject a decision the human already approved.
  assert.throws(() => matchCodeFromDigest(VTA_FIXTURE_HEX), DigestMultibaseError);
});

test("a digest that is not a sha2-256 multihash is refused", () => {
  // Right encoding, wrong multihash code (0x13 is sha2-512).
  const wrong = "z" + base58btcEncode(Uint8Array.from([0x13, 0x20, ...new Uint8Array(32)]));
  assert.throws(() => matchCodeFromDigest(wrong), DigestMultibaseError);
  // Right multihash code, truncated body.
  const short = "z" + base58btcEncode(Uint8Array.from([0x12, 0x20, 1, 2, 3]));
  assert.throws(() => matchCodeFromDigest(short), DigestMultibaseError);
});

test("an unsupported multibase prefix is refused rather than guessed", () => {
  // `x` is not in the framework's `^[zumbfF]` set. Inferring base58 from
  // context is exactly what multibase exists to stop.
  assert.throws(() => decodeMultibase("xQmSK9pGKFn"), DigestMultibaseError);
  assert.throws(() => decodeMultibase(""), DigestMultibaseError);
  assert.throws(() => decodeMultibase("z"), DigestMultibaseError);
});

test("the other bases the framework permits decode to the same bytes", () => {
  // base58btc is what the VTA emits, but the specification permits these and a
  // conforming digest from another executor must not be rejected.
  const bytes = multihash(createHash("sha256").update("payload-0").digest());
  const b64u = Buffer.from(bytes).toString("base64url");
  const b64 = Buffer.from(bytes).toString("base64").replace(/=+$/, "");
  const hex = Buffer.from(bytes).toString("hex");
  const expected = Buffer.from(bytes).toString("hex");

  for (const encoded of [`u${b64u}`, `m${b64}`, `f${hex}`, `F${hex.toUpperCase()}`]) {
    assert.equal(
      Buffer.from(decodeMultibase(encoded)).toString("hex"),
      expected,
      `failed for ${encoded[0]}`,
    );
  }
  // …and all of them produce the one match code the human compares.
  const code = matchCodeFromDigest(`u${b64u}`);
  assert.equal(matchCodeFromDigest(`f${hex}`), code);
  assert.equal(matchCodeFromDigest(digestMultibase("payload-0")), code);
});
