// The marks a world can wear.
//
// A curated grid, not an emoji keyboard. Two reasons, and the second is the one
// that decides it.
//
// A picker over the whole set is a search box and a category rail — a component
// the size of this pane — to choose something that appears at 10px beside a
// name. And the wire bounds `icon` at 8 characters, which most single emoji fit
// and a great many sequences do not: a family emoji is six code points joined by
// zero-width joiners and would be refused by the agent *after* the holder picked
// it, which is the worst moment to find out.
//
// So the grid offers marks that are known to fit, and the free-text field stays
// beside it for anyone who wants something else — typing is the escape hatch,
// and a value typed there is the holder's problem in the way a value this
// console *offered* would not be.
//
// `world-marks.test.mts` asserts every offered mark against the published bound
// rather than trusting the eye that picked them.

/** The published `maxLength` on `persona/facet/put`'s `icon`. */
export const MAX_MARK_LENGTH = 8;

/**
 * Marks, loosely by the part of a life they suggest.
 *
 * Ordered so the first row is the one most people want — the three worlds the
 * feature's own copy names — and every one is a single code point, which is
 * what keeps them inside the bound and renders on the widest set of platforms.
 * Nothing here carries a status meaning: a tick, a cross or a warning triangle
 * would put a judgement on a part of somebody's life.
 */
export const WORLD_MARKS: readonly string[] = [
  // Work, home, play — the three the copy names.
  "\u{1F4BC}", // briefcase
  "\u{1F3E0}", // house
  "\u{1F3AE}", // game controller
  // Around a life
  "\u{1F393}", // graduation cap
  "\u{1F4B0}", // money bag
  "\u{1F3E5}", // hospital
  "\u{1F6D2}", // shopping trolley
  "\u{1F373}", // cooking
  "\u{1F3CB}", // weightlifter
  // Making and playing
  "\u{1F3A8}", // artist palette
  "\u{1F3B5}", // musical note
  "\u{1F4DA}", // books
  "\u{1F4BB}", // laptop
  "\u{1F527}", // wrench
  "\u{26BD}", // football
  // Out in the world
  "\u{1F30D}", // globe
  "\u{1F697}", // car
  "\u{1F333}", // tree
  "\u{1F415}", // dog
  "\u{1F431}", // cat
  // Plain
  "\u{2B50}", // star
  "\u{1F525}", // fire
  "\u{1F30A}", // wave
  "\u{1F511}", // key
];

/**
 * Whether a mark is short enough for the wire.
 *
 * Measured in UTF-16 code units, which is what a JSON Schema `maxLength` is
 * compared against by every validator in this stack — not in bytes, and not in
 * grapheme clusters. A single astral-plane emoji is 2, so the bound of 8 holds
 * two of them and refuses a joined sequence, which is the behaviour the grid
 * above is chosen to stay inside.
 */
export function markFits(mark: string): boolean {
  return mark.length > 0 && mark.length <= MAX_MARK_LENGTH;
}
