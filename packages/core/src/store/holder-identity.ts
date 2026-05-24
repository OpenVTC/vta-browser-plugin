import { ed25519, x25519 } from "@noble/curves/ed25519.js";
import { base64url } from "@openvtc/vti-didcomm-js";
import { createDidPeer2 } from "../did/index.js";
import { Identity, type SecretJwk } from "../didcomm/index.js";
import type { SigningIdentity } from "../siop/index.js";
import type { KVStore } from "./kv-store.js";
import {
  type SecretWrap,
  type WrappedSecret,
  unwrapSecret,
  wrapSecret,
} from "./secret-wrap.js";

// v3: the holder is a single **Ed25519-rooted `did:peer:2`**. v2 used a
// `did:key`, which can sign + derive an X25519 keyAgreement key but CANNOT
// advertise a service endpoint — so an RP can't reach the wallet for
// inbound (RP-initiated) requests. A did:peer:2 encodes both keys plus the
// wallet's mediator service inline, making the wallet reachable, while
// staying self-certifying (resolves with no network).
//
// The Ed25519 secret is still the persisted root: it IS the authentication
// key, and the X25519 keyAgreement key is its Montgomery form, re-derived on
// every load. The DID exposes them at fixed VM ids (`#key-2` = Ed25519 auth,
// `#key-1` = X25519 keyAgreement) — see `createDidPeer2`.
const STORE_KEY = "pnm/holder-identity/v3";

interface PersistedHolder {
  /** The holder's `did:peer:2`. */
  did: string;
  /** Ed25519 authentication VM id (`<did>#key-2`) — the SIOP `id_token` kid. */
  signingKid: string;
  /** X25519 keyAgreement VM id (`<did>#key-1`) — for DIDComm authcrypt. */
  keyAgreementKid: string;
  /**
   * Legacy plaintext secret slot. New records use [`wrappedSecret`]
   * instead; this field is retained for backward compatibility
   * with wallets minted before the H1 wrap landed and is dropped
   * on the next save. Loader prefers `wrappedSecret` when both
   * are present.
   */
  edSecretB64u?: string;
  /**
   * H1: encryption-wrapped Ed25519 secret. Present on records
   * minted after the wrap landed; absent on legacy records that
   * still carry the plaintext `edSecretB64u`.
   */
  wrappedSecret?: WrappedSecret;
  /** Mediator DID baked into the DID's service endpoint (if any), for
   *  reference — the DID itself is the source of truth. */
  mediatorDid?: string;
}

export interface HolderIdentityResult {
  /** DIDComm key-agreement identity (X25519, `#key-1`) — used for authcrypt. */
  identity: Identity;
  /** Signing identity (Ed25519, `#key-2`) — self-issues SIOPv2 login
   *  `id_token`s and signs trust-task proofs. `.did` is the did:peer. */
  signing: SigningIdentity;
  /** True if this run minted a fresh identity (first launch); false if loaded. */
  freshlyMinted: boolean;
}

export interface HolderIdentityOptions {
  /** When set, the minted DID advertises a `DIDCommMessaging` service whose
   *  endpoint is this mediator DID — making the wallet reachable for inbound
   *  DIDComm. Only honoured on a FRESH mint (the persisted DID is immutable).
   *  Omit to mint a keys-only did:peer (sufficient for outbound login). */
  mediatorDid?: string;
  /**
   * H1: encryption wrapper for the persisted Ed25519 secret.
   * When supplied, fresh mints write `wrappedSecret` instead of
   * `edSecretB64u`, and existing wallets stored with a matching
   * wrap require the wrap on load to decrypt.
   *
   * Omit (or supply `PassthroughWrap`) for tests and legacy
   * callers. Production extension wrappers supply a
   * `WebAuthnPrfSecretWrap` so an exfiltrated IndexedDB row is
   * useless without the operator's authenticator.
   *
   * Backward compatibility: a record written before this option
   * landed (no `wrappedSecret`, plaintext `edSecretB64u`) loads
   * regardless of whether a wrap is supplied — the loader
   * detects the legacy shape and reads the plaintext. The
   * **next save** (e.g. mediator-DID rotation, future schema
   * upgrade) will re-persist using the wrap, migrating the
   * record forward.
   */
  secretWrap?: SecretWrap;
}

