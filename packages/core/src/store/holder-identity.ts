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

// v3: the holder is a single **Ed25519-rooted `did:peer:2`** the wallet
// MINTS locally on first run. v2 used a `did:key`, which can sign + derive
// an X25519 keyAgreement key but CANNOT advertise a service endpoint — so
// an RP can't reach the wallet for inbound (RP-initiated) requests. A
// did:peer:2 encodes both keys plus the wallet's mediator service inline,
// making the wallet reachable, while staying self-certifying (resolves
// with no network).
//
// v4: the holder is an Ed25519 **`did:key`** the VTA MINTS during the
// provision-integration flow. The wallet ships its ephemeral did:key to
// the VTA, which mints a long-term admin DID + keys + authorization VC
// and ships them back HPKE-sealed; the wallet adopts the result as its
// holder. The DID method changes — did:key has no service endpoint, so
// the wallet is no longer reachable inbound at the holder layer. RP-
// initiated DIDComm is out-of-scope for v4 (the wallet only initiates).
//
// v4 reads ALWAYS preferred over v3 by the strict loader; v3 records left
// over from a pre-v4 wallet surface as `RequiresReonboardError` so the
// operator can re-onboard at a VTA and adopt a freshly-minted v4 identity.
//
// The Ed25519 secret is the persisted root in both shapes: it IS the
// authentication key, and the X25519 keyAgreement key is its Montgomery
// form, re-derived on every load.
const STORE_KEY = "pnm/holder-identity/v3";
// Legacy single-VTA v4 key. Read-only after multi-VTA landed; records
// found here are migrated to the per-vta path on first access and the
// legacy key is deleted. Kept defined (not exported) so the migration
// helper can read it without re-typing the constant.
const STORE_KEY_V4_LEGACY = "pnm/holder-identity/v4";
// Per-VTA v4 key prefix. Each VTA the wallet has been onboarded at
// has its own record under `{prefix}{vtaDid}`. The trailing `/`
// disambiguates the prefix-scan from the legacy singleton key so a
// caller listing records doesn't accidentally pick up the legacy
// row before its migration ran.
const STORE_KEY_V4_PREFIX = "pnm/holder-identity/v4/";

function v4Key(vtaDid: string): string {
  return STORE_KEY_V4_PREFIX + vtaDid;
}

/**
 * Migrate the legacy single-VTA v4 record (if present) to its
 * per-vta key, using the record's own `vtaDid` field as the path
 * suffix. Idempotent: a second call after migration is a no-op
 * (legacy key is gone, return value is `null`). Returns the migrated
 * record so the immediate caller can use it without a second read.
 *
 * Called inline from every read path so installs predating multi-VTA
 * are picked up on whichever read fires first after upgrade.
 */
async function migrateLegacyV4Record(store: KVStore): Promise<PersistedHolderV4 | null> {
  const legacy = await store.get<PersistedHolderV4>(STORE_KEY_V4_LEGACY);
  if (!legacy) return null;
  // Write FIRST, delete after — a crash between the two leaves the
  // legacy row in place; the next read re-runs the migration.
  await store.put(v4Key(legacy.vtaDid), legacy);
  await store.delete(STORE_KEY_V4_LEGACY);
  return legacy;
}

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

/** Forget every persisted holder identity. Mostly for tests / hard
 *  reset (the options page "wipe wallet" button). Clears the v3 row,
 *  the legacy single-VTA v4 row, AND every per-vta v4 record. After
 *  this the wallet looks freshly installed at every VTA. */
export async function clearHolderIdentity(store: KVStore): Promise<void> {
  await store.delete(STORE_KEY);
  await store.delete(STORE_KEY_V4_LEGACY);
  const perVtaKeys = await store.keys(STORE_KEY_V4_PREFIX);
  for (const k of perVtaKeys) {
    await store.delete(k);
  }
}

// ─── v4: VTA-minted did:key ───
//
// Persisted by `installVtaMintedHolder` after a successful provision-integration
// round-trip; loaded by `loadHolderStrict` (the extension's loading path).

