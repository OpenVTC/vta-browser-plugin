// DID document verification methods → key bytes, chosen by relationship.
//
// TO BE REPLACED by `@openvtc/vti-didcomm-js/verification-method` (its
// `publicKeyOf`, `selectKey`, `x25519KeyAgreement`) when this package moves to
// the vti-didcomm-js release that ships it (vti-didcomm-js #39). This is a port
// of that module, rule for rule and with the same signatures, so the swap is
// an import change and a deletion — not a second implementation to keep in
// step (R4.1: don't fork fixes). Change the library first; mirror here only
// until the bump.
//
// The one place this package turns a verification method into a public key.
// Every site that reads a key out of a DID document — Trust-Task proof
// verification, the TSP VID signing key, a member's directory-card keys, a
// Domain Linkage Credential's key — goes through here, so a DID method that
// publishes its keys differently is supported everywhere at once or nowhere.
//
// Two encodings are read:
//
//   - `publicKeyMultibase` (multicodec multikey) — did:key, did:peer,
//     did:webvh, did:scid. Types `Multikey`, `Ed25519VerificationKey2020`,
//     `X25519KeyAgreementKey2020`, `X25519KeyAgreementKey2019`.
//   - `publicKeyJwk` — did:webs (`JsonWebKey`, ids `<did>#<CESR key>`), and
//     `JsonWebKey2020`. OKP Ed25519 / X25519 and EC P-256.
//
// Anything else fails closed: an unknown or missing `type`, a type whose
// encoding the method does not carry (a `JsonWebKey` with only
// `publicKeyMultibase`), both encodings at once, a curve there is no primitive
// for (secp256k1, P-384), a curve that contradicts the type, a JWK carrying
// private material, or a method marked `revoked`.
//
// A key is chosen by its verification relationship (`keyAgreement`,
// `authentication`, `assertionMethod`, …), never as "the first key of the
// right curve" in `verificationMethod[]` and never by a fragment suffix. Every
// party must be able to resolve a did:webs (VTI-KEY-003), and a did:webs with
// key roles (VTI-KEY-150 / VTI-KEY-173) binds different keys to each
// relationship: a key listed under one is not authorised for another. Entries
// are references (absolute, or relative to the DID) into
// `verificationMethod[]`, or embedded methods, as DID Core allows.

import { p256 } from "@noble/curves/nist.js";
import { jwk as jwkLib, multibase, sameReference } from "@openvtc/vti-didcomm-js";

/** Curves there is a primitive for. */
export const ED25519 = "Ed25519";
export const X25519 = "X25519";
export const P256 = "P-256";

export type KeyCurve = typeof ED25519 | typeof X25519 | typeof P256;

/** The DID Core verification relationships a key can be chosen from. */
export type VerificationRelationship =
  | "keyAgreement"
  | "authentication"
  | "assertionMethod"
  | "capabilityInvocation"
  | "capabilityDelegation";

export const VERIFICATION_RELATIONSHIPS: readonly VerificationRelationship[] = [
  "keyAgreement",
  "authentication",
  "assertionMethod",
  "capabilityInvocation",
  "capabilityDelegation",
];

/** Whether `value` names a DID Core verification relationship. */
export function isVerificationRelationship(value: unknown): value is VerificationRelationship {
  return typeof value === "string" && (VERIFICATION_RELATIONSHIPS as readonly string[]).includes(value);
}

/** Verification method types that carry `publicKeyMultibase`, and the curve each pins (null: any). */
const MULTIKEY_TYPES = new Map<string, KeyCurve | null>([
  ["Multikey", null],
  ["Ed25519VerificationKey2020", ED25519],
  ["X25519KeyAgreementKey2020", X25519],
  ["X25519KeyAgreementKey2019", X25519],
]);

/** Verification method types that carry `publicKeyJwk`. */
const JWK_TYPES = new Set(["JsonWebKey", "JsonWebKey2020"]);

const CODECS: ReadonlyArray<readonly [Uint8Array, KeyCurve]> = [
  [multibase.MULTICODEC.ED25519_PUB, ED25519],
  [multibase.MULTICODEC.X25519_PUB, X25519],
  [multibase.MULTICODEC.P256_PUB, P256],
];

const PREFIX = "verification-method: ";

