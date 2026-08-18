export function bytesToBase64url(bytes: Uint8Array): string {
  let s = "";
  for (let i = 0; i < bytes.length; i++) {
    s += String.fromCharCode(bytes[i] ?? 0);
  }
  return btoa(s).replaceAll("+", "-").replaceAll("/", "_").replace(/=+$/, "");
}

// base64url alphabet, no padding. We accept (and produce) the unpadded form
// everywhere on the wire, so a literal "=" is a disallowed character here.
const BASE64URL_ALPHABET = /^[A-Za-z0-9_-]*$/;

/**
 * Decode an unpadded base64url string to its bytes, rejecting any input that
 * is not the *canonical* encoding of those bytes.
 *
 * Why the strictness matters: `atob` is lenient. For an N-byte value the final
 * base64 character carries only a few significant bits, so multiple distinct
 * strings decode to the same bytes (e.g. "GA", "GB" … "GP" all decode to the
 * single byte 0x18 — the trailing 4 bits are ignored). A decoder that accepts
 * these non-canonical aliases lets an attacker mint many strings that compare
 * equal *after* decoding but differ *before* it. Any caller that round-trips a
 * value through encode→wire→decode and then compares bytes (credential ids,
 * key ids, challenges) would be bypassable by such an alias.
 *
 * This codebase does not currently feed untrusted input through this path, but
 * the function is part of the public API surface, so we make non-canonical
 * input a hard error rather than relying on every future caller to know that
 * `atob` is permissive. Round-trip is guaranteed: `bytesToBase64url(decode(s))`
 * always equals `s` for any `s` this function accepts.
 *
 * @throws if `s` contains characters outside the base64url alphabet, has an
 *   impossible length, or is not the canonical encoding of the bytes it yields.
 */
export function base64urlToBytes(s: string): Uint8Array {
  if (!BASE64URL_ALPHABET.test(s)) {
    throw new Error("base64urlToBytes: input is not unpadded base64url");
  }
  // len % 4 === 1 is unreachable for any base64 encoding: 1 byte → 2 chars,
  // 2 bytes → 3 chars, 3 bytes → 4 chars, so a group can never be 1 char.
  if (s.length % 4 === 1) {
    throw new Error("base64urlToBytes: invalid base64url length");
  }
  const pad = s.length % 4 === 2 ? "==" : s.length % 4 === 3 ? "=" : "";
  const b64 = (s + pad).replaceAll("-", "+").replaceAll("_", "/");
  const bin = atob(b64);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  // Canonicality: the only string that may decode to `out` is its own
  // re-encoding. This rejects trailing-bit aliases like "GG" ≡ "GA".
  if (bytesToBase64url(out) !== s) {
    throw new Error("base64urlToBytes: non-canonical base64url encoding");
  }
  return out;
}