interface PersistedHolderV4 {
  /** The holder's `did:key:z6Mk…` (Ed25519, VTA-minted). */
  did: string;
  /** Ed25519 verification-method id (`<did>#<ed-mb>` — for a did:key,
   *  the fragment equals the multibase identifier in the DID itself). */
  signingKid: string;
  /** X25519 keyAgreement VM id (`<did>#<x-mb>` — derived from the
   *  Ed25519 pubkey via Montgomery clamping; same convention the VTA's
   *  did:key resolver uses). */
  keyAgreementKid: string;
  /** Encryption-wrapped Ed25519 seed — same wrapping primitives as v3. */
  wrappedSecret: WrappedSecret;
  /** Provenance: the VTA that minted this identity. Used by the popup
   *  to show "minted by <vta>" + by re-connect flows to know which VTA
   *  to authenticate against. Set at install; immutable afterwards. */
  vtaDid: string;
  /** REST base URL the VTA advertises, if any — cached so the wallet
   *  doesn't have to re-resolve services on every connect. */
  vtaUrl?: string;
  /** Schema version, for forward compatibility. Always 4 today. */
  schemaVersion: 4;
}

/** Thrown by `loadHolderStrict` when neither a v3 nor a v4 holder record
 *  exists — the wallet is on a fresh install and the operator should
 *  proceed with onboarding. */
export class NoHolderError extends Error {
  constructor() {
    super("no persisted holder identity — onboard with a VTA");
    this.name = "NoHolderError";
  }
}

/** Thrown by `loadHolderStrict` when a v3 (self-derived did:peer) record
 *  exists but no v4 (VTA-minted did:key) record. The wallet was built
 *  before the M2C identity migration; the operator must re-onboard so the
 *  VTA mints a fresh long-term DID. The old did:peer is unusable as the
 *  wallet's holder going forward — every RP that recognised it must be
 *  re-granted with the new VTA-minted DID.
 *
 *  `previousDid` is the v3 DID, surfaced for the migration UI so the
 *  operator can audit what they're abandoning. */
export class RequiresReonboardError extends Error {
  readonly previousDid: string;
  constructor(previousDid: string) {
    super(
      `pre-v4 holder identity (${previousDid}) — re-onboard required: ` +
        "this build expects a VTA-minted holder DID. Connect to a VTA to mint a fresh identity.",
    );
    this.name = "RequiresReonboardError";
    this.previousDid = previousDid;
  }
}

export interface LoadHolderStrictOptions {
  /** Which VTA's holder identity to load. Each VTA the wallet has been
   *  onboarded at has its own per-VTA holder record (the v4 schema is
   *  multi-instance — one record per VTA). Pass the VTA DID the
   *  operation is targeting; the store contains exactly one v4 record
   *  per `(vtaDid)` pair. */
  vtaDid: string;
  /** Wrap that decrypts the persisted Ed25519 seed. Same semantics as
   *  `HolderIdentityOptions.secretWrap` — omit for plaintext (tests /
   *  legacy), supply a `WebAuthnPrfSecretWrap` in production. */
  secretWrap?: SecretWrap;
}

/** Load the wallet's holder identity for the given VTA, strictly
 *  preferring v4.
 *
 *  - v4 record for `vtaDid` present → return the VTA-minted holder.
 *  - no v4 record for `vtaDid` but a legacy single-VTA v4 record
 *    exists → migrate it to the per-vta path (transparently) and
 *    return if its `vtaDid` matches the requested one.
 *  - no v4 (for `vtaDid` or legacy) but v3 present → throw
 *    `RequiresReonboardError` (the operator needs to re-onboard so the
 *    VTA mints a v4 identity).
 *  - none of the above → throw `NoHolderError` (fresh install). */
export async function loadHolderStrict(
  store: KVStore,
  opts: LoadHolderStrictOptions,
): Promise<HolderIdentityResult> {
  let v4 = await store.get<PersistedHolderV4>(v4Key(opts.vtaDid));
  if (!v4) {
    // Inline migration of the legacy single-VTA v4 record. If the
    // legacy row's vtaDid matches the requested one, use it now;
    // otherwise fall through (the wallet is onboarded at a different
    // VTA than the one being asked for).
    const migrated = await migrateLegacyV4Record(store);
    if (migrated && migrated.vtaDid === opts.vtaDid) {
      v4 = migrated;
    }
  }
  if (v4) {
    const edSecret = await unwrapSecret(v4.wrappedSecret, opts.secretWrap);
    return {
      ...buildHolder(edSecret, v4.did, v4.signingKid, v4.keyAgreementKid),
      freshlyMinted: false,
    };
  }
  const v3 = await store.get<PersistedHolder>(STORE_KEY);
  if (v3) {
    throw new RequiresReonboardError(v3.did);
  }
  throw new NoHolderError();
}

