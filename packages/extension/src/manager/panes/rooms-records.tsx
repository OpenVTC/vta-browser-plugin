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

import { useCallback, useEffect, useRef, useState } from "react";
import {
  roomsKeysBrowse,
  roomsKeysRead,
  type HeldRoom,
} from "@openvtc/pnm-core/rooms";
import { Button, Note, Pill } from "../../ui.js";
import { displayAgentName } from "../../agent-name.js";
import { useAgentNames } from "../../use-agent-names.js";
import { shortDid } from "../room-words.js";
import { formatBytes } from "../room-files.js";
import { createLimiter } from "../limit.js";
import { didHost } from "../../did-display.js";
import { c, t, font } from "../../theme.js";
import { managerSender } from "../sender.js";
import { Loading, LoadError } from "../table.js";
import type { Parties } from "../use-vta.js";
import type { RoomFilesPrepared } from "../../bridge-protocol.js";
import { prepareRoomFiles, roomFileClaimOf } from "../room-files.js";
import { GetRoomFile, PutRoomFile, RoomFilesUnavailable } from "./rooms-files.js";
import { holds, NoteEditor, RecordActions } from "./rooms-record-actions.js";

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

/** base64url → text, for a body this agent just opened. */
function decodeBody(plaintext: string): string {
  const padded = plaintext.replace(/-/g, "+").replace(/_/g, "/");
  try {
    const bytes = Uint8Array.from(atob(padded), (ch) => ch.charCodeAt(0));
    return new TextDecoder().decode(bytes);
  } catch {
    // Not text. Saying so is better than printing mojibake and letting a member
    // conclude the record is corrupt.
    return "(this record's body is not text)";
  }
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

/** What an opened record says, as far as this pane reads it. */
interface Opened {
  text: string;
  title?: string;
  body?: string;
  author?: string;
  verification: Verification | null;
}

/** A note's title, body and author, where its body is the JSON a note is written as. */
function readNote(text: string): Pick<Opened, "title" | "body" | "author"> {
  try {
    const doc = JSON.parse(text) as Record<string, unknown>;
    if (typeof doc !== "object" || doc === null) return {};
    return {
      ...(typeof doc.title === "string" && doc.title ? { title: doc.title } : {}),
      ...(typeof doc.body === "string" ? { body: doc.body } : {}),
      ...(typeof doc.author === "string" ? { author: doc.author } : {}),
    };
  } catch {
    return {};
  }
}

function when(iso: string | undefined): string {
  if (!iso) return "";
  const d = new Date(iso);
  return Number.isNaN(d.getTime()) ? "" : d.toLocaleDateString(undefined, { day: "numeric", month: "short", year: "numeric" });
}

/**
 * One record: a title and a preview once opened, everything else on a click.
 *
 * Keys are opaque by rule on the sealed tiers and the title is sealed with the
 * body, so a record says nothing until it is opened. The newest few are opened
 * as the list arrives (`autoOpen`); the rest on a click.
 */
function RecordItem({
  parties,
  room,
  host,
  row,
  prepared,
  autoOpen,
  authorName,
  onChanged,
}: {
  parties: Parties;
  room: HeldRoom;
  host: string;
  row: RecordRow;
  prepared: RoomFilesPrepared | null;
  autoOpen: boolean;
  authorName: (did: string) => string;
  /** The record was edited or its standing changed: list again. */
  onChanged: () => void;
}) {
  const [editing, setEditing] = useState(false);
  const [opened, setOpened] = useState<Opened | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [expanded, setExpanded] = useState(false);

  // A row can be scrolled away or the room left before its read lands.
  const live = useRef(true);
  useEffect(() => {
    live.current = true;
    return () => {
      live.current = false;
    };
  }, []);

  /** Read the record — through the background queue when nobody asked for it. */
  const open = useCallback(async (queued = false) => {
    setBusy(true);
    setError(null);
    try {
      const read = () =>
        roomsKeysRead(managerSender, {
          ...parties,
          roomId: room.roomId,
          host,
          key: row.key,
          ...(room.member !== undefined ? { member: room.member } : {}),
        });
      const res = await (queued ? READS.run(read) : read());
      if (!live.current) return;
      // A retracted record has no body, and that is an answer rather than a
      // failure — the tombstone is what the room retains of it.
      const text = res.plaintext
        ? decodeBody(res.plaintext)
        : res.cleartext
          ? JSON.stringify(res.cleartext, null, 2)
          : res.status === "retracted"
            ? "(retracted — the body is gone)"
            : "(no body)";
      setOpened({ text, ...readNote(text), verification: (res.verification as unknown as Verification) ?? null });
    } catch (e) {
      if (live.current) setError(e instanceof Error ? e.message : String(e));
    }
    if (live.current) setBusy(false);
  }, [parties, room, host, row.key]);

  const started = useRef(false);
  useEffect(() => {
    if (!autoOpen || started.current) return;
    started.current = true;
    void open(true);
  }, [autoOpen, open]);

  const claim = opened ? roomFileClaimOf(opened.text) : null;
  const retracted = row.status === "retracted";
  const title =
    opened?.title ?? claim?.title ?? claim?.name ?? row.title ??
    (retracted ? "Retracted record" : opened ? "Untitled record" : busy ? "Opening…" : "Not opened yet");
  const preview = claim
    ? `${claim.name} · ${formatBytes(claim.size)}${claim.mediaType ? ` · ${claim.mediaType}` : ""}`
    : (opened?.body ?? row.description);
  const author = row.author ?? opened?.author;
  // No version here: it is the room's write counter, not this record's revision.
  const meta = [author ? authorName(author) : "", when(row.updatedAt)].filter(Boolean).join(" · ");
  const caught = opened?.verification ? adverse(opened.verification) : false;

  const toggle = () => {
    setExpanded((x) => !x);
    if (!opened && !busy) void open();
  };

  return (
    <li style={{ borderTop: `1px solid ${c.lineSoft}`, listStyle: "none" }}>
      <button
        onClick={toggle}
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
          {claim ? "▣" : retracted ? "▢" : "▤"}
        </span>
        <span style={{ display: "grid", gap: 3, flex: "1 1 auto", minWidth: 0 }}>
          <span style={{ fontSize: t.base, fontWeight: 600, color: opened || row.title ? c.text : c.muted, wordBreak: "break-word" }}>
            {title}
          </span>
          {preview && !expanded && !claim && (
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
          {caught && <Pill tone="danger">check failed</Pill>}
          {row.status && row.status !== "active" && (
            <Pill tone="warn">{row.status === "deprecated" ? "archived" : row.status}</Pill>
          )}
          <span>{meta}</span>
        </span>
      </button>
      {error && (
        <div style={{ padding: "0 14px 10px", display: "grid", gap: 6 }}>
          <Note tone="danger">{error}</Note>
          {/* Said by the record's standing, not by the error's text (R3.7): an
              archived sealed record is the one case a curation is known to
              leave unreadable, and the member deserves to know it is not lost. */}
          {row.status === "deprecated" && (
            <span style={{ fontSize: t.xs, color: c.muted }}>
              This record was archived. Archiving moved it to a new version, and a sealed record is bound to the version
              it was written at, so it no longer opens — the content is still on the host. This is a fault in the room
              software, not in your copy; it can be recovered once that is fixed.
            </span>
          )}
        </div>
      )}
      {/* A file is shown whether or not the row is expanded: its thumbnail and
          download are the point of it, and the rest is behind the expand. */}
      {opened && claim && (
        <div style={{ padding: "0 14px 12px 38px" }}>
          <GetRoomFile room={room} host={host} prepared={prepared} recordKey={row.key} claim={claim} showTitle={false} autoPreview={autoOpen} />
        </div>
      )}
      {expanded && (
        <div style={{ display: "grid", gap: 10, padding: "0 14px 14px 38px" }}>
          {busy && !opened && <Loading what="the record" />}
          {opened && !claim && (
            <div style={{ fontSize: t.base, color: c.text, whiteSpace: "pre-wrap", wordBreak: "break-word", lineHeight: 1.55 }}>
              {opened.body ?? (opened.title ? "" : opened.text)}
            </div>
          )}
          {opened && (opened.body !== undefined || claim) && (
            <details>
              <summary style={{ fontSize: t.xs, color: c.muted, cursor: "pointer" }}>The signed record</summary>
              <pre style={bodyStyle}>{opened.text}</pre>
            </details>
          )}
          {opened?.verification && <VerdictLine verification={opened.verification} scope="record" />}
          {editing && opened ? (
            <NoteEditor
              key={`${row.key}@${row.version}`}
              room={room}
              host={host}
              existing={{
                key: row.key,
                version: row.version,
                ...(opened.title !== undefined ? { title: opened.title } : {}),
                ...(opened.body !== undefined ? { body: opened.body } : {}),
              }}
              onDone={() => {
                setEditing(false);
                onChanged();
              }}
              onCancel={() => setEditing(false)}
            />
          ) : (
            <RecordActions
              room={room}
              host={host}
              recordKey={row.key}
              version={row.version}
              status={row.status}
              // A note this place wrote: replacing someone else's is not an edit.
              editable={!!opened && !claim && opened.body !== undefined && !!author && author === room.member}
              onEdit={() => setEditing(true)}
              onChanged={onChanged}
            />
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

/** How many of the newest records are opened as the list arrives. */
export const AUTO_OPEN = 5;

/** The records opened unasked, a few at a time and newest first (`limit.ts`). */
const READS = createLimiter(2);

/**
 * Browse a room's records at a host, and open the ones that matter.
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
}: {
  parties: Parties;
  room: HeldRoom;
  host?: string | undefined;
  onListed?: ((host: string) => void) | undefined;
}) {
  const [hostDid, setHostDid] = useState(knownHost ?? "");
  const [askHost, setAskHost] = useState(!knownHost);
  const [rows, setRows] = useState<RecordRow[] | null>(null);
  const [verification, setVerification] = useState<Verification | null>(null);
  const [complete, setComplete] = useState<boolean | undefined>(undefined);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  // The host is learnt here, at listing, so that a click on put or get can ask
  // for its origin as its first act (`rooms-files.tsx`).
  const [listedHost, setListedHost] = useState("");
  const [prepared, setPrepared] = useState<RoomFilesPrepared | null>(null);
  const [filesError, setFilesError] = useState<string | null>(null);

  const started = useRef(false);
  const browse = useCallback(async (asked: string) => {
    const host = asked.trim();
    if (!host) return;
    started.current = true;
    setBusy(true);
    setError(null);
    setRows(null);
    setListedHost(host);
    setPrepared(null);
    setFilesError(null);
    void prepareRoomFiles(host).then(setPrepared, (e: unknown) =>
      setFilesError(e instanceof Error ? e.message : String(e)),
    );
    try {
      const res = await roomsKeysBrowse(managerSender, {
        ...parties,
        roomId: room.roomId,
        host,
        ...(room.member !== undefined ? { member: room.member } : {}),
      });
      setRows((res.records ?? []) as unknown as RecordRow[]);
      setVerification(res.verification as unknown as Verification);
      setComplete(res.complete);
      setAskHost(false);
      onListed?.(host);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
      // A host that did not answer is one to correct, so the field comes back.
      setAskHost(true);
    }
    setBusy(false);
  }, [parties, room, onListed]);

  const [uploading, setUploading] = useState(false);
  const [writing, setWriting] = useState(false);
  // Newest first: a version is assigned by every write, so it orders them.
  const newestFirst = [...(rows ?? [])].sort((x, y) => y.version - x.version);
  const openFirst = new Set(newestFirst.filter((r) => r.status !== "retracted").slice(0, AUTO_OPEN).map((r) => r.key));
  const names = useAgentNames(newestFirst.map((r) => r.author));
  const authorName = (did: string) => {
    const n = names[did];
    return n ? displayAgentName(n) : shortDid(did);
  };

  // Where the room was last found: list it straight away, once — and not again
  // when the host this listing just found comes back down as the known one.
  useEffect(() => {
    if (started.current || !knownHost) return;
    started.current = true;
    void browse(knownHost);
  }, [knownHost, browse]);


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
          <Button kind="quiet" disabled={busy} onClick={() => void browse(listedHost || hostDid)}>
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
          ) : (
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
              {newestFirst.map((r) => (
                <RecordItem
                  // Keyed by version too: an edited record is a new one to open.
                  key={`${r.key}@${r.version}`}
                  parties={parties}
                  room={room}
                  host={listedHost}
                  row={r}
                  prepared={prepared}
                  autoOpen={openFirst.has(r.key)}
                  authorName={authorName}
                  onChanged={() => void browse(listedHost)}
                />
              ))}
            </ul>
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
          {prepared && uploading && (
            <PutRoomFile room={room} host={listedHost} prepared={prepared} onPut={() => void browse(listedHost)} />
          )}
          {!writing && !uploading && (
            <div style={{ display: "flex", gap: 8, flexWrap: "wrap", alignItems: "center" }}>
              <Button disabled={holds(room, "write") === false} onClick={() => setWriting(true)}>
                Write a note
              </Button>
              {prepared && (
                <Button disabled={holds(room, "write") === false} onClick={() => setUploading(true)}>
                  Upload a file
                </Button>
              )}
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
