// DID document verification methods → key bytes, chosen by relationship.
//
// The rules live in `@openvtc/vti-didcomm-js/verification-method` (since
// 0.15.0); this module only gives them this package's TypeScript types, so
// there is one implementation to keep right (R4.1: don't fork fixes). Change
// the library, never this file, to change what is accepted.
//
// Every site that reads a key out of a DID document — Trust-Task proof
// verification, the TSP VID signing key, a member's directory-card keys, a
// Domain Linkage Credential's key — goes through here, so a DID method that
// publishes its keys differently (did:webs's `publicKeyJwk`, VTI-KEY-003) is
// supported everywhere at once or nowhere. A key is chosen by its
// verification relationship, never as "the first key of the right curve" and
// never by a fragment suffix; anything the library cannot read unambiguously
// fails closed.

import * as lib from "@openvtc/vti-didcomm-js/verification-method";

/** Curves there is a primitive for. */
export const ED25519 = lib.ED25519;
export const X25519 = lib.X25519;
export const P256 = lib.P256;

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
 * @throws {Error} on anything it cannot read unambiguously.
 */
export function publicKeyOf(vm: unknown): VerificationMethodKey {
  return lib.publicKeyOf(vm as object);
}

/**
 * Choose a key from `relationship` of a DID document.
 *
 * With `kid`, the entry whose id is exactly `kid`, which must be readable and
 * of one of `curves`; it is refused if it is listed only under another
 * relationship. Without `kid`, the first entry that is readable and of one of
 * `curves`, in document order.
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
  const key = lib.selectKey(didDocument as object, did, relationship, {
    ...(kid !== undefined ? { kid } : {}),
    ...(curves !== undefined ? { curves: [...curves] } : {}),
    ...(label !== undefined ? { label } : {}),
  });
  return { ...key, publicJwk: key.publicJwk as Record<string, unknown> };
}

/** The X25519 `keyAgreement` key of a DID document — or the one whose id is `kid`. */
export function x25519KeyAgreement(
  didDocument: unknown,
  did: string,
  { kid, label }: { kid?: string; label?: string } = {},
): { kid: string; x25519Pub: Uint8Array } {
  return lib.x25519KeyAgreement(didDocument as object, did, {
    ...(kid !== undefined ? { kid } : {}),
    ...(label !== undefined ? { label } : {}),
  });
}