export interface InstallVtaMintedHolderOptions {
  /** The freshly-minted did:key the VTA shipped (e.g. `did:key:z6Mk…`). */
  did: string;
  /** Ed25519 verification-method id (`<did>#<ed-mb>`). The VTA's
   *  template renderer emits this; for `vta-admin` the fragment is the
   *  Ed25519 public-key multibase. */
  signingKid: string;
  /** X25519 keyAgreement verification-method id (`<did>#<x-mb>`).
   *  Derived from the Ed25519 pubkey via Montgomery clamping; the VTA
   *  also emits this in the sealed bundle. */
  keyAgreementKid: string;
  /** 32-byte Ed25519 seed the VTA minted and shipped sealed. The wallet
   *  decoded it from the bundle's `admin.signing_key.private_key_multibase`. */
  edSeed: Uint8Array;
  /** Provenance — the VTA that minted this identity. */
  vtaDid: string;
  /** VTA's REST base URL, if advertised. */
  vtaUrl?: string;
  /** Optional secret wrap. Production extensions supply a
   *  WebAuthnPrfSecretWrap; tests omit. */
  secretWrap?: SecretWrap;
}

/** Persist a freshly-minted VTA holder as the wallet's v4 identity.
 *
 *  Returns the rebuilt `HolderIdentityResult` so the caller can use the
 *  identity immediately without an extra load. Clears any pre-existing
 *  v3 record on a successful install — the migration is a one-way move
 *  and a stale v3 record sitting alongside v4 is just a footgun for a
 *  future loader. */
export async function installVtaMintedHolder(
  store: KVStore,
  opts: InstallVtaMintedHolderOptions,
): Promise<HolderIdentityResult> {
  if (opts.edSeed.length !== 32) {
    throw new Error(
      `installVtaMintedHolder: edSeed must be 32 bytes (got ${opts.edSeed.length})`,
    );
  }
  const wrapped = await wrapSecret(opts.edSeed, opts.secretWrap);
  const record: PersistedHolderV4 = {
    did: opts.did,
    signingKid: opts.signingKid,
    keyAgreementKid: opts.keyAgreementKid,
    wrappedSecret: wrapped,
    vtaDid: opts.vtaDid,
    ...(opts.vtaUrl ? { vtaUrl: opts.vtaUrl } : {}),
    schemaVersion: 4,
  };
  await store.put(v4Key(opts.vtaDid), record);
  // Migration: drop the legacy did:peer record so the next strict load
  // doesn't re-prompt the operator to re-onboard. Without this, a wallet
  // that successfully onboarded but kept the v3 row would loop on its
  // first reload.
  await store.delete(STORE_KEY);
  // Also drop the legacy single-VTA v4 record if present — the per-vta
  // record is the new source of truth. Idempotent: a no-op if the
  // legacy row was already migrated or never existed.
  await store.delete(STORE_KEY_V4_LEGACY);
  return {
    ...buildHolder(opts.edSeed, opts.did, opts.signingKid, opts.keyAgreementKid),
    freshlyMinted: true,
  };
}

export interface RewrapHolderV4Options {
  /** Which VTA's holder record to re-wrap. Multi-VTA: each VTA has
   *  its own v4 record; the rewrap targets exactly one. */
  vtaDid: string;
  /** Wrap that DECRYPTS the currently-persisted v4 record. Pass the
   *  wrap the wallet was using before the migration. Pass `undefined`
   *  when the existing record uses `PassthroughWrap` (plaintext),
   *  which is the typical post-onboard state. */
  fromWrap?: SecretWrap;
  /** Wrap to apply on the re-persisted record. Pass the wrap the
   *  wallet should use going forward (e.g. a `WebAuthnPrfSecretWrap`
   *  in the popup's visible context). Pass `undefined` to switch
   *  back to plaintext. */
  toWrap?: SecretWrap;
}

/** Re-wrap the persisted v4 holder secret in place, preserving the
 *  wallet's DID + verification-method ids + VTA provenance.
 *
 *  The canonical caller is the popup's post-onboard "Encrypt your
 *  wallet?" prompt: the operator clicks the button, the popup runs
 *  `navigator.credentials.create` (visible context, fresh user
 *  gesture), and re-wraps the existing passthrough record under
 *  the PRF-derived AES-GCM key. The wallet DID stays the same — no
 *  re-grant in any RP ACL, no re-onboarding.
 *
 *  Mirrors the v3 `rewrapHolderSecret` but reads + writes the v4
 *  record (`STORE_KEY_V4`). Future cleanup could consolidate the
 *  two into one schema-version-aware function; kept separate for
 *  now so the v3 path's legacy `edSecretB64u` fallback doesn't
 *  leak into v4's cleaner shape.
 *
 *  Throws if no v4 record exists. The popup should only invoke this
 *  AFTER `installVtaMintedHolder` has run. */