/**
 * Generate-or-load the wallet's holder identity (a `did:peer:2`) from a
 * `KVStore`. Only the Ed25519 secret is persisted; the DID + kids are
 * persisted alongside it (the DID is immutable once minted), and the X25519
 * keyAgreement key is re-derived on every load.
 *
 * Persistence is wrapped via the optional [`HolderIdentityOptions.secretWrap`]
 * — production extensions supply a `WebAuthnPrfSecretWrap` so storage
 * exfil yields ciphertext, not the wallet's signing key. Callers that
 * omit the wrap fall back to plaintext (legacy behaviour); the
 * loader handles both shapes for backward compatibility.
 */
export async function generateOrLoadHolderIdentity(
  store: KVStore,
  opts?: HolderIdentityOptions,
): Promise<HolderIdentityResult> {
  const persisted = await store.get<PersistedHolder>(STORE_KEY);
  if (persisted) {
    let edSecret: Uint8Array;
    if (persisted.wrappedSecret) {
      // New shape: read through the wrap. A wrap-algorithm
      // mismatch (record wrapped with X, caller supplied Y)
      // throws — the loader can't silently fall back without
      // risking a secret leak.
      edSecret = await unwrapSecret(persisted.wrappedSecret, opts?.secretWrap);
    } else if (persisted.edSecretB64u) {
      // Legacy shape: plaintext base64url. Pre-H1 wallets.
      edSecret = base64url.decode(persisted.edSecretB64u);
    } else {
      throw new Error("persisted holder record missing both wrappedSecret and edSecretB64u");
    }
    return {
      ...buildHolder(edSecret, persisted.did, persisted.signingKid, persisted.keyAgreementKid),
      freshlyMinted: false,
    };
  }

  const edSecret = ed25519.utils.randomSecretKey();
  const edPublic = ed25519.getPublicKey(edSecret);
  const x25519Public = x25519.getPublicKey(ed25519.utils.toMontgomerySecret(edSecret));

  const peer = createDidPeer2({
    ed25519PublicKey: edPublic,
    x25519PublicKey: x25519Public,
    ...(opts?.mediatorDid ? { service: { serviceEndpoint: opts.mediatorDid } } : {}),
  });

  const wrapped = await wrapSecret(edSecret, opts?.secretWrap);
  const record: PersistedHolder = {
    did: peer.did,
    signingKid: peer.authKid,
    keyAgreementKid: peer.keyAgreementKid,
    wrappedSecret: wrapped,
    ...(opts?.mediatorDid ? { mediatorDid: opts.mediatorDid } : {}),
  };
  await store.put(STORE_KEY, record);

  return {
    ...buildHolder(edSecret, peer.did, peer.authKid, peer.keyAgreementKid),
    freshlyMinted: true,
  };
}

/** Reconstruct the signing + DIDComm identities from the Ed25519 root secret
 *  and the (persisted/minted) did:peer + its VM ids. */
function buildHolder(
  edSecret: Uint8Array,
  did: string,
  signingKid: string,
  keyAgreementKid: string,
): { identity: Identity; signing: SigningIdentity } {
  const edPublic = ed25519.getPublicKey(edSecret);
  const xPrivate = ed25519.utils.toMontgomerySecret(edSecret);
  const xPublic = x25519.getPublicKey(xPrivate);

  const signing: SigningIdentity = {
    did,
    kid: signingKid,
    privateKey: edSecret,
    publicKey: edPublic,
  };

  const identity = Identity.fromSecretJwk({
    did,
    kid: keyAgreementKid,
    jwk: {
      kty: "OKP",
      crv: "X25519",
      x: base64url.encode(xPublic),
      d: base64url.encode(xPrivate),
    } as SecretJwk,
  });

  return { identity, signing };
}

/** Forget the persisted holder identity. Mostly for tests / hard reset. */
export async function clearHolderIdentity(store: KVStore): Promise<void> {
  await store.delete(STORE_KEY);
}
