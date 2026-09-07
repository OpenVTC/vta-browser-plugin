// Who presents a profile, assembled across every context.
//
// No single task answers this. `persona/profile/delete` computes it agent-side
// and only in order to refuse; `persona/binding/list` is per context and
// returns a profile **name**, never a `profileId`. So the console assembles it,
// and the assembly has a correctness property worth stating and testing:
//
// **Filtering candidates by profile name drops no true match.** A persona
// presenting profile P necessarily reports P's name, because the name in the
// listing comes from the bound profile itself. So the name is a sound
// pre-filter — it can admit a wrong profile that happens to share a name, and
// it cannot exclude a right one. `binding/get` then confirms each candidate by
// `profileId`, which removes exactly the false positives the name admits.
//
// That ordering is the whole design. The inverse — confirming everything —
// costs one call per persona per context; this costs one per *name match*, so
// it is proportional to the answer rather than to the store. And the direction
// of the imprecision matters more than the cost: a false positive is visible
// and gets removed, while a false negative would read as "nobody presents
// this", which is the one wrong answer this view must never give.
//
// Lives here, out of the component, with its readers injected — the same shape
// every network helper in this repo uses for testability, and the reason this
// module has no relative imports.

/** The shape `persona/binding/list` returns per persona. */
export interface BindingListRow {
  personaDid: string;
  bound: boolean;
  profileName?: string | undefined;
  claimCount?: number | undefined;
}

/** The shape `persona/binding/get` returns. */
export interface BindingDetail {
  profileId?: string | undefined;
  profileName?: string | undefined;
  claimCount?: number | undefined;
}

export interface PresentedBy {
  contextId: string;
  personaDid: string;
  claimCount: number;
}

export interface ScanResult {
  rows: PresentedBy[];
  /**
   * Contexts, or personas within them, the agent would not answer for.
   *
   * Surfaced rather than swallowed. A context that refused is not a context
   * where nothing presents this profile, and rendering the two the same way is
   * how a holder concludes a linkage does not exist when nobody actually
   * looked.
   */
  unreadable: string[];
}

/**
 * Candidates worth confirming in one context.
 *
 * Sound, in the specific sense above: never excludes a persona that really does
 * present `profileName`. Exported because that claim is the thing worth a test.
 */
export function bindingCandidates(
  rows: readonly BindingListRow[],
  profileName: string,
): BindingListRow[] {
  return rows.filter((r) => r.bound && r.profileName === profileName);
}

/**
 * Find every persona presenting `profileId`, across `contextIds`.
 *
 * `list` and `get` are injected so this is testable without a browser; the pane
 * passes the real `persona/binding/*` calls.
 */
export async function scanForProfile(
  contextIds: readonly string[],
  profile: { profileId: string; name: string },
  readers: {
    list: (contextId: string) => Promise<{ personas: BindingListRow[] }>;
    get: (contextId: string, personaDid: string) => Promise<BindingDetail>;
  },
): Promise<ScanResult> {
  const rows: PresentedBy[] = [];
  const unreadable: string[] = [];

  for (const contextId of contextIds) {
    let candidates: BindingListRow[];
    try {
      const listed = await readers.list(contextId);
      candidates = bindingCandidates(listed.personas, profile.name);
    } catch {
      // One context refusing must not blank the others: a partial answer is
      // useful as long as it says it is partial.
      unreadable.push(contextId);
      continue;
    }

    for (const candidate of candidates) {
      try {
        const exact = await readers.get(contextId, candidate.personaDid);
        // Confirmed by id, not by the name that got it here — two profiles may
        // share a name, and presenting the wrong one as a linkage would invent
        // a correlation the holder does not have.
        if (exact.profileId === profile.profileId) {
          rows.push({
            contextId,
            personaDid: candidate.personaDid,
            claimCount: exact.claimCount ?? 0,
          });
        }
      } catch {
        unreadable.push(`${contextId}/${candidate.personaDid}`);
      }
    }
  }

  return { rows, unreadable };
}
