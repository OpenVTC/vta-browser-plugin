// Sign a Trust-Task envelope with a W3C Data Integrity proof
// (`eddsa-jcs-2022`). The wallet uses this to sign on-behalf-of operations
// at a Relying Party that authenticates the wallet by its holder did:peer
// — the proof's `verificationMethod` is the holder's `#key-2` URL, and the
// RP's server resolves the did:peer to verify.
//
// Same signing primitive (Ed25519) and same canonicalization (JCS / RFC
// 8785) the did-hosting UI uses for its session-key signed trust tasks, so
// a single AffinidiVerifier on the server-side accepts both flows.

import { ed25519 } from "@noble/curves/ed25519.js";
import type { SigningIdentity } from "../siop/self-issued.js";

/** A Trust-Task envelope before signing — anything serializable to JSON.
 *  `proof` is the only field this module reads/writes. */
export type TrustTaskEnvelope = Record<string, unknown> & { proof?: unknown };

export interface SignTrustTaskOptions {
  /** Envelope to sign in place. The function returns the same reference for
   *  ergonomics; mutates `envelope.proof` and leaves every other field
   *  byte-identical (the JCS canonical form must round-trip exactly). */
  envelope: TrustTaskEnvelope;
  /** Holder signing identity — its DID is what the RP attributes the
   *  request to, and its `kid` becomes the proof's `verificationMethod`. */
  signing: SigningIdentity;
}

/**
 * Attach an `eddsa-jcs-2022` Data Integrity proof to a Trust-Task envelope
 * and return the same envelope. The signed input is the concatenation of
 * SHA-256(JCS(proofConfig)) and SHA-256(JCS(envelope minus proof)), per
 * https://www.w3.org/TR/vc-di-eddsa/#eddsa-jcs-2022.
 */
export async function signTrustTask({
  envelope,
  signing,
}: SignTrustTaskOptions): Promise<TrustTaskEnvelope> {
  const proofConfig: Record<string, unknown> = {
    type: "DataIntegrityProof",
    cryptosuite: "eddsa-jcs-2022",
    verificationMethod: signing.kid,
    created: new Date().toISOString(),
    proofPurpose: "assertionMethod",
  };

  const docCopy: TrustTaskEnvelope = { ...envelope };
  delete docCopy.proof;

  const proofConfigHash = await sha256(jcsCanonicalize(proofConfig));
  const docHash = await sha256(jcsCanonicalize(docCopy));

  const toSign = new Uint8Array(proofConfigHash.length + docHash.length);
  toSign.set(proofConfigHash, 0);
  toSign.set(docHash, proofConfigHash.length);

  const sig = ed25519.sign(toSign, signing.privateKey);
  if (sig.length !== 64) {
    throw new Error(`unexpected Ed25519 signature length: ${sig.length} bytes`);
  }

  proofConfig.proofValue = "z" + base58btcEncode(sig);
  envelope.proof = proofConfig;
  return envelope;
}

// ─── JCS (RFC 8785) ───
// Minified JSON, object keys sorted lexicographically by UTF-16 code unit,
// strict JSON-only string escaping per ECMA-404. Mirrors the did-hosting-ui
// `session-key.ts` implementation so wallet-signed and session-signed
// envelopes hash identically when given equivalent input.

function jcsCanonicalize(value: unknown): string {
  const seen = new WeakSet<object>();
  return enc(value);

  function enc(v: unknown): string {
    if (v === null) return "null";
    if (v === true) return "true";
    if (v === false) return "false";
    if (typeof v === "number") {
      if (!Number.isFinite(v)) throw new Error("JCS rejects non-finite numbers");
      if (Object.is(v, -0)) return "0";
      return String(v);
    }
    if (typeof v === "string") return encString(v);
    if (Array.isArray(v)) {
      if (seen.has(v)) throw new Error("circular reference in JCS input");
      seen.add(v);
      const out = "[" + v.map(enc).join(",") + "]";
      seen.delete(v);
      return out;
    }
    if (typeof v === "object" && v !== null) {
      if (seen.has(v as object)) throw new Error("circular reference in JCS input");
      seen.add(v as object);
      const obj = v as Record<string, unknown>;
      const keys = Object.keys(obj).sort();
      const parts = keys.map((k) => encString(k) + ":" + enc(obj[k]));
      seen.delete(v as object);
      return "{" + parts.join(",") + "}";
    }
    throw new Error(`JCS cannot encode value of type ${typeof v}`);
  }

  function encString(s: string): string {
    let out = '"';
    for (let i = 0; i < s.length; i++) {
      const ch = s.charCodeAt(i);
      if (ch === 0x22) out += '\\"';
      else if (ch === 0x5c) out += "\\\\";
      else if (ch === 0x08) out += "\\b";
      else if (ch === 0x0c) out += "\\f";
      else if (ch === 0x0a) out += "\\n";
      else if (ch === 0x0d) out += "\\r";
      else if (ch === 0x09) out += "\\t";
      else if (ch < 0x20) out += "\\u" + ch.toString(16).padStart(4, "0");
      else out += s[i];
    }
    return out + '"';
  }
}

// ─── base58btc (Bitcoin alphabet) ───
// Used as the `z`-prefixed multibase encoding for the Ed25519 `proofValue`.

const B58_ALPHABET = "123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz";

function base58btcEncode(bytes: Uint8Array): string {
  let zeros = 0;
  while (zeros < bytes.length && bytes[zeros] === 0) zeros++;
  const digits: number[] = [];
  for (let i = 0; i < bytes.length; i++) {
    let carry = bytes[i] as number;
    for (let j = 0; j < digits.length; j++) {
      carry += (digits[j] as number) << 8;
      digits[j] = carry % 58;
      carry = (carry / 58) | 0;
    }
    while (carry > 0) {
      digits.push(carry % 58);
      carry = (carry / 58) | 0;
    }
  }
  let out = "";
  for (let z = 0; z < zeros; z++) out += "1";
  for (let i = digits.length - 1; i >= 0; i--) out += B58_ALPHABET[digits[i] as number];
  return out;
}

async function sha256(input: string): Promise<Uint8Array> {
  const buf = new TextEncoder().encode(input);
  return new Uint8Array(await crypto.subtle.digest("SHA-256", buf));
}
