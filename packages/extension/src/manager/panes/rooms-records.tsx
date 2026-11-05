// The records in a room — browsed and read through this wallet's own agent.
//
// ## Why the agent and not the host
//
// `rooms/records/*` is served by the room's host, and this console cannot
// address one: its bridge carries a task type and a payload and addresses
// everything to the wallet's own VTA. That narrowing is deliberate — the
// offscreen document mints and signs rather than counter-signing a document
// composed in a page — so `rooms/keys/{browse,read}` ask the agent to make the
// call, being the party that has a channel to the host, holds the credentials,
// and is the only one that can open what comes back.
//
// ## The verdict is the point, and it is copy before it is code
//
// Every answer carries what the agent checked. The rule those checks feed — a
// client that catches a host **serves reads and refuses writes** — is one nobody
// would guess, so it has to be said in words at the moment it applies. A member
// shown a warning icon dismisses it; a member later refused a write with no
// explanation concludes their own agent is broken. A detection attributed to the
// wrong party is worse than no detection.
//
// So `Verdict` below says *what was observed*, never how alarmed to be, and
// always says that reading still works and writing will not.
//
// ## Two checks, and they are said apart
//
// The verdict is about the **host**: whether a record is in the set it
// committed to. It says nothing about who wrote the record. That is the
// **author's signature** over the sealed body, which this pane checks itself
// (`verifyRecordBody`, the `SealedRecordBody` *Reading* rule): the proof for
// `assertionMethod`, the room, key and version it was sealed at, and on an
// `attributed` room that the host's author is the signer. Nothing of a body is
// shown before that holds, and a body that fails shows none of its content —
// never the content with a warning. "Signed" is said only of a body that passed.
//
// ## What the room looks like is the reading rules', not this pane's
//
// Once read and verified, the records are handed to `assembleRoomRecords`
// (`@openvtc/pnm-core/rooms`), which applies `SealedRecordBody`'s reading rules
// (trust-tasks-tf #1027): notes and messages by `kind`, replies against what they
// answer, reactions counted beside their target, withdrawn messages and
// tombstones, ordering by `writtenAt` with the backdating rule, `editedAt`, and
// records past their `validUntil` hidden. This pane draws what it decides.
// Every body is drawn as plain text: a message's is never markup, a note's is
// rendered inert, and nothing in either is a link this pane follows.
//
// ## Who wrote it: a petname, a name in this room, or the DID
//
// An author is a per-room persona DID. The reading rules take members' names
// out of the room (`memberProfile`, rooms/_shared/0.3) — never shown as notes or
// counted — and `authorLabels` decides how each author is shown: the member's
// own petname for that DID from their contacts first, then the name the author
// gave themselves in this room, then the DID (or a name its document claims).
// A room name is the author's claim about themselves, so it is drawn in quotes
// and never beside a check mark; two authors who would read the same carry a
// fingerprint of their DIDs.

import { useCallback, useEffect, useRef, useState } from "react";
import {
  assembleRoomRecords,
  authorLabels,
  contentFromBody,
  readingFromCleartext,
  readSealedVersion,
  RecordBodyError,
  roomsKeysBrowse,
  roomsKeysReadMany,
  verifyRecordBody,
  type HeldRecord,
  type ReadManyResult,
  type RecordInput,
  type RoomRecordsView,
  type RoomRecordView,
  type VerifiedRecordBody,
} from "@openvtc/pnm-core/rooms";
import { base64url } from "@openvtc/vti-didcomm-js";
import type { RoomPlace } from "../room-groups.js";
import { Button, Note, Pill } from "../../ui.js";
import { displayAgentName } from "../../agent-name.js";
import { useAgentNames } from "../../use-agent-names.js";
import { shortDid } from "../room-words.js";
import { untitledLabel } from "../room-record-text.js";
import { didHost } from "../../did-display.js";
import { c, t, font } from "../../theme.js";
import { managerSender } from "../sender.js";
import { Loading, LoadError } from "../table.js";
import type { Parties } from "../use-vta.js";
import type { RoomFilesPrepared } from "../../bridge-protocol.js";
import { prepareRoomFiles, roomFileClaimOf } from "../room-files.js";
import { GetRoomFile, PutRoomFile, RoomFilesUnavailable } from "./rooms-files.js";
import { holds, MemberNameEditor, NoteEditor, RecordActions } from "./rooms-record-actions.js";

const fieldStyle: React.CSSProperties = {
  boxSizing: "border-box",
  padding: "6px 9px",
  background: c.ground,
  color: c.text,
  border: `1px solid ${c.line}`,
  borderRadius: "var(--w-r-sm)",
  fontSize: t.sm,
};

const bodyStyle: React.CSSProperties = {
  margin: "6px 0 0",
  padding: 10,
  background: c.ground,
  border: `1px solid ${c.line}`,
  borderRadius: "var(--w-r-sm)",
  fontFamily: font.mono,
  fontSize: t.xs,
  whiteSpace: "pre-wrap",
  wordBreak: "break-word",
};

/** The shape both tasks return under `verification`, as this pane reads it. */
interface Verification {
  trace?: string;
  priorRoots: string;
  count?: string;
  head?: { dataCommitment: string; recordCount: number; headVersion: number };
}

