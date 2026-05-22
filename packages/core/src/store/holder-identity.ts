import { base64url } from "@openvtc/vti-didcomm-js";
import { Identity, type SecretJwk } from "../didcomm/index.js";
import {
  didcommKeyAgreementFromSigning,
  generateSigningIdentity,
  signingIdentityFromSecret,
  type SigningIdentity,
} from "../siop/index.js";
import type { KVStore } from "./kv-store.js";

// v2: the holder is an Ed25519 `did:key`. v1 (X25519-only) is superseded
// — an X25519 key can't sign, so it couldn't self-issue a SIOPv2 login
// `id_token`. The Ed25519 key signs login AND derives the X25519
// keyAgreement key for DIDComm, so one DID covers both roles.
const STORE_KEY = "pnm/holder-identity/v2";

interface PersistedHolder {
  /** The holder's Ed25519 `did:key`. */
  did: string;
  /** Ed25519 signing verification-method id (`<did>#<multibase>`). */
  signingKid: string;
  /** Ed25519 secret scalar, base64url. The root key — the X25519
   *  keyAgreement key is derived from it on load, never stored. */
  edSecretB64u: string;
}

export interface HolderIdentityResult {
  /** DIDComm key-agreement identity (the X25519 derived from the holder's
   *  Ed25519 key) — used for authcrypt. */
  identity: Identity;
  /** Signing identity (the holder's Ed25519 key) — used to self-issue
   *  SIOPv2 login `id_token`s and to sign trust-task proofs. */
  signing: SigningIdentity;
  /** True if this run minted a fresh identity (first launch); false if loaded. */
  freshlyMinted: boolean;
}

/**
 * Generate-or-load the wallet's holder identity from a `KVStore`.
 *
 * The holder is a single **Ed25519 `did:key`**. From it we expose two
 * verification methods:
 *   - **signing** (authentication) — the Ed25519 key, for SIOPv2 login.
 *   - **keyAgreement** — the X25519 key derived (Montgomery form) from
 *     the same Ed25519 key, for DIDComm authcrypt.
 *
 * Only the Ed25519 secret is persisted; the X25519 keyAgreement key is
 * re-derived on every load (matching the `did:key` resolver exactly).
 *
 * Persistence is plaintext at the store layer. Production wrappers should
 * encrypt via a WebAuthn PRF-derived key or similar before writing.
 */
export async function generateOrLoadHolderIdentity(
  store: KVStore,
): Promise<HolderIdentityResult> {
  const persisted = await store.get<PersistedHolder>(STORE_KEY);
  if (persisted) {
    const signing = signingIdentityFromSecret(base64url.decode(persisted.edSecretB64u));
    return { ...buildHolder(signing), freshlyMinted: false };
  }

  const signing = generateSigningIdentity();
  const record: PersistedHolder = {
    did: signing.did,
    signingKid: signing.kid,
    edSecretB64u: base64url.encode(signing.privateKey),
  };
  await store.put(STORE_KEY, record);
  return { ...buildHolder(signing), freshlyMinted: true };
}

/** Build the DIDComm key-agreement `Identity` (derived X25519) that
 *  pairs with the holder's Ed25519 signing identity. */
function buildHolder(signing: SigningIdentity): {
  identity: Identity;
  signing: SigningIdentity;
} {
  const ka = didcommKeyAgreementFromSigning(signing);
  const identity = Identity.fromSecretJwk({
    did: signing.did,
    kid: ka.keyAgreementKid,
    jwk: ka.secretJwk as SecretJwk,
  });
  return { identity, signing };
}

/** Forget the persisted holder identity. Mostly for tests / hard reset. */
export async function clearHolderIdentity(store: KVStore): Promise<void> {
  await store.delete(STORE_KEY);
}
