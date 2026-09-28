// The wallet's Ed25519 `did:key` signing identity, and the self-issued JWS it
// signs (an ACL-swap presentation). Logins no longer use a self-issued
// `id_token`: they are `auth/challenge` then `auth/authenticate` Trust Tasks
// (`rp-login/`). The module keeps its SIOPv2 name for its importers.
//
// A `did:key` here is an **Ed25519** key (multicodec 0xed01) because the
// credential must SIGN — an X25519-only `did:key` can only do ECDH (DIDComm
// authcrypt) and cannot produce a JWS. The same Ed25519 key also yields a
// derived X25519 keyAgreement key for DIDComm (see did:key resolution), so one
// identity covers both signing and DIDComm.

import { ed25519, x25519 } from "@noble/curves/ed25519.js";
import { base64url, didKey, multibase } from "@openvtc/vti-didcomm-js";

const ED25519_PUB = multibase.MULTICODEC.ED25519_PUB;

/** An Ed25519 `did:key` signing identity. `privateKey` is held in JS
 *  memory (the accepted trade-off for the no-passkey path — see the
 *  step-up flow for hardware-backed signing). */
export interface SigningIdentity {
  /** `did:key:z6Mk…` */
  did: string;
  /** Verification-method id for the signing key (`<did>#z6Mk…`). */
  kid: string;
  privateKey: Uint8Array;
  publicKey: Uint8Array;
}

/** Mint a fresh Ed25519 `did:key` signing identity. */
export function generateSigningIdentity(): SigningIdentity {
  const privateKey = ed25519.utils.randomSecretKey();
  const publicKey = ed25519.getPublicKey(privateKey);
  return signingIdentityFromKeys(privateKey, publicKey);
}

/** Reconstruct a signing identity from a stored Ed25519 private key. */
export function signingIdentityFromSecret(privateKey: Uint8Array): SigningIdentity {
  return signingIdentityFromKeys(privateKey, ed25519.getPublicKey(privateKey));
}

function signingIdentityFromKeys(
  privateKey: Uint8Array,
  publicKey: Uint8Array,
): SigningIdentity {
  const mb = multibase.encodeMultikey(ED25519_PUB, publicKey);
  const did = `did:key:${mb}`;
  return { did, kid: `${did}#${mb}`, privateKey, publicKey };
}

export interface IssueSwapPresentationOptions {
  /** The signing identity proving control of the **new** DID (the wallet's
   *  long-term holder did:peer, `#key-2`). The presentation's `holder` is its
   *  DID — what the swap creates the new ACL entry for. */
  holder: SigningIdentity;
  /** The VTA's DID — bound as `aud` so the proof can't be replayed elsewhere. */
  audience: string;
  /** Lifetime in seconds (default 300). */
  ttlSeconds?: number;
  /** Optional explicit nonce; a random one is generated when omitted. */
  nonce?: string;
}

/**
 * Issue a swap-acl presentation: a W3C Verifiable Presentation secured as a
 * compact EdDSA JWS (VP-JWT), proving control of the holder DID. The VTA's
 * `swap-acl` handler resolves `iss` and verifies this signature against the
 * holder's key, then moves the caller's ACL entry onto it. Same signing
 * primitive as any self-issued JWS, in a VP envelope.
 */
export function issueSwapPresentation(opts: IssueSwapPresentationOptions): string {
  const now = Math.floor(Date.now() / 1000);
  const nonce =
    opts.nonce ?? base64url.encode(globalThis.crypto.getRandomValues(new Uint8Array(16)));
  const header = { alg: "EdDSA", typ: "JWT", kid: opts.holder.kid };
  const payload = {
    iss: opts.holder.did,
    aud: opts.audience,
    iat: now,
    exp: now + (opts.ttlSeconds ?? 300),
    nonce,
    vp: {
      "@context": ["https://www.w3.org/ns/credentials/v2"],
      type: ["VerifiablePresentation", "AclSwapRequest"],
      holder: opts.holder.did,
    },
  };
  const signingInput = `${b64uJson(header)}.${b64uJson(payload)}`;
  const sig = ed25519.sign(new TextEncoder().encode(signingInput), opts.holder.privateKey);
  return `${signingInput}.${base64url.encode(sig)}`;
}

/** The X25519 keyAgreement material derived from an Ed25519 signing
 *  identity, ready to build a DIDComm `Identity`. */
export interface DidcommKeyAgreement {
  /** keyAgreement VM id (`<did>#<x25519-multibase>`), as the did:key resolver emits it. */
  keyAgreementKid: string;
  /** X25519 secret JWK ({kty:OKP, crv:X25519, x, d}). */
  secretJwk: { kty: "OKP"; crv: "X25519"; x: string; d: string };
}

/**
 * Derive the DIDComm X25519 keyAgreement material from an Ed25519
 * {@link SigningIdentity}. The X25519 key is the Montgomery form of the
 * same key — exactly as the `did:key` resolver derives the keyAgreement
 * VM — so one Ed25519 `did:key` serves both login (signing) and DIDComm
 * (authcrypt) under a single DID. The kid is taken from the resolver so
 * it matches byte-for-byte what counterparties address replies to.
 */
export function didcommKeyAgreementFromSigning(
  identity: SigningIdentity,
): DidcommKeyAgreement {
  const xPriv = ed25519.utils.toMontgomerySecret(identity.privateKey);
  const xPub = x25519.getPublicKey(xPriv);
  const doc = didKey.resolve(identity.did).didDocument as {
    keyAgreement?: string[];
  };
  const keyAgreementKid = doc.keyAgreement?.[0];
  if (!keyAgreementKid) {
    throw new Error("siop: Ed25519 did:key has no keyAgreement VM");
  }
  return {
    keyAgreementKid,
    secretJwk: {
      kty: "OKP",
      crv: "X25519",
      x: base64url.encode(xPub),
      d: base64url.encode(xPriv),
    },
  };
}

function b64uJson(value: unknown): string {
  return base64url.encode(new TextEncoder().encode(JSON.stringify(value)));
}
