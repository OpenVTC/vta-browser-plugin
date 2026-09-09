// What the worlds screen needs to know, computed out of the component.
//
// Same discipline as `identity-graph.ts` and `attribute-list.ts`: the questions
// with an answer worth testing live here, and the component draws. Every one of
// these is a question a person asks of the screen — *where is that face
// already?*, *what belongs nowhere?* — and getting one wrong is a screen that
// says something untrue rather than a screen that looks wrong.

import type { FacetColour, PoolFacet, PoolProfile } from "@openvtc/pnm-core/admin";
import { RelayTaskError } from "./carrier.js";

/** One face the agent refused to place, and the world already holding it. */
export interface Placement {
  faceId: string;
  facetId: string;
}

/**
 * The world a face already belongs to, or `undefined`.
 *
 * `excluding` is the world being edited, so its own members do not read as
 * conflicts — without it every checkbox in an edit would be disabled the moment
 * the world held anything, which is the same self-clash the agent's own
 * placement check excludes.
 */
export function worldOfFace(
  worlds: readonly PoolFacet[],
  faceId: string,
  excluding?: string,
): PoolFacet | undefined {
  return worlds.find((w) => w.facetId !== excluding && (w.faceIds ?? []).includes(faceId));
}

/**
 * Faces belonging to no world.
 *
 * Shown, never hidden. A face that belongs nowhere is a perfectly good state —
 * most are, before anyone arranges anything — and a screen that listed only
 * arranged faces would quietly under-report what the holder has, which is the
 * same defect as a context tally that omits a standing.
 */
export function unplacedFaces(
  worlds: readonly PoolFacet[],
  faces: readonly PoolProfile[],
): PoolProfile[] {
  const placed = new Set(worlds.flatMap((w) => w.faceIds ?? []));
  return faces.filter((f) => !placed.has(f.profileId));
}

/**
 * The `faceAlreadyPlaced` refusal, read off an error, or `null`.
 *
 * **Matched on the top-level extended `code`, not on a message.** R3.7: a
 * condition this console must detect needs a stable machine-readable field, and
 * a string match here would break the first time the agent reworded itself.
 *
 * The details are the whole point of the code existing. Told only that the
 * write failed, this pane could do nothing but send the holder off to find
 * where the face already is; told which world, it can say so beside the
 * checkbox. So a refusal whose details are missing or malformed returns `null`
 * rather than an empty list — an empty list would render as "0 faces already
 * belong elsewhere", which is a claim, and the honest answer is to fall through
 * to the generic error.
 */
export function placedElsewhere(error: unknown): Placement[] | null {
  // Typed on the class that actually carries a code. A bare `Error` with a
  // `code` property glued on is not a refusal from the relay, and a
  // `ConsentRequiredError` — the sibling that must reach its own ceremony —
  // has no `code` at all, so neither can be mistaken for this.
  if (!(error instanceof RelayTaskError)) return null;
  if (error.code !== "persona/facet/put:faceAlreadyPlaced") return null;
  const placed = (error.details as { placed?: unknown } | undefined)?.placed;
  if (!Array.isArray(placed) || placed.length === 0) return null;
  const out: Placement[] = [];
  for (const row of placed) {
    if (
      typeof row === "object" &&
      row !== null &&
      typeof (row as Placement).faceId === "string" &&
      typeof (row as Placement).facetId === "string"
    ) {
      out.push({ faceId: (row as Placement).faceId, facetId: (row as Placement).facetId });
    }
  }
  // A mixed array is refused rather than filtered: half an answer about where
  // the holder's faces are is worse than none, because the half that is missing
  // is invisible.
  return out.length === placed.length ? out : null;
}

/**
 * The worlds an attribute belongs to.
 *
 * Plural, and that is the difference from {@link worldOfFace}. A face belongs
 * to one world because the world is where a consumer reads its colour from; an
 * attribute belongs to as many as are true, because a mobile number is
 * genuinely part of a working life and a home one at the same time. A model
 * that made the holder choose would be asking a question about their phone that
 * has no answer, and the agent enforces no exclusivity here for the same
 * reason.
 *
 * Returned in the order the worlds are listed rather than the order the
 * attribute was added to each, so two attributes in the same worlds draw their
 * chips in the same order — a row whose chips reshuffle between renders reads
 * as a change when nothing changed.
 */
export function worldsOfAttribute(
  worlds: readonly PoolFacet[],
  attributeId: string,
): PoolFacet[] {
  return worlds.filter((w) => (w.attributeIds ?? []).includes(attributeId));
}

