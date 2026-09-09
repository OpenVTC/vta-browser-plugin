// The words an attribute is described by, wherever it is drawn.
//
// These were private to `persona-map.tsx` while the map was the only surface
// that drew an attribute. The list view draws the same attributes in a
// different shape, and a second copy of `provenanceWords` is how the map comes
// to say *you said so* beside a row the list calls *credential · storm.ws* —
// the same defect as two groupings of one pool that disagree, in the channel a
// person is most likely to act on.
//
// So they moved down rather than being copied across, and they take no props
// and touch no DOM: every one of them is a claim about an attribute, testable
// as a string. The rule they all follow is `design-docs/persona-vocabulary.md`
// — *you said so*, *credential · ‹issuer›*, *made per verifier*, *stale ·
// ‹reason›* — which is the other reason to have exactly one of each. A word
// retired from that table has to be findable, and it is findable here.

import { splitDid } from "../did-display.js";
import type { AttributeNode } from "./identity-graph.js";

/**
 * What provenance says on screen, and the tone it says it in.
 *
 * Both halves of the credential case, every time: *provable* and *the same
 * signature to everyone who sees it*. The second is the one people miss, and
 * the vocabulary table calls it out for that reason — a credential is the
 * strongest thing an attribute can be and the most linkable, and a surface that
 * prints only the first half is selling one without the other.
 */
export function provenanceWords(p: AttributeNode["provenance"]): {
  text: string;
  tone: "off" | "accent" | "ok";
} {
  switch (p.kind) {
    case "credentialBacked": {
      const issuer = p.issuerDid ? issuerLabel(p.issuerDid) : null;
      return { text: issuer ? `credential · ${issuer}` : "credential", tone: "accent" };
    }
    case "generated":
      return { text: p.perVerifier ? "made per verifier" : "generated", tone: "ok" };
    default:
      return { text: "you said so", tone: "off" };
  }
}

export function issuerLabel(did: string): string {
  const host = splitDid(did).find((part) => part.role === "host")?.text;
  return host ?? did.slice(0, 18) + "…";
}

/**
 * Whether the holder's own label is telling the reader anything the value does
 * not already say.
 *
 * A label is a note to self — "work mobile", "the flat" — and it earns its
 * place beside the value. When it *is* the value it earns nothing: a `company`
 * attribute labelled "Affinidi" holding "Affinidi" drew **Affinidi · Affinidi**,
 * which reads as a stutter and, worse, as two facts.
 *
 * Compared case- and space-insensitively, because "affinidi" beside "Affinidi"
 * is the same stutter with a different shift key. Only a string value is
 * compared: a JSON object rendered beside a label never repeats it, and
 * stringifying one here to find out would be work in aid of a case that cannot
 * arise.
 */
export function labelSaysSomethingElse(label: string | undefined, value: unknown): boolean {
  if (!label) return false;
  if (typeof value !== "string") return true;
  return label.trim().toLowerCase() !== value.trim().toLowerCase();
}

/**
 * *stale · ‹reason›* — shown, never hidden.
 *
 * A pool that looks smaller than it is would leave the holder unaware that
 * something they believe they hold can no longer be proven.
 */
export function staleWords(reason: string | undefined): string {
  switch (reason) {
    case "expired":
      return "stale · expired";
    case "revoked":
      return "stale · revoked";
    default:
      return "stale";
  }
}
