// HPKE (RFC 9180) implemented on @noble primitives — no WebCrypto.
//
// This is the ecosystem's single HPKE implementation, for every runtime and
// every caller. The suite is the one affinidi-tsp and the VTA sealed-transfer
// format both mandate (KEM 0x0020 DHKEM(X25519,HKDF-SHA256), KDF 0x0001
// HKDF-SHA256, AEAD 0x0003 ChaCha20Poly1305), single-shot, in two modes:
//
//   mode_base (0x00) — VTA sealed bundles (`@openvtc/pnm-core` provisioning)
//   mode_auth (0x02) — TSP messages, which authenticate the sender via the KEM
//
// Both modes share the KEM, the key schedule, and the AEAD; they differ only
// in the DH inputs to Encap/Decap and the mode byte. Keeping them in one file
// is the point — two copies of an RFC 9180 key schedule is exactly the
// duplication the stack guide's R4.1 warns about.
//
// The test suite holds this implementation byte-identical to hpke-js (kept as
// a dev-dependency for exactly that cross-check, both modes) and to the
// official CFRG RFC 9180 vectors.
//
// Why pure JS: hpke-js reaches for `crypto.subtle` for HKDF and X25519, which
// does not exist on React Native's Hermes engine and is only *partially*
// polyfilled in real apps (a wallet that provides `subtle.digest` alone looks
// WebCrypto-capable to any feature probe and then fails at runtime). One
// implementation with no platform dependency keeps the "runs anywhere" promise
// literal — and keeps behavior identical everywhere.
//
// Section numbers below are RFC 9180.

import { x25519 } from "@noble/curves/ed25519.js";
import { sha256 } from "@noble/hashes/sha2.js";
import { extract, expand } from "@noble/hashes/hkdf.js";
import { chacha20poly1305 } from "@noble/ciphers/chacha.js";

import type { SealResult } from "./hpke.js";

const KEM_ID = 0x0020;
const KDF_ID = 0x0001;
const AEAD_ID = 0x0003;

const MODE_BASE = 0x00;
const MODE_AUTH = 0x02;

const NSECRET = 32; // DHKEM(X25519) shared secret
const NK = 32; // ChaCha20Poly1305 key
const NN = 12; // ChaCha20Poly1305 nonce
const NX25519 = 32; // X25519 public key, and its DH output

const HPKE_V1 = new TextEncoder().encode("HPKE-v1");
const EMPTY = new Uint8Array(0);

function cat(...arrays: Uint8Array[]): Uint8Array {
  const out = new Uint8Array(arrays.reduce((n, a) => n + a.length, 0));
  let off = 0;
  for (const a of arrays) {
    out.set(a, off);
    off += a.length;
  }
  return out;
}

const i2osp2 = (n: number): Uint8Array => new Uint8Array([(n >> 8) & 0xff, n & 0xff]);
const label = (s: string): Uint8Array => new TextEncoder().encode(s);

// §4.1 — the KEM's labeled calls and the key schedule's use different suite ids.
const KEM_SUITE_ID = cat(label("KEM"), i2osp2(KEM_ID));
const HPKE_SUITE_ID = cat(label("HPKE"), i2osp2(KEM_ID), i2osp2(KDF_ID), i2osp2(AEAD_ID));

// §4 LabeledExtract / LabeledExpand
const labeledExtract = (suiteId: Uint8Array, salt: Uint8Array, lbl: string, ikm: Uint8Array): Uint8Array =>
  extract(sha256, cat(HPKE_V1, suiteId, label(lbl), ikm), salt);

const labeledExpand = (
  suiteId: Uint8Array,
  prk: Uint8Array,
  lbl: string,
  info: Uint8Array,
  len: number,
): Uint8Array => expand(sha256, prk, cat(i2osp2(len), HPKE_V1, suiteId, label(lbl), info), len);

// §4.1 ExtractAndExpand
function extractAndExpand(dhBytes: Uint8Array, kemContext: Uint8Array): Uint8Array {
  const eaePrk = labeledExtract(KEM_SUITE_ID, EMPTY, "eae_prk", dhBytes);
  return labeledExpand(KEM_SUITE_ID, eaePrk, "shared_secret", kemContext, NSECRET);
}

