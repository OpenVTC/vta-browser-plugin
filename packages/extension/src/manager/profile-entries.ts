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
//     apparently unchanged edit, two entries for one attribute.
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

// ── Slots ───────────────────────────────────────────────────────────────────
//
// Any entry may carry a `slot` naming the role it plays in the face —
// `displayName` answers "what does this face call itself", which a face holding
// a legal name and a preferred one cannot answer by claim type. `profile/put`
// replaces the whole face, so the rules that keep a preserved entry from
// vanishing apply to a slot too: rebuilding live entries as bare `{ref}` would
// strip every slot on them, silently, on the first edit.

/** The slot `displayName`. */
export const DISPLAY_NAME = "displayName";

function slotOf(entry: PoolProfileEntry): string | undefined {
  return (entry as { slot?: string }).slot;
}

function withSlot<E extends PoolProfileEntry>(entry: E, slot: string | undefined): E {
  const { slot: _drop, ...rest } = entry as E & { slot?: string };
  return (slot === undefined ? rest : { ...rest, slot }) as E;
}

/** The attribute the face calls itself by, or null when no entry says. An
 *  inline name has no attribute, and reads as null here too. */
export function displayNameOf(entries: readonly PoolProfileEntry[]): string | null {
  const e = entries.find((x) => slotOf(x) === DISPLAY_NAME);
  return e ? refOf(e) : null;
}

/** Whether a face names itself with a value typed only into the face — a
 *  choice the tick list cannot make, and so must not overwrite. */
export function displayNameIsInline(entries: readonly PoolProfileEntry[]): boolean {
  return entries.some((x) => slotOf(x) === DISPLAY_NAME && refOf(x) === null);
}

/**
 * {@link composeEntries}, carrying slots through and setting `displayName`.
 *
 * `displayName` is the attribute to mark, `null` to mark none, or `undefined`
 * to leave whatever the face already says. Every other slot is kept where it
 * was: a live entry keeps the slot its attribute had, a preserved entry keeps
 * its own. The one slot moved is `displayName`, and it moves whole — one entry
 * holds it afterwards, or none, never two (the agent would refuse two).
 */
export function composeEntriesWithSlots(
  existing: readonly PoolProfileEntry[],
  ticked: Iterable<string>,
  displayName?: string | null,
): PoolProfileEntry[] {
  const liveSlots = new Map<string, string>();
  for (const e of existing) {
    const s = slotOf(e);
    if (isPlainRef(e) && s !== undefined) liveSlots.set(refOf(e) as string, s);
  }
  const composed = composeEntries(existing, ticked).map((e) =>
    isPlainRef(e) ? withSlot(e, liveSlots.get(refOf(e) as string)) : e,
  );
  if (displayName === undefined) return composed;

  // Clear it everywhere, then set it on the first entry naming the attribute.
  let placed = false;
  return composed.map((e) => {
    const s = slotOf(e);
    const cleared = s === DISPLAY_NAME ? withSlot(e, undefined) : e;
    if (!placed && displayName !== null && refOf(e) === displayName && slotOf(cleared) === undefined) {
      placed = true;
      return withSlot(cleared, DISPLAY_NAME);
    }
    return cleared;
  });
}
