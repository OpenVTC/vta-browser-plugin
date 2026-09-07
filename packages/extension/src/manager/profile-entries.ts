// Composing a profile's entries from a tick list, and why that is not obvious.
//
// A profile is a whitelist over the attribute pool, and its entries have four
// forms: a live reference, a reference pinned to a version, a reference with a
// profile-local override, and an inline value that lives nowhere else. The
// console's editor can express exactly one of them — the live reference — which
// makes composing the new list a decision rather than a mapping.
//
// It lives here, out of the component, for the reason the consent screen's
// `buildConsentView` does: **what a profile presents is a security property,
// and nothing tests a component's reasoning.** Get this wrong and the profile
// still saves, still has its name, still works — and quietly presents more or
// less than the holder ticked. The failure has no symptom until a disclosure.
//
// Two ways it goes wrong, and they pull in opposite directions:
//
//   - **Rebuild from the ticks alone** and every pinned, overridden and inline
//     entry disappears. The profile presents less than it did, silently.
//   - **Seed the ticks from every `ref`** — pinned and overridden entries have
//     one too — and saving writes the same attribute twice: once live, from the
//     tick, and once pinned, from the entry that was carried through. One
//     apparently unchanged edit, two entries for one fact.
//
// So the split is by entry *form*, not by whether an entry has a `ref`.

import type { PoolProfileEntry } from "@openvtc/pnm-core/admin";

/** A live reference — the one form the tick list composes. */
export function isPlainRef(entry: PoolProfileEntry): boolean {
  return "ref" in entry && !("pinVersion" in entry) && !("override" in entry);
}

/** The attribute id an entry names, or null for an inline value. */
export function refOf(entry: PoolProfileEntry): string | null {
  return "ref" in entry ? entry.ref : null;
}

/**
 * Entries the editor carries through untouched.
 *
 * Preserved rather than editable: the honest alternatives are to round-trip
 * them or to refuse the edit, and refusing would make every profile holding one
 * uneditable from this console.
 */
export function preservedEntries(entries: readonly PoolProfileEntry[]): PoolProfileEntry[] {
  return entries.filter((e) => !isPlainRef(e));
}

/** Which boxes start ticked. Live references only — see the header. */
export function tickedFrom(entries: readonly PoolProfileEntry[]): string[] {
  return entries.filter(isPlainRef).map((e) => refOf(e) as string);
}

/**
 * Attributes a preserved entry already projects.
 *
 * Their tick is shown on and locked. Unticking would not remove them — the
 * preserved entry is written back regardless — so an editable box would let an
 * operator clear it, save, and find the attribute still presented.
 */
export function lockedRefs(entries: readonly PoolProfileEntry[]): Set<string> {
  return new Set(
    preservedEntries(entries)
      .map(refOf)
      .filter((id): id is string => id !== null),
  );
}

/**
 * The entries to write back.
 *
 * `ticked` is what the operator has on screen; `existing` is what the profile
 * holds. A ticked attribute that a preserved entry already projects is dropped
 * from the live half rather than added beside it — the preserved entry is the
 * more specific statement, and duplicating the attribute would present it
 * twice.
 */
export function composeEntries(
  existing: readonly PoolProfileEntry[],
  ticked: Iterable<string>,
): PoolProfileEntry[] {
  const preserved = preservedEntries(existing);
  const locked = lockedRefs(existing);
  const live = [...new Set(ticked)]
    .filter((ref) => !locked.has(ref))
    .map((ref) => ({ ref }));
  return [...live, ...preserved];
}