interface RecordRow {
  key: string;
  version: number;
  status?: string;
  updatedAt?: string;
  epoch?: number;
  author?: string;
  /** Present only on an `open` room; sealed with the body otherwise. */
  title?: string;
  description?: string;
  /** The host's, from `rooms/keys/browse/0.4` (`RecordMetadataV3`): absent from an agent or host that predates them. */
  createdAt?: string;
  createdBy?: string;
  bodyStoredAt?: string;
  /** The record's kind, served on an `open` room's listing (`rooms/records/list/0.6`). */
  kind?: string;
}

/**
 * One finding, in words that name what was observed.
 *
 * The order matters: a caught host is reported before anything reassuring, and
 * `trace: "verified"` is never allowed to stand alone as though it settled the
 * question. It does not — a host serving a private view of a room builds a
 * consistent tree over that view and traces every record in it perfectly.
 */
function Verdict({
  verification,
  complete,
  returned,
}: {
  verification: Verification;
  complete?: boolean | undefined;
  returned?: number | undefined;
}) {
  const { trace, priorRoots, count, head } = verification;

  // ── Caught ────────────────────────────────────────────────────────────────
  if (priorRoots === "conflict") {
    return (
      <Note tone="danger">
        <strong>This host has given your agent two different answers about this room.</strong>{" "}
        Two record sets, both claimed as this room at version {head?.headVersion ?? "?"}. One
        of them is wrong, and a write would explain neither — a write moves the version.
        <br />
        <br />
        Reading still works, and is how you gather what you need. Writing to this host will
        be refused.
      </Note>
    );
  }
  if (count === "short") {
    return (
      <Note tone="danger">
        <strong>This host served fewer records than it committed to.</strong> It sent{" "}
        {returned ?? "some"} and committed to a set of {head?.recordCount ?? "?"}, with no
        filter to explain the difference. That is a contradiction inside a single answer.
        <br />
        <br />
        Reading still works. Writing to this host will be refused.
      </Note>
    );
  }
  if (trace === "failed") {
    return (
      <Note tone="danger">
        <strong>The path this host gave for this record does not reach the root it
        asserted</strong> in the same answer. Either its bookkeeping is broken or the path
        was made up, and from here those look the same.
        <br />
        <br />
        The record is above, unopened by anything this says. Writing to this host will be
        refused.
      </Note>
    );
  }

  // ── Nothing claimed ───────────────────────────────────────────────────────
  if (!head) {
    return (
      <Note tone="warn">
        This host keeps no record tree, so it makes no claim about what this room holds and
        nothing here can be checked. That is allowed — and it is worth knowing, because a
        record it simply left out would look exactly like a room that never held one.
      </Note>
    );
  }

  // ── Checked, and honest about what that is worth ──────────────────────────
  const agrees = priorRoots === "agree";
  return (
    <Note tone="accent">
      {trace === "verified" && (
        <>This record is inside the set this host committed to. </>
      )}
      {count === "agrees" && <>Its listing holds exactly the {head.recordCount} records it
        committed to. </>}
      {agrees ? (
        <>
          That commitment matches what this host told your agent before at version{" "}
          {head.headVersion}.
        </>
      ) : (
        <>
          Whether that commitment is the room&rsquo;s is a different question. Your agent has
          nothing to compare it against yet — a first reading is not a comparison
          {priorRoots === "notChecked" && ", and this agent is not keeping the history that " +
            "would make one possible"}
          .
        </>
      )}
      {complete === false && (
        <>
          {" "}
          The listing stopped before the end, so its length says nothing.
        </>
      )}
    </Note>
  );
}

/** Whether a verdict reports a host caught out — said in full, never folded away. */
function adverse(v: Verification): boolean {
  return v.priorRoots === "conflict" || v.count === "short" || v.trace === "failed";
}

/**
 * A verdict, sized to what it found. Anything adverse is the full `Verdict`,
 * in the open: the spec requires an adverse finding be surfaced, and a member
 * shown a folded warning dismisses it. A clean one is a single line, with the
 * same words one click away — it is the common case and it repeated under
 * every record.
 */
function VerdictLine({
  verification,
  complete,
  returned,
  scope,
}: {
  verification: Verification;
  complete?: boolean | undefined;
  returned?: number | undefined;
  scope: "listing" | "record";
}) {
  if (adverse(verification)) return <Verdict verification={verification} complete={complete} returned={returned} />;
  const { head, count, trace } = verification;
  const checked = scope === "record" ? trace === "verified" : !!head && count === "agrees";
  const words =
    scope === "record"
      ? trace === "verified"
        ? "In the set this host committed to"
        : "Not traced against the host's commitment"
      : !head
        ? "No count to check: this host keeps no record tree"
        : count === "agrees"
          ? `Holds exactly the ${head.recordCount} ${head.recordCount === 1 ? "record" : "records"} this host committed to`
          : `This host committed to ${head.recordCount} ${head.recordCount === 1 ? "record" : "records"}`;
  return (
    <details style={{ fontSize: t.xs, color: checked ? c.ok : c.muted }}>
      <summary style={{ cursor: "pointer" }}>
        {checked ? "✓ " : ""}
        {words}
      </summary>
      <div style={{ marginTop: 6 }}>
        <Verdict verification={verification} complete={complete} returned={returned} />
      </div>
    </details>
  );
}