/** A public key read from a verification method. `publicKey` is 32 raw bytes
 *  for Ed25519 / X25519 and the 65-byte uncompressed SEC1 point for P-256. */
export interface VerificationMethodKey {
  crv: KeyCurve;
  publicKey: Uint8Array;
}

/** A key chosen from a relationship: the method's absolute id beside it. */
export interface SelectedKey extends VerificationMethodKey {
  kid: string;
  publicJwk: Record<string, unknown>;
}

export interface SelectKeyOptions {
  /** Absolute key id to select. */
  kid?: string;
  /** Acceptable curves (default: any supported). */
  curves?: readonly KeyCurve[];
  /** Prefix for error messages, in place of `verification-method`. */
  label?: string;
}

/**
 * The public key a verification method carries.
 *
 * @throws {Error} on anything it cannot read unambiguously (see the module
 *   documentation).
 */
export function publicKeyOf(vm: unknown): VerificationMethodKey {
  if (!vm || typeof vm !== "object" || Array.isArray(vm)) {
    throw new TypeError(`${PREFIX}a verification method must be an object`);
  }
  const m = vm as Record<string, unknown>;
  const label = typeof m.id === "string" ? m.id : "(no id)";
  if (m.revoked !== undefined && m.revoked !== null) {
    throw new Error(`${PREFIX}${label} is revoked`);
  }
  const hasMultibase = m.publicKeyMultibase !== undefined;
  const hasJwk = m.publicKeyJwk !== undefined;
  if (hasMultibase && hasJwk) {
    throw new Error(`${PREFIX}${label} carries both publicKeyMultibase and publicKeyJwk`);
  }
  const type = m.type;
  if (typeof type === "string" && MULTIKEY_TYPES.has(type)) {
    if (!hasMultibase) throw new Error(`${PREFIX}${label} is a ${type} without publicKeyMultibase`);
    const key = fromMultikey(m.publicKeyMultibase, label);
    const pinned = MULTIKEY_TYPES.get(type);
    if (pinned && key.crv !== pinned) {
      throw new Error(`${PREFIX}${label} is a ${type} holding a ${key.crv} key`);
    }
    return key;
  }
  if (typeof type === "string" && JWK_TYPES.has(type)) {
    if (!hasJwk) throw new Error(`${PREFIX}${label} is a ${type} without publicKeyJwk`);
    return fromJwk(m.publicKeyJwk, label);
  }
  throw new Error(`${PREFIX}${label} has unsupported type ${JSON.stringify(type)}`);
}

/**
 * Choose a key from `relationship` of a DID document.
 *
 * With `kid`, the entry whose id is exactly `kid` (a did:scid `src` aside),
 * which must be readable and of one of `curves`; it is refused if it is listed
 * only under another relationship. Without `kid`, the first entry that is
 * readable and of one of `curves`, in document order — an entry of another
 * curve or of a type that cannot be read is passed over, never used.
 *
 * @param did - the DID the document was resolved for; the base of relative ids.
 * @throws {Error} when no entry qualifies.
 */
export function selectKey(
  didDocument: unknown,
  did: string,
  relationship: VerificationRelationship,
  { kid, curves, label }: SelectKeyOptions = {},
): SelectedKey {
  try {
    return select(didDocument, did, relationship, kid, curves);
  } catch (e) {
    if (label && e instanceof Error && e.message.startsWith(PREFIX)) {
      e.message = `${label}: ${e.message.slice(PREFIX.length)}`;
    }
    throw e;
  }
}

/** The X25519 `keyAgreement` key of a DID document — or the one whose id is `kid`. */
export function x25519KeyAgreement(
  didDocument: unknown,
  did: string,
  { kid, label }: { kid?: string; label?: string } = {},
): { kid: string; x25519Pub: Uint8Array } {
  const key = selectKey(didDocument, did, "keyAgreement", {
    ...(kid !== undefined ? { kid } : {}),
    curves: [X25519],
    ...(label !== undefined ? { label } : {}),
  });
  return { kid: key.kid, x25519Pub: key.publicKey };
}

// ─── Internals ──────────────────────────────────────────────────────────

