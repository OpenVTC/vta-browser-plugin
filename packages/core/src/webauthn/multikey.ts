import { base58 } from "@scure/base";

export const COSE_ALG = {
  ES256: -7,
  EdDSA: -8,
  ES384: -35,
  ES512: -36,
  RS256: -257,
} as const;

export type CoseAlg = (typeof COSE_ALG)[keyof typeof COSE_ALG];

const MULTICODEC = {
  p256Pub: 0x1200,
  ed25519Pub: 0xed,
  p384Pub: 0x1201,
} as const;

function encodeVarint(value: number): Uint8Array {
  if (value < 0 || !Number.isInteger(value)) {
    throw new RangeError("multicodec must be a non-negative integer");
  }
  const bytes: number[] = [];
  let v = value;
  while (v >= 0x80) {
    bytes.push((v & 0x7f) | 0x80);
    v >>>= 7;
  }
  bytes.push(v & 0x7f);
  return new Uint8Array(bytes);
}

function concatBytes(...parts: Uint8Array[]): Uint8Array {
  const len = parts.reduce((n, p) => n + p.length, 0);
  const out = new Uint8Array(len);
  let off = 0;
  for (const p of parts) {
    out.set(p, off);
    off += p.length;
  }
  return out;
}

/**
 * Encode a multikey from a multicodec code and raw key bytes.
 * Returns the canonical `z…` multibase-base58btc string used by W3C
 * Multikey verificationMethods.
 */
export function encodeMultikey(multicodec: number, keyBytes: Uint8Array): string {
  const prefix = encodeVarint(multicodec);
  return "z" + base58.encode(concatBytes(prefix, keyBytes));
}

/**
 * SEC1 point compression for an uncompressed P-256 / P-384 public key.
 * Input: 0x04 || X || Y (65 bytes for P-256, 97 for P-384).
 * Output: 0x02|0x03 || X (33 bytes for P-256, 49 for P-384).
 */
export function compressEcPoint(uncompressed: Uint8Array): Uint8Array {
  if (uncompressed[0] !== 0x04) {
    throw new Error("expected uncompressed SEC1 point (0x04 prefix)");
  }
  if (uncompressed.length % 2 !== 1) {
    throw new Error("invalid uncompressed point length");
  }
  const coordLen = (uncompressed.length - 1) / 2;
  const x = uncompressed.subarray(1, 1 + coordLen);
  const yLastByte = uncompressed[uncompressed.length - 1] ?? 0;
  const prefix = (yLastByte & 1) === 0 ? 0x02 : 0x03;
  const out = new Uint8Array(1 + coordLen);
  out[0] = prefix;
  out.set(x, 1);
  return out;
}

/**
 * Convert a CryptoKey (imported from WebAuthn SPKI) into a W3C Multikey
 * string. Currently supports ES256 (P-256) and Ed25519.
 */
export async function cryptoKeyToMultikey(
  publicKey: CryptoKey,
  coseAlg: CoseAlg,
): Promise<string> {
  if (coseAlg === COSE_ALG.ES256) {
    const raw = new Uint8Array(await crypto.subtle.exportKey("raw", publicKey));
    const compressed = compressEcPoint(raw);
    return encodeMultikey(MULTICODEC.p256Pub, compressed);
  }
  if (coseAlg === COSE_ALG.EdDSA) {
    const raw = new Uint8Array(await crypto.subtle.exportKey("raw", publicKey));
    if (raw.length !== 32) {
      throw new Error(`unexpected Ed25519 key length: ${raw.length}`);
    }
    return encodeMultikey(MULTICODEC.ed25519Pub, raw);
  }
  if (coseAlg === COSE_ALG.ES384) {
    const raw = new Uint8Array(await crypto.subtle.exportKey("raw", publicKey));
    const compressed = compressEcPoint(raw);
    return encodeMultikey(MULTICODEC.p384Pub, compressed);
  }
  throw new Error(`unsupported COSE algorithm for multikey: ${coseAlg}`);
}
