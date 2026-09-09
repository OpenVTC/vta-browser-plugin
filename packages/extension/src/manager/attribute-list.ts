// The list view's model: attributes in groups, a selection over them, and what
// a bulk action would do.
//
// ## Why a second view at all
//
// The identity map answers "what reaches what". It is the right picture for a
// pool of five and the wrong one for a pool of fifty: reach is drawn per
// selection, so a holder who wants to *tidy* — delete four stale numbers, put
// six attributes into a new face — has to open, read and confirm one card at a
// time. That is the clunkiness the map cannot design its way out of, because
// the map's whole subject is one selection at a time.
//
// So this module is the model for a second view over the same graph: the same
// `AttributeNode`s, the same families, no new wire records, and a selection
// that is a *set* rather than a single node. It lives out of the component for
// the same reason `identity-graph.ts` does — the interesting parts are the
// ordering and the set arithmetic, and both are testable with no DOM.
//
// ## The grouping is the one that already exists
//
// Rows group by `familyOf`, in `FAMILY_ORDER`, with `familyStyle`'s words as
// the headings. Not a second taxonomy invented for this view: two groupings of
// the same pool that disagree is the defect where a person counts six in one
// place and five in the other and neither is wrong. If the list wants a
// grouping the map does not have, it belongs in `attribute-family.ts` where
// both read it.
//
// ## One bulk action is deliberately missing
//
// `persona/attribute/put` is a **replace**, and this console lists without
// `includeSensitive` on purpose — so an attribute resolving to `sensitivity:
// high` reaches the client with `value: undefined`. A bulk "change visibility
// on these twelve" written through `put` would send `value: ""` for every
// sensitive one and blank it, silently, with no `attribute/get` and no version
// history to restore from. That is the same hazard `AttributeEditor` fetches a
// value to avoid, multiplied by the size of the selection.
//
// So {@link BULK_ACTIONS} has two members and not three, and
// {@link whyNoBulkVisibility} exists so the screen can *say* why rather than
// leaving a gap someone fills in later. Visibility stays a one-at-a-time edit
// through the editor that holds the value.

import {
  familyOf,
  familyStyle,
  FAMILY_ORDER,
  type Family,
  type FamilyStyle,
} from "./attribute-family.js";
import type { AttributeNode } from "./identity-graph.js";
import type { ClaimTypeRegistry } from "@openvtc/pnm-core/persona";

/** One family's heading and the attributes under it, in display order. */
export interface ListGroup {
  family: Family;
  style: FamilyStyle;
  rows: AttributeNode[];
}

/**
 * The attributes grouped for display, in `FAMILY_ORDER`.
 *
 * Empty families are dropped rather than drawn empty: a heading over nothing
 * reads as a category the holder has failed to fill in, and the pool has no
 * such obligation. Within a family the incoming order is kept — the pool is
 * ULID-ordered, so that is creation order, and a list that re-sorted by label
 * would move a row under the cursor the moment someone renamed it.
 */
export function groupRows(
  attributes: readonly AttributeNode[],
  registry: ClaimTypeRegistry | null,
): ListGroup[] {
  const byFamily = new Map<Family, AttributeNode[]>();
  for (const a of attributes) {
    const family = familyOf(a.type, registry);
    const rows = byFamily.get(family);
    if (rows) rows.push(a);
    else byFamily.set(family, [a]);
  }
  return FAMILY_ORDER.flatMap((family) => {
    const rows = byFamily.get(family);
    if (!rows || rows.length === 0) return [];
    return [{ family, style: familyStyle(family), rows }];
  });
}

/**
 * Every visible row id, top to bottom.
 *
 * This is what a shift-range selects over, and it has to come from the rendered
 * groups rather than from the unsorted pool: a range is what the person saw
 * between the two rows they clicked, and computing it from anything else
 * selects attributes that were never between them on screen.
 */
export function flatOrder(groups: readonly ListGroup[]): string[] {
  return groups.flatMap((g) => g.rows.map((r) => r.id));
}

/** Add or remove one id. */
export function toggle(selection: ReadonlySet<string>, id: string): Set<string> {
  const next = new Set(selection);
  if (!next.delete(id)) next.add(id);
  return next;
}

/**
 * Select every row between `anchor` and `id` inclusive, in visible order.
 *
 * Additive — a range never clears what was already selected — because the
 * gesture people expect from a file list is "and also these", and a range that
 * silently dropped an earlier selection would be discovered by someone who had
 * just lost one.
 *
 * An anchor that is no longer in `order` (its row was deleted, or a filter
 * moved it out of view) degrades to selecting `id` alone rather than throwing
 * or selecting from the top: the anchor is a memory of where the person last
 * clicked, and a stale one is not worth a surprise.
 */
