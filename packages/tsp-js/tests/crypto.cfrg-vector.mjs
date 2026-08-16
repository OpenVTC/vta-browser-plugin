import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

// The official CFRG RFC 9180 test vector for the exact TSP suite (mode_auth
// 0x02, DHKEM(X25519,HKDF-SHA256) 0x0020, HKDF-SHA256 0x0001,
// ChaCha20Poly1305 0x0003). Every key — including the ephemeral — is fixed by
// the vector, so there is exactly one correct output; matching it proves the
// implementation is right per the standard, not merely self-consistent.
import { authEncap, authDecap, seal, open } from "../dist/crypto/hpke-noble.js";

const vec = JSON.parse(
  readFileSync(fileURLToPath(new URL("./fixtures/cfrg-auth-x25519-chacha.json", import.meta.url)), "utf8"),
).vectors[0];

const fromHex = (s) => Uint8Array.from(s.match(/../g), (b) => parseInt(b, 16));
const toHex = (u) => Array.from(u, (b) => b.toString(16).padStart(2, "0")).join("");

test("AuthEncap reproduces the vector's enc and shared_secret", () => {
  const { enc, sharedSecret } = authEncap(fromHex(vec.pkRm), fromHex(vec.skSm), {
    __unsafeFixedEphemeralSk: fromHex(vec.skEm),
  });
  assert.equal(toHex(enc), vec.enc);
  assert.equal(toHex(sharedSecret), vec.shared_secret);
});

test("AuthDecap reproduces the vector's shared_secret", () => {
  const sharedSecret = authDecap(fromHex(vec.enc), fromHex(vec.skRm), fromHex(vec.pkSm));
  assert.equal(toHex(sharedSecret), vec.shared_secret);
});

test("single-shot seal reproduces the vector's seq-0 ciphertext", async () => {
  const e0 = vec.encryptions[0];
  const sealed = await seal(
    fromHex(e0.pt),
    fromHex(e0.aad),
    fromHex(vec.skSm),
    fromHex(vec.pkRm),
    fromHex(vec.info),
    { __unsafeFixedEphemeralSk: fromHex(vec.skEm) },
  );
  assert.equal(toHex(sealed.enc), vec.enc);
  assert.equal(toHex(sealed.ciphertext), e0.ct);
});

test("single-shot open recovers the vector's plaintext", async () => {
  const e0 = vec.encryptions[0];
  const opened = await open(
    fromHex(e0.ct),
    fromHex(e0.aad),
    fromHex(vec.enc),
    fromHex(vec.skRm),
    fromHex(vec.pkSm),
    fromHex(vec.info),
  );
  assert.equal(toHex(opened), e0.pt);
});