/** What reading one key gave this pane, beside what the reading rules make of it. */
interface Opened {
  /** The record as read: the signed body once verified, an open room's cleartext. Empty when nothing of it may be shown. */
  text: string;
  /** Whether the body's author signature, location and author all verified — never true for cleartext. */
  signed: boolean;
  verification: Verification | null;
}

/** Words for a body that is refused or shown as a placeholder: what failed, never the body. */
function refusalWords(e: unknown): string {
  if (e instanceof RecordBodyError) {
    switch (e.kind) {
      case "signature":
        return "Its author's signature does not verify.";
      case "relocated":
        return "It is signed for a different room, record or version than the one it was read from.";
      case "authorMismatch":
        return "The host names a different author from the one who signed it.";
      case "malformed":
        return "It is not a record body this wallet can read.";
      case "authorUnresolvable":
        return "Its author's DID no longer resolves, so who wrote it cannot be checked.";
      case "authorUnverifiable":
        return (
          "Its signature does not hold against its author's DID document as it is now, and the document as it was " +
          "when the record was stored could not be read — so this cannot tell a forgery from a key the author has since replaced."
        );
      default:
        break;
    }
  }
  return e instanceof Error ? e.message : String(e);
}

/**
 * Verify a sealed body before anything in it is read (`SealedRecordBody`,
 * *Reading*). `hostAuthor` is the read's author; `listedAuthor` the listing's
 * for the same version — both are the host's, and on an `attributed` room both
 * must be the signer. `bodyStoredAt` is when the host stored this body: the
 * author's DID document is the one that stood then (*Which DID document*).
 */
async function verifySealed(
  plaintext: string,
  at: { roomId: string; key: string; version: number },
  hostAuthor: string | undefined,
  listedAuthor: string | undefined,
  bodyStoredAt: string | undefined,
): Promise<VerifiedRecordBody> {
  let bytes: Uint8Array;
  try {
    bytes = base64url.decode(plaintext);
  } catch {
    throw new RecordBodyError("malformed", "the record body is not base64url");
  }
  const body = await verifyRecordBody(bytes, at, hostAuthor, bodyStoredAt !== undefined ? { bodyStoredAt } : {});
  if (listedAuthor !== undefined && listedAuthor !== body.author) {
    throw new RecordBodyError(
      "authorMismatch",
      `the record body is signed by ${body.author}, but the host listed ${listedAuthor} as its author`,
    );
  }
  return body;
}

/**
 * An open room's cleartext with its file's `fileKey` left out. The key is in the
 * record by design — the host and every member may open the file — but nobody
 * needs to read it, and what is shown here is copied and screenshotted.
 */
function withoutFileKey(cleartext: Record<string, unknown>): Record<string, unknown> {
  const file = cleartext.file;
  if (typeof file !== "object" || file === null || !("fileKey" in file)) return cleartext;
  const { fileKey: _, ...rest } = file as Record<string, unknown>;
  return { ...cleartext, file: rest };
}

function when(iso: string | undefined): string {
  if (!iso) return "";
  const d = new Date(iso);
  return Number.isNaN(d.getTime()) ? "" : d.toLocaleDateString(undefined, { day: "numeric", month: "short", year: "numeric" });
}

/** One read answer, made into what the pane keeps and what the reading rules take. */
async function readOne(
  roomId: string,
  row: RecordRow,
  res: ReadManyResult,
): Promise<{ opened: Opened; input: RecordInput }> {
  const verification = (res.verification as unknown as Verification | undefined) ?? null;
  const version = res.version ?? row.version;
  const meta = {
    key: row.key,
    version,
    ...((res.status ?? row.status) !== undefined ? { status: res.status ?? row.status } : {}),
    ...((res.updatedAt ?? row.updatedAt) !== undefined ? { updatedAt: res.updatedAt ?? row.updatedAt } : {}),
    ...((res.createdAt ?? row.createdAt) !== undefined ? { createdAt: res.createdAt ?? row.createdAt } : {}),
    ...((res.createdBy ?? row.createdBy) !== undefined ? { createdBy: res.createdBy ?? row.createdBy } : {}),
    ...((res.bodyStoredAt ?? row.bodyStoredAt) !== undefined ? { bodyStoredAt: res.bodyStoredAt ?? row.bodyStoredAt } : {}),
    ...(row.kind !== undefined ? { listedKind: row.kind } : {}),
  };
  const nothing = { text: "", signed: false, verification };
  if (res.error) {
    const why = res.error.message ?? res.error.code;
    return { opened: nothing, input: { ...meta, reading: { state: "unreadable", reason: why } } };
  }
  // The listing's word, used only for the version it listed.
  const sameVersion = version === row.version;
  const hostAuthor = res.author ?? (sameVersion ? row.author : undefined);
  if (res.plaintext !== undefined) {
    // Sealed: nothing of the body before its author's signature holds.
    try {
      const verified = await verifySealed(
        res.plaintext,
        { roomId, key: row.key, version: readSealedVersion({ version, ...(res.ext !== undefined ? { ext: res.ext } : {}) }) },
        res.author,
        sameVersion ? row.author : undefined,
        res.bodyStoredAt ?? (sameVersion ? row.bodyStoredAt : undefined),
      );
      if (verified.roomProfile) return { opened: nothing, input: { ...meta, reading: { state: "profile" } } };
      return {
        opened: { text: new TextDecoder().decode(base64url.decode(res.plaintext)), signed: true, verification },
        input: { ...meta, reading: { state: "read", content: contentFromBody(verified) } },
      };
    } catch (e) {
      const reason = refusalWords(e);
      const state = e instanceof RecordBodyError && e.placeholder ? "placeholder" : "refused";
      return { opened: nothing, input: { ...meta, reading: { state, reason } } };
    }
  }
  if (res.cleartext) {
    const reading = readingFromCleartext(res.cleartext, hostAuthor ?? meta.createdBy ?? "", version);
    return {
      opened: { text: JSON.stringify(withoutFileKey(res.cleartext), null, 2), signed: false, verification },
      input: { ...meta, reading },
    };
  }
  // A retracted record has no body, and that is an answer rather than a failure.
  return { opened: nothing, input: { ...meta, reading: { state: "tombstone" } } };
}

