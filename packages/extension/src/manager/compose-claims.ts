// Composing a face for one context — `persona/profile/compose`, design note
// `persona-context-first.md` §5.3.
//
// The form holds rows; the agent takes claims. Turning one into the other, and
// saying what came back, is this module — words and shapes only, testable
// without a DOM.
//
// Local by default: a typed value stays in this face unless the holder ticks
// "use in my other faces too". Where the face lives follows from the claims.

import type { ComposeClaim } from "@openvtc/pnm-core/admin";

/** One row of the compose form. */
export type ComposeRow =
  | { kind: "new"; type: string; value: string; share: boolean }
  | { kind: "held"; attributeId: string };

/** The claim-type grammar the agent enforces — checked here so the holder is
 *  told on the row rather than by a refusal of the whole face. */
const CLAIM_TYPE = /^(x:)?[a-z][a-zA-Z0-9]*(\.[a-z][a-zA-Z0-9]*)*$/;

/** Rows as the claims the agent takes, or why they cannot be sent. Blank rows
 *  are dropped; a half-filled one is refused. */
export function composeClaimsFrom(
  rows: readonly ComposeRow[],
): { ok: true; claims: [ComposeClaim, ...ComposeClaim[]] } | { ok: false; why: string } {
  const claims: ComposeClaim[] = [];
  for (const row of rows) {
    if (row.kind === "held") {
      if (row.attributeId) claims.push({ attributeId: row.attributeId });
      continue;
    }
    const type = row.type.trim();
    const value = row.value.trim();
    if (!type && !value) continue;
    if (!type || !value) return { ok: false, why: "A row needs both what it is and its value." };
    if (!CLAIM_TYPE.test(type)) {
      return { ok: false, why: `“${type}” is not a claim type — dotted and lower-case, like name.display.` };
    }
    claims.push({ type, valueType: "string", value, ...(row.share ? { share: "pool" as const } : {}) });
  }
  const [first, ...rest] = claims;
  if (!first) return { ok: false, why: "A face needs at least one thing to show." };
  return { ok: true, claims: [first, ...rest] };
}

/** What a compose did, in the words the form closes with. */
export function composedWords(res: {
  scope: string;
  pooled?: readonly { created: boolean }[];
  binding?: { personaDid: string };
}): string {
  const where =
    res.scope === "local"
      ? "Made here. Nothing you typed is reusable elsewhere — make a value reusable later if you want it in other faces."
      : "Made in your pool, so it can be worn in other contexts too.";
  const reused = (res.pooled ?? []).filter((p) => !p.created).length;
  const shared =
    reused > 0
      ? ` ${reused} value${reused === 1 ? " was" : "s were"} already kept, so this face now draws on the same fact as whatever else shows it — an edit changes both.`
      : "";
  const worn = res.binding ? " It is worn here now." : "";
  return where + shared + worn;
}
