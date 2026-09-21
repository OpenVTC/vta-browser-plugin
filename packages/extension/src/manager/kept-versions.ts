// Earlier values the agent keeps because a face pins them.
//
// After a name change, a face pinned to the old version — the bank that
// verified the old name — keeps showing it, so the agent keeps that version.
// `Attribute.retainedVersions` says which versions are kept and which faces are
// the reason. A holder who overwrote a value may reasonably believe it gone;
// this is where the console tells them it is not, and offers to remove it.
//
// Removing it does not make those faces show the new value: a pin exists so a
// counterparty is not shown a value the holder did not choose for them. They
// show nothing for that entry until the holder repins or edits them. The words
// here say that, because "remove the old name" reads like "update the bank".

import type { PoolAttribute } from "@openvtc/pnm-core/admin";

export interface KeptVersion {
  version: number;
  /** The faces pinning it, by the holder's own name where the console has one. */
  faces: string[];
}

/** What the agent keeps of this attribute beyond its current value. */
export function keptVersions(
  attribute: PoolAttribute,
  profiles: readonly { profileId: string; name: string }[],
): KeptVersion[] {
  return (attribute.retainedVersions ?? []).map((k) => ({
    version: k.version,
    faces: k.pinnedBy.map((id) => profiles.find((p) => p.profileId === id)?.name ?? "a face"),
  }));
}

/** One line for the strip, or `null` when nothing is kept. */
export function keptWords(kept: readonly KeptVersion[]): string | null {
  if (kept.length === 0) return null;
  const faces = [...new Set(kept.flatMap((k) => k.faces))];
  const who = faces.length === 1 ? faces[0] : `${faces.slice(0, -1).join(", ")} and ${faces.at(-1)}`;
  return kept.length === 1
    ? `An earlier value is still kept, because ${who} ${faces.length === 1 ? "is" : "are"} pinned to it.`
    : `${kept.length} earlier values are still kept, because ${who} ${faces.length === 1 ? "is" : "are"} pinned to them.`;
}

/** What removing them does to the faces that pinned them. */
export function purgeConsequence(kept: readonly KeptVersion[]): string {
  const faces = [...new Set(kept.flatMap((k) => k.faces))];
  return (
    `${faces.join(", ")} will show nothing for this afterwards — not the current value, ` +
    `which you did not choose for ${faces.length === 1 ? "it" : "them"}. Repin or edit ` +
    `${faces.length === 1 ? "it" : "them"} if that is not what you want. Anyone already shown ` +
    `the old value keeps it.`
  );
}
