// Changing what a room holds, from the console: write a note, edit one, and
// change a record's standing.
//
// Every one of these goes to the host from the offscreen document, completed
// by the member's own VTA as the member (`writeRoomNote` / `curateRoomRecord`
// in room-files.ts, over the room-files port) — the console only says what.
//
// ## What the words have to carry
//
// - **Retract is not erase.** The body is dropped from the room and a tombstone
//   stays — the key, a version, and the reason — so every member converges on
//   the record having been withdrawn. Anyone who read it may still hold what
//   they read. The button says *Retract*, never *Delete*, and the confirmation
//   says the rest, and asks why: a retraction without a reason is the one
//   nobody can interpret later (rooms/records/curate/0.1, `reason`).
// - **Each action is its own grant.** Editing needs `write`; retracting needs
//   `curate`, which `write` does not imply. Where the agent said
//   what the place holds (`HeldRoom.actions`), an action it lacks is shown as
//   such rather than offered; where it said nothing, it is offered and the host
//   decides. The host decides either way.
// - **Archive is not retract.** Archiving (`deprecated`) keeps the body and
//   only demotes the record; *Restore* undoes it. Both move the record to a new
//   version, and a sealed body stays readable because the host keeps the
//   version it was sealed at (`SealedRecord.version`, trust-tasks-tf #816,
//   VTI #2185) — so neither needs a confirmation, and neither asks why.
// - **No pin.** The listing does not say which records are pinned, so a pin
//   could be set and never shown.
// - **An edit never silently undoes someone else's.** It names the version the
//   member read, and the host refuses it if anything has replaced the record
//   since.

import { useEffect, useState } from "react";
import {
  memberNameRefusal,
  memberNameWriteRefusal,
  roomsKeysProfileRead,
  type HeldRoom,
} from "@openvtc/pnm-core/rooms";
import type { RoomPlace } from "../room-groups.js";
import { Button, Note } from "../../ui.js";
import { c, t } from "../../theme.js";
import { curateRoomRecord, writeRoomMemberName, writeRoomNote } from "../room-files.js";
import { managerSender } from "../sender.js";
import type { Parties } from "../use-vta.js";

const fieldStyle: React.CSSProperties = {
  boxSizing: "border-box",
  width: "100%",
  padding: "7px 10px",
  background: c.ground,
  color: c.text,
  border: `1px solid ${c.line}`,
  borderRadius: "var(--w-r-sm)",
  fontSize: t.sm,
  fontFamily: "inherit",
};

/** Whether the place holds `action`, as far as its agent said. `undefined`: not said. */
export function holds(room: Pick<HeldRoom, "actions">, action: "write" | "curate"): boolean | undefined {
  return room.actions === undefined ? undefined : room.actions.includes(action);
}

/** A write or edit of one note. `existing` makes it an edit of that record, at that version. */
export function NoteEditor({
  room,
  host,
  existing,
  onDone,
  onCancel,
}: {
  room: RoomPlace;
  host: string;
  existing?: { key: string; version: number; title?: string; body?: string };
  onDone: () => void;
  onCancel: () => void;
}) {
  const [title, setTitle] = useState(existing?.title ?? "");
  const [body, setBody] = useState(existing?.body ?? "");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const save = async () => {
    setBusy(true);
    setError(null);
    try {
      await writeRoomNote(
        { roomId: room.roomId, hostDid: host, ...(room.member !== undefined ? { member: room.member } : {}) },
        {
          title: title.trim(),
          ...(body.trim() ? { body } : {}),
          ...(existing ? { key: existing.key, replaces: existing.version } : {}),
        },
      );
      onDone();
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
      setBusy(false);
    }
  };

  return (
    <div
      style={{
        display: "grid",
        gap: 8,
        padding: 12,
        border: `1px solid ${c.line}`,
        borderRadius: "var(--w-r-md)",
        background: c.surface,
      }}
    >
      <span style={{ fontSize: t.sm, fontWeight: 650 }}>{existing ? "Edit this note" : "Write a note"}</span>
      <input aria-label="Note title" placeholder="Title" style={fieldStyle} value={title} onChange={(e) => setTitle(e.target.value)} />
      <textarea
        aria-label="Note text"
        placeholder="What it says"
        rows={6}
        style={{ ...fieldStyle, resize: "vertical", lineHeight: 1.5 }}
        value={body}
        onChange={(e) => setBody(e.target.value)}
      />
      <span style={{ fontSize: t.xs, color: c.faint }}>
        {existing
          ? "Saved over the version you opened. If someone has changed it since, the room refuses this and nothing is lost: open it again and redo the edit."
          : "Signed by your agent as the identity you are acting as, and sealed on a sealed room, so the host stores it without reading it."}
      </span>
      <div style={{ display: "flex", gap: 8 }}>
        <Button kind="primary" disabled={busy || !title.trim()} onClick={() => void save()}>
          {busy ? "Saving…" : existing ? "Save changes" : "Add the note"}
        </Button>
        <Button kind="quiet" disabled={busy} onClick={onCancel}>
          Cancel
        </Button>
      </div>
      {error && <Note tone="danger">{error}</Note>}
    </div>
  );
}

