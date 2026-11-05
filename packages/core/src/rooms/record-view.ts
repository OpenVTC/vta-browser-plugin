// How a reader shows a room's records — the reading rules `SealedRecordBody`
// states at `rooms/_shared/0.2` for `kind`, replies, reactions, withdrawals,
// tombstones, `writtenAt`, `editedAt` and `validUntil`.
//
// ## Pure, and after verification
//
// Nothing here fetches, resolves or verifies. A surface reads the room's
// records (`rooms/keys/browse`, `rooms/keys/read`), verifies each sealed body
// (`verifyRecordBody`) or reads an open room's cleartext, and hands this module
// what it found for each key: a body it may show, a refusal, a placeholder, a
// tombstone. This module decides what the room looks like from that — which
// records are notes and which messages, in what order, which reply has lost its
// target, which reactions count and where — so every surface that shows a room
// shows it the same way, and each rule has one place to be tested.
//
// ## Only what the reader can already read
//
// A reply or a reaction is resolved against the records passed in and nothing
// else (`RecordReference`): a target that is not among them, or is there but
// cannot be shown, is "not available", and nothing is fetched because of it.
//
// ## Never authority
//
// `kind`, `inReplyTo`, `writtenAt` and `editedAt` are the author's claims, and
// this module treats them as display: they order and group records, and confer
// nothing.

import type { RecordReference, VerifiedRecordBody } from "./record-body.js";
import {
  isNameWithdrawal,
  MEMBER_PROFILE_KIND,
  memberProfileRefusal,
  namesByAuthor,
  type MemberNameCandidate,
  type MemberNameRecord,
} from "./member-name.js";

/** What a record says, once a reader may show it: a verified sealed body, or an open room's cleartext. */
export interface RecordContent {
  /** The verified signer on a sealed tier; the host's record of the writer on an `open` room. */
  author: string;
  kind?: string;
  title?: string;
  description?: string;
  /** Plain text on a message and a reaction; markdown, rendered inert, on a note. Untrusted. */
  body?: string;
  tags?: readonly string[];
  inReplyTo?: RecordReference;
  writtenAt?: string;
  editedAt?: string;
  validUntil?: string;
  /** Whether the record carries a file (its `body` is then the file's caption). */
  hasFile: boolean;
  /**
   * The version the content was written at: the sealed body's own `version`
   * (which a curation leaves behind), or the record's version on an `open` room.
   */
  bodyVersion: number;
  /**
   * The content members the record carries, by name — the sealed body's beyond
   * its location, author and proof, or every member of an open room's
   * cleartext. What a rule about which members a record may carry reads
   * (`memberProfile`); absent where the surface did not say.
   */
  members?: readonly string[];
  /** An open room's cleartext, rather than a verified sealed body. */
  cleartext?: true;
}

/** What reading one key came to. */
export type RecordReading =
  /** A body the reader may show: verified, or an open room's cleartext. */
  | { state: "read"; content: RecordContent }
  /** The room's own profile: not one of its records. */
  | { state: "profile" }
  /** Refused by the reading rules. Nothing of it is shown. */
  | { state: "refused"; reason: string }
  /** Its author cannot be verified (*Which DID document*, *An author whose DID does not resolve*). Nothing of it is shown. */
  | { state: "placeholder"; reason: string }
  /** Not read: it did not open, or the read failed. */
  | { state: "unreadable"; reason: string }
  /** Retracted: the key and version remain, the body is gone. */
  | { state: "tombstone" };

/** A version of a record this reader showed earlier, which a later version is compared with. */
export interface HeldRecord {
  version: number;
  content: RecordContent;
}

/** One key of the room, as listed and read. */
export interface RecordInput {
  key: string;
  version: number;
  status?: string;
  /** The host's times (`RecordMetadataV3`): the version read was stored, the record's first version was stored. */
  updatedAt?: string;
  createdAt?: string;
  /** The author of the record's first version, as the host recorded it (`open` and `attributed` only). */
  createdBy?: string;
  /** When the host stored the body this version carries (`RecordMetadataV3`). */
  bodyStoredAt?: string;
  /** The record's `kind` as the listing gave it (an `open` room's): where the record could not be read, it still says what it was. */
  listedKind?: string;
  reading: RecordReading;
  /** An earlier version of this record the reader held, if any. Only one with a lower version counts. */
  held?: HeldRecord;
}

