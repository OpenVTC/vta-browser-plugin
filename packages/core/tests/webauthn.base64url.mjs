// Regression test for base64url canonicality.
//
// `atob` is lenient: for an N-byte value the final base64 character carries
// only a few significant bits, so multiple distinct strings decode to the same
// bytes. "GA".."GP" (16 strings) all decode to the single byte 0x18 — the
// trailing 4 bits are ignored. A decoder that silently accepts these aliases
// lets a value that differs on the wire compare equal after decoding, which is
// a problem for any caller that decodes-then-compares (credential ids, key ids,
// challenges). `base64urlToBytes` therefore rejects non-canonical input rather
// than relying on every caller to know `atob` is permissive.
//
// (A reported "auth bypass" PoC leaned on this leniency. Nothing in this repo
// decodes-then-compares untrusted input through this path today, but the
// function is public API, so we make the strictness explicit and guard it.)

import { test } from "node:test";
import assert from "node:assert/strict";

import { base64urlToBytes, bytesToBase64url } from "../dist/index.js";

test("canonical inputs round-trip exactly", () => {
  for (const s of ["", "AA", "AAA", "AAAA", "GA", "_-_-", "BOp_ZH4G"]) {
    assert.equal(bytesToBase64url(base64urlToBytes(s)), s, `round-trip failed for ${JSON.stringify(s)}`);
  }
});

test("non-canonical trailing-bit aliases are rejected", () => {
  // Every member of the "G_" family except the canonical "GA" decodes to 0x18
  // under a lenient decoder; all must be rejected.
  for (const bad of ["GB", "GC", "GG", "GH", "GP"]) {
    assert.throws(
      () => base64urlToBytes(bad),
      /non-canonical base64url encoding/,
      `expected ${JSON.stringify(bad)} to be rejected`,
    );
  }
  // The canonical member still decodes.
  assert.deepEqual(base64urlToBytes("GA"), new Uint8Array([0x18]));
});

test("disallowed characters are rejected", () => {
  for (const bad of ["AA AA", "AAAA=", "AAAA\n", "ab+cd", "ab/cd", "AA*"]) {
    assert.throws(
      () => base64urlToBytes(bad),
      /not unpadded base64url/,
      `expected ${JSON.stringify(bad)} to be rejected`,
    );
  }
});

test("impossible lengths are rejected", () => {
  // len % 4 === 1 can never be produced by base64 encoding any byte count.
  for (const bad of ["A", "AAAAA"]) {
    assert.throws(() => base64urlToBytes(bad), /invalid base64url length/);
  }
});

test("a full-length canonical value (VAPID-style P-256 point) round-trips", () => {
  const vapid =
    "BOp_ZH4GUVZ1aPNmBJl9rpQWTJyNQWLGAclN3d2VYJKxhyzYqYoKbOwwU98C9jaa1IiTjz-IasJFV74Yop0qUOQ";
  const bytes = base64urlToBytes(vapid);
  assert.equal(bytes.length, 65);
  assert.equal(bytes[0], 0x04); // uncompressed EC point prefix
  assert.equal(bytesToBase64url(bytes), vapid);
});
