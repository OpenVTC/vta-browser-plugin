import { ed25519, x25519 } from "@noble/curves/ed25519.js";
import { base64url, multibase } from "@openvtc/vti-didcomm-js";

import type { SigningIdentity } from "../siop/index.js";
import {
  checkAttestPayload,
  checkStepUpApproval,
  signApproverStatement,
  type TrustTaskEnvelope,
} from "../trust-tasks/index.js";
import { APPROVER_WRAP_ALGORITHM } from "./approver-prf-wrap.js";
import type { KVStore } from "./kv-store.js";
import { type SecretWrap, type WrappedSecret, unwrapSecret, wrapSecret } from "./secret-wrap.js";

// Step-up approvers: one Ed25519 `did:key` per relying party (VTC), held for
// `auth/step-up/approver/attest/0.1`.
//
// ## One per audience, so communities cannot correlate the user
//
// A VTC learns its approver's DID at enrolment and sees it on every statement.
// If one key served every community, any two of them could match the user by
// it. So each audience gets its own key, and nothing about one is derivable
// from another.
//
// ## Minted and sealed, not derived — and why
//
// The obvious alternative is to HKDF each audience's seed out of one
// PRF-protected root (`info = "vta-approver/v1" ‖ audience`). It was rejected
// for three reasons:
//
//   1. **A derived key needs the root to be named.** `approverIdentity` must
//      return an audience's DID with no gesture, but a key derived from a
//      gesture-locked root cannot be computed until the gesture — so the first
//      visit to a community would need a gesture just to say which key it
//      *would* use.
//   2. **A root is every key at once.** Unwrapping it to sign for one community
//      yields every community's key, including ones not yet visited. A minted
//      key per audience exposes only itself when unwrapped.
//   3. **Forgetting a community should forget its key.** Deleting a derived
//      key's record changes nothing — it can be re-derived. Deleting a minted
//      one is final.
//
// So each audience's seed comes from the CSPRNG and is **sealed to a wallet
// sealing key**: an X25519 key pair whose public half is stored in the clear
// and whose secret half is PRF-wrapped under the approver KEK
// (`ApproverPrfSecretWrap`, the same domain as the VTA DTTE approver). Minting
// for a new audience therefore needs only the public half — no gesture, and the
// seed is never at rest unsealed — while using any key needs the gesture that
// unwraps the sealing secret. The sealing key itself is created the first time
// a gesture is available (an approval, an enrolment, or a one-off setup
// prompt).
//
// Sealing is ephemeral-static X25519 → HKDF-SHA256 → AES-256-GCM, with the
// audience and the DID in both the HKDF info and the AAD, so a sealed seed
// cannot be moved to another audience's record, and an unsealed seed is
// checked against the DID it was filed under before it signs anything.
//
// ## Distinct from every other key
//
// The VTA DTTE approver (`approver-identity.ts`, one per VTA) is untouched and
// is a different key: this module never reads or writes its records. A step-up
// approver is fresh CSPRNG output, so it shares nothing with a persona (the
// VTA's, never in this browser), the holder, or a console key. Minting also
// refuses — cheaply, and against a failure that should never happen — a DID
// already on file anywhere in either approver store.

const PREFIX = "pnm/step-up-approver/v1/";
const SEAL_KEY = `${PREFIX}seal`;
const AUD_PREFIX = `${PREFIX}aud/`;
const DTTE_APPROVER_PREFIX = "pnm/approver-identity/v1/";
const SEAL_INFO = "pnm/step-up-approver/seal/v1";

function audienceKey(audience: string): string {
  return AUD_PREFIX + audience;
}

interface PersistedSealKeyV1 {
  /** X25519 public key, base64url. */
  publicKeyB64u: string;
  /** PRF-wrapped X25519 secret key. */
  wrappedSecret: WrappedSecret;
  schemaVersion: 1;
}

interface SealedSeedV1 {
  ephemeralPublicB64u: string;
  ivB64u: string;
  ciphertextB64u: string;
}

