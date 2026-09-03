// Rendering helpers that refuse to state more than the agent said.
//
// Both of these exist because of the same failure, seen against a live agent:
// a value the console did not have was rendered as a confident, wrong one.

import type { ContextRecord } from "@openvtc/pnm-core";

/**
 * Anything at or before this is treated as "no timestamp", not as a date.
 *
 * `new Date(null)`, `new Date(0)` and `new Date(undefined as never)` all land
 * on or near the epoch, and `toLocaleString()` renders that as
 * "01/01/1970, 01:00:00" — which reads as a real answer and is not one. A
 * session whose expiry the agent did not send is not a session that expired
 * fifty-six years ago, and the difference matters on a banner whose whole job
 * is to say how long your authority lasts.
 *
 * A year is generous: no real timestamp in this system predates the protocol.
 */
const NOT_A_TIMESTAMP = Date.UTC(1971, 0, 1);

/** Parse to a Date, or null when the value cannot be one. */
function parseInstant(value: string | number | null | undefined): Date | null {
  if (value === null || value === undefined || value === "") return null;
  const d = new Date(value);
  const ms = d.getTime();
  if (Number.isNaN(ms) || ms <= NOT_A_TIMESTAMP) return null;
  return d;
}

/** Date and time, or `fallback` when the agent gave nothing usable. */
export function formatInstant(
  value: string | number | null | undefined,
  fallback = "unknown",
): string {
  return parseInstant(value)?.toLocaleString() ?? fallback;
}

/** Date only, or `fallback`. */
export function formatDate(
  value: string | number | null | undefined,
  fallback = "unknown",
): string {
  return parseInstant(value)?.toLocaleDateString() ?? fallback;
}

/** Whether an instant has passed. `false` when there is no usable instant —
 *  "we don't know" must never render as "expired". */
export function isPast(value: string | number | null | undefined): boolean {
  const d = parseInstant(value);
  return d !== null && d.getTime() < Date.now();
}

/**
 * How a context is named everywhere in this console.
 *
 * The tree used to render `name` ("Verifiable Trust Agent") while every table
 * column and pane title rendered `id` ("vta"), so the same context had two
 * names on one screen and nothing connecting them. An operator selecting
 * "Verifiable Trust Agent" and reading "Audit for vta" has to guess those are
 * the same thing — and when the ids are `vta`, `vtc` and `webvh`, guessing is
 * exactly what they should not be doing.
 *
 * So both are shown, always, in the same order: the operator's own label reads
 * first because that is what they navigate by, and the `id` follows in
 * monospace because that is the vocabulary the agent's own records carry — a
 * key's `contextId`, a DID's `contextId`, an ACL scope. The id is what joins
 * this tree to every table beside it, so it is never the half that gets
 * dropped.
 */
export interface ContextLabel {
  /** What to read first. The operator's label, or the id when there is none. */
  primary: string;
  /** The agent's own identifier, when it differs from `primary`. Monospace. */
  id?: string;
}

export function contextLabel(record: ContextRecord): ContextLabel {
  const name = record.name?.trim();
  return name && name !== record.id ? { primary: name, id: record.id } : { primary: record.id };
}

/** One-line form for a heading: `Verifiable Trust Agent (vta)`. */
export function contextHeading(record: ContextRecord | undefined, id: string): string {
  if (!record) return id;
  const label = contextLabel(record);
  return label.id ? `${label.primary} (${label.id})` : label.primary;
}