/** What a reply line calls the record it answers. */
function labelOf(view: RoomRecordView | undefined): string {
  const c = view?.content;
  if (!c) return "a record";
  return c.title || untitledLabel(c.body ?? "")?.label || "an untitled record";
}

/** When it was written, as far as the reading rules let it be said. */
function writtenWords(view: RoomRecordView, row: RecordRow): string {
  const late = view.written.arrivedLate;
  if (late) return `received ${when(late.received)}, later than the ${when(late.claimed)} it claims`;
  if (view.written.at) return when(view.written.at);
  // No claim, or an implausible one: never the claimed time — the host's.
  return when(row.createdAt ?? row.updatedAt);
}

/**
 * One record, as the reading rules show it: a note or a message with its
 * reactions beside it and what it answers above it; or a withdrawn, retracted,
 * refused or unverifiable one, saying so and showing nothing of it.
 */
function RecordItem({
  room,
  host,
  row,
  view,
  opened,
  target,
  prepared,
  autoPreview,
  authorName,
  onChanged,
}: {
  room: RoomPlace;
  host: string;
  row: RecordRow;
  view: RoomRecordView;
  opened: Opened | undefined;
  /** The record this one answers, where it can be shown. */
  target: RoomRecordView | undefined;
  prepared: RoomFilesPrepared | null;
  autoPreview: boolean;
  authorName: (did: string) => string;
  /** The record was edited or its standing changed: list again. */
  onChanged: () => void;
}) {
  const [editing, setEditing] = useState(false);
  const [expanded, setExpanded] = useState(false);

  const content = view.content;
  const shown = view.shown;
  const readable = content !== undefined;
  const claim = readable && content.hasFile && opened ? roomFileClaimOf(opened.text) : null;
  // A file record's `body` is its caption.
  const caption = claim && content?.body?.trim() ? content.body : undefined;
  const derived = readable && !content.title && !claim && content.body ? untitledLabel(content.body) : null;
  const title = (() => {
    switch (shown) {
      case "refused":
        return "This record could not be verified";
      case "placeholder":
        return "A record whose author cannot be verified";
      case "unreadable":
        return "This record could not be read";
      case "withdrawn":
        return "Withdrawn message";
      case "retracted":
        return "Retracted record";
      default:
        return content?.title ?? claim?.title ?? claim?.name ?? derived?.label ?? (shown === "message" ? "Empty message" : "Untitled record");
    }
  })();
  const preview = !readable ? undefined : claim ? caption : derived ? derived.rest || undefined : content.body;
  const author = content?.author ?? (shown === "retracted" || shown === "withdrawn" ? undefined : row.author);
  const edited = view.edited ? (view.edited.at ? `edited ${when(view.edited.at)}` : "edited") : "";
  const meta = [author ? authorName(author) : "", readable ? writtenWords(view, row) : "", edited]
    .filter(Boolean)
    .join(" · ");
  const caught = opened?.verification ? adverse(opened.verification) : false;
  const unshown = shown === "refused" || shown === "placeholder" || shown === "unreadable";

  return (
    <li style={{ borderTop: `1px solid ${c.lineSoft}`, listStyle: "none" }}>
      {view.replyTo && (
        <div style={{ padding: "8px 14px 0 38px", fontSize: t.xs, color: c.muted, wordBreak: "break-word" }}>
          ↩{" "}
          {view.replyTo.available ? (
            <>
              In reply to <strong style={{ fontWeight: 600 }}>{labelOf(target)}</strong>
              {target?.content?.author && <> by {authorName(target.content.author)}</>}
              {view.replyTo.changed === "edited" && <> — edited since</>}
            </>
          ) : (
            <>In reply to a record that is not available</>
          )}
        </div>
      )}
      <button
        onClick={() => setExpanded((x) => !x)}
        aria-expanded={expanded}
        style={{
          all: "unset",
          boxSizing: "border-box",
          cursor: "pointer",
          width: "100%",
          display: "flex",
          gap: 12,
          alignItems: "flex-start",
          padding: "11px 14px",
        }}
      >
        <span aria-hidden="true" style={{ color: c.faint, paddingTop: 1 }}>
          {claim ? "▣" : !readable ? "▢" : shown === "message" ? "▹" : "▤"}
        </span>
        <span style={{ display: "grid", gap: 3, flex: "1 1 auto", minWidth: 0 }}>
          <span style={{ fontSize: t.base, fontWeight: 600, color: readable ? c.text : c.muted, wordBreak: "break-word" }}>
            {title}
          </span>
          {preview && !expanded && (
            <span
              style={{
                fontSize: t.sm,
                color: c.muted,
                whiteSpace: "pre-wrap",
                display: "-webkit-box",
                WebkitLineClamp: 2,
                WebkitBoxOrient: "vertical",
                overflow: "hidden",
              }}
            >
              {preview}
            </span>
          )}
        </span>
        <span style={{ display: "flex", gap: 8, alignItems: "center", flex: "0 0 auto", fontSize: t.xs, color: c.faint }}>
          {shown === "refused" && <Pill tone="danger">signature not verified</Pill>}
          {shown === "placeholder" && <Pill tone="warn">author not verified</Pill>}
          {caught && <Pill tone="danger">check failed</Pill>}
          {view.expired && <Pill tone="warn">expired</Pill>}
          {row.status && row.status !== "active" && (
            <Pill tone="warn">{row.status === "deprecated" ? "archived" : row.status}</Pill>
          )}
          <span>{meta}</span>
        </span>
      </button>
      {view.reactions.length > 0 && (
        <div style={{ display: "flex", gap: 6, flexWrap: "wrap", padding: "0 14px 10px 38px" }}>
          {view.reactions.map((r) => (
            <span
              key={r.normalised}
              title={r.authors.map(authorName).join(", ")}
              style={{
                fontSize: t.sm,
                padding: "1px 8px",
                border: `1px solid ${c.line}`,
                borderRadius: 999,
                whiteSpace: "pre",
              }}
            >
              {r.value} {r.count}
            </span>
          ))}
        </div>
      )}
      {/* Refused or unverifiable, it is said where the record is, whether or not it is expanded. */}
      {shown === "refused" && (
        <div style={{ padding: "0 14px 12px 38px" }}>
          <Note tone="danger">
            <strong>Your agent opened this record, but it could not be verified, so none of it is shown.</strong>{" "}
            {view.reason}
          </Note>
        </div>
      )}
      {shown === "placeholder" && (
        <div style={{ padding: "0 14px 12px 38px" }}>
          <Note tone="warn">
            <strong>Who wrote this record cannot be verified, so none of it is shown.</strong> {view.reason}
          </Note>
        </div>
      )}
      {view.rewrite && (
        <div style={{ padding: "0 14px 10px 38px", fontSize: t.xs, color: c.warn }}>
          This version was written by {authorName(view.rewrite.by)}, not by {authorName(view.rewrite.original)}, who
          wrote the record — it is their rewrite, not an edit by {authorName(view.rewrite.original)}.
        </div>
      )}
      {/* A file is shown whether or not the row is expanded: its thumbnail and
          download are the point of it, and the rest is behind the expand. */}
      {claim && (
        <div style={{ padding: "0 14px 12px 38px" }}>
          <GetRoomFile room={room} host={host} prepared={prepared} recordKey={row.key} claim={claim} showTitle={false} autoPreview={autoPreview} />
        </div>
      )}
      {expanded && (
        <div style={{ display: "grid", gap: 10, padding: "0 14px 14px 38px" }}>
          {shown === "withdrawn" && (
            <div style={{ fontSize: t.sm, color: c.muted }}>Its author withdrew this message. Nothing of it is shown.</div>
          )}
          {shown === "retracted" && (
            <div style={{ fontSize: t.sm, color: c.muted }}>(retracted — the body is gone)</div>
          )}
          {shown === "unreadable" && <Note tone="warn">{view.reason}</Note>}
          {readable && (!claim || caption) && (
            // Plain text, always: a message's body is never markup, and a note's is rendered inert.
            <div style={{ fontSize: t.base, color: c.text, whiteSpace: "pre-wrap", wordBreak: "break-word", lineHeight: 1.55 }}>
              {claim ? caption : (content.body ?? "")}
            </div>
          )}
          {readable && view.written.arrivedLate && (
            <div style={{ fontSize: t.xs, color: c.warn }}>
              The room received this on {when(view.written.arrivedLate.received)}, though it says it was written on{" "}
              {when(view.written.arrivedLate.claimed)}. It is placed where it arrived.
            </div>
          )}
          {opened?.signed && content?.author && (
            // The check is the signature's, over the DID: never beside a name the author gave themselves.
            <div style={{ fontSize: t.xs, color: c.ok, wordBreak: "break-all" }}>
              ✓ Signed by {content.author} — the author&rsquo;s signature checks out
            </div>
          )}
          {readable && opened && (
            <details>
              <summary style={{ fontSize: t.xs, color: c.muted, cursor: "pointer" }}>
                {opened.signed ? "The signed record" : "The record, as the host stores it"}
              </summary>
              <pre style={bodyStyle}>{opened.text}</pre>
            </details>
          )}
          {opened?.verification && <VerdictLine verification={opened.verification} scope="record" />}
          {editing && content ? (
            <NoteEditor
              key={`${row.key}@${row.version}`}
              room={room}
              host={host}
              existing={{
                key: row.key,
                version: row.version,
                ...(content.title !== undefined ? { title: content.title } : {}),
                ...(content.body !== undefined ? { body: content.body } : {}),
              }}
              onDone={() => {
                setEditing(false);
                onChanged();
              }}
              onCancel={() => setEditing(false)}
            />
          ) : (
            !unshown && (
              <RecordActions
                room={room}
                host={host}
                recordKey={row.key}
                version={row.version}
                status={row.status}
                // A note this place wrote, carrying nothing this editor would drop:
                // a new version must keep `kind`, `inReplyTo` and `writtenAt`, which it
                // does not write. Replacing someone else's is not an edit.
                editable={
                  !!content &&
                  !claim &&
                  content.body !== undefined &&
                  content.kind === undefined &&
                  content.inReplyTo === undefined &&
                  content.writtenAt === undefined &&
                  !!author &&
                  author === room.member
                }
                onEdit={() => setEditing(true)}
                onChanged={onChanged}
              />
            )
          )}
          <code style={{ fontFamily: font.mono, fontSize: t.xs, color: c.faint, wordBreak: "break-all" }}>{row.key}</code>
        </div>
      )}
      {/* Caught, it is said where the record is, whether or not it is expanded. */}
      {caught && !expanded && opened?.verification && (
        <div style={{ padding: "0 14px 12px 38px" }}>
          <Verdict verification={opened.verification} />
        </div>
      )}
    </li>
  );
}

