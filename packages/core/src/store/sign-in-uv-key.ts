import { ed25519 } from "@noble/curves/ed25519.js";
import { multibase } from "@openvtc/vti-didcomm-js";

import type { SigningIdentity } from "../siop/index.js";
import { SIGN_IN_UV_WRAP_ALGORITHM, SignInUvPrfSecretWrap } from "./approver-prf-wrap.js";
import type { KVStore } from "./kv-store.js";
import { type WrappedSecret, unwrapSecret, wrapSecret } from "./secret-wrap.js";

// The key that approves this browser's wallet sign-ins: one Ed25519 `did:key`
// per VTA, held sealed under the wallet's PRF passkey.
//
// The VTA signs an `auth/oob/grant` only on a `task-consent/decision` made by
// the device's enrolled UV key (VTA `oob_sign_in.rs`). A phone's UV key lives
// in its secure element and is released by a biometric. A browser has no such
// element, so this key is sealed instead: its seed is wrapped under a KEK
// derived from the PRF output of the wallet's passkey, which the authenticator
// yields only after user verification. Every approval runs that ceremony and
// unwraps the seed for one signature; nothing caches it. The VTA records it as
// its own kind (`prfSealedKey`), never as a hardware key.
//
// It reuses the wallet's one passkey, so a browser needs no second credential
// for sign-in approvals, and its KEK domain is its own
// (`SignInUvPrfSecretWrap`): the holder's and the approvers' records do not
// open with it, nor it with theirs. It is a separate key from both the VTA
// approver (`approver-identity.ts`) and the per-community step-up approvers
// (`step-up-approver.ts`), which confer authority this key never holds.

const STORE_KEY_PREFIX = "pnm/sign-in-uv-key/v1/";

function storeKey(vtaDid: string): string {
  return STORE_KEY_PREFIX + vtaDid;
}

interface PersistedSignInUvKeyV1 {
  /** `did:key:z6Mk…` (Ed25519, minted here). */
  did: string;
  /** `<did>#<multikey>`. */
  signingKid: string;
  /** The seed, wrapped by `SignInUvPrfSecretWrap`. */
  wrappedSecret: WrappedSecret;
  /** The VTA this key approves sign-ins at. */
  vtaDid: string;
  schemaVersion: 1;
}

function signingIdentity(edSecret: Uint8Array): SigningIdentity {
  const publicKey = ed25519.getPublicKey(edSecret);
  const mb = multibase.encodeMultikey(multibase.MULTICODEC.ED25519_PUB, publicKey);
  const did = `did:key:${mb}`;
  return { did, kid: `${did}#${mb}`, privateKey: edSecret, publicKey };
}

/**
 * This browser's sign-in approval key for `vtaDid`, unsealed with `prfOutput`
 * for the caller's one signature — minted and sealed first if there is none.
 *
 * `prfOutput` is the PRF result of the wallet passkey's ceremony for this
 * approval. A record not sealed by `SignInUvPrfSecretWrap` is refused rather
 * than opened: `unwrapSecret` would read a passthrough record as plaintext, and
 * a key stored that way is usable without anyone's gesture.
 */
export async function signInUvKey(
  store: KVStore,
  opts: { vtaDid: string; prfOutput: Uint8Array },
): Promise<{ signing: SigningIdentity; minted: boolean }> {
  const wrap = new SignInUvPrfSecretWrap(opts.prfOutput);
  const record = await store.get<PersistedSignInUvKeyV1>(storeKey(opts.vtaDid));
  if (record) {
    if (record.wrappedSecret.algorithm !== SIGN_IN_UV_WRAP_ALGORITHM) {
      throw new Error("the sign-in approval key is not sealed under the wallet's passkey");
    }
    const signing = signingIdentity(await unwrapSecret(record.wrappedSecret, wrap));
    if (signing.did !== record.did) throw new Error("the sign-in approval key does not match its record");
    return { signing, minted: false };
  }
  const edSecret = ed25519.utils.randomSecretKey();
  const signing = signingIdentity(edSecret);
  const next: PersistedSignInUvKeyV1 = {
    did: signing.did,
    signingKid: signing.kid,
    wrappedSecret: await wrapSecret(edSecret, wrap),
    vtaDid: opts.vtaDid,
    schemaVersion: 1,
  };
  await store.put(storeKey(opts.vtaDid), next);
  return { signing, minted: true };
}

/** The approval key's DID for `vtaDid`, without unsealing it, or `null`. */
export async function signInUvKeyDid(store: KVStore, vtaDid: string): Promise<string | null> {
  return (await store.get<PersistedSignInUvKeyV1>(storeKey(vtaDid)))?.did ?? null;
}

/** Forget the approval key for `vtaDid`. Idempotent. */
export async function forgetSignInUvKey(store: KVStore, vtaDid: string): Promise<void> {
  await store.delete(storeKey(vtaDid));
}
