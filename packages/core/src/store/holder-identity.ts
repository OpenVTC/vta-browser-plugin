import { Identity, type SecretJwk } from "../didcomm/index.js";
import { base64urlToBytes } from "../webauthn/base64url.js";
import { encodeMultikey } from "../webauthn/multikey.js";
import type { KVStore } from "./kv-store.js";

const STORE_KEY = "pnm/holder-identity/v1";

interface PersistedHolder {
  /** `did` of the holder. */
  did: string;
  /** Key-agreement key id (`<did>#…`). */
  kid: string;
  /** Secret JWK as exported by `Identity.secretJwk()` — `{kty, crv, x, d}`. */
  jwk: SecretJwk;
}

/** Multicodec for `x25519-pub`: `0xec`. Varint-encoded as `[0xec, 0x01]`. */
const X25519_PUB_MULTICODEC = 0xec;

function didKeyFromX25519PublicX(xB64u: string): string {
  const pub = base64urlToBytes(xB64u);
  return `did:key:${encodeMultikey(X25519_PUB_MULTICODEC, pub)}`;
}

export interface HolderIdentityResult {
  identity: Identity;
  /** True if this run minted a fresh identity (first launch); false if loaded. */
  freshlyMinted: boolean;
}

/**
 * Generate-or-load the wallet's holder identity from a `KVStore`.
 *
 * On first run:
 *   1. Generate an X25519 keypair in WASM (Identity.generate).
 *   2. Derive a conformant `did:key` from the X25519 public key.
 *   3. Re-create the Identity with the proper DID via fromSecretJwk
 *      so the `kid` is `<did>#key-agreement-1` referencing the
 *      computed DID, not a placeholder.
 *   4. Persist the secret JWK to the KVStore.
 *
 * On subsequent runs:
 *   1. Read the persisted JWK from the KVStore.
 *   2. Reconstruct Identity via fromSecretJwk.
 *
 * Persistence is plaintext at the store layer. Production wrappers
 * should encrypt via WebAuthn PRF-derived key or similar before
 * writing.
 */
export async function generateOrLoadHolderIdentity(
  store: KVStore,
): Promise<HolderIdentityResult> {
  const persisted = await store.get<PersistedHolder>(STORE_KEY);
  if (persisted) {
    const identity = Identity.fromSecretJwk({
      did: persisted.did,
      kid: persisted.kid,
      jwk: persisted.jwk,
    });
    return { identity, freshlyMinted: false };
  }

  // First-run generation. Mint with a temporary DID, compute the
  // proper did:key from the public X, then rebuild with the real
  // DID so kids reference it correctly.
  const tmp = Identity.generate("did:pnm:tmp-bootstrap");
  const tmpPub = tmp.publicJwk() as { kid: string; jwk: { x: string } };
  const did = didKeyFromX25519PublicX(tmpPub.jwk.x);

  const tmpSecret = tmp.secretJwk() as PersistedHolder;
  tmp.dispose();

  const persistedRecord: PersistedHolder = {
    did,
    kid: `${did}#key-agreement-1`,
    jwk: tmpSecret.jwk,
  };
  await store.put(STORE_KEY, persistedRecord);

  const identity = Identity.fromSecretJwk({
    did: persistedRecord.did,
    kid: persistedRecord.kid,
    jwk: persistedRecord.jwk,
  });
  return { identity, freshlyMinted: true };
}

/** Forget the persisted holder identity. Mostly for tests / hard reset. */
export async function clearHolderIdentity(store: KVStore): Promise<void> {
  await store.delete(STORE_KEY);
}