/**
 * The member's own name in this room (`memberProfile`, rooms/_shared/0.3): set,
 * changed or withdrawn.
 *
 * The room's profile is read first, through the member's own agent, and the
 * control says so plainly when it does not list both `kind` and `memberProfile`
 * in `recordMembers` — a reader that predates names would show each one as a
 * note. The offscreen document reads it again and refuses before anything is
 * sent, so this check is the explanation, not the gate.
 */
export function MemberNameEditor({
  parties,
  room,
  host,
  current,
  held,
  onDone,
  onCancel,
}: {
  parties: Parties;
  room: RoomPlace;
  host: string;
  /** The name this member has in the room now, where the page knows who the member is. */
  current?: string | undefined;
  /** Every author's name record the page read: the member's own is written over. */
  held: { author: string; key: string; version: number }[];
  onDone: () => void;
  onCancel: () => void;
}) {
  const [name, setName] = useState(current ?? "");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  // `undefined`: still reading the profile; `null`: the room takes names.
  const [closed, setClosed] = useState<string | null | undefined>(undefined);

  useEffect(() => {
    let live = true;
    roomsKeysProfileRead(managerSender, {
      ...parties,
      roomId: room.roomId,
      host,
      ...(room.member !== undefined ? { member: room.member } : {}),
    }).then(
      (read) => {
        const listed = read.status === "found" ? (read.profile as { recordMembers?: string[] } | undefined)?.recordMembers : undefined;
        if (live) setClosed(memberNameWriteRefusal(listed) ?? null);
      },
      (e: unknown) => {
        if (live) {
          setClosed(
            `This room's profile could not be read, so whether it takes members' names is not known, and nothing is written: ${
              e instanceof Error ? e.message : String(e)
            }`,
          );
        }
      },
    );
    return () => {
      live = false;
    };
  }, [parties, room, host]);

  const invalid = memberNameRefusal(name);
  const save = async (value: string) => {
    setBusy(true);
    setError(null);
    try {
      await writeRoomMemberName(
        { roomId: room.roomId, hostDid: host, ...(room.member !== undefined ? { member: room.member } : {}) },
        { name: value, held },
      );
      onDone();
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
      setBusy(false);
    }
  };

  return (
    <div
      style={{
        display: "grid",
        gap: 8,
        padding: 12,
        border: `1px solid ${c.line}`,
        borderRadius: "var(--w-r-md)",
        background: c.surface,
      }}
    >
      <span style={{ fontSize: t.sm, fontWeight: 650 }}>Your name in this room</span>
      {closed === undefined && <span style={{ fontSize: t.xs, color: c.faint }}>Checking whether this room takes members&rsquo; names…</span>}
      {typeof closed === "string" && <Note tone="warn">{closed}</Note>}
      {closed === null && (
        <>
          <input
            aria-label="Your name in this room"
            placeholder="What the room's members should call you"
            style={fieldStyle}
            value={name}
            onChange={(e) => setName(e.target.value)}
          />
          <span style={{ fontSize: t.xs, color: c.faint }}>
            Shown to this room&rsquo;s members beside your records, in this room only. It is your own claim: nobody
            verifies it, and a member who keeps their own name for you sees theirs instead. Signed by your agent as the
            identity you act as here, and sealed on a sealed room.
          </span>
          {invalid && name !== "" && <Note tone="warn">{invalid}</Note>}
        </>
      )}
      <div style={{ display: "flex", gap: 8, flexWrap: "wrap" }}>
        {closed === null && (
          <Button kind="primary" disabled={busy || !name.trim() || invalid !== undefined} onClick={() => void save(name.trim())}>
            {busy ? "Saving…" : "Save my name"}
          </Button>
        )}
        {closed === null && current !== undefined && (
          <Button disabled={busy} onClick={() => void save("")}>
            Withdraw my name
          </Button>
        )}
        <Button kind="quiet" disabled={busy} onClick={onCancel}>
          {closed === null || closed === undefined ? "Cancel" : "Close"}
        </Button>
      </div>
      {error && <Note tone="danger">{error}</Note>}
    </div>
  );
}

