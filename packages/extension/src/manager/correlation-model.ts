// Which links are worth acting on, and which the holder built on purpose.
//
// `persona/correlation/analyze` reports every value two of the holder's
// identities share. Before worlds existed that was the whole answer, and it is
// a noisy one: a work email in every work face is a link, reported at the same
// standing as a home phone number that turned up in a work face. A holder who
// meets six findings of equal weight learns to dismiss all six, and the one
// that mattered goes with them.
//
// ## Two axes, and this module must not collapse them
//
// `severity` is how strongly a disclosure would link the holder — a fact about
// provenance and proof rung, true whatever they intended. `crossesFacets` is
// whether they would mind. Nothing here reads one as the other, and nothing
// here **softens a severity** because a link stays inside one world: the link
// is real either way, two verifiers who see both faces link the holder
// regardless of how they filed each, and a screen that said otherwise would be
// reporting a false all-clear about something a counterparty can still do.
//
// So a within-a-world finding is *ordered last and worded differently*. It is
// never hidden and never downgraded.
//
// ## Absent is unknown, and that is the trap
//
// `crossesFacets` is **omitted** by an agent that keeps no facets — the
// specification requires that, because `false` would assert the holder keeps
// these identities in one part of their life and an agent with no facets has
// made no such finding. A consumer reading absence as `false` files every
// finding under "you arranged this", which is the worst available answer: it
// tells someone their linkage is intentional on the authority of a question
// nobody asked.

import type { CorrelationFinding, PoolFacet } from "@openvtc/pnm-core/admin";

/** Where a finding sits on the second axis. */
export type Crossing = "crosses" | "within" | "unknown";

export interface RankedFinding {
  finding: CorrelationFinding;
  crossing: Crossing;
  /** The worlds this link touches, resolved to records the console holds.
   *  Ids the console cannot resolve are dropped from the names but still
   *  counted by `crossing` — the agent's answer decides that, not our ability
   *  to name it. */
  worlds: PoolFacet[];
}

/**
 * Read the second axis off one finding.
 *
 * Absent is {@link Crossing} `unknown`, never `within`. See the module header.
 */
export function crossingOf(finding: CorrelationFinding): Crossing {
  const crosses = (finding as { crossesFacets?: unknown }).crossesFacets;
  if (crosses === undefined) return "unknown";
  return crosses ? "crosses" : "within";
}

/**
 * Findings in the order a holder should meet them.
 *
 * Crossing first, then unknown, then within-a-world. Within is last rather than
 * absent: the holder may have arranged it and may equally have forgotten they
 * did, and a link they cannot see is one they cannot revisit.
 *
 * Stable inside each group — the agent's own order is preserved, so two runs
 * over an unchanged pool read the same way.
 */
export function rankFindings(
  findings: readonly CorrelationFinding[],
  worlds: readonly PoolFacet[],
): RankedFinding[] {
  const order: Record<Crossing, number> = { crosses: 0, unknown: 1, within: 2 };
  return findings
    .map((finding) => {
      const ids = ((finding as { facetIds?: unknown }).facetIds ?? []) as string[];
      return {
        finding,
        crossing: crossingOf(finding),
        worlds: ids.flatMap((id) => worlds.filter((w) => w.facetId === id)),
      };
    })
    .map((row, i) => ({ row, i }))
    .sort((a, b) => order[a.row.crossing] - order[b.row.crossing] || a.i - b.i)
    .map(({ row }) => row);
}

export interface CrossingTally {
  crosses: number;
  within: number;
  unknown: number;
}

/** Every finding counted once, under exactly one heading. */
export function tallyCrossings(ranked: readonly RankedFinding[]): CrossingTally {
  const tally: CrossingTally = { crosses: 0, within: 0, unknown: 0 };
  for (const r of ranked) tally[r.crossing] += 1;
  return tally;
}

/**
 * The sentence for one finding's second axis, or `null` where there is nothing
 * honest to say.
 *
 * `null` for `unknown` on purpose. The alternatives are both claims: "this
 * stays in one part of your life" asserts what the agent did not answer, and
 * "your agent did not say" is noise on every row when the holder simply keeps
 * no worlds. The summary says it once instead.
 *
 * The crossing sentence names the worlds where it can, because *"Work and Home
 * share this"* is something a person can act on and *"this crosses a
 * boundary"* is not. With ids it cannot resolve it falls back to the count,
 * which is still true.
 */
export function crossingWords(row: RankedFinding): string | null {
  switch (row.crossing) {
    case "crosses": {
      const names = row.worlds.map((w) => w.name);
      if (names.length >= 2) {
        const last = names[names.length - 1]!;
        const head = names.slice(0, -1).join(", ");
        return `${head} and ${last} share this — anyone who sees both knows they are the same person.`;
      }
      return "This crosses two parts of your life — anyone who sees both knows they are the same person.";
    }
    case "within": {
      const name = row.worlds[0]?.name;
      return name
        ? `Both sides of this are in ${name}, so you arranged it. It is still a link.`
        : "Both sides of this are in one world, so you arranged it. It is still a link.";
    }
    default:
      return null;
  }
}

// ## A finding with no attribute is about faces
//
// The agent reports a value that only faces hold — typed into a face as an
// inline entry, or shown in place of an attribute by an override — with no
// `attributeId`, because there is no attribute. The map places findings on
// attribute cards, so without this such a finding was counted in the summary
// and drawn nowhere: "2 links" above one visible one, which is the numbers not
// closing, the thing `tallyContexts` exists to prevent one band up.

/** One face a face-only finding names. */
export interface NamedFace {
  profileId: string;
  /** The holder's own name for the face, where the console holds the record. */
  name: string | null;
  /** The context a context-local face lives in. The console does not list
   *  those faces, so the context is how the holder finds it. */
  contextId: string | null;
}

/** Findings the map cannot place on an attribute card. */
export function faceOnly(ranked: readonly RankedFinding[]): RankedFinding[] {
  return ranked.filter((r) => !r.finding.attributeId);
}

/**
 * The faces one finding names, each once, in the agent's order.
 *
 * A face appears in `sharedWith` once per context it is worn in, and the
 * holder is being told *which faces*, so repeats collapse. A profile the
 * console holds is named; one it does not is a context-local face, and its
 * context is the only handle there is.
 */
export function facesNamed(
  finding: CorrelationFinding,
  profiles: readonly { profileId: string; name: string }[],
): NamedFace[] {
  const out: NamedFace[] = [];
  const seen = new Set<string>();
  for (const s of (finding.sharedWith ?? []) as { profileId?: string; contextId?: string }[]) {
    if (!s.profileId || seen.has(s.profileId)) continue;
    seen.add(s.profileId);
    const held = profiles.find((p) => p.profileId === s.profileId);
    out.push({
      profileId: s.profileId,
      name: held?.name ?? null,
      contextId: held ? null : (s.contextId ?? null),
    });
  }
  return out;
}

/** "Market and a face kept only in ctx-b" — names, never ids, where there are names. */
export function facesWords(faces: readonly NamedFace[]): string {
  const words = faces.map((f) =>
    f.name !== null
      ? f.name
      : f.contextId !== null
        ? `a face kept only in ${f.contextId}`
        : "a face this console cannot name",
  );
  if (words.length <= 1) return words[0] ?? "No face";
  return `${words.slice(0, -1).join(", ")} and ${words[words.length - 1]}`;
}
