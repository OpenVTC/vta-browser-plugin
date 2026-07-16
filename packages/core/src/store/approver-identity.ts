import { ed25519, x25519 } from "@noble/curves/ed25519.js";
import { multibase } from "@openvtc/vti-didcomm-js";

import type { Identity } from "../didcomm/index.js";
import type { SigningIdentity } from "../siop/index.js";
import { buildHolder } from "./holder-identity.js";
import type { KVStore } from "./kv-store.js";
import {
  type SecretWrap,
  type WrappedSecret,
  unwrapSecret,
  wrapSecret,
} from "./secret-wrap.js";

// Approver identity: a SECOND, distinct `did:key` the wallet mints locally and
// holds alongside the worker/holder identity, so one browser can run both the
// requester ("worker") and the human approver ("approver") roles.
//
// Two properties are non-negotiable, and both follow from it being a DISTINCT
// DID from the worker:
//   1. Separation of duties — the VTA's `excludeRequester` refuses a self-
//      approval, so the approver must not share the worker's DID.
//   2. Delegated authority — the approver's approval is what confers context
//      authority (per the VTA delegation model), so this is the identity the
//      operator registers in the VTA's `approver_set` + ACL as a context admin.
//
// The Ed25519 seed is PRF-wrapped at rest by a `WebAuthnPrfSecretWrap` the
// extension supplies, under a KEK *cryptographically separated* from the worker's
// (a distinct HKDF `info`), so the approver key is released only by a biometric /
// hardware gesture and a worker-key compromise never reaches it.

const STORE_KEY_PREFIX = "pnm/approver-identity/v1/";

function approverKey(vtaDid: string): string {
  return STORE_KEY_PREFIX + vtaDid;
}

interface PersistedApproverV1 {
  /** The approver's `did:key:z6Mk…` (Ed25519, locally minted). */
  did: string;
  /** Ed25519 verification-method id (`<did>#<ed-mb>`). */
  signingKid: string;
  /** X25519 keyAgreement VM id (`<did>#<x-mb>`), for authcrypting the decision. */
  keyAgreementKid: string;
  /** PRF-wrapped Ed25519 seed. */
  wrappedSecret: WrappedSecret;
  /** The VTA this approver acts at (one approver per onboarded VTA). */
  vtaDid: string;
  /** Schema version, for forward compatibility. Always 1 today. */
  schemaVersion: 1;
}

export interface ApproverIdentityResult {
  /** X25519 identity — the authcrypt sender for the decision. */
  identity: Identity;
  /** Ed25519 identity — signs the `task-consent/decision` proof. */
  signing: SigningIdentity;
  /** Convenience: the approver DID (`signing.did`). */
  did: string;
}

export interface ApproverIdentityOptions {
  vtaDid: string;
  /** The PRF wrap. Production callers MUST supply one: without it the seed is
   *  stored in plaintext, which defeats the entire purpose of a gated approver
   *  key. Optional only so tests can exercise the storage shape. */
  secretWrap?: SecretWrap;
}

/** Derive the `did:key` + both VM ids from an Ed25519 seed, using the standard
 *  did:key convention: the fragment is the key's multikey, and the keyAgreement
 *  VM is the Montgomery (X25519) form of the same key. */
function didKeyIdentifiers(edSecret: Uint8Array): {
  did: string;
  signingKid: string;
  keyAgreementKid: string;
} {
  const edPublic = ed25519.getPublicKey(edSecret);
  const xPublic = x25519.getPublicKey(ed25519.utils.toMontgomerySecret(edSecret));
  const edMb = multibase.encodeMultikey(multibase.MULTICODEC.ED25519_PUB, edPublic);
  const xMb = multibase.encodeMultikey(multibase.MULTICODEC.X25519_PUB, xPublic);
  const did = `did:key:${edMb}`;
  return { did, signingKid: `${did}#${edMb}`, keyAgreementKid: `${did}#${xMb}` };
}

/**
 * Mint a fresh approver identity for `vtaDid` and persist it (seed PRF-wrapped).
 * Throws if one already exists — minting is a deliberate one-time act, and a
 * silent re-mint would orphan an approver DID the VTA may already trust.
 */
export async function mintApproverIdentity(
  store: KVStore,
  opts: ApproverIdentityOptions,
): Promise<ApproverIdentityResult> {
  const existing = await store.get<PersistedApproverV1>(approverKey(opts.vtaDid));
  if (existing) {
    throw new Error(`approver identity already exists for ${opts.vtaDid}`);
  }
  const edSecret = ed25519.utils.randomSecretKey();
  const ids = didKeyIdentifiers(edSecret);
  const wrapped = await wrapSecret(edSecret, opts.secretWrap);
  const record: PersistedApproverV1 = {
    ...ids,
    wrappedSecret: wrapped,
    vtaDid: opts.vtaDid,
    schemaVersion: 1,
  };
  await store.put(approverKey(opts.vtaDid), record);
  return {
    ...buildHolder(edSecret, ids.did, ids.signingKid, ids.keyAgreementKid),
    did: ids.did,
  };
}

/**
 * Load the approver identity for `vtaDid`, unwrapping its seed via the PRF wrap.
 * Returns `null` if none has been minted. Propagates `WalletLockedError` from the
 * wrap when the biometric hasn't released the approver KEK — the caller must run
 * the per-decision unlock ceremony first.
 */
export async function loadApproverIdentity(
  store: KVStore,
  opts: ApproverIdentityOptions,
): Promise<ApproverIdentityResult | null> {
  const record = await store.get<PersistedApproverV1>(approverKey(opts.vtaDid));
  if (!record) return null;
  const edSecret = await unwrapSecret(record.wrappedSecret, opts.secretWrap);
  return {
    ...buildHolder(edSecret, record.did, record.signingKid, record.keyAgreementKid),
    did: record.did,
  };
}

/**
 * The approver DID for `vtaDid` without unwrapping the key — safe to render in
 * the UI so the operator can copy it into the VTA's `approver_set` + ACL. Returns
 * `null` when no approver has been minted yet.
 */
export async function approverDid(
  store: KVStore,
  vtaDid: string,
): Promise<string | null> {
  const record = await store.get<PersistedApproverV1>(approverKey(vtaDid));
  return record?.did ?? null;
}

/** Forget the approver identity for `vtaDid`, or every approver if omitted. */
export async function clearApproverIdentity(
  store: KVStore,
  vtaDid?: string,
): Promise<void> {
  if (vtaDid) {
    await store.delete(approverKey(vtaDid));
    return;
  }
  for (const k of await store.keys(STORE_KEY_PREFIX)) {
    await store.delete(k);
  }
}
