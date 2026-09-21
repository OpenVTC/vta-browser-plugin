// Who still holds a value you have since changed.
//
// `persona/disclosure/history` reports, per disclosed claim, whether the value
// the verifier received is still what that persona presents in that context
// (`claimCurrency`, aligned with `claimTypes`). The agent answers it from a
// keyed hash taken at disclosure, compared with the persona's projection now —
// the history holds no value, so neither can this.
//
// ## The four answers are four, and two of them are easy to merge wrongly
//
// `changed` is the one that matters after a name change: the verifier holds an
// outdated copy, and the holder may want to send the new one. `removed` is not
// the same — the persona no longer presents that type at all, and there is
// nothing newer to send; the verifier simply keeps what it got, because a
// disclosure cannot be recalled. Folding `removed` into `changed` would offer
// to re-present something that no longer exists.
//
// `unknown` is a record made before the agent fingerprinted disclosures, or a
// predicate that disclosed no value. It is never `current`: reading it as
// current is the false all-clear the whole feature exists to avoid.
//
// An agent that predates the member omits it entirely. Every claim is then
// `unknown`, for the same reason.

import type { DisclosureRecord } from "@openvtc/pnm-core/admin";

export type Currency = "current" | "changed" | "removed" | "unknown";

/** One claim of one disclosure, with its currency. */
export interface DisclosedClaimCurrency {
  claimType: string;
  currency: Currency;
}

/** Each claim of a record with its currency, `unknown` wherever the agent did not say. */
export function currencyOf(record: DisclosureRecord): DisclosedClaimCurrency[] {
  const said: readonly unknown[] = record.claimCurrency ?? [];
  return record.claimTypes.map((claimType, i) => {
    const c = said[i];
    const currency: Currency =
      c === "current" || c === "changed" || c === "removed" ? c : "unknown";
    return { claimType, currency };
  });
}

/** One party holding a value the holder has since changed. */
export interface Outdated {
  verifierDid: string;
  contextId: string;
  personaDid: string;
  /** The claim types that party holds an outdated copy of, in disclosure order. */
  claimTypes: string[];
  /** The most recent disclosure that left them holding it. */
  disclosedAt: string;
}

/**
 * The re-present list: every (verifier, context, persona) holding at least one
 * value the persona has since changed, most recent first.
 *
 * Grouped by that triple because that is who would be sent the new value — the
 * same verifier in two contexts, or through two personas, is two relationships.
 * Only the **latest** disclosure to each triple counts: a verifier re-sent the
 * current value after an older disclosure is not outdated, even though the
 * older record still says `changed`.
 */
export function outdatedHolders(records: readonly DisclosureRecord[]): Outdated[] {
  const latest = new Map<string, DisclosureRecord>();
  for (const r of records) {
    const key = `${r.verifierDid}\u0000${r.contextId}\u0000${r.personaDid}`;
    const seen = latest.get(key);
    if (!seen || r.disclosedAt > seen.disclosedAt) latest.set(key, r);
  }
  const out: Outdated[] = [];
  for (const r of latest.values()) {
    const changed = currencyOf(r)
      .filter((c) => c.currency === "changed")
      .map((c) => c.claimType);
    if (changed.length === 0) continue;
    out.push({
      verifierDid: r.verifierDid,
      contextId: r.contextId,
      personaDid: r.personaDid,
      claimTypes: [...new Set(changed)],
      disclosedAt: r.disclosedAt,
    });
  }
  return out.sort((a, b) => b.disclosedAt.localeCompare(a.disclosedAt));
}

/** The words for one claim's currency — `null` for `current`, which needs none. */
export function currencyWords(c: Currency): string | null {
  switch (c) {
    case "changed":
      return "they hold an older value";
    case "removed":
      return "you no longer show this here — they keep what they got";
    case "unknown":
      return "your agent cannot say whether this is still current";
    default:
      return null;
  }
}

// ## Where an edit landed
//
// `persona/attribute/put` now answers with `refreshed` (the bindings the edit
// re-pushed) and `heldByPin` (faces that pin the attribute and so did not
// follow). An edit propagating is the point of a pool and also its surprise,
// so a save that changed what nine counterparties see says so. An agent that
// predates the members omits both, and then nothing is claimed either way.

interface EditReach {
  refreshed?: readonly { profileId: string; contextId: string }[];
  heldByPin?: readonly { profileId: string }[];
}

/** The sentence for where an edit landed, or `null` when the agent said nothing. */
export function editReachWords(res: EditReach): string | null {
  const refreshed = res.refreshed ?? [];
  const held = res.heldByPin ?? [];
  if (refreshed.length === 0 && held.length === 0) return null;
  const parts: string[] = [];
  if (refreshed.length > 0) {
    const contexts = new Set(refreshed.map((r) => r.contextId)).size;
    parts.push(
      `Now shown in ${refreshed.length} place${refreshed.length === 1 ? "" : "s"} ` +
        `across ${contexts} context${contexts === 1 ? "" : "s"}.`,
    );
  }
  if (held.length > 0) {
    parts.push(
      `${held.length} face${held.length === 1 ? " pins" : "s pin"} the earlier value and ` +
        `${held.length === 1 ? "keeps" : "keep"} showing it — that is what pinning is for.`,
    );
  }
  return parts.join(" ");
}
