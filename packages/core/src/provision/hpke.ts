// HPKE (RFC 9180) base-mode open for VTA sealed bundles.
//
// Suite (pinned, matches `vta-sdk/src/sealed_transfer/hpke.rs`):
//   KEM:  DHKEM(X25519, HKDF-SHA256)
//   KDF:  HKDF-SHA256
//   AEAD: ChaCha20-Poly1305
//
// Single-shot, base mode (no PSK, no auth-mode KEM). The chunk header is
// bound as AEAD AAD by the caller (`buildChunkAad` in `armor.ts`); the info
// string `vta-sealed-transfer/v1` domain-separates this suite from any
// future use of the same primitives.
//
// We feed the X25519 secret as raw 32-byte material via the suite's KEM
// `importKey("raw", secret, false)` — the Rust side derives the X25519
// secret from an Ed25519 seed via SHA-512 + clamping; the wallet does the
// same conversion in `bundle-secret.ts` before calling `hpkeOpen` here.

import { CipherSuite, DhkemX25519HkdfSha256, HkdfSha256 } from "@hpke/core";
import { Chacha20Poly1305 } from "@hpke/chacha20poly1305";

/** Domain-binding info string. Hardcoded — a different envelope format means
 *  a different info string, not a parameter the caller picks. */
const HPKE_INFO = new TextEncoder().encode("vta-sealed-transfer/v1");

let _suite: CipherSuite | null = null;

function suite(): CipherSuite {
  if (!_suite) {
    _suite = new CipherSuite({
      kem: new DhkemX25519HkdfSha256(),
      kdf: new HkdfSha256(),
      aead: new Chacha20Poly1305(),
    });
  }
  return _suite;
}

export interface HpkeOpenInput {
  /** 32-byte X25519 secret. Derived from the wallet's Ed25519 seed via
   *  Montgomery conversion + clamping (see `bundle-secret.ts`). */
  recipientSecret: Uint8Array;
  /** 32-byte KEM encapsulation (the sender's ephemeral X25519 pubkey). */
  kemEncap: Uint8Array;
  /** AEAD ciphertext (ciphertext || tag). */
  ciphertext: Uint8Array;
  /** Additional authenticated data — built from the chunk header via
   *  `buildChunkAad`. Must byte-match the AAD used at seal time. */
  aad: Uint8Array;
}

/** Open one HPKE-sealed chunk. Returns the plaintext bytes (CBOR-encoded
 *  ChunkPlaintext, decoded by the caller). Throws on AEAD failure — wrong
 *  recipient secret, tampered AAD, or replayed ciphertext. */
export async function hpkeOpen(input: HpkeOpenInput): Promise<Uint8Array> {
  if (input.recipientSecret.length !== 32) {
    throw new Error(`hpke: recipientSecret must be 32 bytes (got ${input.recipientSecret.length})`);
  }
  if (input.kemEncap.length !== 32) {
    throw new Error(`hpke: kemEncap must be 32 bytes (got ${input.kemEncap.length})`);
  }
  const cs = suite();
  const recipientKey = await cs.kem.importKey("raw", asArrayBuffer(input.recipientSecret), false);
  const pt = await cs.open(
    {
      recipientKey,
      enc: asArrayBuffer(input.kemEncap),
      info: HPKE_INFO,
    },
    asArrayBuffer(input.ciphertext),
    asArrayBuffer(input.aad),
  );
  return new Uint8Array(pt);
}

/** Force-detached ArrayBuffer copy. `@hpke/core` rejects typed-array views
 *  whose underlying buffer is a SharedArrayBuffer or has unusual byteOffset
 *  semantics; a fresh copy normalises everything. */
function asArrayBuffer(u8: Uint8Array): ArrayBuffer {
  const out = new ArrayBuffer(u8.byteLength);
  new Uint8Array(out).set(u8);
  return out;
}
