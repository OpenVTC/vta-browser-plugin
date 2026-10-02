// Which key signs a page's `signTrustTask` request.
//
// A page asks for a document signed *as* a particular identity (`asDid`) when
// the relying party authenticated the session as that identity — after a
// `vault/proxy-login`, the persona whose key the VTA holds. Signing it with any
// other key is never what the page asked for: the relying party binds the
// proof to the document's `issuer` and refuses a document signed by somebody
// else, so the best case is an opaque refusal there, and the worst is a
// document that claims one identity carrying a proof by another.
//
// This used to fall back to the holder key, with a `console.warn` nobody saw,
// when no vault entry matched `asDid` — and also, silently, whenever no REST
// base was known. Both now refuse with a stable code, before anything is
// signed.
//
// Kept free of `chrome.*` so the rule is testable without the extension.

/** Stable code: `asDid` names an identity this wallet cannot sign as (R3.7). */
export const SIGN_AS_UNAVAILABLE = "sign-trust-task/as-did-unavailable";

export class SignAsUnavailableError extends Error {
  // Declared and assigned rather than a constructor parameter property: Node's
  // type-stripping rejects parameter properties.
  readonly code: string;

  constructor(message: string) {
    super(message);
    this.code = SIGN_AS_UNAVAILABLE;
    this.name = "SignAsUnavailableError";
  }
}

/** A vault entry, as far as choosing a signer needs it. */
export interface SignableEntry {
  id: string;
  principalDid?: string;
  secretKind: string;
}

export type TrustTaskSigner =
  /** The wallet's own holder key. */
  | { kind: "holder" }
  /** The VTA signs as the entry's principal (`vault/sign-trust-task`). */
  | { kind: "vault"; entryId: string };

/** Whether an `asDid` request can only be served through the VTA. */
export function needsVault(asDid: string | undefined, holderDid: string): boolean {
  return asDid !== undefined && asDid !== holderDid;
}

/**
 * The signer for a request signed as `asDid`.
 *
 * - No `asDid`, or `asDid` naming the holder itself: the holder key.
 * - Otherwise a `didSelfIssued` / `didcommPeer` vault entry whose
 *   `principalDid` is `asDid`, signed by the VTA.
 * - Otherwise refused — never the holder key in its place.
 *
 * `entries` is `null` when the VTA could not be reached for them (no REST base
 * known), which is refused the same way.
 */
export function chooseTrustTaskSigner(
  asDid: string | undefined,
  holderDid: string,
  entries: readonly SignableEntry[] | null,
): TrustTaskSigner {
  if (!needsVault(asDid, holderDid)) return { kind: "holder" };
  if (entries === null) {
    throw new SignAsUnavailableError(
      `cannot sign as ${asDid}: this wallet has no route to its VTA to sign with that identity`,
    );
  }
  const match = entries.find(
    (e) =>
      e.principalDid === asDid &&
      (e.secretKind === "didSelfIssued" || e.secretKind === "didcommPeer"),
  );
  if (!match) {
    throw new SignAsUnavailableError(
      `cannot sign as ${asDid}: no identity of that DID is held in this wallet's vault`,
    );
  }
  return { kind: "vault", entryId: match.id };
}
