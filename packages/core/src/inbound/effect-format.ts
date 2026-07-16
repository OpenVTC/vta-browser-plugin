// Pure formatting of a `ConsentEffect`'s structured diff for display.
//
// The approver surface must render *what changes*, not merely the VTA's one-line
// summary: a human can only meaningfully consent to a change they can see —
// "what you see is what you sign". That property is load-bearing once the
// approval is gated behind a biometric/hardware unlock, because the gesture
// authorizes whatever the screen showed.
//
// These helpers turn the open-ended `before`/`after`/`path` fields into short,
// readable strings without pulling a rendering framework into core. Kept pure so
// they are unit-testable and identical across every surface that shows effects.

import type { ConsentEffect } from "./task-consent.js";

/** Max characters of a rendered before/after value before it is truncated, so a
 *  single effect (a whole DID document, say) can't flood the approval popup. */
export const EFFECT_VALUE_MAX = 200;

/** The marker shown for an absent (`undefined`) side of a diff, so "added"
 *  (∅ → value) and "removed" (value → ∅) never render identically to
 *  "unchanged". A concrete glyph beats an empty string, which reads as nothing. */
export const ABSENT_VALUE = "∅";

/**
 * Render an arbitrary effect value (`before` / `after`) as a short display
 * string. Strings pass through verbatim; everything else becomes compact JSON
 * (falling back to `String()` for anything non-serialisable, e.g. a cycle).
 * Long values are truncated with an ellipsis.
 */
export function formatEffectValue(value: unknown): string {
  if (value === undefined) return ABSENT_VALUE;
  let s: string;
  if (typeof value === "string") {
    s = value;
  } else {
    try {
      s = JSON.stringify(value) ?? String(value);
    } catch {
      s = String(value);
    }
  }
  return s.length > EFFECT_VALUE_MAX ? `${s.slice(0, EFFECT_VALUE_MAX)}…` : s;
}

/**
 * Whether an effect carries a structured diff worth rendering beneath its
 * summary. A `path` alone counts — it names *where* the change lands even when
 * the values aren't spelled out.
 */
export function effectHasDiff(
  effect: Pick<ConsentEffect, "path" | "before" | "after">,
): boolean {
  return (
    effect.path !== undefined ||
    effect.before !== undefined ||
    effect.after !== undefined
  );
}

/** A flattened, display-ready view of one effect's diff. `null` when the effect
 *  carries only a summary (nothing structured to show). */
export interface EffectDiffView {
  /** Dotted path the change lands on, if the VTA named one. */
  path?: string;
  /** Prior value, pre-formatted. Present only when `before` was set. */
  before?: string;
  /** New value, pre-formatted. Present only when `after` was set. */
  after?: string;
}

/**
 * Project a `ConsentEffect` to its display-ready diff, or `null` if it has none.
 * Centralises the "which sides are present" logic so every surface renders an
 * add / remove / change consistently.
 */
export function effectDiffView(effect: ConsentEffect): EffectDiffView | null {
  if (!effectHasDiff(effect)) return null;
  const view: EffectDiffView = {};
  if (effect.path !== undefined) view.path = effect.path;
  if (effect.before !== undefined) view.before = formatEffectValue(effect.before);
  if (effect.after !== undefined) view.after = formatEffectValue(effect.after);
  return view;
}