function select(
  didDocument: unknown,
  did: string,
  relationship: VerificationRelationship,
  kid: string | undefined,
  curves: readonly KeyCurve[] | undefined,
): SelectedKey {
  if (!didDocument || typeof didDocument !== "object") {
    throw new TypeError(`${PREFIX}no DID document for ${did}`);
  }
  const doc = didDocument as Record<string, unknown>;
  const entries = doc[relationship];
  if (!Array.isArray(entries) || entries.length === 0) {
    throw new Error(`${PREFIX}${did} has no ${relationship} entries`);
  }
  const allowed = curves ? new Set<string>(curves) : null;
  const methods: unknown[] = Array.isArray(doc.verificationMethod) ? doc.verificationMethod : [];
  const abs = (id: unknown): unknown => (typeof id === "string" && id.startsWith("#") ? `${did}${id}` : id);
  const idOf = (v: unknown): unknown => (v && typeof v === "object" ? (v as { id?: unknown }).id : undefined);
  const reasons: string[] = [];
  for (const entry of entries) {
    const id = abs(typeof entry === "string" ? entry : idOf(entry));
    if (typeof id !== "string") {
      reasons.push("an entry without an id");
      continue;
    }
    if (kid && !sameReference(id, kid)) continue;
    const vm = typeof entry === "string" ? methods.find((v) => sameReference(abs(idOf(v)) as string, id)) : entry;
    let key: VerificationMethodKey;
    try {
      if (!vm) throw new Error(`${PREFIX}${relationship} reference ${id} is not in verificationMethod[]`);
      key = publicKeyOf(vm);
      if (allowed && !allowed.has(key.crv)) {
        throw new Error(`${PREFIX}${id} is ${key.crv}, not ${[...allowed].join(" or ")}`);
      }
    } catch (e) {
      // An explicitly named key is used or refused, never substituted.
      if (kid) throw e;
      reasons.push(e instanceof Error ? e.message : String(e));
      continue;
    }
    return {
      kid: kid ?? id,
      crv: key.crv,
      publicKey: key.publicKey,
      publicJwk: jwkLib.publicJwk(key.crv, key.publicKey) as unknown as Record<string, unknown>,
    };
  }
  if (kid) throw new Error(`${PREFIX}${did} lists no ${relationship} key ${kid}`);
  const wanted = allowed ? ` ${[...allowed].join("/")}` : "";
  throw new Error(
    `${PREFIX}${did} has no usable${wanted} ${relationship} key` + (reasons.length ? ` (${reasons.join("; ")})` : ""),
  );
}

function fromMultikey(value: unknown, label: string): VerificationMethodKey {
  if (typeof value !== "string") {
    throw new Error(`${PREFIX}${label} publicKeyMultibase must be a string`);
  }
  const { codec, key } = multibase.decodeMultikey(value);
  const match = CODECS.find(([c]) => c.length === codec.length && c.every((b, i) => b === codec[i]));
  if (!match) {
    const hex = Array.from(codec, (b) => b.toString(16).padStart(2, "0")).join("");
    throw new Error(`${PREFIX}${label} uses unsupported multicodec 0x${hex}`);
  }
  const crv = match[1];
  if (crv === P256) {
    if (key.length !== 33 && key.length !== 65) {
      throw new Error(`${PREFIX}${label} P-256 key must be a 33- or 65-byte SEC1 point`);
    }
    // vti-didcomm-js #39 adds `p256.uncompressedPoint` for this; 0.14 lacks it.
    return { crv, publicKey: p256.Point.fromBytes(key).toBytes(false) };
  }
  if (key.length !== 32) {
    throw new Error(`${PREFIX}${label} ${crv} key must be 32 bytes, got ${key.length}`);
  }
  return { crv, publicKey: key };
}

function fromJwk(value: unknown, label: string): VerificationMethodKey {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error(`${PREFIX}${label} publicKeyJwk must be an object`);
  }
  if ((value as { d?: unknown }).d !== undefined) {
    throw new Error(`${PREFIX}${label} publicKeyJwk carries private key material`);
  }
  try {
    const jwk = value as Parameters<typeof jwkLib.curveOf>[0];
    const crv = jwkLib.curveOf(jwk) as KeyCurve;
    return { crv, publicKey: jwkLib.rawPublic(jwk) };
  } catch (e) {
    throw new Error(`${PREFIX}${label} publicKeyJwk: ${e instanceof Error ? e.message : String(e)}`);
  }
}
