// What the console says about a face's life: how far it has spoken before a
// delete, what retiring did, where it is worn, and its timeline.
//
// Words only, no DOM — so each claim is testable as a string, as
// `attribute-words.ts` and `kept-versions.ts` are. Design note
// `persona-context-first.md` §9.4 (retire, and the delete warning), §5.4
// (usage and reach), §9.6 (timeline).

import type { FaceReach, TimelineEvent } from "@openvtc/pnm-core/admin";

/** `persona/profile/get` / `delete` `disclosedTo`. */
export interface DisclosedTo {
  partyCount: number;
  contextCount: number;
}

/**
 * The sentence a delete must say before it happens: deleting a face does not
 * un-tell anyone. `null` when the face has told no one — then there is nothing
 * to warn about, and a warning with a zero in it teaches people to skip it.
 */
export function unTellWords(d: DisclosedTo | undefined | null): string | null {
  if (!d || d.partyCount === 0) return null;
  const parties = `${d.partyCount} part${d.partyCount === 1 ? "y" : "ies"}`;
  const contexts = `${d.contextCount} context${d.contextCount === 1 ? "" : "s"}`;
  return (
    `This face has disclosed to ${parties} across ${contexts}. Deleting it does not un-tell ` +
    `them — they keep what they were shown, and your history keeps saying so.`
  );
}

/** What retiring did, for the line under the button. */
export function retiredWords(unbound: readonly unknown[] | undefined): string {
  const n = unbound?.length ?? 0;
  return n === 0
    ? "Retired. It was worn nowhere; it is kept, and you can reinstate it."
    : `Retired. Taken off ${n} place${n === 1 ? "" : "s"} it was worn, and kept — reinstate it to wear it again.`;
}

/** A face's reach in words. */
export function reachWords(reach: FaceReach | undefined): string {
  if (!reach || reach.kind === "anywhere") return "may be worn anywhere";
  const n = reach.contextIds.length;
  return `may be worn only in ${n === 1 ? "one context" : `${n} contexts`}`;
}

/**
 * One timeline event as a line. Never a value and never a private label — the
 * event carries neither, and nothing here reaches for one.
 */
export function timelineWords(e: TimelineEvent, contextName: (id: string) => string): string {
  const where = e.contextId ? ` in ${contextName(e.contextId)}` : "";
  const types = e.claimTypes?.length ? e.claimTypes.join(", ") : "";
  switch (e.kind) {
    case "composed":
      return `Made${where}`;
    case "worn":
      return `Worn${where}`;
    case "unworn":
      return `Taken off${where}`;
    case "expired":
      return `Came off by itself${where}`;
    case "disclosed":
      return `Told ${e.verifierDid ?? "a party"}${types ? ` ${types}` : ""}${where}`;
    case "valueChanged":
      return `${types || "A value it shows"} changed${e.version ? ` (version ${e.version})` : ""}`;
    case "promoted":
      return `Made reusable across your faces${where ? `, from${where.slice(3)}` : ""}`;
    case "retired":
      return "Retired";
    case "reinstated":
      return "Reinstated";
    default:
      return String(e.kind);
  }
}