interface PersistedStepUpApproverV1 {
  /** The approver's `did:key:z6Mk…`. */
  did: string;
  /** `<did>#<ed-multikey>`. */
  signingKid: string;
  /** The relying party this approver is for. */
  audience: string;
  /** The Ed25519 seed, sealed to the wallet sealing key. */
  sealed: SealedSeedV1;
  createdAt: string;
  schemaVersion: 1;
}

/** Stable code: no sealing key exists yet, so a new audience's approver cannot
 *  be minted without a gesture (R3.7). */
export const STEP_UP_APPROVER_SETUP_REQUIRED = "step-up-approver/setup-required";

export class StepUpApproverSetupRequiredError extends Error {
  readonly code = STEP_UP_APPROVER_SETUP_REQUIRED;
  constructor() {
    super(
      "this wallet has no step-up approver key yet; approving the setup prompt creates one",
    );
    this.name = "StepUpApproverSetupRequiredError";
  }
}

function didKeyIds(edSecret: Uint8Array): { did: string; signingKid: string } {
  const edMb = multibase.encodeMultikey(
    multibase.MULTICODEC.ED25519_PUB,
    ed25519.getPublicKey(edSecret),
  );
  const did = `did:key:${edMb}`;
  return { did, signingKid: `${did}#${edMb}` };
}

async function sealKdf(
  shared: Uint8Array,
  ephemeralPublic: Uint8Array,
  sealPublic: Uint8Array,
  audience: string,
  did: string,
): Promise<{ key: CryptoKey; aad: Uint8Array }> {
  const enc = new TextEncoder();
  const binding = enc.encode(`${SEAL_INFO}\0${audience}\0${did}`);
  const ikm = await crypto.subtle.importKey("raw", shared as BufferSource, "HKDF", false, [
    "deriveKey",
  ]);
  const salt = new Uint8Array(ephemeralPublic.length + sealPublic.length);
  salt.set(ephemeralPublic, 0);
  salt.set(sealPublic, ephemeralPublic.length);
  const key = await crypto.subtle.deriveKey(
    { name: "HKDF", hash: "SHA-256", salt: salt as BufferSource, info: binding as BufferSource },
    ikm,
    { name: "AES-GCM", length: 256 },
    false,
    ["encrypt", "decrypt"],
  );
  return { key, aad: binding };
}

async function sealSeed(
  seed: Uint8Array,
  sealPublic: Uint8Array,
  audience: string,
  did: string,
): Promise<SealedSeedV1> {
  const eph = x25519.utils.randomSecretKey();
  const ephPublic = x25519.getPublicKey(eph);
  const shared = x25519.getSharedSecret(eph, sealPublic);
  eph.fill(0);
  const { key, aad } = await sealKdf(shared, ephPublic, sealPublic, audience, did);
  shared.fill(0);
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const ct = new Uint8Array(
    await crypto.subtle.encrypt(
      { name: "AES-GCM", iv: iv as BufferSource, additionalData: aad as BufferSource },
      key,
      seed as BufferSource,
    ),
  );
  return {
    ephemeralPublicB64u: base64url.encode(ephPublic),
    ivB64u: base64url.encode(iv),
    ciphertextB64u: base64url.encode(ct),
  };
}

async function unsealSeed(
  sealed: SealedSeedV1,
  sealSecret: Uint8Array,
  audience: string,
  did: string,
): Promise<Uint8Array> {
  const ephPublic = base64url.decode(sealed.ephemeralPublicB64u);
  const sealPublic = x25519.getPublicKey(sealSecret);
  const shared = x25519.getSharedSecret(sealSecret, ephPublic);
  const { key, aad } = await sealKdf(shared, ephPublic, sealPublic, audience, did);
  shared.fill(0);
  return new Uint8Array(
    await crypto.subtle.decrypt(
      {
        name: "AES-GCM",
        iv: base64url.decode(sealed.ivB64u) as BufferSource,
        additionalData: aad as BufferSource,
      },
      key,
      base64url.decode(sealed.ciphertextB64u) as BufferSource,
    ),
  );
}

