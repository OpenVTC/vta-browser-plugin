// A member's name in a room — a record of kind `memberProfile` whose `title` is
// the name (`rooms/_shared/0.3/member-profile.schema.json`: `MemberName`,
// `MemberProfileRecord`, `MemberProfileCleartext`; trust-tasks-tf #1035).
//
// ## An ordinary record, read by its own rules
//
// No task, host or key holder changes for it: on the sealed tiers it is a
// `SealedRecordBody` the member's key holder signs and seals like any other
// (`rooms/keys/seal/0.3`), on an `open` room the `cleartext` of
// `rooms/records/put/0.5`. What is here is the writer's and the reader's rules:
//
// - **the writer's gate** — a name is written only where the room's profile
//   lists both `kind` and `memberProfile` in `recordMembers`, because a reader
//   that predates the kind shows it as a note ({@link memberNameWriteRefusal});
// - **its shape** — `kind`, the name in `title`, `writtenAt` / `editedAt` at
//   most; no `body` on a sealed tier and an empty one on an `open` room
//   ({@link memberProfileRefusal});
// - **whose name it is** — the author's of the version, in this room only:
//   of every name record whose current version is by that author, the one the
//   host stored most recently, ties to the greater version — never the first a
//   reader met. A version another member wrote over someone's record is that
//   member's claim about themselves, weighed like any other of theirs, and
//   never the original author's (`assembleRoomRecords`, which takes these
//   records out of every conversation, library and count; trust-tasks-tf
//   #1038, *Several records by one author*);
// - **how it is shown** — after the reader's own petname, before a shortened
//   DID, never as verified, never guessed before a name is found, and told
//   apart where two would read the same or look the same — equal after NFC and
//   case folding, or by their UTS #39 skeletons ({@link authorLabels});
// - **keeping it near the head** — a member that writes SHOULD write its name
//   again once its write's version is more than 500 past the name record's
//   ({@link memberNameRewriteDue}, `rewriteMemberNameAsMember`).
//
// A name is a claim by the member about themselves, and plain text: never
// markup, never instructions, never a reason to fetch anything.

import type { RecordContent } from "./record-view.js";
import { skeleton } from "./confusables.js";

/** The record kind that carries a member's name, and the `recordMembers` value that permits writing one. */
export const MEMBER_PROFILE_KIND = "memberProfile";

/** The most code points a name may hold, after Unicode Normalization Form C. */
export const MEMBER_NAME_MAX_CODE_POINTS = 64;

/** The `recordMembers` values a room's profile must list before a member may write a name. */
export const MEMBER_NAME_RECORD_MEMBERS: readonly string[] = Object.freeze(["kind", MEMBER_PROFILE_KIND]);

/** Content members a `memberProfile` record never carries (`MemberProfileRecord`). `body` is apart: an open room's cleartext requires it. */
const FORBIDDEN = [
  "description",
  "tags",
  "file",
  "inReplyTo",
  "roomProfile",
  "basis",
  "confidence",
  "evidence",
  "validFor",
  "validUntil",
] as const;

/** What an open room's `MemberProfileCleartext` may carry (`additionalProperties: false`). */
const CLEARTEXT_MEMBERS = ["kind", "title", "body", "writtenAt", "editedAt"];

// `MemberName`'s pattern: no C0 or C1 control, no DEL, no line or paragraph separator.
const FORBIDDEN_CHAR = /[\u0000-\u001F\u007F-\u009F\u2028\u2029]/u;
const ONLY_WHITE_SPACE = /^\p{White_Space}*$/u;

/**
 * Why `name` is not a `MemberName`, or `undefined` when it is: one line, no
 * control characters, at most 64 code points as written and after NFC. Empty
 * (or only White_Space) is a name — the one that withdraws.
 */
export function memberNameRefusal(name: string): string | undefined {
  const bad = FORBIDDEN_CHAR.exec(name);
  if (bad) {
    const cp = bad[0].codePointAt(0)!.toString(16).toUpperCase().padStart(4, "0");
    return `a name is one line of plain text, and may not hold U+${cp}`;
  }
  const length = Math.max([...name].length, [...name.normalize("NFC")].length);
  if (length > MEMBER_NAME_MAX_CODE_POINTS) {
    return `a name is at most ${MEMBER_NAME_MAX_CODE_POINTS} characters; this one is ${length}`;
  }
  return undefined;
}

/** Whether `name` withdraws the member's name: empty, or only White_Space. */
export function isNameWithdrawal(name: string): boolean {
  return ONLY_WHITE_SPACE.test(name);
}

/**
 * Why `content` is not a name record a reader may take a name from, or
 * `undefined` when it is (`MemberProfileRecord` on a sealed tier,
 * `MemberProfileCleartext` on an `open` room). Only for a record whose `kind`
 * is `memberProfile`: one that is refused is still never shown as a note.
 */
