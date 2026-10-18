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
// - **Each action is its own grant.** Editing needs `write`; retracting and
//   archiving need `curate`, which `write` does not imply. Where the agent said
//   what the place holds (`HeldRoom.actions`), an action it lacks is shown as
//   such rather than offered; where it said nothing, it is offered and the host
//   decides. The host decides either way.
// - **An edit never silently undoes someone else's.** It names the version the
//   member read, and the host refuses it if anything has replaced the record
//   since.

import { useState } from "react";
import type { HeldRoom } from "@openvtc/pnm-core/rooms";
import { Button, Note } from "../../ui.js";
import { c, t } from "../../theme.js";
import { curateRoomRecord, writeRoomNote } from "../room-files.js";

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
  room: HeldRoom;
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
  room: HeldRoom;
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
        {standing === "deprecated" ? (
          <Button
            disabled={curate === false || busy !== null}
            title={curate === false ? missing("curate") : ""}
            onClick={() => void run("restore", { status: "active" })}
          >
            {busy === "restore" ? "Restoring…" : "Restore"}
          </Button>
        ) : (
          <Button
            disabled={curate === false || busy !== null}
            title={curate === false ? missing("curate") : "Kept, and marked as no longer current"}
            onClick={() => void run("archive", { status: "deprecated" })}
          >
            {busy === "archive" ? "Archiving…" : "Archive"}
          </Button>
        )}
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