function requireWrap(secretWrap: SecretWrap | undefined): SecretWrap {
  // A step-up approver key that is not behind a gesture is not a factor. There
  // is no plaintext fallback here, unlike the holder's, and only the approver
  // KEK domain will do.
  if (!secretWrap || secretWrap.algorithm !== APPROVER_WRAP_ALGORITHM) {
    throw new Error("a step-up approver key needs the approver PRF wrap");
  }
  return secretWrap;
}

async function createSealKey(store: KVStore, secretWrap: SecretWrap): Promise<Uint8Array> {
  const secret = x25519.utils.randomSecretKey();
  const wrapped = await wrapSecret(secret, secretWrap);
  const record: PersistedSealKeyV1 = {
    publicKeyB64u: base64url.encode(x25519.getPublicKey(secret)),
    wrappedSecret: wrapped,
    schemaVersion: 1,
  };
  await store.put(SEAL_KEY, record);
  secret.fill(0);
  return base64url.decode(record.publicKeyB64u);
}

async function knownApproverDids(store: KVStore): Promise<Set<string>> {
  const out = new Set<string>();
  for (const prefix of [AUD_PREFIX, DTTE_APPROVER_PREFIX]) {
    for (const k of await store.keys(prefix)) {
      const rec = await store.get<{ did?: unknown }>(k);
      if (typeof rec?.did === "string") out.add(rec.did);
    }
  }
  return out;
}

/** The step-up approver DID for `audience`, without minting or unwrapping
 *  anything. `null` when none has been minted. */
export async function stepUpApproverDid(store: KVStore, audience: string): Promise<string | null> {
  const rec = await store.get<PersistedStepUpApproverV1>(audienceKey(audience));
  return rec?.did ?? null;
}

/** Whether the wallet sealing key exists, i.e. a new audience's approver can be
 *  minted without a gesture. */
export async function hasStepUpApproverSealKey(store: KVStore): Promise<boolean> {
  return (await store.get<PersistedSealKeyV1>(SEAL_KEY)) !== undefined;
}

/**
 * The approver DID for `audience`, minting one if there is none.
 *
 * Minting needs the sealing key's public half only, so it needs no gesture once
 * that key exists. Without one, it is created from `secretWrap` (a gesture's
 * PRF output) when given, and otherwise this throws
 * {@link StepUpApproverSetupRequiredError}.
 */
export async function ensureStepUpApprover(
  store: KVStore,
  audience: string,
  opts: { secretWrap?: SecretWrap } = {},
): Promise<string> {
  if (typeof audience !== "string" || !audience.startsWith("did:")) {
    throw new Error("a step-up approver's audience must be a DID");
  }
  const existing = await stepUpApproverDid(store, audience);
  if (existing) return existing;

  const seal = await store.get<PersistedSealKeyV1>(SEAL_KEY);
  let sealPublic: Uint8Array;
  if (seal) {
    sealPublic = base64url.decode(seal.publicKeyB64u);
  } else if (opts.secretWrap) {
    sealPublic = await createSealKey(store, requireWrap(opts.secretWrap));
  } else {
    throw new StepUpApproverSetupRequiredError();
  }

  const seed = ed25519.utils.randomSecretKey();
  try {
    const ids = didKeyIds(seed);
    if ((await knownApproverDids(store)).has(ids.did)) {
      throw new Error("refusing to reuse an approver DID already on file");
    }
    const record: PersistedStepUpApproverV1 = {
      ...ids,
      audience,
      sealed: await sealSeed(seed, sealPublic, audience, ids.did),
      createdAt: new Date().toISOString(),
      schemaVersion: 1,
    };
    await store.put(audienceKey(audience), record);
    return ids.did;
  } finally {
    seed.fill(0);
  }
}

/**
 * Unseal the approver for `audience` with a gesture's PRF wrap, for one
 * signature. The unsealed seed is checked against the DID it was filed under.
 */