export function memberProfileRefusal(content: RecordContent): string | undefined {
  if (content.kind !== MEMBER_PROFILE_KIND) return `a member's name is a record of kind ${MEMBER_PROFILE_KIND}`;
  if (content.title === undefined) return "a member's name record carries the name in its title";
  const bad = memberNameRefusal(content.title);
  if (bad !== undefined) return bad;
  const members = content.members ?? [];
  const forbidden = FORBIDDEN.find(
    (m) =>
      members.includes(m) ||
      (m === "description" && content.description !== undefined) ||
      (m === "tags" && content.tags !== undefined) ||
      (m === "file" && content.hasFile) ||
      (m === "inReplyTo" && content.inReplyTo !== undefined) ||
      (m === "validUntil" && content.validUntil !== undefined),
  );
  if (forbidden !== undefined) return `a member's name record carries no ${forbidden}`;
  if (content.cleartext) {
    const extra = members.find((m) => !CLEARTEXT_MEMBERS.includes(m));
    if (extra !== undefined) return `a member's name on an open room carries no ${extra}`;
    if (content.body !== "") return "a member's name on an open room has an empty body";
  } else if (content.body !== undefined || members.includes("body")) {
    return "a member's sealed name record carries no body";
  }
  return undefined;
}

/**
 * The writer's gate: why a member may not write a name in a room whose
 * profile lists `recordMembers`, or `undefined` when it may. `undefined` for
 * `recordMembers` is a room with no profile, a profile that lists none, or one
 * that could not be read — and permits nothing.
 */
export function memberNameWriteRefusal(recordMembers: readonly string[] | undefined): string | undefined {
  const missing = MEMBER_NAME_RECORD_MEMBERS.filter((m) => !(recordMembers ?? []).includes(m));
  if (missing.length === 0) return undefined;
  return (
    "This room does not take members' names yet: its profile must list both `kind` and `memberProfile` " +
    `in recordMembers, and it ${recordMembers === undefined ? "lists none" : `does not list ${missing.map((m) => `\`${m}\``).join(" or ")}`}. ` +
    "A member of the room who may curate it can turn them on in the room's profile. Nothing was written."
  );
}

/** One author's name record as a reader holds it: the version that decides their name in this room. */
export interface MemberNameRecord {
  key: string;
  version: number;
  /** The name it gives. Absent where it withdraws the name, is retracted, or is refused as a name. */
  name?: string;
  /** Why it gives no name, where it is refused. */
  refused?: string;
  /** The version's `writtenAt` and `editedAt`, as it carries them: what a rewrite near the head keeps. */
  writtenAt?: string;
  editedAt?: string;
}

/** A candidate for an author's name, offered by `assembleRoomRecords` for every name record it reads. */
export interface MemberNameCandidate {
  author: string;
  key: string;
  version: number;
  /** When the host stored this version: `bodyStoredAt`, else `updatedAt`. */
  storedAt?: string;
  name?: string;
  refused?: string;
  writtenAt?: string;
  editedAt?: string;
}

/**
 * Each author's name record, by rule 2 of *Reading one*: of the name records
 * whose current version is by that author — whatever their key, and whoever
 * created the record — the version the host stored most recently, by
 * `bodyStoredAt`, else `updatedAt`, decides; of two stored at the same time,
 * the one with the greater `version`. It gives no name where it withdraws one,
 * is retracted or is refused. A version with no time loses to one with a time.
 *
 * *Several records by one author* (trust-tasks-tf #1038): this is the whole
 * rule. The order `candidates` arrive in never matters — nothing is kept
 * because it was met first or set aside because another was — so two readers
 * holding the same records show the same name whichever way they read.
 */
export function namesByAuthor(candidates: readonly MemberNameCandidate[]): Record<string, MemberNameRecord> {
  const at = (s: string | undefined) => {
    const t = s === undefined ? NaN : Date.parse(s);
    return Number.isNaN(t) ? -Infinity : t;
  };
  const best = new Map<string, MemberNameCandidate>();
  for (const c of candidates) {
    const held = best.get(c.author);
    if (held === undefined || at(c.storedAt) > at(held.storedAt) || (at(c.storedAt) === at(held.storedAt) && c.version > held.version)) {
      best.set(c.author, c);
    }
  }
  const out: Record<string, MemberNameRecord> = {};
  for (const [author, c] of best) {
    out[author] = {
      key: c.key,
      version: c.version,
      ...(c.name !== undefined ? { name: c.name } : {}),
      ...(c.refused !== undefined ? { refused: c.refused } : {}),
      ...(c.writtenAt !== undefined ? { writtenAt: c.writtenAt } : {}),
      ...(c.editedAt !== undefined ? { editedAt: c.editedAt } : {}),
    };
  }
  return out;
}

// ── Writing it again near the head ───────────────────────────────────────────

/**
 * How far, in versions, a member's write may run past its name record before
 * it writes the name again: the largest page `rooms/records/list/0.6` returns.
 * *Near the room's head* (trust-tasks-tf #1038).
 */
