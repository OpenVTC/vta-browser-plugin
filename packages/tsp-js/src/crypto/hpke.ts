// HPKE-Auth (RFC 9180) seal/open for TSP — the exact suite affinidi-tsp
// mandates: DHKEM(X25519, HKDF-SHA256), HKDF-SHA256, ChaCha20Poly1305, Auth
// mode, single-shot.
//
// Implemented in pure TypeScript on the @noble primitives (`hpke-noble.ts`)
// so ONE code path runs identically in every JS runtime — browser, Node, and
// React Native, whose Hermes engine ships no `crypto.subtle` (and real apps
// polyfill it only partially, which is why runtime detection was dropped).
// hpke-js remains as a dev-dependency: the test suite holds this
// implementation byte-identical to it and to the official RFC 9180 vectors.
//
// The only runtime requirement is `crypto.getRandomValues` (native in
// browsers/Node; on React Native: `react-native-get-random-values`).

import * as noble from "./hpke-noble.js";

/** ChaCha20Poly1305 tag length appended to the ciphertext. */
export const TAG_LEN = 16;
/** X25519 encapsulated-key length. */
export const ENC_LEN = 32;

export interface SealResult {
  /** The X25519 ephemeral public key (32 bytes). */
  enc: Uint8Array;
  /** The AEAD ciphertext, `ct ‖ tag(16)`. */
  ciphertext: Uint8Array;
}

/**
 * HPKE-Auth seal: encrypt + authenticate `plaintext` from the sender to the
 * recipient. `info` binds context (in TSP, the `-E` envelope frame); `aad` is
 * the AEAD additional data (empty in TSP).
 *
 * All keys are raw 32-byte X25519 keys.
 */
export async function seal(
  plaintext: Uint8Array,
  aad: Uint8Array,
  senderSk: Uint8Array,
  recipientPk: Uint8Array,
  info: Uint8Array,
): Promise<SealResult> {
  return noble.seal(plaintext, aad, senderSk, recipientPk, info);
}

/**
 * HPKE-Auth open: decrypt + verify sender. `ciphertext` is `ct ‖ tag(16)`;
 * `enc` is the sender's encapsulated key (32 bytes). Throws on authentication
 * failure. All keys are raw 32-byte X25519 keys.
 */
export async function open(
  ciphertext: Uint8Array,
  aad: Uint8Array,
  enc: Uint8Array,
  recipientSk: Uint8Array,
  senderPk: Uint8Array,
  info: Uint8Array,
): Promise<Uint8Array> {
  return noble.open(ciphertext, aad, enc, recipientSk, senderPk, info);
}
