// Ed25519 outer signatures for TSP — a TS port of affinidi-tsp
// `src/crypto/signing.rs`. The 32-byte private key is the Ed25519 seed
// (matching ed25519-dalek `SigningKey::from_bytes`).

import { ed25519 } from "@noble/curves/ed25519.js";

/** Sign `data` with a 32-byte Ed25519 private key (seed). Returns a 64-byte
 *  signature. */
export function sign(data: Uint8Array, privateKey: Uint8Array): Uint8Array {
  return ed25519.sign(data, privateKey);
}

/** Verify a 64-byte Ed25519 signature over `data` against a 32-byte public
 *  key. Returns false on a bad key, bad signature, or mismatch (never throws). */
export function verify(data: Uint8Array, signature: Uint8Array, publicKey: Uint8Array): boolean {
  try {
    return ed25519.verify(signature, data, publicKey);
  } catch {
    return false;
  }
}

/** Derive the 32-byte Ed25519 public key from a 32-byte private key (seed). */
export function ed25519PublicKey(privateKey: Uint8Array): Uint8Array {
  return ed25519.getPublicKey(privateKey);
}

/** A capability that can produce an Ed25519 signature without exposing the
 *  private key — e.g. a hardware-backed signing oracle whose only primitive
 *  is "sign this", never "give me the key". */
export interface SigningKey {
  publicKey: Uint8Array;
  sign(message: Uint8Array): Promise<Uint8Array>;
}

/** `sign`, ported to a `SigningKey` capability — a direct passthrough, since
 *  there is no DH-style custody problem here: a signing oracle already
 *  returns just the signature, never the key. */
export async function signWithSigningKey(data: Uint8Array, signingKey: SigningKey): Promise<Uint8Array> {
  return signingKey.sign(data);
}