/** How many of the newest file records preview themselves as the list arrives. */
export const AUTO_PREVIEW = 5;

/**
 * Browse a room's records at a host, read them, and show them as the reading
 * rules say (`@openvtc/pnm-core/rooms`'s `assembleRoomRecords`).
 *
 * Every record listed is read — in batches, through `rooms/keys/read/0.2` — and
 * verified before any of it is shown: a reply is placed against what it
 * answers, reactions beside their target, and messages by when they were
 * written, none of which can be done one opened record at a time.
 *
 * Nothing authoritative maps a room to its host — a room is portable, and may
 * have more than one, a mirror serving reads while its primary takes writes —
 * so `host` is only where this wallet last found it (`room-hosts.ts`). Given
 * one, the listing starts there and offers *Change*; without one, it asks.
 * `onListed` hears each host that answered, so the pane can remember it.
 */
export function RoomRecords({
  parties,
  room,
  host: knownHost,
  onListed,
  petnames,
}: {
  parties: Parties;
  room: RoomPlace;
  host?: string | undefined;
  onListed?: ((host: string) => void) | undefined;
  /** The member's own petnames, by DID, from their contacts: shown before any name an author gives themselves. */
  petnames?: ReadonlyMap<string, string> | undefined;
}) {
  const [hostDid, setHostDid] = useState(knownHost ?? "");
  const [askHost, setAskHost] = useState(!knownHost);
  const [rows, setRows] = useState<RecordRow[] | null>(null);
  const [verification, setVerification] = useState<Verification | null>(null);
  const [complete, setComplete] = useState<boolean | undefined>(undefined);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [reading, setReading] = useState(false);
  const [opened, setOpened] = useState<Map<string, Opened>>(new Map());
  const [shownRoom, setShownRoom] = useState<RoomRecordsView | null>(null);
  const [showExpired, setShowExpired] = useState(false);
  // The host is learnt here, at listing, so that a click on put or get can ask
  // for its origin as its first act (`rooms-files.tsx`).
  const [listedHost, setListedHost] = useState("");
  const [prepared, setPrepared] = useState<RoomFilesPrepared | null>(null);
  const [filesError, setFilesError] = useState<string | null>(null);
  /**
   * The versions this pane last showed, by key: what a later version is compared
   * with (*What a new version keeps*, *Edits*, *Tombstones*). Kept for as long as
   * the pane is, across every refresh.
   */
  const held = useRef(new Map<string, HeldRecord>());
  // A listing can be overtaken by the next one before its reads land.
  const generation = useRef(0);

  const started = useRef(false);
  const browse = useCallback(async (asked: string) => {
    const host = asked.trim();
    if (!host) return;
    started.current = true;
    const mine = ++generation.current;
    setBusy(true);
    setError(null);
    setRows(null);
    setShownRoom(null);
    setOpened(new Map());
    setListedHost(host);
    setPrepared(null);
    setFilesError(null);
    void prepareRoomFiles(host).then(setPrepared, (e: unknown) =>
      setFilesError(e instanceof Error ? e.message : String(e)),
    );
    let listed: RecordRow[];
    try {
      const res = await roomsKeysBrowse(managerSender, {
        ...parties,
        roomId: room.roomId,
        host,
        ...(room.member !== undefined ? { member: room.member } : {}),
      });
      listed = (res.records ?? []) as unknown as RecordRow[];
      setRows(listed);
      setVerification(res.verification as unknown as Verification);
      setComplete(res.complete);
      setAskHost(false);
      onListed?.(host);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
      // A host that did not answer is one to correct, so the field comes back.
      setAskHost(true);
      setBusy(false);
      return;
    }
    setBusy(false);

    // Read every record that has a body; a tombstone has none to read.
    setReading(true);
    try {
      const toRead = listed.filter((r) => r.status !== "retracted");
      const answers =
        toRead.length === 0
          ? []
          : await roomsKeysReadMany(managerSender, {
              ...parties,
              roomId: room.roomId,
              host,
              keys: toRead.map((r) => r.key),
              ...(room.member !== undefined ? { member: room.member } : {}),
            });
      const byKey = new Map(answers.map((a) => [a.key, a]));
      const read = await Promise.all(
        listed.map(async (row) => {
          const res = byKey.get(row.key);
          if (res) return { row, ...(await readOne(room.roomId, row, res)) };
          const input: RecordInput = {
            key: row.key,
            version: row.version,
            ...(row.status !== undefined ? { status: row.status } : {}),
            ...(row.updatedAt !== undefined ? { updatedAt: row.updatedAt } : {}),
            ...(row.createdAt !== undefined ? { createdAt: row.createdAt } : {}),
            ...(row.createdBy !== undefined ? { createdBy: row.createdBy } : {}),
            ...(row.bodyStoredAt !== undefined ? { bodyStoredAt: row.bodyStoredAt } : {}),
            ...(row.kind !== undefined ? { listedKind: row.kind } : {}),
            reading: { state: "tombstone" },
          };
          return { row, opened: undefined, input };
        }),
      );
      if (mine !== generation.current) return;
      const inputs = read.map(({ input }) => {
        const before = held.current.get(input.key);
        return before !== undefined ? { ...input, held: before } : input;
      });
      setShownRoom(assembleRoomRecords(inputs, { now: Date.now() }));
      setOpened(new Map(read.flatMap(({ row, opened: o }) => (o ? [[row.key, o] as const] : []))));
      for (const input of inputs) {
        if (input.reading.state === "read") held.current.set(input.key, { version: input.version, content: input.reading.content });
      }
    } catch (e) {
      if (mine === generation.current) setError(e instanceof Error ? e.message : String(e));
    }
    if (mine === generation.current) setReading(false);
  }, [parties, room, onListed]);

  const [uploading, setUploading] = useState(false);
  const [writing, setWriting] = useState(false);
  const rowsByKey = new Map((rows ?? []).map((r) => [r.key, r]));
  const visible = shownRoom ? [...shownRoom.records, ...(showExpired ? shownRoom.expired : [])] : [];
  const viewsByKey = new Map(visible.map((v) => [v.key, v]));
  // Newest first, by the order the reading rules give: when it was written,
  // else when the room received it.
  const newestFirst = [...visible].sort((x, y) => y.orderAt - x.orderAt || (x.key < y.key ? 1 : x.key > y.key ? -1 : 0));
  const previewFirst = new Set(
    newestFirst.filter((v) => v.content?.hasFile).slice(0, AUTO_PREVIEW).map((v) => v.key),
  );
  const names = useAgentNames((rows ?? []).map((r) => r.author).concat(visible.map((v) => v.content?.author)));
  const roomNames = shownRoom?.names;
  const labels = authorLabels(
    [
      ...(rows ?? []).flatMap((r) => (r.author ? [r.author] : [])),
      ...visible.flatMap((v) => [
        ...(v.content ? [v.content.author] : []),
        ...(v.rewrite ? [v.rewrite.by, v.rewrite.original] : []),
        ...v.reactions.flatMap((r) => r.authors),
      ]),
    ],
    { petnames, roomNames },
  );
  // A petname is the member's own; a room name is the author's claim, in quotes;
  // otherwise the DID, or a name its own document claims.
  const authorName = (did: string) => {
    const l = labels.get(did);
    if (l?.source === "petname") return l.text!;
    if (l?.source === "room") return `“${l.text}”${l.fingerprint ? ` (…${l.fingerprint})` : ""}`;
    const n = names[did];
    return n ? displayAgentName(n) : shortDid(did);
  };
  const anyRoomName = [...labels.values()].some((l) => l.source === "room");
  const [naming, setNaming] = useState(false);
  const ownName = room.member !== undefined ? roomNames?.[room.member]?.name : undefined;
  const heldNames = Object.entries(roomNames ?? {}).map(([author, r]) => ({ author, key: r.key, version: r.version }));

  // Where the room was last found: list it straight away, once — and not again
  // when the host this listing just found comes back down as the known one.
  useEffect(() => {
    if (started.current || !knownHost) return;
    started.current = true;
    void browse(knownHost);
  }, [knownHost, browse]);

  const hiddenExpired = shownRoom?.expired.length ?? 0;
  const tombstones = shownRoom?.tombstones.length ?? 0;

  return (
    <div style={{ display: "grid", gap: 8, marginTop: 10 }}>
      {askHost ? (
        <div style={{ display: "flex", gap: 8, alignItems: "flex-end", flexWrap: "wrap" }}>
          <label style={{ display: "grid", gap: 4, flex: "1 1 22rem" }}>
            <span style={{ fontSize: t.xs, color: c.muted }}>
              HOST DID <span style={{ color: c.faint }}>— who serves this room</span>
            </span>
            <input
              style={fieldStyle}
              value={hostDid}
              onChange={(e) => setHostDid(e.target.value)}
            />
          </label>
          <Button disabled={busy || !hostDid.trim()} onClick={() => void browse(hostDid)}>
            {busy ? "Listing…" : "List the records"}
          </Button>
        </div>
      ) : (
        <div style={{ display: "flex", gap: 8, alignItems: "center", flexWrap: "wrap", fontSize: t.sm, color: c.muted }}>
          <span>Served by</span>
          <strong style={{ color: c.text, fontWeight: 600 }} title={listedHost || hostDid}>
            {didHost(listedHost || hostDid) ?? listedHost ?? hostDid}
          </strong>
          <Button kind="quiet" onClick={() => setAskHost(true)}>
            Change
          </Button>
          <Button kind="quiet" disabled={busy || reading} onClick={() => void browse(listedHost || hostDid)}>
            {busy ? "Listing…" : "Refresh"}
          </Button>
        </div>
      )}

      {error && <LoadError what="this room's records" error={error} />}
      {busy && rows === null && !error && <Loading what="records" />}

      {rows !== null && (
        <>
          {verification && (
            <VerdictLine verification={verification} complete={complete} returned={rows.length} scope="listing" />
          )}
          {rows.length === 0 ? (
            <div style={{ fontSize: t.sm, color: c.faint, lineHeight: 1.55 }}>
              This host served no records for this room — which is also what a host withholding all of them
              looks like, unless it committed to a count.
            </div>
          ) : reading && !shownRoom ? (
            <Loading what="the records" />
          ) : (
            newestFirst.length > 0 && (
              <ul
                style={{
                  margin: 0,
                  padding: 0,
                  background: c.surface,
                  border: `1px solid ${c.line}`,
                  borderRadius: "var(--w-r-md)",
                  overflow: "hidden",
                }}
              >
                {newestFirst.map((v) => {
                  const row = rowsByKey.get(v.key) ?? { key: v.key, version: v.version };
                  return (
                    <RecordItem
                      // Keyed by version too: an edited record is a new one to show.
                      key={`${v.key}@${v.version}`}
                      room={room}
                      host={listedHost}
                      row={row}
                      view={v}
                      opened={opened.get(v.key)}
                      target={v.replyTo ? viewsByKey.get(v.replyTo.key) : undefined}
                      prepared={prepared}
                      autoPreview={previewFirst.has(v.key)}
                      authorName={authorName}
                      onChanged={() => void browse(listedHost)}
                    />
                  );
                })}
              </ul>
            )
          )}
          {anyRoomName && (
            <div style={{ fontSize: t.xs, color: c.faint, lineHeight: 1.5 }}>
              A name in quotes is what that member calls themselves in this room — their own claim, not verified. Your own
              petnames for people come first.
            </div>
          )}
          {(hiddenExpired > 0 || tombstones > 0) && (
            <div style={{ display: "flex", gap: 10, flexWrap: "wrap", alignItems: "center", fontSize: t.xs, color: c.faint }}>
              {hiddenExpired > 0 && (
                <>
                  <span>
                    {hiddenExpired === 1
                      ? "1 record is past the time its author stood behind it, and is hidden."
                      : `${hiddenExpired} records are past the time their authors stood behind them, and are hidden.`}
                  </span>
                  <Button kind="quiet" onClick={() => setShowExpired((x) => !x)}>
                    {showExpired ? "Hide expired records" : "Show expired records"}
                  </Button>
                </>
              )}
              {tombstones > 0 && (
                <span>
                  {tombstones === 1 ? "1 record was retracted" : `${tombstones} records were retracted`} — the body is
                  gone; the room keeps only its key.
                </span>
              )}
            </div>
          )}
          {filesError && <RoomFilesUnavailable error={filesError} />}
          {writing && (
            <NoteEditor
              key={`new@${room.roomId}|${room.member ?? ""}`}
              room={room}
              host={listedHost}
              onDone={() => {
                setWriting(false);
                void browse(listedHost);
              }}
              onCancel={() => setWriting(false)}
            />
          )}
          {naming && (
            <MemberNameEditor
              key={`name@${room.roomId}|${room.member ?? ""}`}
              parties={parties}
              room={room}
              host={listedHost}
              current={ownName}
              held={heldNames}
              onDone={() => {
                setNaming(false);
                void browse(listedHost);
              }}
              onCancel={() => setNaming(false)}
            />
          )}
          {prepared && uploading && (
            <PutRoomFile room={room} host={listedHost} prepared={prepared} onPut={() => void browse(listedHost)} />
          )}
          {!writing && !uploading && !naming && (
            <div style={{ display: "flex", gap: 8, flexWrap: "wrap", alignItems: "center" }}>
              <Button disabled={holds(room, "write") === false} onClick={() => setWriting(true)}>
                Write a note
              </Button>
              {prepared && (
                <Button disabled={holds(room, "write") === false} onClick={() => setUploading(true)}>
                  Upload a file
                </Button>
              )}
              <Button kind="quiet" disabled={holds(room, "write") === false} onClick={() => setNaming(true)}>
                {ownName !== undefined ? "Change my name in this room" : "Set my name in this room"}
              </Button>
              {holds(room, "write") === false && (
                <span style={{ fontSize: t.xs, color: c.faint }}>
                  This identity's credentials for the room do not include write.
                </span>
              )}
            </div>
          )}
        </>
      )}
    </div>
  );
}