/** A world's membership, split into what still exists and what does not. */
export interface SeededMembership {
  faceIds: Set<string>;
  attributeIds: Set<string>;
  /** Ids the world names whose records are gone. Counted, not listed: the
   *  holder cannot act on a ULID for a record that no longer exists, and the
   *  only useful thing to say is that the arrangement referred to something
   *  and no longer does. */
  droppedFaces: number;
  droppedAttributes: number;
}

/**
 * The membership to open an editor with.
 *
 * **Only what still resolves.** `persona/facet/list` returns dangling
 * membership rather than pruning it — deliberately, so a consumer can offer to
 * tidy — and the specification is explicit that a consumer "renders a dangling
 * id as an arrangement to repair rather than as a record that exists".
 *
 * Seeding the raw lists breaks that in the worst available way. A dangling id
 * has no checkbox, because there is no record to draw a row for; it rides along
 * invisibly into the next `put`; and the agent refuses the whole write with
 * `unresolvedReference`, naming ULIDs the holder cannot find, cannot untick and
 * cannot clear. The world becomes permanently uneditable by the only screen
 * that edits it.
 *
 * So the editor opens with the live membership and says how much it dropped.
 * Saving then repairs the record, which is the tidying the agent kept the
 * dangling ids around to make possible.
 */
export function seedMembership(
  existing: PoolFacet | undefined,
  faces: readonly PoolProfile[],
  attributes: readonly { attributeId: string }[],
): SeededMembership {
  const liveFaces = new Set(faces.map((f) => f.profileId));
  const liveAttributes = new Set(attributes.map((a) => a.attributeId));
  const namedFaces = existing?.faceIds ?? [];
  const namedAttributes = existing?.attributeIds ?? [];
  const faceIds = new Set(namedFaces.filter((id) => liveFaces.has(id)));
  const attributeIds = new Set(namedAttributes.filter((id) => liveAttributes.has(id)));
  return {
    faceIds,
    attributeIds,
    droppedFaces: namedFaces.length - faceIds.size,
    droppedAttributes: namedAttributes.length - attributeIds.size,
  };
}

/** One `persona/facet/put`, as a mover needs to send it. */
export interface FacetWrite {
  facetId: string;
  name: string;
  colour: FacetColour;
  icon?: string | undefined;
  faceIds: string[];
  attributeIds: string[];
}

/**
 * The writes that move one face from wherever it is to `toFacetId`.
 *
 * **Order matters and is the whole reason this is a function.** `facet/put`
 * replaces, and the agent refuses a write that would place a face already
 * placed elsewhere (`persona/facet/put:faceAlreadyPlaced` — see
 * {@link placedElsewhere}). So the source has to be rewritten *without* the
 * face before the destination is rewritten *with* it. Sending them the other
 * way round is refused, and sending only the destination silently leaves the
 * face in two worlds on any agent that does not enforce the check.
 *
 * Every write carries the world's **live** membership, via {@link seedMembership}:
 * a put that echoed back a dangling id would be refused with `unresolvedReference`
 * naming a ULID whose record no longer exists — which is exactly the bug that
 * made a world permanently uneditable (plugin #216). Moving a face therefore
 * also tidies the world it touches, which is the behaviour the dangling ids
 * were kept for.
 *
 * Returns `[]` when the face is already where it is being dropped, so a drop
 * onto its own world costs no round trip and cannot fail.
 */
export function movePlan(
  worlds: readonly PoolFacet[],
  faces: readonly PoolProfile[],
  attributes: readonly { attributeId: string }[],
  faceId: string,
  toFacetId: string | null,
): FacetWrite[] {
  const from = worldOfFace(worlds, faceId);
  if ((from?.facetId ?? null) === toFacetId) return [];

  const writeFor = (w: PoolFacet, faceIds: string[]): FacetWrite => {
    const live = seedMembership(w, faces, attributes);
    return {
      facetId: w.facetId,
      name: w.name,
      colour: w.colour,
      ...(w.icon ? { icon: w.icon } : {}),
      faceIds,
      attributeIds: [...live.attributeIds],
    };
  };

  const out: FacetWrite[] = [];
  if (from) {
    const live = seedMembership(from, faces, attributes);
    out.push(writeFor(from, [...live.faceIds].filter((id) => id !== faceId)));
  }
  if (toFacetId) {
    const to = worlds.find((w) => w.facetId === toFacetId);
    // A destination that has vanished between render and drop is dropped
    // silently rather than guessed at: the source write above still runs, so
    // the face ends up unplaced, which is the honest half of the move.
    if (to) {
      const live = seedMembership(to, faces, attributes);
      out.push(writeFor(to, [...new Set([...live.faceIds, faceId])]));
    }
  }
  return out;
}
