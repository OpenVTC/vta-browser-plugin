// Which personas a context may offer, and the one rule that governs it.
//
// **Every candidate belongs to the named context, and nothing else does.** A
// binding is context-scoped — the same DID in two contexts is two unrelated
// bindings — so offering an identifier from elsewhere invites a holder to be
// known in one place by a name another place already knows them by, which is
// the correlation the whole family exists to let them avoid. Doing it in a
// picker labelled "the identifier this context knows you by" is worse than not
// offering a list at all.
//
// The agent already filters (`list_dids_webvh` drops anything whose
// `context_id` differs). This filters again anyway, and the difference between
// "the agent promises" and "this list cannot contain one" is a test — which is
// the whole reason the rule is here rather than inline in the component.

/** A published identifier, as `vta/webvh/dids/list` returns it. */
export interface PublishedDid {
  did: string;
  contextId: string;
}

/** A persona `persona/binding/list` already knows about in this context. */
export interface KnownPersona {
  personaDid: string;
  bound: boolean;
  profileName?: string | undefined;
}

export interface PersonaCandidate {
  did: string;
  /** What it is, in the words the picker shows beside it. */
  note: string;
}

/**
 * The personas to offer for `contextId`.
 *
 * Two sources, and the second is why the first is not enough: a persona that is
 * not a published `did:webvh` — a `did:key` the VTA minted, a `did:peer` — never
 * appears in the published list, and a picker built from that alone would hide
 * exactly the personas already in use.
 *
 * `known` is trusted as already scoped, because `binding/list` takes the
 * context as its argument and its rows carry no context of their own to check.
 * `published` is not: its rows carry a `contextId`, so it is checked.
 */
export function personaCandidates(
  contextId: string,
  published: readonly PublishedDid[],
  known: readonly KnownPersona[],
): PersonaCandidate[] {
  const out = new Map<string, string>();
  for (const d of published) {
    if (d.contextId !== contextId) continue;
    out.set(d.did, "published here");
  }
  for (const persona of known) {
    // Already-known wins the label: "wears Developer" says more than "published
    // here", and it is the line a holder is looking for when they came to change
    // what a persona wears.
    out.set(
      persona.personaDid,
      persona.bound ? `wears ${persona.profileName ?? "a face"}` : "known here, wearing nothing",
    );
  }
  return [...out].map(([did, note]) => ({ did, note }));
}
