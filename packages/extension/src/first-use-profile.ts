/**
 * First-use profile binding for site-initiated proxy logins.
 *
 * A relying party's page calls `window.vtaWallet.proxyLogin(...)` and the VTA
 * mints a SIOP id_token as a vault entry's `principalDid` — the persona this
 * user is at that site. Until now the *page* had to name the entry, which meant
 * the persona had to be bound in advance through the vault panel, and a site
 * that did not already have one dead-ended: it had to call `vaultList()` (its
 * own consent prompt, enumerating the user's vault to the site) just to learn
 * an entry id that did not exist.
 *
 * So the wallet resolves the entry itself, from the origin the browser
 * attested, and asks the human once when there is nothing bound yet. The
 * helpers here are the decision half of that, kept free of `chrome` so they can
 * be tested: which entry a proxy login should use, and what entry to create
 * when the operator picks a persona.
 *
 * ## Why the match is exact, not a prefix
 *
 * `vault/list` filters by `targetOriginPrefix`, and a prefix is not an origin:
 * `https://example.com` is a prefix of `https://example.com.evil.test`. Asking
 * the VTA to narrow the set is a bandwidth decision; deciding which entry is
 * *this site's* is a security decision, and it belongs here, on the
 * browser-attested origin, with `===`.
 */

import type { RuntimeVaultUpsertRequest, VaultEntryView } from "./bridge-protocol.js";

/** Secret kind a proxy login can act as — the VTA holds the signing key and
 *  mints the id_token as the entry's `principalDid`. */
export const PROFILE_SECRET_KIND = "didSelfIssued";

/**
 * The entry a proxy login from `origin` should use, or `undefined` when this
 * site has no persona bound yet.
 *
 * Ties are broken by `createdAt` (oldest first) so the answer does not depend
 * on the order the VTA happened to return, and so a later duplicate — one an
 * interrupted first-use flow could leave behind — never displaces the entry the
 * operator has been signing in with.
 */
export function matchProfileEntry(
  entries: readonly VaultEntryView[],
  origin: string,
): VaultEntryView | undefined {
  return entries
    .filter(
      (e) =>
        e.secretKind === PROFILE_SECRET_KIND &&
        e.targets.some((t) => t.kind === "webOrigin" && t.origin === origin),
    )
    .sort((a, b) => a.createdAt.localeCompare(b.createdAt))[0];
}

/** Human label for a newly bound entry — the site's hostname, or the raw
 *  origin when it will not parse (never a fabricated name). */
export function profileLabelFor(origin: string): string {
  try {
    return new URL(origin).hostname || origin;
  } catch {
    return origin;
  }
}

export interface ProfileEntryInput {
  /** Browser-attested origin of the page that asked to sign in. */
  origin: string;
  /** Persona DID the operator picked in the first-use prompt. */
  did: string;
  /** Context the persona belongs to — taken from the DID's own record, never
   *  chosen separately: a persona and its entry in different contexts is an
   *  entry the VTA cannot sign for. */
  contextId: string;
  /** Verification method the VTA signs the id_token with, derived from `did`. */
  signingKeyId: string;
  /** The relying party's DID, when the page named one. Added as a second
   *  target so the RP's own `vaultList({ targetDid })` finds the entry, but
   *  never used to *match* one — only the origin is attested. */
  rpDid?: string;
}

/**
 * The `vault/upsert` body that binds `did` to `origin`.
 *
 * No `id`: the maintainer assigns a ULID, so this always creates. A first-use
 * flow that was interrupted after the upsert therefore leaves an entry the next
 * attempt finds by origin, rather than colliding with a guessed id.
 */
export function buildProfileEntry(
  input: ProfileEntryInput,
): Omit<RuntimeVaultUpsertRequest, "type"> {
  return {
    contextId: input.contextId,
    label: profileLabelFor(input.origin),
    targets: [
      { kind: "webOrigin", origin: input.origin },
      ...(input.rpDid ? [{ kind: "did" as const, did: input.rpDid }] : []),
    ],
    secretKind: PROFILE_SECRET_KIND,
    secret: {
      kind: "didSelfIssued",
      did: input.did,
      signingKeyId: input.signingKeyId,
    },
  };
}

/** What a sign-in at this origin should do about identity. */
export type SiteIdentityDecision =
  | { kind: "persona"; entryId: string }
  | { kind: "holder" }
  | { kind: "ask" };

/**
 * Resolve the identity for a sign-in, from the two places the answer can live.
 *
 * A bound persona is a vault entry; choosing the wallet's own identity is a
 * local record (`site-identity.ts`). **A persona always wins**, and the order
 * is not arbitrary: a persona is the more specific statement about this site,
 * and it is the one the operator can see and revoke in the vault. Reading the
 * local record first would let a stale holder choice mask an entry the operator
 * later bound through `proxyLogin`, and the sign-in would quietly use a
 * different identity than the vault says it does.
 *
 * `ask` means neither exists — raise the picker.
 */
export function decideSiteIdentity(
  entries: readonly VaultEntryView[],
  origin: string,
  prefersHolder: boolean,
): SiteIdentityDecision {
  const match = matchProfileEntry(entries, origin);
  if (match) return { kind: "persona", entryId: match.id };
  if (prefersHolder) return { kind: "holder" };
  return { kind: "ask" };
}