/** The actions on one record, by its standing and what the place may do. */
export function RecordActions({
  room,
  host,
  recordKey,
  version,
  status,
  editable,
  onEdit,
  onChanged,
}: {
  room: RoomPlace;
  host: string;
  recordKey: string;
  version: number;
  status: string | undefined;
  /** A note this place may replace — its own, opened. */
  editable: boolean;
  onEdit: () => void;
  onChanged: () => void;
}) {
  const [confirming, setConfirming] = useState(false);
  const [reason, setReason] = useState("");
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  const write = holds(room, "write");
  const curate = holds(room, "curate");
  const standing = status ?? "active";
  if (standing === "retracted") return null;

  const run = async (label: string, params: { status: "active" | "deprecated" | "retracted"; reason?: string }) => {
    setBusy(label);
    setError(null);
    try {
      await curateRoomRecord(
        { roomId: room.roomId, hostDid: host, ...(room.member !== undefined ? { member: room.member } : {}) },
        { key: recordKey, expectedVersion: version, ...params },
      );
      setConfirming(false);
      onChanged();
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    }
    setBusy(null);
  };

  const missing = (action: string) => `This identity's credentials for the room do not include ${action}.`;

  return (
    <div style={{ display: "grid", gap: 8 }}>
      <div style={{ display: "flex", gap: 8, flexWrap: "wrap", alignItems: "center" }}>
        {editable && (
          <Button disabled={write === false || busy !== null} title={write === false ? missing("write") : ""} onClick={onEdit}>
            Edit
          </Button>
        )}
        <Button
          disabled={curate === false || busy !== null}
          title={curate === false ? missing("curate") : ""}
          onClick={() => void run(standing === "deprecated" ? "restore" : "archive", { status: standing === "deprecated" ? "active" : "deprecated" })}
        >
          {standing === "deprecated"
            ? busy === "restore" ? "Restoring…" : "Restore"
            : busy === "archive" ? "Archiving…" : "Archive"}
        </Button>
        <Button
          kind="danger"
          disabled={curate === false || busy !== null}
          title={curate === false ? missing("curate") : ""}
          onClick={() => setConfirming(true)}
        >
          Retract…
        </Button>
        {curate === false && (
          <span style={{ fontSize: t.xs, color: c.faint }}>Archiving and retracting need the room's curate grant.</span>
        )}
      </div>

      {confirming && (
        <div
          role="dialog"
          aria-label="Retract this record"
          style={{
            display: "grid",
            gap: 8,
            padding: 12,
            borderRadius: "var(--w-r-md)",
            border: `1px solid ${c.danger}`,
            background: "var(--w-danger-wash)",
          }}
        >
          <span style={{ fontSize: t.sm, fontWeight: 650 }}>Retract this record?</span>
          <span style={{ fontSize: t.sm, color: c.text, lineHeight: 1.5 }}>
            Its content is dropped from the room for everyone, and a marker stays in its place with your reason, so every
            member sees it was withdrawn. It is not an erase: anyone who has already opened it may still have what they
            read, and this cannot be undone.
          </span>
          <textarea
            aria-label="Why it is retracted"
            placeholder="Why — shown to the room's members"
            rows={2}
            style={{ ...fieldStyle, resize: "vertical" }}
            value={reason}
            onChange={(e) => setReason(e.target.value)}
          />
          <div style={{ display: "flex", gap: 8 }}>
            <Button
              kind="primary"
              style={{ background: c.danger, borderColor: c.danger }}
              disabled={busy !== null || !reason.trim()}
              onClick={() => void run("retract", { status: "retracted", reason: reason.trim() })}
            >
              {busy === "retract" ? "Retracting…" : "Retract it"}
            </Button>
            <Button kind="quiet" disabled={busy !== null} onClick={() => setConfirming(false)}>
              Keep it
            </Button>
          </div>
        </div>
      )}
      {error && <Note tone="danger">{error}</Note>}
    </div>
  );
}
