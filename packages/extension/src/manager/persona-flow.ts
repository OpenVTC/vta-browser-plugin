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