/** How a record is shown. */
export type ShownAs =
  | "note"
  | "message"
  /** A message its author withdrew: nothing of any version is shown. */
  | "withdrawn"
  /** A retracted record whose kind and place the reader held from an earlier version. */
  | "retracted"
  /** Its author cannot be verified: nothing of it is shown. */
  | "placeholder"
  | "refused"
  | "unreadable";

/** Which instant a record is ordered by. */
export type OrderedBy = "writtenAt" | "createdAt" | "updatedAt" | "readAt";

/** When a record was written, as far as the reader may say. */
export interface WrittenView {
  /** The author's `writtenAt`, where it is plausible and not backdated: the time to show. */
  at?: string;
  /** The claim was implausible (*When it was written*): no time is shown for it. */
  implausible?: boolean;
  /** The claim is more than 24 hours before the room received the record: shown as arriving later than it claims. */
  arrivedLate?: { claimed: string; received: string };
}

/** One reaction value on a record, counted once per author. */
export interface ReactionCount {
  /** The value as the first counted record wrote it (a reader may show the qualified form). */
  value: string;
  /** The normalised value it was counted by. */
  normalised: string;
  count: number;
  authors: string[];
}

/** One record as a reader shows it. */
export interface RoomRecordView {
  key: string;
  version: number;
  status?: string;
  shown: ShownAs;
  /** Present on a note and a message only. */
  content?: RecordContent;
  /**
   * The current version's author is not the author of the version before it (or
   * of the record's first version, by the host's `createdBy`): a rewrite by this
   * author, never shown as the original author's edit.
   */
  rewrite?: { by: string; original: string };
  /** The version shown carries `editedAt`. `at` is absent when the claim is implausible. */
  edited?: { at?: string };
  written: WrittenView;
  orderAt: number;
  orderedBy: OrderedBy;
  /** The record this one answers. `available: false` when it cannot be shown. */
  replyTo?: { key: string; version?: number; available: boolean; changed?: "edited" };
  reactions: ReactionCount[];
  /** Past its `validUntil`: hidden from the default listing, shown only on request. */
  expired?: boolean;
  /** Why it is refused, unreadable or a placeholder. */
  reason?: string;
}

/** The room as a reader shows it. */
export interface RoomRecordsView {
  /** What a default listing shows, oldest first: by `orderAt`, then by key. */
  records: RoomRecordView[];
  /** Records past their `validUntil`, hidden from the default listing; shown only on an explicit request, marked expired. */
  expired: RoomRecordView[];
  /** Retracted records the reader held nothing of: shown in no conversation and no reaction count. */
  tombstones: { key: string; version: number }[];
  /** Records shown nowhere, and why: a reaction that breaks the rules, a record answering a reaction, a rewrite that changed `kind`. */
  ignored: { key: string; reason: string }[];
  /**
   * Members' names in this room, by author (`memberProfile`; rooms/_shared/0.3):
   * the record that decides each author's name, and the name where it gives
   * one. Only for this room, and only for that author. Name records are shown
   * nowhere else — in no conversation, library or count.
   */
  names: Record<string, MemberNameRecord>;
  /** The keys of every name record read, whatever it came to. */
  nameRecords: string[];
}

const FIVE_MINUTES = 5 * 60_000;
const ONE_DAY = 24 * 60 * 60_000;

/** The most code points a reaction's value may hold, after normalisation. */
export const REACTION_MAX_CODE_POINTS = 64;

// U+000A, U+000B, U+000C, U+000D, U+0085, U+2028, U+2029.
const LINE_TERMINATOR = /[\n\u000B\u000C\r\u0085\u2028\u2029]/u;
const ONLY_WHITE_SPACE = /^\p{White_Space}*$/u;

