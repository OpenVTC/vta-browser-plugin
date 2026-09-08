// The identity map's model: attributes, faces, contexts, and what reaches what.
//
// The persona pane draws one picture of the whole model — attributes on top, faces
// in the middle, contexts below — and lights up everything a selection reaches.
// Which things light up is the substance of the picture: an attribute that reaches
// two contexts through one face is the holder's linkage made visible, and a
// context that lights the wrong face is a lie about what it holds. So the graph
// and the reach computation live here, out of the component, with no DOM and
// no relative imports, where they can be tested the way `profile-entries.ts`
// was.
//
// Vocabulary on screen follows `design-docs/persona-vocabulary.md`: an attribute, a
// face, a context, a persona that *wears* a face. The identifiers below keep the
// spec's names where they name wire records (`profileId`, `personaDid`).

import type { PoolAttribute, PoolProfile, PoolProfileEntry } from "@openvtc/pnm-core/admin";

export interface AttributeNode {
  id: string;
  type: string;
  label?: string | undefined;
  value: unknown;
  provenance: PoolAttribute["provenance"];
  stale: boolean;
  staleReason?: string | undefined;
  version: number;
}

export interface FaceNode {
  id: string;
  name: string;
  /** Attributes this face selects by live reference. */
  attributeIds: string[];
  /** Entries that are not a live reference — pinned, overridden, inline. They
   *  still reach a context; they just do not draw to an attribute card. */
  preserved: number;
  entries: PoolProfileEntry[];
  version: number;
}

export interface PersonaNode {
  did: string;
  contextId: string;
  /** The face it wears, or null when it presents nothing. */
  faceId: string | null;
  faceName?: string | undefined;
  claimCount: number;
}

export interface ContextNode {
  id: string;
  label: string;
  personas: PersonaNode[];
  /** Set when the agent would not list this context's bindings. A context
   *  that could not be read is not a context where nobody is known — the
   *  picture has to say which. */
  unreadable?: string | undefined;
}

/** A face worn by more than one persona. Every wearer presents the same
 *  values, so anyone who sees two of them knows they are the same person. */
export interface FaceLink {
  faceId: string;
  wearers: PersonaNode[];
}

export interface IdentityGraph {
  attributes: AttributeNode[];
  faces: FaceNode[];
  contexts: ContextNode[];
  links: FaceLink[];
}

export type Selection =
  | { kind: "attribute"; id: string }
  | { kind: "face"; id: string }
  | { kind: "context"; id: string }
  | { kind: "persona"; contextId: string; did: string };

/** One key for a persona across the map. The same DID in two contexts is two
 *  unrelated bindings, so the context is part of the identity. */
export function personaKey(contextId: string, did: string): string {
  return `${contextId} ${did}`;
}

function liveRefs(entries: readonly PoolProfileEntry[]): string[] {
  return entries
    .filter((e) => "ref" in e && !("pinVersion" in e) && !("override" in e))
    .map((e) => (e as { ref: string }).ref);
}

/** What the pane loaded for one context, before it becomes a node. */
export interface ContextInput {
  id: string;
  label: string;
  bindings:
    | {
        ok: true;
        personas: {
          did: string;
          faceId: string | null;
          faceName?: string | undefined;
          claimCount: number;
        }[];
      }
    | { ok: false; error: string };
}

export function buildGraph(
  attributes: readonly PoolAttribute[],
  profiles: readonly PoolProfile[],
  contexts: readonly ContextInput[],
): IdentityGraph {
  const attributeNodes: AttributeNode[] = attributes.map((a) => ({
    id: a.attributeId,
    type: a.type,
    label: a.label,
    value: a.value,
    provenance: a.provenance,
    stale: a.stale === true,
    staleReason: a.staleReason,
    version: a.version,
  }));

  const faces: FaceNode[] = profiles.map((p) => {
    const refs = liveRefs(p.entries);
    return {
      id: p.profileId,
      name: p.name,
      attributeIds: refs,
      preserved: p.entries.length - refs.length,
      entries: p.entries,
      version: p.version,
    };
  });

  const contextNodes: ContextNode[] = contexts.map((c) => {
    if (!c.bindings.ok) {
      return { id: c.id, label: c.label, personas: [], unreadable: c.bindings.error };
    }
    return {
      id: c.id,
      label: c.label,
      personas: c.bindings.personas.map((p) => ({
        did: p.did,
        contextId: c.id,
        faceId: p.faceId,
        faceName: p.faceName,
        claimCount: p.claimCount,
      })),
    };
  });

  // A link is structural — derivable from the bindings alone, no agent call.
  // Two personas wearing one face present identical values by construction.
  const wearers = new Map<string, PersonaNode[]>();
  for (const ctx of contextNodes) {
    for (const persona of ctx.personas) {
      if (!persona.faceId) continue;
      const list = wearers.get(persona.faceId) ?? [];
      list.push(persona);
      wearers.set(persona.faceId, list);
    }
  }
  const links: FaceLink[] = [...wearers]
    .filter(([, list]) => list.length > 1)
    .map(([faceId, list]) => ({ faceId, wearers: list }));

  return { attributes: attributeNodes, faces, contexts: contextNodes, links };
}