// §5.1 KeySchedule, no PSK. `mode` is the only difference between base and
// auth once the KEM has produced its shared secret.
function keySchedule(
  mode: number,
  sharedSecret: Uint8Array,
  info: Uint8Array,
): { key: Uint8Array; baseNonce: Uint8Array } {
  const pskIdHash = labeledExtract(HPKE_SUITE_ID, EMPTY, "psk_id_hash", EMPTY);
  const infoHash = labeledExtract(HPKE_SUITE_ID, EMPTY, "info_hash", info);
  const ksContext = cat(new Uint8Array([mode]), pskIdHash, infoHash);
  const secret = labeledExtract(HPKE_SUITE_ID, sharedSecret, "secret", EMPTY);
  return {
    key: labeledExpand(HPKE_SUITE_ID, secret, "key", ksContext, NK),
    baseNonce: labeledExpand(HPKE_SUITE_ID, secret, "base_nonce", ksContext, NN),
  };
}

// §4.1 DH with the mandated all-zero check (noble also rejects low-order points).
function dh(sk: Uint8Array, pk: Uint8Array): Uint8Array {
  const shared = x25519.getSharedSecret(sk, pk);
  if (shared.every((b) => b === 0)) throw new Error("tsp: DH produced the all-zero shared secret");
  return shared;
}

// The ephemeral-key hook below exists ONLY so RFC 9180 test vectors (which fix
// skEm) can be verified. Reusing one ephemeral key for two messages to the same
// recipient repeats the (key, base_nonce) pair, which for ChaCha20Poly1305
// leaks the XOR of the plaintexts and the Poly1305 one-time key — i.e. it
// breaks both confidentiality and integrity. Never pass it in production; the
// public `hpke.ts` wrappers deliberately do not forward it.
type UnsafeFixedEphemeral = { __unsafeFixedEphemeralSk?: Uint8Array };

/** §4.1 Encap (base mode). Exported for test-vector verification. */
export function encap(recipientPk: Uint8Array, unsafe?: UnsafeFixedEphemeral): {
  sharedSecret: Uint8Array;
  enc: Uint8Array;
} {
  const skE = unsafe?.__unsafeFixedEphemeralSk ?? x25519.utils.randomSecretKey();
  const enc = x25519.getPublicKey(skE);
  return {
    sharedSecret: extractAndExpand(dh(skE, recipientPk), cat(enc, recipientPk)),
    enc,
  };
}

/** §4.1 Decap (base mode). Exported for test-vector verification. */
export function decap(enc: Uint8Array, recipientSk: Uint8Array): Uint8Array {
  const kemContext = cat(enc, x25519.getPublicKey(recipientSk));
  return extractAndExpand(dh(recipientSk, enc), kemContext);
}

/** §5.1.4 AuthEncap. Exported for test-vector verification. */
export function authEncap(
  recipientPk: Uint8Array,
  senderSk: Uint8Array,
  unsafe?: UnsafeFixedEphemeral,
): { sharedSecret: Uint8Array; enc: Uint8Array } {
  const skE = unsafe?.__unsafeFixedEphemeralSk ?? x25519.utils.randomSecretKey();
  const enc = x25519.getPublicKey(skE);
  const dhBytes = cat(dh(skE, recipientPk), dh(senderSk, recipientPk));
  const kemContext = cat(enc, recipientPk, x25519.getPublicKey(senderSk));
  return { sharedSecret: extractAndExpand(dhBytes, kemContext), enc };
}

/** §5.1.4 AuthDecap. Exported for test-vector verification. */
export function authDecap(enc: Uint8Array, recipientSk: Uint8Array, senderPk: Uint8Array): Uint8Array {
  const dhBytes = cat(dh(recipientSk, enc), dh(recipientSk, senderPk));
  const kemContext = cat(enc, x25519.getPublicKey(recipientSk), senderPk);
  return extractAndExpand(dhBytes, kemContext);
}

// Single-shot: seq = 0, so the nonce is base_nonce unmodified (§5.2).

/** HPKE-Auth single-shot seal. Same contract as `hpke.seal`. */
export async function seal(
  plaintext: Uint8Array,
  aad: Uint8Array,
  senderSk: Uint8Array,
  recipientPk: Uint8Array,
  info: Uint8Array,
  unsafe?: UnsafeFixedEphemeral,
): Promise<SealResult> {
  const { sharedSecret, enc } = authEncap(recipientPk, senderSk, unsafe);
  const { key, baseNonce } = keySchedule(MODE_AUTH, sharedSecret, info);
  return { enc, ciphertext: chacha20poly1305(key, baseNonce, aad).encrypt(plaintext) };
}

