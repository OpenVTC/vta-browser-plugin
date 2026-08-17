// Pure model behind the Sites screen — no React, no `chrome`, so the merge
// rules are testable directly. See `sites-panel.tsx` for the rendering.

import type { TrustedSiteRecord } from "./trusted-sites.js";

export interface SiteRow {
  /** The bare host — what a user recognises, and the merge key. */
  host: string;
  /** Present when the site has consent trust ("Remember this site"). */
  trusted?: TrustedSiteRecord;
  /** The granted match pattern, when host access is held. */
  grantedPattern?: string;
}

/**
 * Merge consent trust and host grants into one row per site.
 *
 * Keyed on host, not on the raw strings, because the two sources spell the
 * same site differently: a trust record stores an origin
 * (`https://app.example`) while a grant stores a match pattern
 * (`https://app.example/*`). Keying on the strings would render one site as
 * two rows, each looking half-permissioned — the exact confusion this screen
 * exists to remove.
 *
 * `hostOf` is injected rather than imported so this module stays free of
 * `chrome`; callers pass `displayHostFor`.
 */
export function mergeSiteRows(
  trusted: TrustedSiteRecord[],
  grantedPatterns: string[],
  hostOf: (s: string) => string,
): SiteRow[] {
  const rows = new Map<string, SiteRow>();

  for (const record of trusted) {
    const host = hostOf(record.origin);
    rows.set(host, { ...rows.get(host), host, trusted: record });
  }
  for (const pattern of grantedPatterns) {
    const host = hostOf(pattern);
    rows.set(host, { ...rows.get(host), host, grantedPattern: pattern });
  }

  return [...rows.values()].sort((a, b) => {
    // Most recently connected first. Rows with only a host grant have no
    // timestamp and settle alphabetically at the bottom, which keeps the
    // list stable rather than reordering on every refresh.
    const at = a.trusted?.trustedAt ?? 0;
    const bt = b.trusted?.trustedAt ?? 0;
    if (at !== bt) return bt - at;
    return a.host.localeCompare(b.host);
  });
}

/** Coarse relative time for the "Connected …" line. Deliberately vague — the
 *  exact minute is noise, and the user is scanning for "do I still recognise
 *  this?", not auditing. `now` is injectable so tests don't depend on a clock. */
export function relativeDay(ms: number, now: number = Date.now()): string {
  const days = Math.floor((now - ms) / 86_400_000);
  if (days <= 0) return "today";
  if (days === 1) return "yesterday";
  if (days < 30) return `${days} days ago`;
  const months = Math.floor(days / 30);
  return months === 1 ? "a month ago" : `${months} months ago`;
}
