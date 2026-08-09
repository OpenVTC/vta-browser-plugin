// `digestMultibase` — decoding, and the human-checkable match code derived from
// it.
//
// Trust Tasks 0.4 moved `payloadDigest` to the shared `DigestMultibase` type: a
// multibase-encoded multihash matching `^[zumbfF][A-Za-z0-9+/=_-]+$`. The
// registry is explicit that "a bare hex string or a `sha-256:`-style prefix
// hard-codes one algorithm into the wire contract and is non-conforming". The
// change was landed errata-style, **in place** on `task-consent/{request,
// decision,granted}/0.1` — the type URI did not move, so no version check
// anywhere can detect it. The encoding is the only signal.
//
// The VTA side is `vta_policy::consent::encode_digest_multibase` and
// `vta_mobile_core::consent::match_code_from_digest` (OpenVTC/
// verifiable-trust-infrastructure#911). This file must agree with both: the
// first decides what arrives on the wire, the second decides what the *other*
// approver surface shows the human. A match code that disagrees with the mobile
// approver's is worse than no match code, because both screens still render six
// plausible characters and the mismatch reads as a forgery rather than a bug.

import { base32nopad, base64nopad, base64urlnopad } from "@scure/base";
import { base58btcDecode } from "./canonical.js";

/**
 * Multihash prefix for SHA-256 with a 32-byte digest: code `0x12`, length
 * `0x20`. Carried in-band so the value is self-describing and the wire format
 * survives an algorithm change without a schema revision.
 */
const MULTIHASH_SHA2_256_32 = Uint8Array.of(0x12, 0x20);

/** Thrown when a `payloadDigest` is not a well-formed sha2-256 digestMultibase. */
export class DigestMultibaseError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "DigestMultibaseError";
  }
}

function hexDecode(s: string): Uint8Array {
  if (s.length % 2 !== 0) throw new DigestMultibaseError("base16 digest has an odd length");
  const out = new Uint8Array(s.length / 2);
  for (let i = 0; i < out.length; i++) {
    const byte = Number.parseInt(s.slice(i * 2, i * 2 + 2), 16);
    if (Number.isNaN(byte)) throw new DigestMultibaseError("base16 digest has a non-hex character");
    out[i] = byte;
  }
  return out;
}

/**
 * Decode a multibase string to its raw bytes.
 *
 * Covers exactly the prefixes the framework's `DigestMultibase` pattern admits.
 * base58btc (`z`) is what the VTA emits and what `did:key` / `did:webvh` use;
 * the rest are permitted by the specification, so rejecting them would refuse a
 * conforming digest. Anything else is refused rather than guessed at — the
 * whole point of multibase is that a verifier never infers the base from
 * context.
 */
export function decodeMultibase(value: string): Uint8Array {
  const prefix = value[0];
  const body = value.slice(1);
  if (!prefix || !body) throw new DigestMultibaseError("digest is empty");
  try {
    switch (prefix) {
      case "z":
        return base58btcDecode(body);
      // Padding is stripped before decoding: the framework's pattern admits `=`,
      // while the canonical multibase codes for `u`/`m` are the unpadded ones.
      case "u":
        return base64urlnopad.decode(body.replace(/=+$/, ""));
      case "m":
        return base64nopad.decode(body.replace(/=+$/, ""));
      case "b":
        return base32nopad.decode(body.replace(/=+$/, "").toUpperCase());
      case "f":
      case "F":
        return hexDecode(body.toLowerCase());
      default:
        throw new DigestMultibaseError(`unsupported multibase prefix: ${prefix}`);
    }
  } catch (e) {
    if (e instanceof DigestMultibaseError) throw e;
    throw new DigestMultibaseError(
      `digest is not valid multibase: ${e instanceof Error ? e.message : String(e)}`,
    );
  }
}

/**
 * The raw 32 SHA-256 bytes inside a `digestMultibase`, with the multihash
 * prefix stripped.
 *
 * Throws on a bare hex digest — the pre-0.4 wire form. That is deliberate: a
 * stale digest must fail here, on the surface that would otherwise render a
 * match code for a decision the executor could never match.
 */
export function decodeDigestMultibase(payloadDigest: string): Uint8Array {
  const bytes = decodeMultibase(payloadDigest);
  if (
    bytes.length < MULTIHASH_SHA2_256_32.length ||
    bytes[0] !== MULTIHASH_SHA2_256_32[0] ||
    bytes[1] !== MULTIHASH_SHA2_256_32[1]
  ) {
    throw new DigestMultibaseError("payloadDigest is not a sha2-256 multihash");
  }
  const digest = bytes.subarray(MULTIHASH_SHA2_256_32.length);
  if (digest.length !== 32) {
    throw new DigestMultibaseError(
      `sha2-256 multihash carries ${digest.length} bytes, expected 32`,
    );
  }
  return digest;
}

/** Length of the human-checkable match code compared across two approver screens. */
export const MATCH_CODE_LEN = 6;

/**
 * The operator's comparison code: the first {@link MATCH_CODE_LEN} hex
 * characters of the digest **bytes**, not of their multibase encoding.
 *
 * This distinction is the whole point. Every `digestMultibase` over SHA-256
 * begins `zQm` — that is the base58btc marker plus the `0x12 0x20` multihash
 * prefix, identical for every digest ever produced:
 *
 * ```text
 * zQmcdLJ…   zQmRTnb…   zQmb7oR…   zQmbu6r…      ← four different payloads
 * ```
 *
 * Slicing the encoded string would therefore spend half a six-character code on
 * a constant, leaving ~17.6 bits where the human believes they are comparing
 * ~35 — and it would still *look* like six random characters, which is what
 * makes it dangerous rather than merely wasteful.
 *
 * Decoding first restores the full entropy and, because the digest is still
 * SHA-256, reproduces exactly the code this surface showed when the wire
 * carried bare hex: `hex(digest)[..6]` either way. The migration is invisible
 * on screen, which is what lets the two repositories cut over independently of
 * whatever the human already has in front of them.
 */
export function matchCodeFromDigest(payloadDigest: string): string {
  const digest = decodeDigestMultibase(payloadDigest);
  // Two hex characters per byte.
  const need = Math.ceil(MATCH_CODE_LEN / 2);
  let hex = "";
  for (let i = 0; i < need; i++) {
    hex += (digest[i] as number).toString(16).padStart(2, "0");
  }
  return hex.slice(0, MATCH_CODE_LEN);
}