/** HPKE-Auth single-shot open. Same contract as `hpke.open`. */
export async function open(
  ciphertext: Uint8Array,
  aad: Uint8Array,
  enc: Uint8Array,
  recipientSk: Uint8Array,
  senderPk: Uint8Array,
  info: Uint8Array,
): Promise<Uint8Array> {
  const sharedSecret = authDecap(enc, recipientSk, senderPk);
  const { key, baseNonce } = keySchedule(MODE_AUTH, sharedSecret, info);
  return chacha20poly1305(key, baseNonce, aad).decrypt(ciphertext);
}

/** HPKE base-mode single-shot seal. Same contract as `hpke.sealBase`. */
export async function sealBase(
  plaintext: Uint8Array,
  aad: Uint8Array,
  recipientPk: Uint8Array,
  info: Uint8Array,
  unsafe?: UnsafeFixedEphemeral,
): Promise<SealResult> {
  const { sharedSecret, enc } = encap(recipientPk, unsafe);
  const { key, baseNonce } = keySchedule(MODE_BASE, sharedSecret, info);
  return { enc, ciphertext: chacha20poly1305(key, baseNonce, aad).encrypt(plaintext) };
}

/** HPKE base-mode single-shot open. Same contract as `hpke.openBase`. */
export async function openBase(
  ciphertext: Uint8Array,
  aad: Uint8Array,
  enc: Uint8Array,
  recipientSk: Uint8Array,
  info: Uint8Array,
): Promise<Uint8Array> {
  const sharedSecret = decap(enc, recipientSk);
  const { key, baseNonce } = keySchedule(MODE_BASE, sharedSecret, info);
  return chacha20poly1305(key, baseNonce, aad).decrypt(ciphertext);
}

/**
 * A capability that can compute the raw X25519 Diffie-Hellman shared secret
 * with a peer's public key, without ever exposing the private key itself —
 * e.g. non-exporting software custody (an Askar-backed KMS) whose only DH
 * primitive is "give me the shared secret", never "give me the key". Note
 * this is NOT an enclave/HSM claim: Secure Enclave, StrongBox, and mainstream
 * cloud KMS ECDH (AWS `DeriveSharedSecret`, GCP raw ECDH) are NIST-curve-only
 * and cannot perform X25519 ECDH, so none of them can satisfy this interface
 * on the KEM this suite pins.
 * `publicKey` is the identity's own public key; `agree` returns the RAW ECDH
 * output, no KDF applied — this is exactly the static-key half of AuthEncap/
 * AuthDecap's DH, nothing more.
 *
 * Both members are validated on every call — see `checkedAgree`.
 */
export interface KeyAgreement {
  publicKey: Uint8Array;
  agree(peerPublicKey: Uint8Array): Promise<Uint8Array>;
}

// A `KeyAgreement` is foreign code, so its two outputs get the validation
// noble gives a raw key. Two distinct reasons, and the first is the sharp one:
//
// §4.1 makes the all-zero abort MANDATORY for X25519, and on the raw path
// `dh()` is the only place it happens. A backend whose DH is opaque — Askar, a
// `crypto_scalarmult`-style primitive, a KMS's raw ECDH — has no reason to
// reject a low-order peer key on our behalf, so taking its output unchecked
// moves the whole guarantee into the backend. That matters because `enc` is
// attacker-chosen and `senderPk` comes from the peer's own DID document: with
// both DH terms of AuthDecap derived from low-order points, `shared_secret`
// becomes a constant the attacker can compute, and HPKE-Auth's sender
// authentication — TSP's only sender proof for the ciphertext — is forgeable.
//
// The lengths are the quieter half: a backend handing back a DER- or
// multibase-wrapped secret, or a `publicKey` that is the identity's Ed25519
// key rather than its X25519 one, otherwise produces well-formed ciphertext
// that no recipient can open, failing at the AEAD tag with nothing pointing
// back at the adapter.
async function checkedAgree(ka: KeyAgreement, peerPublicKey: Uint8Array): Promise<Uint8Array> {
  const shared = await ka.agree(peerPublicKey);
  if (shared.length !== NX25519) {
    throw new Error(`tsp: KeyAgreement.agree returned ${shared.length} bytes, expected ${NX25519}`);
  }
  // Same message as `dh()`: the two paths must be indistinguishable here.
  if (shared.every((b) => b === 0)) throw new Error("tsp: DH produced the all-zero shared secret");
  return shared;
}