export async function rewrapHolderV4Secret(
  store: KVStore,
  opts: RewrapHolderV4Options,
): Promise<HolderIdentityResult> {
  let persisted = await store.get<PersistedHolderV4>(v4Key(opts.vtaDid));
  if (!persisted) {
    // Try migrating a legacy single-VTA row into the per-vta path,
    // then re-read. Same idempotent helper used by `loadHolderStrict`.
    const migrated = await migrateLegacyV4Record(store);
    if (migrated && migrated.vtaDid === opts.vtaDid) {
      persisted = migrated;
    }
  }
  if (!persisted) {
    throw new Error(`no persisted v4 holder identity to re-wrap for ${opts.vtaDid}`);
  }

  // 1. Recover the raw seed using the from-wrap. `unwrapSecret`
  //    dispatches on the stored record's `algorithm`, so a
  //    PassthroughWrap record opens regardless of which wrap the
  //    caller supplies (they're typically passing the new
  //    encryption-target wrap, not the existing passthrough).
  const edSecret = await unwrapSecret(persisted.wrappedSecret, opts.fromWrap);

  // 2. Re-wrap with the to-wrap and write back. Same shape as
  //    `installVtaMintedHolder`'s write path; only `wrappedSecret`
  //    actually changes.
  const wrapped = await wrapSecret(edSecret, opts.toWrap);
  const next: PersistedHolderV4 = {
    did: persisted.did,
    signingKid: persisted.signingKid,
    keyAgreementKid: persisted.keyAgreementKid,
    wrappedSecret: wrapped,
    vtaDid: persisted.vtaDid,
    ...(persisted.vtaUrl ? { vtaUrl: persisted.vtaUrl } : {}),
    schemaVersion: 4,
  };
  await store.put(v4Key(persisted.vtaDid), next);

  return {
    ...buildHolder(edSecret, persisted.did, persisted.signingKid, persisted.keyAgreementKid),
    freshlyMinted: false,
  };
}

export type HolderIdentityStateResult =
  | { kind: "none" }
  | { kind: "v3"; did: string }
  | { kind: "v4"; did: string; vtaDid: string; wrapAlgorithm: string };

/** Inspect the persisted state without throwing. Used by the popup to
 *  decide which onboarding screen to show.
 *
 *  For v4 records, `wrapAlgorithm` reveals whether the secret is
 *  encrypted at rest. `"passthrough"` means plaintext (the operator
 *  hasn't enabled encryption); anything else (currently only
 *  `"webauthn-prf-aes-gcm"`) means the popup needs to run an
 *  unlock ceremony before offscreen can load the holder identity.
 *
 *  When `vtaDid` is passed: returns the state for that specific
 *  VTA's holder record. Used by the popup's active-VTA probe.
 *  When `vtaDid` is omitted: returns the first v4 record found
 *  (after migrating any legacy single-VTA row), else falls back to
 *  v3 / none. Used for the initial fresh-install / migration-banner
 *  decision before an active VTA has been selected. */
export async function holderIdentityState(
  store: KVStore,
  vtaDid?: string,
): Promise<HolderIdentityStateResult> {
  // Migrate the legacy row if present — it joins the per-vta keyspace
  // and will be picked up by the lookups below.
  await migrateLegacyV4Record(store);

  if (vtaDid !== undefined) {
    const v4 = await store.get<PersistedHolderV4>(v4Key(vtaDid));
    if (v4) {
      return {
        kind: "v4",
        did: v4.did,
        vtaDid: v4.vtaDid,
        wrapAlgorithm: v4.wrappedSecret.algorithm,
      };
    }
  } else {
    // No specific VTA — scan the per-vta keyspace and return the
    // first match. The popup uses this for the migration banner
    // detection (any v4 present at all → skip the v3 banner).
    const keys = await store.keys(STORE_KEY_V4_PREFIX);
    if (keys.length > 0) {
      const first = await store.get<PersistedHolderV4>(keys[0]!);
      if (first) {
        return {
          kind: "v4",
          did: first.did,
          vtaDid: first.vtaDid,
          wrapAlgorithm: first.wrappedSecret.algorithm,
        };
      }
    }
  }
  const v3 = await store.get<PersistedHolder>(STORE_KEY);
  if (v3) return { kind: "v3", did: v3.did };
  return { kind: "none" };
}

