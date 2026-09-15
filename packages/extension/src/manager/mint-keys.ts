// Which of the agent's existing keys a new DID could be built on.
//
// `signingKeyId` and `kaKeyId` on `vta/webvh/dids/create` say "publish this key
// I already hold" rather than "mint a fresh one". Absent is the right default
// and stays the default; this module exists so that when an operator does reach
// for the control, the list they are shown cannot contain a key that would make
// the DID broken or unsafe.
//
// **Three filters, and each one rules out a different kind of wrong.**
//
//   - `x25519` never signs and `ed25519`/`p256` never perform key agreement.
//     A DID whose signing method is an x25519 key cannot sign its own log
//     entries, which means it can never be updated again — and the log's first
//     entry, the one that would have to be signed, is written at mint time. So
//     this is not a fault that shows up later.
//   - A `revoked` key may not be named in a signing request, and a key is kept
//     after revocation precisely so historic signatures stay attributable.
//     Publishing one in a *new* DID reverses that: it attributes new material
//     to a key someone decided to stop trusting.
//   - A key's `contextId` must match the DID's. **Absence is not "every
//     context"** — the specification says so directly, and says a consumer that
//     reads it as a wildcard inverts the guarantee. A key with no context is
//     reachable only by unrestricted authority, so it is not offered for a mint
//     inside one.
//
// What this module deliberately does **not** decide is whether reusing a key is
// a good idea. Two DIDs sharing a key are provably controlled by the same
// holder, and that is a correlation decision only the operator can make — so it
// is said on screen beside the control, not filtered out here.
//
// A plain module rather than part of the form so a test can reach it.

import type { KeyRecord } from "@openvtc/pnm-core/admin";

/** Key types that sign. `x25519` is absent because it never does. */
export const SIGNING_TYPES: readonly string[] = ["ed25519", "p256"];

/** The one key type that performs key agreement. */
export const AGREEMENT_TYPE = "x25519";

/** What a mint could be built on, split by the role each key can fill. */
export interface MintKeys {
  /** Keys that could sign this DID's log entries. */
  signing: KeyRecord[];
  /** Keys that could be published as its key-agreement method. */
  agreement: KeyRecord[];
}

/**
 * Split `keys` into the two roles, keeping only what is usable for a DID in
 * `contextId`.
 *
 * `contextId` is required rather than optional: a mint always names a context,
 * and an overload that allowed "no context" would be the wildcard reading the
 * key record's own documentation warns against.
 */
export function mintKeys(keys: KeyRecord[], contextId: string): MintKeys {
  const usable = keys.filter(
    (k) => k.status === "active" && k.contextId === contextId,
  );
  return {
    signing: usable.filter((k) => SIGNING_TYPES.includes(k.keyType)),
    agreement: usable.filter((k) => k.keyType === AGREEMENT_TYPE),
  };
}

/**
 * How a key reads in a picker.
 *
 * The label first where there is one, because that is what the operator named
 * it; the id always, because that is what is sent and what every other pane
 * shows. A key type is included for the same reason the two lists are separate —
 * it is the fact that decides which role the key can fill.
 */
export function keyLabel(key: KeyRecord): string {
  const base = key.label ? `${key.label} (${key.keyId})` : key.keyId;
  return `${base} · ${key.keyType}`;
}

/**
 * Whether a chosen key id is still a valid choice.
 *
 * The context can change under a selection — the operator picks a key, then
 * changes the tree — and a stale id would be sent as a key that does not belong
 * to the context being minted into. The form clears the selection on this
 * answer rather than letting the agent refuse it.
 */
export function stillOffered(keyId: string, offered: KeyRecord[]): boolean {
  return keyId === "" || offered.some((k) => k.keyId === keyId);
}
