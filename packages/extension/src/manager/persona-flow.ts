// Which of the persona pane's two screens a holder sees.
//
// A plain module, not part of the guide's own file, because the guide is
// `.tsx` and Node's type stripping cannot load JSX — and this rule has been
// wrong twice, so it needed to be somewhere a test can reach.

/**
 * Whether the pane shows the guide rather than the map.
 *
 * Three inputs, and each of the two flags exists because deriving from `faces`
 * alone is wrong in a different direction:
 *
 * - **`faces === 0` alone** would flip to the map the instant step two creates
 *   a face — past step three, which is the step the whole guide leads to.
 *   `guiding` holds it open.
 * - **Deciding once on first load** leaves a holder who deletes their last face
 *   on an empty map with no way back but a page reload. Exploring this pane by
 *   deleting things is the first thing anyone does, so the answer has to be
 *   live.
 * - **`skipped`** is sticky for the session: someone who said they would build
 *   it themselves must not be dropped back into the guide by deleting a face.
 *
 * `faces === null` is "not loaded yet" and is not zero — treating it as zero
 * would flash the guide at every holder on every load.
 */
export function showsGuide(state: { faces: number | null; guiding: boolean; skipped: boolean }): boolean {
  if (state.skipped) return false;
  return state.guiding || state.faces === 0;
}

/**
 * Whether a holder can jump to a step of the guided setup.
 *
 * Step one is always reachable — going back to add another attribute is the most
 * ordinary thing a person wants here, and until the stepper answered clicks
 * the only route was a button labelled "Cancel", which reads as abandoning the
 * whole flow rather than stepping back one.
 *
 * The later two are reachable only once they have something to work on: a face
 * cannot be composed out of no attributes, and a persona cannot wear a face that
 * does not exist. Reaching them empty would present a form whose every control
 * refuses, which is a worse answer than not offering the step.
 */
export function reachableStep(step: 1 | 2 | 3, have: { attributes: number; faces: number }): boolean {
  if (step === 1) return true;
  if (step === 2) return have.attributes > 0;
  return have.faces > 0;
}

/**
 * Whether the pane should point a holder at worlds yet.
 *
 * Worlds are the one part of this model that is **optional and late**. An
 * attribute, a face and a context are each required for the next to mean
 * anything, which is why the guide walks all three; a world arranges faces the
 * holder does not have yet, so putting it in the guide would be asking someone
 * to file one thing into a category.
 *
 * The cost of leaving it out is real, though, and was invisible until someone
 * asked: nothing in the guide mentions worlds, so a holder finishes setup, lands
 * on the map, and only meets the feature by clicking a tab they had no reason to
 * look for. Discoverable to someone already hunting for it is not discoverable.
 *
 * So the nudge is timed to when the answer is useful rather than to arrival:
 * several faces, and no world yet. Below the threshold a world would be an
 * arrangement of one thing; above it, the list is starting to be the wall this
 * feature exists to fix.
 *
 * Returns false while either number is unknown. A pane that nudged during a
 * load would flash a suggestion and withdraw it, and a suggestion that appears
 * and vanishes is one nobody trusts.
 */
export const NUDGE_AT_FACES = 4;

export function suggestsWorlds(state: {
  faces: number | null;
  worlds: number | null;
}): boolean {
  if (state.faces === null || state.worlds === null) return false;
  return state.worlds === 0 && state.faces >= NUDGE_AT_FACES;
}