export interface HolderRecordSummary {
  vtaDid: string;
  did: string;
  /** Encryption algorithm of the persisted secret. `"passthrough"` =
   *  plaintext at rest. */
  wrapAlgorithm: string;
}

/** Enumerate every v4 holder record on disk — one per VTA the wallet
 *  has been onboarded at. Powers the popup's multi-VTA dropdown
 *  (PR 2). Migrates the legacy single-VTA row inline so a wallet
 *  upgraded from a single-VTA build surfaces its one wallet here. */
export async function listHolderRecords(store: KVStore): Promise<HolderRecordSummary[]> {
  await migrateLegacyV4Record(store);
  const keys = await store.keys(STORE_KEY_V4_PREFIX);
  const out: HolderRecordSummary[] = [];
  for (const k of keys) {
    const r = await store.get<PersistedHolderV4>(k);
    if (!r) continue;
    out.push({
      vtaDid: r.vtaDid,
      did: r.did,
      wrapAlgorithm: r.wrappedSecret.algorithm,
    });
  }
  return out;
}

/** Delete the v4 holder record for a specific VTA. Companion to
 *  `installVtaMintedHolder`. Idempotent: a no-op when the record is
 *  already gone. Other VTAs' records are left alone — call
 *  `clearHolderIdentity` to wipe every wallet on this device. */
export async function forgetHolderRecord(store: KVStore, vtaDid: string): Promise<void> {
  await store.delete(v4Key(vtaDid));
}

export interface RewrapOptions {
  /**
   * Wrap that decrypts the currently-persisted secret. Pass the
   * wrap the wallet was using before the migration (or `undefined`
   * if it was plaintext).
   */
  fromWrap?: SecretWrap;
  /**
   * Wrap to apply on the re-persisted record. Pass the wrap the
   * wallet should use going forward (or `undefined` to switch back
   * to plaintext).
   */
  toWrap?: SecretWrap;
}

/**
 * Re-wrap the persisted holder secret in place, preserving the
 * wallet's DID + verification-method ids + mediator endpoint.
 *
 * Used by the extension's settings UI when the operator flips
 * the `encryptHolderSecret` toggle — the existing wallet keeps
 * its identity (no re-grant in any RP ACL) but the on-disk
 * secret transitions between plaintext and wrap-encrypted.
 *
 * Returns the rebuilt `HolderIdentityResult` so the caller can
 * report the (unchanged) DID back to the operator immediately.
 *
 * Errors if no persisted record exists — caller should check
 * `freshlyMinted` semantics first (a fresh-mint wallet has no
 * pre-existing secret to re-wrap).
 */
export async function rewrapHolderSecret(
  store: KVStore,
  opts: RewrapOptions,
): Promise<HolderIdentityResult> {
  const persisted = await store.get<PersistedHolder>(STORE_KEY);
  if (!persisted) {
    throw new Error("no persisted holder identity to re-wrap");
  }

  // 1. Recover the raw secret using the from-wrap.
  let edSecret: Uint8Array;
  if (persisted.wrappedSecret) {
    edSecret = await unwrapSecret(persisted.wrappedSecret, opts.fromWrap);
  } else if (persisted.edSecretB64u) {
    edSecret = base64url.decode(persisted.edSecretB64u);
  } else {
    throw new Error("persisted record missing both wrappedSecret and edSecretB64u");
  }

  // 2. Re-wrap with the to-wrap and write back. Drop the legacy
  //    plaintext slot on the way out so a partially-migrated
  //    record can't load through the legacy path on the next
  //    boot.
  const wrapped = await wrapSecret(edSecret, opts.toWrap);
  const next: PersistedHolder = {
    did: persisted.did,
    signingKid: persisted.signingKid,
    keyAgreementKid: persisted.keyAgreementKid,
    wrappedSecret: wrapped,
    ...(persisted.mediatorDid ? { mediatorDid: persisted.mediatorDid } : {}),
  };
  await store.put(STORE_KEY, next);

  return {
    ...buildHolder(edSecret, persisted.did, persisted.signingKid, persisted.keyAgreementKid),
    freshlyMinted: false,
  };
}