export async function loadStepUpApprover(
  store: KVStore,
  audience: string,
  secretWrap: SecretWrap,
): Promise<SigningIdentity | null> {
  const rec = await store.get<PersistedStepUpApproverV1>(audienceKey(audience));
  if (!rec) return null;
  if (rec.audience !== audience) throw new Error("step-up approver record is misfiled");
  const seal = await store.get<PersistedSealKeyV1>(SEAL_KEY);
  if (!seal) throw new Error("the step-up approver sealing key is missing");
  // `unwrapSecret` would accept a passthrough record without any wrap; a
  // sealing key stored that way is not behind a gesture, so it is refused.
  if (seal.wrappedSecret.algorithm !== APPROVER_WRAP_ALGORITHM) {
    throw new Error("the step-up approver sealing key is not PRF-wrapped");
  }
  const sealSecret = await unwrapSecret(seal.wrappedSecret, requireWrap(secretWrap));
  try {
    const seed = await unsealSeed(rec.sealed, sealSecret, audience, rec.did);
    const ids = didKeyIds(seed);
    if (ids.did !== rec.did || ids.signingKid !== rec.signingKid) {
      seed.fill(0);
      throw new Error("step-up approver key does not match its DID");
    }
    return {
      did: rec.did,
      kid: rec.signingKid,
      privateKey: seed,
      publicKey: ed25519.getPublicKey(seed),
    };
  } finally {
    sealSecret.fill(0);
  }
}

/** Forget the step-up approver for `audience`, or every one (and the sealing
 *  key) when omitted. Never touches the VTA DTTE approvers. */
export async function clearStepUpApprovers(store: KVStore, audience?: string): Promise<void> {
  if (audience) {
    await store.delete(audienceKey(audience));
    return;
  }
  for (const k of await store.keys(PREFIX)) await store.delete(k);
}

/**
 * Answer a step-up with the approver for `audience`: run
 * {@link checkStepUpApproval} against this wallet's own approver DID for the
 * audience (never one the caller names), unseal it with the gesture's wrap, and
 * sign the attest/0.1 statement. Refuses before unsealing when any check fails.
 */
export async function signStepUpApproval(
  store: KVStore,
  args: { request: unknown; operation: unknown; audience: string; secretWrap: SecretWrap },
): Promise<{ statement: TrustTaskEnvelope; approverDid: string }> {
  const approverDid = await stepUpApproverDid(store, args.audience);
  if (!approverDid) {
    throw new Error(`this wallet has no step-up approver for ${args.audience}; enrol one first`);
  }
  const payload = await checkStepUpApproval({ ...args, approverDid });
  const signing = await loadStepUpApprover(store, args.audience, args.secretWrap);
  if (!signing) throw new Error("step-up approver vanished before signing");
  try {
    return { statement: await signApproverStatement(payload, signing), approverDid };
  } finally {
    signing.privateKey.fill(0);
  }
}

/**
 * Sign an enrolment statement (attest/0.1, `purpose: enrol`) with the approver
 * for `audience`, minting it first if there is none. `boundTo` is signed as
 * given — what it names is route-dependent and the relying party's to define.
 */
export async function signEnrolAttestation(
  store: KVStore,
  args: {
    subject: string;
    audience: string;
    challenge: string;
    boundTo: string;
    secretWrap: SecretWrap;
  },
): Promise<{ statement: TrustTaskEnvelope; approverDid: string }> {
  const payload = checkAttestPayload({
    purpose: "enrol",
    subject: args.subject,
    audience: args.audience,
    challenge: args.challenge,
    boundTo: args.boundTo,
  });
  const approverDid = await ensureStepUpApprover(store, args.audience, {
    secretWrap: args.secretWrap,
  });
  const signing = await loadStepUpApprover(store, args.audience, args.secretWrap);
  if (!signing) throw new Error("step-up approver vanished before signing");
  try {
    return { statement: await signApproverStatement(payload, signing), approverDid };
  } finally {
    signing.privateKey.fill(0);
  }
}
