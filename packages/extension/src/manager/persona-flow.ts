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
 * Step one is always reachable — going back to add another fact is the most
 * ordinary thing a person wants here, and until the stepper answered clicks
 * the only route was a button labelled "Cancel", which reads as abandoning the
 * whole flow rather than stepping back one.
 *
 * The later two are reachable only once they have something to work on: a face
 * cannot be composed out of no facts, and a persona cannot wear a face that
 * does not exist. Reaching them empty would present a form whose every control
 * refuses, which is a worse answer than not offering the step.
 */
export function reachableStep(step: 1 | 2 | 3, have: { facts: number; faces: number }): boolean {
  if (step === 1) return true;
  if (step === 2) return have.facts > 0;
  return have.faces > 0;
}
