// HPKE (RFC 9180) seal/open — the exact suite affinidi-tsp and the VTA
// sealed-transfer format both mandate: DHKEM(X25519, HKDF-SHA256),
// HKDF-SHA256, ChaCha20Poly1305, single-shot.
//
// Two modes, one implementation:
//   - Auth mode (`seal`/`open`)          — TSP messages; the KEM also
//     authenticates the sender, so no separate signature is needed for it.
//   - Base mode (`sealBase`/`openBase`)  — VTA sealed bundles; the sender is
//     anonymous and authentication comes from the surrounding envelope.
//
// Implemented in pure TypeScript on the @noble primitives (`hpke-noble.ts`)
// so ONE code path runs identically in every JS runtime — browser, Node, and
// React Native, whose Hermes engine ships no `crypto.subtle` (and real apps
// polyfill it only partially, which is why runtime detection was dropped).
// hpke-js remains as a dev-dependency: the test suite holds this
// implementation byte-identical to it, in both modes, and to the official
// RFC 9180 vectors.
//
// The only runtime requirement is `crypto.getRandomValues` (native in
// browsers/Node; on React Native: `react-native-get-random-values`) — and
// only for sealing. Opening needs no randomness at all.

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

/**
 * HPKE base-mode seal: encrypt `plaintext` to the recipient with an anonymous
 * sender. Use this only where the sender is authenticated by the surrounding
 * format; where the sender must be proven, use {@link seal} (auth mode).
 *
 * Keys are raw 32-byte X25519 keys.
 */
export async function sealBase(
  plaintext: Uint8Array,
  aad: Uint8Array,
  recipientPk: Uint8Array,
  info: Uint8Array,
): Promise<SealResult> {
  return noble.sealBase(plaintext, aad, recipientPk, info);
}

/**
 * HPKE base-mode open: decrypt `ciphertext` (`ct ‖ tag(16)`) sealed to us with
 * an anonymous sender. `enc` is the sender's encapsulated key (32 bytes).
 * Throws on AEAD failure — wrong recipient secret, tampered AAD, or a
 * ciphertext that was not sealed to this key.
 *
 * `recipientSk` is a raw 32-byte X25519 secret.
 */
export async function openBase(
  ciphertext: Uint8Array,
  aad: Uint8Array,
  enc: Uint8Array,
  recipientSk: Uint8Array,
  info: Uint8Array,
): Promise<Uint8Array> {
  return noble.openBase(ciphertext, aad, enc, recipientSk, info);
}