export const MEMBER_NAME_REWRITE_DISTANCE = 500;

/**
 * Whether a write the host assigned `writeVersion` should be followed by the
 * member writing its name again: it exceeds the name record's current
 * `version` by more than {@link MEMBER_NAME_REWRITE_DISTANCE}. Never for a
 * member whose name is withdrawn, refused or retracted (`name` absent): such
 * a member writes nothing.
 */
export function memberNameRewriteDue(own: Pick<MemberNameRecord, "version" | "name"> | undefined, writeVersion: number): boolean {
  if (own === undefined || own.name === undefined) return false;
  return writeVersion - own.version > MEMBER_NAME_REWRITE_DISTANCE;
}

// ── Showing a name ───────────────────────────────────────────────────────────

/** A name as text: control characters (bidi controls among them) removed, trimmed. Never markup. */
export function inertName(name: string): string {
  return [...name]
    .filter((ch) => {
      const cp = ch.codePointAt(0) ?? 0;
      const control = cp < 0x20 || (cp >= 0x7f && cp < 0xa0) || cp === 0x2028 || cp === 0x2029;
      const bidi = (cp >= 0x202a && cp <= 0x202e) || (cp >= 0x2066 && cp <= 0x2069) || cp === 0x200e || cp === 0x200f;
      return !control && !bidi;
    })
    .join("")
    .trim();
}

/** What two names are compared by: NFC, then case folded. */
export function nameFoldKey(name: string): string {
  return inertName(name).normalize("NFC").toLowerCase().normalize("NFC");
}

/**
 * What two names are compared by for look-alikes: the UTS #39 `skeleton()` of
 * the name after NFC and case folding (*Showing a name*). For comparing only —
 * never shown, and never a name.
 */
export function nameSkeletonKey(name: string): string {
  return skeleton(nameFoldKey(name));
}

/** A short fingerprint of a DID, to tell apart two authors shown by the same name: the last eight characters of its identifier. */
export function didFingerprint(did: string): string {
  return did.slice(-8);
}

/** How a reader shows one author. */
export interface AuthorLabel {
  /**
   * `petname`: the reader's own name for the DID. `room`: the name the member
   * gave themselves in this room — their claim, never shown as verified.
   * `did`: neither; the surface shows the DID shortened (or a name its
   * document claims).
   */
  source: "petname" | "room" | "did";
  /** The name, as plain text. Absent for `did`. */
  text?: string;
  /** Present where another author would otherwise be shown by the same name: a short fingerprint of this DID. */
  fingerprint?: string;
}

/**
 * How to show each of `dids` (*Showing a name*): the reader's own petname for
 * the DID where it keeps one; else the author's name in this room; else the
 * DID — shortened by the surface, and never a name from anywhere else (*Before
 * a name is found*: not a directory's, a DID document's or a credential's, nor
 * one from another room). Two authors whose room names are the same after NFC
 * and case folding, or whose UTS #39 skeletons are equal — or a room name that
 * is either of those to the reader's petname for another DID — each carry a
 * fingerprint, so that neither can pass for the other.
 */
export function authorLabels(
  dids: Iterable<string>,
  opts: {
    /** The reader's petnames, by DID. */
    petnames?: ReadonlyMap<string, string> | undefined;
    /** Names in this room, by author (`assembleRoomRecords`' `names`). */
    roomNames?: Readonly<Record<string, MemberNameRecord>> | undefined;
  },
): Map<string, AuthorLabel> {
  const out = new Map<string, AuthorLabel>();
  const petnames = opts.petnames ?? new Map<string, string>();
  for (const did of new Set(dids)) {
    const petname = petnames.get(did);
    const pet = petname !== undefined ? inertName(petname) : "";
    if (pet !== "") {
      out.set(did, { source: "petname", text: pet });
      continue;
    }
    const raw = opts.roomNames?.[did]?.name;
    const room = raw !== undefined ? inertName(raw) : "";
    out.set(did, room !== "" ? { source: "room", text: room } : { source: "did" });
  }
  // Who else answers to a name, or to one that looks the same: every room-named
  // author, and every petname's DID — by the folded name and by its skeleton.
  const holders = new Map<string, Set<string>>();
  const keysOf = (name: string) => [`=${nameFoldKey(name)}`, `~${nameSkeletonKey(name)}`];
  const claim = (name: string, did: string) => {
    for (const k of keysOf(name)) holders.set(k, (holders.get(k) ?? new Set()).add(did));
  };
  for (const [did, label] of out) if (label.source === "room") claim(label.text!, did);
  for (const [did, name] of petnames) if (inertName(name) !== "") claim(name, did);
  for (const [did, label] of out) {
    if (label.source !== "room") continue;
    if (keysOf(label.text!).some((k) => (holders.get(k)?.size ?? 0) > 1)) label.fingerprint = didFingerprint(did);
  }
  return out;
}
