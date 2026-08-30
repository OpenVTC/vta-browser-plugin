/**
 * Which identity a site knows the user as, when the answer is "the wallet's
 * own".
 *
 * Persona choices need no store: binding one *is* a vault entry, and
 * `matchProfileEntry` reads it back. Choosing the holder DID creates nothing —
 * there is no entry to find — so without a record here the operator would be
 * asked again on every sign-in, and a prompt that reappears after being
 * answered is one people learn to click through (R7.2).
 *
 * So this stores exactly one fact, per origin: *the operator chose the holder
 * for this site.* It is a decision, not a cache — nothing here is derivable
 * from the vault, which is why it cannot live there.
 *
 * ## Why the holder is offered at all
 *
 * A per-site persona is the better answer and the default. But the RP's ACL is
 * checked against whichever DID signs in, and every enrolment made before
 * personas existed names the holder DID. Removing that route would break those
 * sites on the next sign-in, with a refusal from the RP as the only signal. So
 * it stays, as an explicit choice the operator makes with the consequence on
 * screen — rather than as a silent fallback, which is the thing this whole
 * change set exists to remove.
 *
 * Storage: `chrome.storage.local`, key prefix `site-identity:`. Revoked by
 * clearing extension storage, or by binding a persona — a persona always wins,
 * because it is the more specific statement about this site.
 */

const KEY_PREFIX = "site-identity:";

/** The value the consent picker returns when the operator chooses the wallet's
 *  own identity. Not a DID: it must never be mistaken for one, and a sentinel
 *  that cannot parse as a DID fails loudly if it ever reaches a place expecting
 *  one. */
export const HOLDER_IDENTITY = "holder" as const;

interface SiteIdentityRecord {
  kind: typeof HOLDER_IDENTITY;
  chosenAt: number;
}

function key(origin: string): string {
  return `${KEY_PREFIX}${origin}`;
}

/** Did the operator choose the wallet's own identity for this site? */
export async function prefersHolderIdentity(origin: string): Promise<boolean> {
  if (!origin) return false;
  const k = key(origin);
  const got = await chrome.storage.local.get(k);
  return (got[k] as SiteIdentityRecord | undefined)?.kind === HOLDER_IDENTITY;
}

/** Record that this site signs in as the wallet's own identity. */
export async function rememberHolderIdentity(origin: string): Promise<void> {
  if (!origin) return;
  const record: SiteIdentityRecord = { kind: HOLDER_IDENTITY, chosenAt: Date.now() };
  await chrome.storage.local.set({ [key(origin)]: record });
}

/** Forget the choice, so the next sign-in asks again. Used when a persona is
 *  bound for the same origin: leaving a stale holder record behind would make
 *  the answer depend on which of two stores was read first. */
export async function forgetSiteIdentity(origin: string): Promise<void> {
  if (!origin) return;
  await chrome.storage.local.remove(key(origin));
}

/** Every origin pinned to the wallet's own identity, for the options page. */
export async function listHolderIdentitySites(): Promise<string[]> {
  const all = await chrome.storage.local.get(null);
  return Object.keys(all)
    .filter((k) => k.startsWith(KEY_PREFIX))
    .map((k) => k.slice(KEY_PREFIX.length))
    .sort();
}
