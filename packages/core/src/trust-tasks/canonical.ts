// Shared canonicalization + multibase primitives for `eddsa-jcs-2022` Data
// Integrity proofs. Both the signer (`./sign.ts`) and the verifier
// (`./verify.ts`) MUST hash byte-identical input, so these live in one place.
//
// JCS is RFC 8785: minified JSON, object keys sorted lexicographically by
// UTF-16 code unit, strict JSON-only string escaping per ECMA-404. Mirrors the
// did-hosting-ui `session-key.ts` implementation so wallet-signed and
// session-signed envelopes hash identically when given equivalent input.

export function jcsCanonicalize(value: unknown): string {
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
// The `z`-prefixed multibase encoding for the Ed25519 `proofValue`.

const B58_ALPHABET = "123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz";

export function base58btcEncode(bytes: Uint8Array): string {
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

export function base58btcDecode(s: string): Uint8Array {
  let zeros = 0;
  while (zeros < s.length && s[zeros] === "1") zeros++;
  const bytes: number[] = [];
  for (let i = 0; i < s.length; i++) {
    const ch = s[i] as string;
    const value = B58_ALPHABET.indexOf(ch);
    if (value === -1) throw new Error(`invalid base58btc character: ${ch}`);
    let carry = value;
    for (let j = 0; j < bytes.length; j++) {
      carry += (bytes[j] as number) * 58;
      bytes[j] = carry & 0xff;
      carry >>= 8;
    }
    while (carry > 0) {
      bytes.push(carry & 0xff);
      carry >>= 8;
    }
  }
  const out = new Uint8Array(zeros + bytes.length);
  for (let i = 0; i < bytes.length; i++) out[zeros + bytes.length - 1 - i] = bytes[i] as number;
  return out;
}

export async function sha256(input: string): Promise<Uint8Array> {
  const buf = new TextEncoder().encode(input);
  return new Uint8Array(await crypto.subtle.digest("SHA-256", buf));
}
