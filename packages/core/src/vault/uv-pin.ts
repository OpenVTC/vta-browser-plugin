// A PIN as the browser device's user-verification ("UV") key (`vtaPin`).
//
// For a browser with no PRF passkey (Linux Chromium without a security key,
// 1Password, which cannot answer an extension's WebAuthn calls) the VTA checks
// a PIN instead, and enforces a guess limit. The wire contract:
//
//   K        = PBKDF2-HMAC-SHA256(utf8(NFC(pin)), salt, iterations, 32 bytes)
//   enrol    ext["org.openvtc.uv-key"] = {kind: "vtaPin", salt, iterations,
//            verifier: K, hardwareBacked: false, biometricGated: false}
//   approve  ext["org.openvtc.uv-consent"] = {decision, pinProof}
//            pinProof = HMAC-SHA256(K, utf8("org.openvtc.uv-pin/v1|" + D))
//   change   ext["org.openvtc.uv-key-change"] = {pinProof}
//            pinProof = HMAC-SHA256(K_old, utf8("org.openvtc.uv-pin/v1|change|"
//                       + sha256hex(JCS(new uv-key enrolment))))
//
// The wallet keeps only `{salt, iterations}` (`store/uv-pin-params.ts`). The
// PIN and K are never stored: K is derived for one proof and wiped.

import { jcsCanonicalize, sha256 } from "../trust-tasks/canonical.js";
import { bytesToBase64url } from "../util/base64url.js";

/** PBKDF2 iterations for a new PIN: the VTA's floor. */
export const UV_PIN_ITERATIONS = 600_000;
/** Bytes of salt for a new PIN (the VTA takes 16..64). */
export const UV_PIN_SALT_BYTES = 16;
/** The shortest PIN or passphrase the wallet accepts. */
export const UV_PIN_MIN_LENGTH = 6;

const PROOF_PREFIX = "org.openvtc.uv-pin/v1|";
const CHANGE_PREFIX = "org.openvtc.uv-pin/v1|change|";

/** The bytes a PIN proof for grant digest `D` is the HMAC of. */
export function pinProofMessage(payloadDigest: string): string {
  return PROOF_PREFIX + payloadDigest;
}

/** The string a PIN change proof is the HMAC of, for `newEnrolment`. */
export async function pinChangeMessage(newEnrolment: unknown): Promise<string> {
  const digest = await sha256(jcsCanonicalize(newEnrolment));
  return CHANGE_PREFIX + Array.from(digest, (b) => b.toString(16).padStart(2, "0")).join("");
}

/**
 * K: PBKDF2-HMAC-SHA256 over the NFC-normalised UTF-8 PIN. The caller owns the
 * bytes and wipes them (`fill(0)`) once the proof or enrolment is made.
 */
export async function derivePinKey(pin: string, salt: Uint8Array, iterations: number): Promise<Uint8Array> {
  const pinBytes = new TextEncoder().encode(pin.normalize("NFC"));
  try {
    const base = await crypto.subtle.importKey("raw", pinBytes as BufferSource, "PBKDF2", false, ["deriveBits"]);
    const bits = await crypto.subtle.deriveBits(
      { name: "PBKDF2", hash: "SHA-256", salt: salt as BufferSource, iterations },
      base,
      256,
    );
    return new Uint8Array(bits);
  } finally {
    pinBytes.fill(0);
  }
}

async function hmac(key: Uint8Array, message: string): Promise<string> {
  const k = await crypto.subtle.importKey("raw", key as BufferSource, { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
  const mac = await crypto.subtle.sign("HMAC", k, new TextEncoder().encode(message));
  return bytesToBase64url(new Uint8Array(mac));
}

/** base64url HMAC-SHA256(K, "org.openvtc.uv-pin/v1|" + D). */
export function pinProof(key: Uint8Array, payloadDigest: string): Promise<string> {
  return hmac(key, pinProofMessage(payloadDigest));
}

/** base64url HMAC-SHA256(K_old, "org.openvtc.uv-pin/v1|change|" +
 *  sha256hex(JCS(newEnrolment))): replacing a `vtaPin` UV key needs it. */
export async function pinChangeProof(oldKey: Uint8Array, newEnrolment: unknown): Promise<string> {
  return hmac(oldKey, await pinChangeMessage(newEnrolment));
}

/** A fresh salt for a new PIN. */
export function newPinSalt(): Uint8Array {
  return crypto.getRandomValues(new Uint8Array(UV_PIN_SALT_BYTES));
}
