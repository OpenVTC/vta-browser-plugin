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
// The primitives come from `@openvtc/vti-tsp-js/hpke` — the ecosystem's single
// RFC 9180 implementation, pure TypeScript on @noble. That package owns both
// modes (TSP uses auth mode over the same suite), so there is exactly one key
// schedule in the tree rather than one per caller, and this path no longer
// needs `crypto.subtle` — which the MV3 worker has but a React Native host
// does not.
//
// The X25519 secret is passed as raw 32-byte material: the Rust side derives
// it from an Ed25519 seed via SHA-512 + clamping, and the wallet does the same
// conversion in `bundle-secret.ts` before calling `hpkeOpen` here.

import { openBase } from "@openvtc/vti-tsp-js/hpke";

/** Domain-binding info string. Hardcoded — a different envelope format means
 *  a different info string, not a parameter the caller picks. */
const HPKE_INFO = new TextEncoder().encode("vta-sealed-transfer/v1");

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
  return openBase(input.ciphertext, input.aad, input.kemEncap, input.recipientSecret, HPKE_INFO);
}