/**
 * A reaction's value as it is measured and compared (*A reaction's value*):
 * NFC, then every U+FE0E and U+FE0F removed — so `❤` and `❤\uFE0F` are one value.
 */
export function normaliseReactionValue(body: string): string {
  return body.normalize("NFC").replace(/[\uFE0E\uFE0F]/gu, "");
}

/** What a reaction record's `body` is, as a value. */
export type ReactionValue =
  | { kind: "value"; value: string; normalised: string }
  /** Empty, or only White_Space: a version carrying it withdraws the reaction. */
  | { kind: "empty" }
  /** Longer than 64 code points, or holding a line terminator: the record is not shown. */
  | { kind: "invalid"; reason: string };

/** Read a reaction's `body` as a value (*A reaction's value*). */
export function reactionValue(body: string | undefined): ReactionValue {
  const normalised = normaliseReactionValue(body ?? "");
  if (ONLY_WHITE_SPACE.test(normalised)) return { kind: "empty" };
  if (LINE_TERMINATOR.test(normalised)) return { kind: "invalid", reason: "its value holds a line break" };
  if ([...normalised].length > REACTION_MAX_CODE_POINTS) {
    return { kind: "invalid", reason: `its value is longer than ${REACTION_MAX_CODE_POINTS} characters` };
  }
  return { kind: "value", value: body ?? "", normalised };
}

/** A verified sealed body as content. Its `version` is the one the body was written at. */
export function contentFromBody(body: VerifiedRecordBody): RecordContent {
  return {
    author: body.author,
    ...(body.kind !== undefined ? { kind: body.kind } : {}),
    ...(body.title !== undefined ? { title: body.title } : {}),
    ...(body.description !== undefined ? { description: body.description } : {}),
    ...(body.body !== undefined ? { body: body.body } : {}),
    ...(body.tags !== undefined ? { tags: [...body.tags] } : {}),
    ...(body.inReplyTo !== undefined ? { inReplyTo: { ...body.inReplyTo } } : {}),
    ...(body.writtenAt !== undefined ? { writtenAt: body.writtenAt } : {}),
    ...(body.editedAt !== undefined ? { editedAt: body.editedAt } : {}),
    ...(body.validUntil !== undefined ? { validUntil: body.validUntil } : {}),
    hasFile: body.file !== undefined,
    bodyVersion: body.version,
    members: Object.keys(body).filter((k) => !BODY_FRAME.has(k)),
  };
}

/** A sealed body's members that place and sign it, rather than say anything. */
const BODY_FRAME = new Set(["roomId", "key", "version", "author", "proof"]);

const LOWER_CAMEL = /^[a-z][A-Za-z0-9]*$/;
const UTC_DATE_TIME = /^[0-9]{4}-[0-9]{2}-[0-9]{2}T[0-9]{2}:[0-9]{2}:[0-9]{2}(\.[0-9]{1,9})?Z$/;
const DATE_TIME = /^\d{4}-\d{2}-\d{2}[Tt]\d{2}:\d{2}:\d{2}(\.\d+)?([Zz]|[+-]\d{2}:\d{2})$/;

/**
 * An `open` room's cleartext as content — or a refusal where a member it
 * carries has a shape `rooms/records/put` does not allow. The host stores and
 * serves these members and never acts on them, so they are checked here as a
 * sealed body's are.
 */