/** The capability's own public key, which goes into `kem_context` verbatim. */
function checkedPublicKey(ka: KeyAgreement): Uint8Array {
  if (ka.publicKey.length !== NX25519) {
    throw new Error(`tsp: KeyAgreement.publicKey is ${ka.publicKey.length} bytes, expected ${NX25519}`);
  }
  return ka.publicKey;
}

/**
 * `authEncap`, ported to a `KeyAgreement` capability instead of a raw private
 * key. The ephemeral half of the DH is still minted here directly (never
 * custody-sensitive — freshly generated per call, discarded after); only the
 * static-key half goes through `senderKeyAgreement.agree(...)`. Identical
 * output to `authEncap(recipientPk, senderSk)` when `senderKeyAgreement`
 * wraps `senderSk` directly.
 */
export async function authEncapWithKeyAgreement(
  recipientPk: Uint8Array,
  senderKeyAgreement: KeyAgreement,
  unsafe?: UnsafeFixedEphemeral,
): Promise<{ sharedSecret: Uint8Array; enc: Uint8Array }> {
  const senderPk = checkedPublicKey(senderKeyAgreement);
  const skE = unsafe?.__unsafeFixedEphemeralSk ?? x25519.utils.randomSecretKey();
  const enc = x25519.getPublicKey(skE);
  const staticDh = await checkedAgree(senderKeyAgreement, recipientPk);
  const dhBytes = cat(dh(skE, recipientPk), staticDh);
  const kemContext = cat(enc, recipientPk, senderPk);
  return { sharedSecret: extractAndExpand(dhBytes, kemContext), enc };
}

/**
 * `authDecap`, ported to a `KeyAgreement` capability. Both DH terms are the
 * recipient's static key against a different peer public key each time, so
 * both go through the capability — there is no non-custodial half here.
 */
export async function authDecapWithKeyAgreement(
  enc: Uint8Array,
  recipientKeyAgreement: KeyAgreement,
  senderPk: Uint8Array,
): Promise<Uint8Array> {
  const recipientPk = checkedPublicKey(recipientKeyAgreement);
  // Both terms are the same static key against a different peer key, so the
  // two calls are independent. Awaiting them in sequence doubles decap latency
  // against exactly the network- or IPC-backed custody this interface exists
  // for, for no ordering the KEM cares about.
  const [dhWithEnc, dhWithSender] = await Promise.all([
    checkedAgree(recipientKeyAgreement, enc),
    checkedAgree(recipientKeyAgreement, senderPk),
  ]);
  const kemContext = cat(enc, recipientPk, senderPk);
  return extractAndExpand(cat(dhWithEnc, dhWithSender), kemContext);
}

/** `seal`, ported — same contract as `seal`, minus the raw sender key. */
export async function sealWithKeyAgreement(
  plaintext: Uint8Array,
  aad: Uint8Array,
  senderKeyAgreement: KeyAgreement,
  recipientPk: Uint8Array,
  info: Uint8Array,
  unsafe?: UnsafeFixedEphemeral,
): Promise<SealResult> {
  const { sharedSecret, enc } = await authEncapWithKeyAgreement(recipientPk, senderKeyAgreement, unsafe);
  const { key, baseNonce } = keySchedule(MODE_AUTH, sharedSecret, info);
  return { enc, ciphertext: chacha20poly1305(key, baseNonce, aad).encrypt(plaintext) };
}

/** `open`, ported. */
export async function openWithKeyAgreement(
  ciphertext: Uint8Array,
  aad: Uint8Array,
  enc: Uint8Array,
  recipientKeyAgreement: KeyAgreement,
  senderPk: Uint8Array,
  info: Uint8Array,
): Promise<Uint8Array> {
  const sharedSecret = await authDecapWithKeyAgreement(enc, recipientKeyAgreement, senderPk);
  const { key, baseNonce } = keySchedule(MODE_AUTH, sharedSecret, info);
  return chacha20poly1305(key, baseNonce, aad).decrypt(ciphertext);
}
