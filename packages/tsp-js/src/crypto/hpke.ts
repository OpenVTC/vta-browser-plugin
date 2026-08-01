// HPKE-Auth (RFC 9180) seal/open for TSP — the exact suite affinidi-tsp
// mandates: DHKEM(X25519, HKDF-SHA256), HKDF-SHA256, ChaCha20Poly1305, Auth
// mode, single-shot. affinidi-tsp hand-rolls this from primitives; we use
// hpke-js, which implements the identical standard suite, so the wire bytes
// (shared secret, key schedule, ciphertext, enc) match byte-for-byte.
//
// Suite IDs (must match): KEM 0x0020, KDF 0x0001 (HKDF-SHA256), AEAD 0x0003
// (ChaCha20Poly1305) — exactly `DhkemX25519HkdfSha256 + HkdfSha256 +
// Chacha20Poly1305`.

import { CipherSuite, DhkemX25519HkdfSha256, HkdfSha256 } from "@hpke/core";
import { Chacha20Poly1305 } from "@hpke/chacha20poly1305";

import * as noble from "./hpke-noble.js";

/** ChaCha20Poly1305 tag length appended to the ciphertext. */
export const TAG_LEN = 16;
/** X25519 encapsulated-key length. */
export const ENC_LEN = 32;

// hpke-js needs `crypto.subtle` for HKDF and X25519. React Native's Hermes
// engine has none (and some older Node / edge runtimes ship it partially), so
// fall back to the pure-JS implementation in `hpke-noble.ts` — same RFC 9180
// suite, byte-identical output. Set `TSP_HPKE_BACKEND=noble|webcrypto` to
// force one (tests exercise both).
export type HpkeBackend = "webcrypto" | "noble";

function detectBackend(): HpkeBackend {
  const forced = (globalThis as { process?: { env?: Record<string, string | undefined> } }).process?.env
    ?.TSP_HPKE_BACKEND;
  if (forced === "noble" || forced === "webcrypto") return forced;
  return typeof globalThis.crypto?.subtle?.importKey === "function" ? "webcrypto" : "noble";
}

let backend: HpkeBackend | undefined;

/** Which HPKE implementation this runtime resolved to. */
export function activeBackend(): HpkeBackend {
  return (backend ??= detectBackend());
}

/** Override backend selection (mainly for tests and benchmarking). */
export function setBackend(next: HpkeBackend | undefined): void {
  backend = next;
}

const suite = (): CipherSuite =>
  new CipherSuite({
    kem: new DhkemX25519HkdfSha256(),
    kdf: new HkdfSha256(),
    aead: new Chacha20Poly1305(),
  });

/** View a Uint8Array as an ArrayBuffer (copying only the used region) — hpke-js
 *  takes ArrayBuffer inputs. */
function ab(u8: Uint8Array): ArrayBuffer {
  return u8.buffer.slice(u8.byteOffset, u8.byteOffset + u8.byteLength) as ArrayBuffer;
}

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
  if (activeBackend() === "noble") {
    return noble.seal(plaintext, aad, senderSk, recipientPk, info);
  }
  const s = suite();
  const senderKey = await s.kem.importKey("raw", ab(senderSk), false);
  const recipientPublicKey = await s.kem.importKey("raw", ab(recipientPk), true);
  const sender = await s.createSenderContext({ recipientPublicKey, senderKey, info: ab(info) });
  const ciphertext = new Uint8Array(await sender.seal(ab(plaintext), ab(aad)));
  return { enc: new Uint8Array(sender.enc), ciphertext };
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
  if (activeBackend() === "noble") {
    return noble.open(ciphertext, aad, enc, recipientSk, senderPk, info);
  }
  const s = suite();
  const recipientKey = await s.kem.importKey("raw", ab(recipientSk), false);
  const senderPublicKey = await s.kem.importKey("raw", ab(senderPk), true);
  const recipient = await s.createRecipientContext({
    recipientKey,
    enc: ab(enc),
    senderPublicKey,
    info: ab(info),
  });
  return new Uint8Array(await recipient.open(ab(ciphertext), ab(aad)));
}