export function readingFromCleartext(
  cleartext: Record<string, unknown>,
  author: string,
  version: number,
): RecordReading {
  const str = (v: unknown) => (typeof v === "string" ? v : undefined);
  const refuse = (why: string): RecordReading => ({ state: "refused", reason: `the record's ${why}` });
  const { kind, inReplyTo, writtenAt, editedAt, validUntil } = cleartext;
  if (kind !== undefined && (typeof kind !== "string" || kind.length > 64 || !LOWER_CAMEL.test(kind))) {
    return refuse("kind is not a record kind");
  }
  if (inReplyTo !== undefined) {
    const r = inReplyTo as Record<string, unknown>;
    if (
      typeof r !== "object" ||
      r === null ||
      Array.isArray(r) ||
      Object.keys(r).some((k) => k !== "key" && k !== "version") ||
      typeof r.key !== "string" ||
      r.key === "" ||
      r.key.length > 512 ||
      (r.version !== undefined && !(Number.isSafeInteger(r.version) && (r.version as number) >= 1))
    ) {
      return refuse("inReplyTo is not a record reference");
    }
  }
  for (const [name, v] of [["writtenAt", writtenAt], ["editedAt", editedAt]] as const) {
    if (v !== undefined && !(typeof v === "string" && UTC_DATE_TIME.test(v) && !Number.isNaN(Date.parse(v)))) {
      return refuse(`${name} is not a UTC date-time`);
    }
  }
  if (validUntil !== undefined && !(typeof validUntil === "string" && DATE_TIME.test(validUntil) && !Number.isNaN(Date.parse(validUntil)))) {
    return refuse("validUntil is not a date-time");
  }
  const reply = inReplyTo as RecordReference | undefined;
  const tags = Array.isArray(cleartext.tags) ? cleartext.tags.filter((t): t is string => typeof t === "string") : undefined;
  const content: RecordContent = {
    author,
    ...(kind !== undefined ? { kind: kind as string } : {}),
    ...(str(cleartext.title) !== undefined ? { title: str(cleartext.title)! } : {}),
    ...(str(cleartext.description) !== undefined ? { description: str(cleartext.description)! } : {}),
    ...(str(cleartext.body) !== undefined ? { body: str(cleartext.body)! } : {}),
    ...(tags !== undefined ? { tags } : {}),
    ...(reply !== undefined ? { inReplyTo: { key: reply.key, ...(reply.version !== undefined ? { version: reply.version } : {}) } } : {}),
    ...(writtenAt !== undefined ? { writtenAt: writtenAt as string } : {}),
    ...(editedAt !== undefined ? { editedAt: editedAt as string } : {}),
    ...(validUntil !== undefined ? { validUntil: validUntil as string } : {}),
    hasFile: cleartext.file !== undefined && cleartext.file !== null,
    bodyVersion: version,
    members: Object.keys(cleartext),
    cleartext: true,
  };
  return { state: "read", content };
}

/**
 * What a record is shown as, by its `kind` (*Kind*, *Untitled records*): a
 * `message`; a record with no `kind` and no `title`, which a reader keeping a
 * conversation MAY treat as one; a `reaction`; and everything else — `note`,
 * and every kind this reader does not know — a note.
 */
export function shownKind(content: Pick<RecordContent, "kind" | "title">): "note" | "message" | "reaction" {
  if (content.kind === "reaction") return "reaction";
  if (content.kind === "message") return "message";
  if (content.kind === undefined && !content.title) return "message";
  return "note";
}

const ms = (iso: string | undefined): number | undefined => {
  if (iso === undefined) return undefined;
  const t = Date.parse(iso);
  return Number.isNaN(t) ? undefined : t;
};

/** The host's stand-in for when a record was written: `createdAt`, else `updatedAt`, else the read. */
function hostTime(input: RecordInput, now: number): { at: number; by: OrderedBy } {
  const created = ms(input.createdAt);
  if (created !== undefined) return { at: created, by: "createdAt" };
  const updated = ms(input.updatedAt);
  if (updated !== undefined) return { at: updated, by: "updatedAt" };
  return { at: now, by: "readAt" };
}

/**
 * Where a record goes, and what the reader may say of when it was written
 * (*When it was written*): by `writtenAt` where it is plausible; by the host's
 * `createdAt` (else `updatedAt`, else the read) where there is none, where it
 * is more than five minutes after that, or where a rewrite changed it; and by
 * `createdAt` where it claims to be more than 24 hours older than the room's
 * receipt of the record — shown as arriving later than it claims.
 */