/** Everything a selection reaches, in every direction it can reach. */
export interface Reach {
  attributeIds: Set<string>;
  faceIds: Set<string>;
  personaKeys: Set<string>;
  contextIds: Set<string>;
}

function empty(): Reach {
  return { attributeIds: new Set(), faceIds: new Set(), personaKeys: new Set(), contextIds: new Set() };
}

/**
 * What lights up.
 *
 * Reach runs **downwards from an attribute** — the faces that select it, the personas
 * that wear those faces, the contexts they are in — and **upwards from a
 * context** — its personas' faces and those faces' attributes. A face reaches both
 * ways. That asymmetry is the model: an attribute's reach is where it *goes*; a
 * context's reach is what it *holds*.
 *
 * Nothing here reads a context's copy. The picture is drawn from the pool and
 * the bindings, which is all the console is allowed to see; it is correct
 * because a write above the boundary pushes (VTI#1281), not because anything
 * pulled.
 */
export function reachOf(graph: IdentityGraph, selection: Selection | null): Reach {
  const out = empty();
  if (!selection) return out;

  const facesWithAttribute = (attributeId: string) => graph.faces.filter((f) => f.attributeIds.includes(attributeId));
  const wearersOf = (faceId: string) =>
    graph.contexts.flatMap((c) => c.personas.filter((p) => p.faceId === faceId));

  const lightFaceDown = (faceId: string) => {
    out.faceIds.add(faceId);
    for (const p of wearersOf(faceId)) {
      out.personaKeys.add(personaKey(p.contextId, p.did));
      out.contextIds.add(p.contextId);
    }
  };
  const lightFaceUp = (faceId: string) => {
    out.faceIds.add(faceId);
    const face = graph.faces.find((f) => f.id === faceId);
    for (const id of face?.attributeIds ?? []) out.attributeIds.add(id);
  };

  switch (selection.kind) {
    case "attribute":
      out.attributeIds.add(selection.id);
      for (const face of facesWithAttribute(selection.id)) lightFaceDown(face.id);
      break;
    case "face":
      lightFaceUp(selection.id);
      lightFaceDown(selection.id);
      break;
    case "context": {
      out.contextIds.add(selection.id);
      const ctx = graph.contexts.find((c) => c.id === selection.id);
      for (const p of ctx?.personas ?? []) {
        out.personaKeys.add(personaKey(p.contextId, p.did));
        if (p.faceId) lightFaceUp(p.faceId);
      }
      break;
    }
    case "persona": {
      out.contextIds.add(selection.contextId);
      out.personaKeys.add(personaKey(selection.contextId, selection.did));
      const ctx = graph.contexts.find((c) => c.id === selection.contextId);
      const p = ctx?.personas.find((x) => x.did === selection.did);
      if (p?.faceId) lightFaceUp(p.faceId);
      break;
    }
  }
  return out;
}

/** The faces an attribute reaches, and the contexts beyond them — the sentence the
 *  detail strip says: "reaches 2 contexts through Glenn – Developer". */
export function attributeReach(
  graph: IdentityGraph,
  attributeId: string,
): { faces: FaceNode[]; contextIds: string[]; wearers: PersonaNode[] } {
  const faces = graph.faces.filter((f) => f.attributeIds.includes(attributeId));
  const wearers = graph.contexts.flatMap((c) =>
    c.personas.filter((p) => p.faceId !== null && faces.some((f) => f.id === p.faceId)),
  );
  return { faces, contextIds: [...new Set(wearers.map((w) => w.contextId))], wearers };
}