export function selectRange(
  selection: ReadonlySet<string>,
  order: readonly string[],
  anchor: string | null,
  id: string,
): Set<string> {
  const next = new Set(selection);
  const to = order.indexOf(id);
  const from = anchor === null ? -1 : order.indexOf(anchor);
  if (to < 0) return next;
  if (from < 0) {
    next.add(id);
    return next;
  }
  const [lo, hi] = from <= to ? [from, to] : [to, from];
  for (let i = lo; i <= hi; i += 1) {
    const at = order[i];
    if (at !== undefined) next.add(at);
  }
  return next;
}

/**
 * Whether a group is fully selected, partly selected, or not at all — the three
 * states its heading checkbox has to render.
 *
 * `some` is not a rounding of `all`: a heading that showed a tick while two of
 * its six rows were selected would make a bulk delete look like it covered the
 * group when it covered a third of it.
 */
export type GroupState = "none" | "some" | "all";

export function groupState(selection: ReadonlySet<string>, group: ListGroup): GroupState {
  let selected = 0;
  for (const row of group.rows) if (selection.has(row.id)) selected += 1;
  if (selected === 0) return "none";
  return selected === group.rows.length ? "all" : "some";
}

/**
 * Select or clear a whole family.
 *
 * A partly-selected group selects the rest rather than clearing, which is the
 * behaviour that needs no thought: the person clicking a half-ticked heading is
 * reaching for "all of these", and a click that instead threw away the four
 * they had picked one at a time is destructive of work.
 */
export function toggleGroup(selection: ReadonlySet<string>, group: ListGroup): Set<string> {
  const next = new Set(selection);
  if (groupState(selection, group) === "all") {
    for (const row of group.rows) next.delete(row.id);
  } else {
    for (const row of group.rows) next.add(row.id);
  }
  return next;
}

/**
 * Drop ids that are no longer in the pool.
 *
 * Called after every reload. A selection is a set of ids and a delete removes
 * rows from under it, so without this the count on the bulk bar keeps
 * describing attributes that are gone — and the next bulk action sends their
 * ids to an agent that will refuse them one at a time.
 */
export function pruneSelection(
  selection: ReadonlySet<string>,
  attributes: readonly AttributeNode[],
): Set<string> {
  const live = new Set(attributes.map((a) => a.id));
  const next = new Set<string>();
  for (const id of selection) if (live.has(id)) next.add(id);
  return next;
}

/** The selected attributes, in visible order rather than selection order. */
export function selectedRows(
  selection: ReadonlySet<string>,
  groups: readonly ListGroup[],
): AttributeNode[] {
  return groups.flatMap((g) => g.rows.filter((r) => selection.has(r.id)));
}

/**
 * The bulk actions this view offers.
 *
 * Two, not three — see the module header. Both are expressible with tasks the
 * console already carries (`persona/attribute/delete`, `persona/profile/put`)
 * and neither writes an attribute's `value`, which is the property that makes
 * them safe to run over a selection whose sensitive values this console
 * deliberately does not hold.
 */
export const BULK_ACTIONS = ["delete", "addToFace"] as const;
export type BulkAction = (typeof BULK_ACTIONS)[number];

/**
 * Why visibility is not among them, in the words the screen uses.
 *
 * Exported rather than inlined so the copy is asserted rather than described:
 * a later change that adds a bulk visibility action has to delete this
 * sentence, and deleting it is visible in a diff in a way that quietly adding
 * a third button beside it is not.
 */
export function whyNoBulkVisibility(): string {
  return (
    "Showing and letting go are changed one attribute at a time, from the attribute itself — " +
    "your agent does not send this console the values it keeps back, and changing them in bulk " +
    "would write over the ones it never sent."
  );
}

/**
 * What a bulk delete would take, summarised for the confirm step.
 *
 * The agent has no preview task for the pool the way it does for a context, so
 * the console builds this from what it already listed. It counts rather than
 * reciting: a person confirming a delete of thirty needs the shape of what is
 * going, and thirty rows of it is the same wall the list view exists to fix.
 */
export interface DeletePreview {
  count: number;
  /** Type tokens in the selection, deduplicated, in visible order. */
  types: string[];
  /**
   * How many are the only attribute of their type left in the pool.
   *
   * The one thing a count cannot say and a person would want to know: deleting
   * your third phone number is tidying, deleting your only email address is a
   * face that stops presenting one.
   */
  lastOfType: number;
  /** How many are credential-backed, and so cost more than retyping. */
  credentialBacked: number;
}

export function previewDelete(
  selection: ReadonlySet<string>,
  groups: readonly ListGroup[],
  attributes: readonly AttributeNode[],
): DeletePreview {
  const rows = selectedRows(selection, groups);
  const remaining = new Map<string, number>();
  for (const a of attributes) {
    if (selection.has(a.id)) continue;
    remaining.set(a.type, (remaining.get(a.type) ?? 0) + 1);
  }
  const types: string[] = [];
  for (const r of rows) if (!types.includes(r.type)) types.push(r.type);
  return {
    count: rows.length,
    types,
    lastOfType: types.filter((ty) => (remaining.get(ty) ?? 0) === 0).length,
    credentialBacked: rows.filter((r) => r.provenance.kind === "credentialBacked").length,
  };
}