function timing(
  input: RecordInput,
  content: RecordContent | undefined,
  held: HeldRecord | undefined,
  now: number,
): { written: WrittenView; orderAt: number; orderedBy: OrderedBy } {
  const host = hostTime(input, now);
  const writtenAt = content?.writtenAt;
  const claimed = ms(writtenAt);
  if (writtenAt === undefined || claimed === undefined) {
    return { written: {}, orderAt: host.at, orderedBy: host.by };
  }
  const rewroteIt = held !== undefined && held.content.writtenAt !== writtenAt;
  if (claimed > host.at + FIVE_MINUTES || rewroteIt) {
    return { written: { implausible: true }, orderAt: host.at, orderedBy: host.by };
  }
  const created = ms(input.createdAt);
  if (created !== undefined && claimed < created - ONE_DAY) {
    return {
      written: { arrivedLate: { claimed: writtenAt, received: input.createdAt! } },
      orderAt: created,
      orderedBy: "createdAt",
    };
  }
  return { written: { at: writtenAt }, orderAt: claimed, orderedBy: "writtenAt" };
}

/** Whether the version shown is edited, and when, where that is plausible (*Edits*). */
function editedView(input: RecordInput, content: RecordContent): { at?: string } | undefined {
  const edited = ms(content.editedAt);
  if (content.editedAt === undefined || edited === undefined) return undefined;
  const written = ms(content.writtenAt);
  const updated = ms(input.updatedAt);
  const implausible = (written !== undefined && edited < written) || (updated !== undefined && edited > updated + FIVE_MINUTES);
  return implausible ? {} : { at: content.editedAt };
}

const sameReference = (a: RecordReference | undefined, b: RecordReference | undefined) =>
  a?.key === b?.key && a?.version === b?.version;

/** A reaction that may count: by `author`, with `value`, on the record at `target`. */
interface ReactionCandidate {
  key: string;
  target: string;
  author: string;
  value: string;
  normalised: string;
}

/**
 * Show a room: apply the reading rules to every key a reader has listed and
 * read, and say what each is shown as, where, and with which reactions.
 *
 * `now` is the reader's clock, for `validUntil` and for a record the host gave
 * no time for.
 */
