// Which sites to draw in the trust graph, and what to say about each.
//
// Two sources describe the same relationship from different angles:
//
//   - a **vault entry** knows the identity you present (`principalDid`) and
//     carries a human label;
//   - a **trust record** knows whether the site may act without prompting.
//
// Neither is complete, so they merge. The merge key is the **host**, not the
// raw string, because the two sources spell a site differently — an entry
// target is `https://first.openvtc.net` while a trust record may carry a
// trailing slash, a port, or different case. Keying on the strings renders one
// site as two boxes, one showing an identity and no trust, the other showing
// trust and no identity. That is exactly what happened, and it is the second
// time the same mistake has been made in this codebase (see `sites-model.ts`),
// which is why the rule now lives in one tested place.

import type { TrustedSiteRecord } from "./trusted-sites.js";
import type { VaultEntryView } from "./bridge-protocol.js";

export interface RpRow {
  /** Stable React key. */
  key: string;
  /** The site's own DID, from an entry's `did` target or a trust record's
   *  `rpDid`. The two sources agree on this even when only one knows a URL. */
  rpDid?: string;
  origin?: string;
  /** The identity **you** present there. Distinct from `rpDid`, which is the
   *  site's own identity — conflating the two is easy and badly misleading. */
  principalDid?: string;
  entry?: VaultEntryView;
  trusted?: TrustedSiteRecord;
}

/** Every identifier a row can be recognised by. A site described from two
 *  directions may share only one of them. */
function keysOf(origin: string | undefined, rpDid: string | undefined, hostOf: (s: string) => string): string[] {
  const out: string[] = [];
  if (origin) out.push(`host:${hostOf(origin)}`);
  if (rpDid) out.push(`did:${rpDid}`);
  return out;
}

/**
 * What to call the site itself.
 *
 * The host first, because that is what a person recognises as "the site". The
 * entry's label is deliberately *not* preferred here: it names the credential
 * ("WebVH Prod"), not the destination, and using it made the site box claim a
 * name that belongs on the login-entry box beside it.
 *
 * A DID-only target has no host, so the caller gets the DID back and can
 * resolve it to an agent name.
 */
export function siteTitle(row: RpRow, hostOf: (s: string) => string): string {
  if (row.origin) return hostOf(row.origin);
  if (row.rpDid) return row.rpDid;
  return row.entry?.label ?? row.key;
}

/** Most-recent activity, for ordering. Falls back through the timestamps each
 *  source happens to carry; 0 when nothing is known. */
export function lastActivity(row: RpRow): number {
  const fromEntry = Date.parse(row.entry?.lastUsedAt ?? row.entry?.updatedAt ?? "");
  if (Number.isFinite(fromEntry)) return fromEntry;
  return row.trusted?.trustedAt ?? 0;
}

/**
 * Merge vault entries and trust records into one row per site.
 *
 * Matching is on **either** identifier, because the two sources frequently
 * share only one. A `did-self-issued` entry targets the relying party's DID
 * and may carry no URL at all; a trust record is keyed by web origin and
 * carries the RP's DID only when consent captured one. Keying on origin alone
 * drew those as two boxes — one with an identity and no trust, one with trust
 * and no identity — which is the duplication this function exists to prevent.
 *
 * `hostOf` is injected so this module stays free of `chrome`; callers pass
 * `displayHostFor`.
 */
export function mergeRpRows(
  entries: readonly VaultEntryView[],
  sites: readonly TrustedSiteRecord[],
  hostOf: (s: string) => string,
): RpRow[] {
  const rows: RpRow[] = [];
  /** identifier → index into `rows`, so a second identifier can find the row
   *  a first one already created. */
  const index = new Map<string, number>();

  const attach = (keys: string[], patch: Partial<RpRow>): void => {
    const hit = keys.map((k) => index.get(k)).find((i) => i !== undefined);
    const at = hit ?? rows.length;
    const prev = rows[at];
    // Later sources add to a row, never blank a field an earlier one filled.
    const origin = patch.origin ?? prev?.origin;
    const rpDid = patch.rpDid ?? prev?.rpDid;
    const principalDid = patch.principalDid ?? prev?.principalDid;
    const merged: RpRow = {
      key: prev?.key ?? keys[0] ?? `row-${at}`,
      ...(origin ? { origin } : {}),
      ...(rpDid ? { rpDid } : {}),
      ...(principalDid ? { principalDid } : {}),
      ...(patch.entry ?? prev?.entry ? { entry: (patch.entry ?? prev?.entry)! } : {}),
      ...(patch.trusted ?? prev?.trusted ? { trusted: (patch.trusted ?? prev?.trusted)! } : {}),
    };
    rows[at] = merged;
    // Register every identifier this row is now known by, so a third source
    // matching on the other one lands here too.
    for (const k of [...keys, ...keysOf(merged.origin, merged.rpDid, hostOf)]) {
      index.set(k, at);
    }
  };

  for (const entry of entries) {
    const web = entry.targets.find((t) => t.kind === "webOrigin");
    const did = entry.targets.find((t) => t.kind === "did");
    const origin = web?.kind === "webOrigin" ? web.origin : undefined;
    const rpDid = did?.kind === "did" ? did.did : undefined;
    const keys = keysOf(origin, rpDid, hostOf);
    attach(keys.length > 0 ? keys : [`entry:${entry.id}`], {
      ...(origin ? { origin } : {}),
      ...(rpDid ? { rpDid } : {}),
      ...(entry.principalDid ? { principalDid: entry.principalDid } : {}),
      entry,
    });
  }

  for (const site of sites) {
    attach(keysOf(site.origin, site.rpDid, hostOf), {
      origin: site.origin,
      ...(site.rpDid ? { rpDid: site.rpDid } : {}),
      trusted: site,
    });
  }

  return rows.sort((a, b) => lastActivity(b) - lastActivity(a));
}

/**
 * How many rows present each identity.
 *
 * The wallet *supports* a distinct identity per site, but nothing enforces it
 * — two entries can name the same `principalDid`, and then those sites can
 * correlate you. Stating "used only here" unconditionally would assert a
 * privacy property the user may not actually have, which is worse than saying
 * nothing: it is the kind of claim someone relies on.
 */
export function identityUsage(rows: readonly RpRow[]): Map<string, number> {
  const counts = new Map<string, number>();
  for (const r of rows) {
    if (!r.principalDid) continue;
    counts.set(r.principalDid, (counts.get(r.principalDid) ?? 0) + 1);
  }
  return counts;
}
