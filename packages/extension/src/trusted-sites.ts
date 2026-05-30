/// <reference types="chrome" />

/**
 * Per-origin "connected sites" trust.
 *
 * Opt-in: a record is written only when the user ticks "Remember this site"
 * on a consent prompt and approves. While a trust record exists, that
 * origin's page-initiated wallet actions (`login`, `vaultList`,
 * `proxyLogin`, step-up) skip the consent popup — the MetaMask-style
 * "connected site" model. The user revokes a site from the options page,
 * which removes the record and makes the next call prompt again.
 *
 * Storage: `chrome.storage.local`, key prefix `trusted-site:`. One entry
 * per origin, holding the (optional) rpDid it was first approved for and a
 * creation timestamp.
 *
 * Mirrors `origin-pin.ts` (which is about *change-detection*, not skipping
 * consent — the two are intentionally separate concerns).
 */

const TRUSTED_KEY_PREFIX = "trusted-site:";

export interface TrustedSiteRecord {
  origin: string;
  /** The rpDid the site was first approved for, if any (display only). */
  rpDid?: string;
  trustedAt: number;
}

function key(origin: string): string {
  return `${TRUSTED_KEY_PREFIX}${origin}`;
}

/** `true` if the origin has an active trust record. Empty origin is never
 *  trusted (a request with no origin always prompts). */
export async function isOriginTrusted(origin: string): Promise<boolean> {
  if (!origin) return false;
  const k = key(origin);
  const result = await chrome.storage.local.get(k);
  return result[k] !== undefined;
}

/** Persist trust for `origin`. Call only after an approved consent whose
 *  "Remember this site" box was ticked. */
export async function trustOrigin(origin: string, rpDid?: string): Promise<void> {
  if (!origin) return;
  const record: TrustedSiteRecord = {
    origin,
    trustedAt: Date.now(),
    ...(rpDid ? { rpDid } : {}),
  };
  await chrome.storage.local.set({ [key(origin)]: record });
}

/** Revoke trust for `origin` (options-page action). The next call from this
 *  origin prompts again. */
export async function untrustOrigin(origin: string): Promise<void> {
  await chrome.storage.local.remove(key(origin));
}

/** All trusted sites, most-recently-trusted first. Backs the options-page
 *  "Connected sites" list. */
export async function listTrustedSites(): Promise<TrustedSiteRecord[]> {
  const all = await chrome.storage.local.get(null);
  return Object.entries(all)
    .filter(([k]) => k.startsWith(TRUSTED_KEY_PREFIX))
    .map(([, v]) => v as TrustedSiteRecord)
    .sort((a, b) => b.trustedAt - a.trustedAt);
}