export function assembleRoomRecords(inputs: readonly RecordInput[], opts: { now: number }): RoomRecordsView {
  const now = opts.now;
  const views = new Map<string, RoomRecordView>();
  const tombstones: RoomRecordsView["tombstones"] = [];
  const ignored: RoomRecordsView["ignored"] = [];
  const reactions: ReactionCandidate[] = [];
  /** Keys whose current version is a readable reaction: nothing may answer them. */
  const reactionKeys = new Set<string>();
  /** The record each shown record answers, checked once every key is known. */
  const replies: { key: string; ref: RecordReference; writtenAt: string | undefined }[] = [];
  /** Every name record read (`memberProfile`): shown nowhere, offered as its author's name. */
  const nameCandidates: MemberNameCandidate[] = [];
  const nameRecords: string[] = [];

  const shell = (input: RecordInput, shown: ShownAs, t: ReturnType<typeof timing>): RoomRecordView => ({
    key: input.key,
    version: input.version,
    ...(input.status !== undefined ? { status: input.status } : {}),
    shown,
    written: t.written,
    orderAt: t.orderAt,
    orderedBy: t.orderedBy,
    reactions: [],
  });

  for (const input of inputs) {
    const held = input.held !== undefined && input.held.version < input.version ? input.held : undefined;
    const reading = input.reading;

    const storedAt = input.bodyStoredAt ?? input.updatedAt;

    // ── A tombstone: the place the reader held, or nowhere ─────────────────
    if (reading.state === "tombstone" || input.status === "retracted") {
      if (held?.content.kind === MEMBER_PROFILE_KIND || (held === undefined && input.listedKind === MEMBER_PROFILE_KIND)) {
        // A retracted name: its author has no name from it, and it is shown nowhere.
        nameRecords.push(input.key);
        const author = held?.content.author ?? input.createdBy;
        if (author !== undefined) {
          nameCandidates.push({
            author,
            key: input.key,
            version: input.version,
            ...(storedAt !== undefined ? { storedAt } : {}),
            refused: "retracted",
          });
        }
        continue;
      }
      if (held === undefined) {
        tombstones.push({ key: input.key, version: input.version });
        continue;
      }
      const was = shownKind(held.content);
      if (was === "reaction") {
        // A retracted reaction counts as no reaction, and is shown nowhere.
        ignored.push({ key: input.key, reason: "a retracted reaction" });
        continue;
      }
      // Where the message was: ordered as the version the reader held, none of it shown.
      views.set(input.key, shell(input, "retracted", { ...timing(input, held.content, undefined, now), written: {} }));
      continue;
    }

    if (reading.state === "profile") continue;

    if (reading.state === "refused" || reading.state === "unreadable" || reading.state === "placeholder") {
      // A name record that did not read is still never a note (*Reading one*, rule 1).
      if (input.listedKind === MEMBER_PROFILE_KIND || held?.content.kind === MEMBER_PROFILE_KIND) {
        nameRecords.push(input.key);
        const reason = `a member's name that ${reading.state === "refused" ? "was refused" : "could not be read"}: ${reading.reason}`;
        ignored.push({ key: input.key, reason });
        // Rule 2: where the version that decides is refused, its author has no name from it.
        const author = held?.content.author ?? input.createdBy;
        if (author !== undefined) {
          nameCandidates.push({ author, key: input.key, version: input.version, ...(storedAt !== undefined ? { storedAt } : {}), refused: reason });
        }
        continue;
      }
      // A placeholder is ordered by the host's time so replies still anchor to it.
      const host = hostTime(input, now);
      views.set(input.key, {
        ...shell(input, reading.state, { written: {}, orderAt: host.at, orderedBy: host.by }),
        reason: reading.reason,
      });
      continue;
    }

    const content = reading.content;
    const kind = shownKind(content);
    // Whose record it was before this version: the version held, else the host's `createdBy`.
    const prior = held?.content.author ?? input.createdBy;

    // *What a new version keeps*: its kind, and a reaction's target.
    if (held !== undefined && held.content.kind !== content.kind) {
      ignored.push({ key: input.key, reason: "a new version changed the record's kind" });
      continue;
    }
    if (held !== undefined && held.content.kind === "reaction" && !sameReference(held.content.inReplyTo, content.inReplyTo)) {
      ignored.push({ key: input.key, reason: "a new version moved the reaction to another record" });
      continue;
    }

    // ── A member's name (`memberProfile`): never a note, a message or a reaction ──
    if (content.kind === MEMBER_PROFILE_KIND) {
      nameRecords.push(input.key);
      // Rule 3: a version by anyone but the record's earlier author never names
      // that author. It is its own author's claim about themselves, weighed by
      // rule 2 like any other of theirs (*Several records by one author*,
      // trust-tasks-tf #1038) — so it is offered below as `content.author`'s.
      const refused = memberProfileRefusal(content);
      nameCandidates.push({
        author: content.author,
        key: input.key,
        version: input.version,
        ...(storedAt !== undefined ? { storedAt } : {}),
        ...(content.writtenAt !== undefined ? { writtenAt: content.writtenAt } : {}),
        ...(content.editedAt !== undefined ? { editedAt: content.editedAt } : {}),
        ...(refused !== undefined
          ? { refused }
          : !isNameWithdrawal(content.title!)
            ? { name: content.title! }
            : {}),
      });
      continue;
    }

    if (kind === "reaction") {
      reactionKeys.add(input.key);
      if (content.inReplyTo === undefined) {
        ignored.push({ key: input.key, reason: "a reaction that names no record" });
        continue;
      }
      const value = reactionValue(content.body);
      if (value.kind === "invalid") {
        ignored.push({ key: input.key, reason: `a reaction ${value.reason}` });
        continue;
      }
      const target = content.inReplyTo.key;
      const until = ms(content.validUntil);
      if (until !== undefined && until <= now) continue; // Expired: not presented, so not counted.
      if (value.kind === "empty") {
        // Only the reaction's own author withdraws it. An empty version by
        // anyone else withdraws nothing, and the earlier version goes on counting.
        if (prior !== undefined && prior !== content.author && held !== undefined) {
          const was = reactionValue(held.content.body);
          if (was.kind === "value" && held.content.inReplyTo !== undefined) {
            reactions.push({
              key: input.key,
              target: held.content.inReplyTo.key,
              author: held.content.author,
              value: was.value,
              normalised: was.normalised,
            });
          }
        }
        continue;
      }
      reactions.push({ key: input.key, target, author: content.author, value: value.value, normalised: value.normalised });
      continue;
    }

    const rewrite = prior !== undefined && prior !== content.author ? { by: content.author, original: prior } : undefined;
    const t = timing(input, content, held, now);

    // *Withdrawing a message*: an empty body and no file, from the message's own author.
    if (kind === "message" && !content.body && !content.hasFile && rewrite === undefined) {
      views.set(input.key, shell(input, "withdrawn", { ...t, written: {} }));
      continue;
    }

    const edited = editedView(input, content);
    const view: RoomRecordView = {
      ...shell(input, kind, t),
      content,
      ...(rewrite !== undefined ? { rewrite } : {}),
      ...(edited !== undefined ? { edited } : {}),
    };
    const until = ms(content.validUntil);
    if (until !== undefined && until <= now) view.expired = true;
    views.set(input.key, view);
    if (content.inReplyTo !== undefined) replies.push({ key: input.key, ref: content.inReplyTo, writtenAt: content.writtenAt });
  }

  // *Nothing answers a reaction*: a record naming one is shown nowhere, and counts as no reaction.
  for (const reply of replies) {
    if (reactionKeys.has(reply.ref.key)) {
      views.delete(reply.key);
      ignored.push({ key: reply.key, reason: "it answers a reaction" });
    }
  }
  const counted = reactions.filter((r) => {
    if (!reactionKeys.has(r.target)) return true;
    ignored.push({ key: r.key, reason: "a reaction to a reaction" });
    return false;
  });

  /** A target a reader can show: a note or a message, not withdrawn, retracted, expired or unverified. */
  const available = (key: string): RoomRecordView | undefined => {
    const v = views.get(key);
    return v && (v.shown === "note" || v.shown === "message") && !v.expired ? v : undefined;
  };

  // *Replies*: shown either way, marked where the target is not available.
  for (const reply of replies) {
    const view = views.get(reply.key);
    if (view === undefined) continue;
    const target = available(reply.ref.key);
    const changed =
      target !== undefined &&
      reply.ref.version !== undefined &&
      target.content!.bodyVersion !== reply.ref.version &&
      target.content!.editedAt !== undefined &&
      reply.writtenAt !== undefined &&
      Date.parse(target.content!.editedAt) > Date.parse(reply.writtenAt);
    view.replyTo = {
      key: reply.ref.key,
      ...(reply.ref.version !== undefined ? { version: reply.ref.version } : {}),
      available: target !== undefined,
      ...(changed ? { changed: "edited" as const } : {}),
    };
  }

  // *Counting reactions*: once per author, value and target; none on a target that is not available.
  const seen = new Set<string>();
  for (const r of counted) {
    const target = available(r.target);
    if (target === undefined) continue;
    const id = JSON.stringify([r.target, r.author, r.normalised]);
    if (seen.has(id)) continue;
    seen.add(id);
    const count = target.reactions.find((c) => c.normalised === r.normalised);
    if (count) {
      count.count += 1;
      count.authors.push(r.author);
    } else {
      target.reactions.push({ value: r.value, normalised: r.normalised, count: 1, authors: [r.author] });
    }
  }
  for (const v of views.values()) v.reactions.sort((a, b) => b.count - a.count);

  const order = (a: RoomRecordView, b: RoomRecordView) =>
    a.orderAt - b.orderAt || (a.key < b.key ? -1 : a.key > b.key ? 1 : 0);
  const all = [...views.values()].sort(order);
  return {
    records: all.filter((v) => !v.expired),
    expired: all.filter((v) => v.expired),
    tombstones,
    ignored,
    names: namesByAuthor(nameCandidates),
    nameRecords,
  };
}
