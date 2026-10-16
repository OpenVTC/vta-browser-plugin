// Room files in the console — putting one in a room, and getting one out.
//
// The transfer runs in the offscreen document, which alone asks for a file's
// key (`manager/room-files.ts`). What this pane adds is the two things only a
// page can do: hold the click that grants the wallet the host's origin, and
// hand a verified file to the person.
//
// ## The click asks for the host first
//
// The wallet talks to a room's host directly, so it needs that host's origin.
// Chrome grants one only inside a user gesture, and a gesture does not survive
// an `await`. So the endpoint is learnt *before* the click (`prepareRoomFiles`,
// when the records are listed) and the click's first act is the request. Every
// handler below starts with `askForHost` for that reason; do not move anything
// in front of it.
//
// ## What is shown before a download is a claim
//
// A record's name and size are read from a body the console cannot verify — the
// author's signature is checked offscreen, with the file. They are labelled as
// the record's own account until the download finishes, and the saved file's
// name is made safe whatever it says (`safeFileName`).

import { useCallback, useRef, useState } from "react";
import type { HeldRoom } from "@openvtc/pnm-core/rooms";
import { Button, Note } from "../../ui.js";
import { c, t, font } from "../../theme.js";
import { requestOriginPermission } from "../../host-permissions.js";
import type { RoomFilesPrepared } from "../../bridge-protocol.js";
import {
  describeProgress,
  formatBytes,
  getRoomFileIntoConsole,
  putRoomFileFromConsole,
  ROOM_FILE_MAX_BYTES,
  safeFileName,
  type GetResult,
  type RoomFileClaim,
} from "../room-files.js";

/**
 * The click's first act. Resolves `true` when the wallet may reach the host.
 * Must be called synchronously from the handler — see the module comment.
 */
function askForHost(prepared: RoomFilesPrepared): Promise<boolean> {
  return prepared.granted ? Promise.resolve(true) : requestOriginPermission(prepared.endpoint);
}

const REFUSED_HOST =
  "The wallet was not allowed to reach this room's host, so nothing was sent. Files go to " +
  "the host directly, not through your agent.";

/** Hand a verified file to the person, under a name that cannot choose where it lands. */
function save(got: GetResult): void {
  const url = URL.createObjectURL(got.blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = safeFileName(got.file.name);
  a.rel = "noopener";
  document.body.appendChild(a);
  a.click();
  a.remove();
  // The download has its own reference by now; this one only holds memory.
  setTimeout(() => URL.revokeObjectURL(url), 60_000);
}

function Progress({ line }: { line: string | null }) {
  if (!line) return null;
  return <p style={{ margin: 0, fontSize: t.xs, color: c.muted }}>{line}</p>;
}

/**
 * Whether files can be moved at this host at all. Shown once, beside the
 * listing, so the reason is said where the buttons would be.
 */
export function RoomFilesUnavailable({ error }: { error: string }) {
  return (
    <Note>
      Files cannot be moved here from this wallet: {error}. Reading records still works — it
      goes through your agent, not to the host.
    </Note>
  );
}

/** Put a file in the room, as a new record. */
export function PutRoomFile({
  room,
  host,
  prepared,
  onPut,
}: {
  room: HeldRoom;
  host: string;
  prepared: RoomFilesPrepared;
  onPut: () => void;
}) {
  const [file, setFile] = useState<File | null>(null);
  const [title, setTitle] = useState("");
  const [line, setLine] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [done, setDone] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const stop = useRef<AbortController | null>(null);
  const input = useRef<HTMLInputElement | null>(null);

  const tooLarge = file !== null && file.size > ROOM_FILE_MAX_BYTES;

  const put = useCallback(() => {
    if (!file) return;
    const allowed = askForHost(prepared); // first — see the module comment
    const ctl = new AbortController();
    stop.current = ctl;
    setBusy(true);
    setError(null);
    setDone(null);
    setLine(null);
    void (async () => {
      try {
        if (!(await allowed)) throw new Error(REFUSED_HOST);
        const res = await putRoomFileFromConsole(
          { roomId: room.roomId, hostDid: host, ...(room.member !== undefined ? { member: room.member } : {}) },
          file,
          title.trim() ? { title: title.trim() } : {},
          { signal: ctl.signal, onProgress: (p) => setLine(describeProgress(p)) },
        );
        setDone(`${safeFileName(file.name)} is in the room as record ${res.key}, version ${res.version}.`);
        setFile(null);
        setTitle("");
        if (input.current) input.current.value = "";
        onPut();
      } catch (e) {
        setError(e instanceof Error ? e.message : String(e));
      }
      stop.current = null;
      setLine(null);
      setBusy(false);
    })();
  }, [file, title, prepared, room, host, onPut]);

  return (
    <div style={{ display: "grid", gap: 8, paddingTop: 10, borderTop: `1px solid ${c.line}` }}>
      <span style={{ fontSize: t.xs, color: c.muted }}>PUT A FILE IN THIS ROOM</span>
      <div style={{ display: "flex", gap: 8, alignItems: "center", flexWrap: "wrap" }}>
        <input
          ref={input}
          type="file"
          disabled={busy}
          onChange={(e) => {
            setFile(e.target.files?.[0] ?? null);
            setDone(null);
            setError(null);
          }}
          style={{ fontSize: t.sm, color: c.text }}
        />
        <input
          placeholder="Title (optional)"
          value={title}
          disabled={busy}
          onChange={(e) => setTitle(e.target.value)}
          style={{
            flex: "1 1 12rem",
            padding: "6px 9px",
            background: c.ground,
            color: c.text,
            border: `1px solid ${c.line}`,
            borderRadius: "var(--w-r-sm)",
            fontSize: t.sm,
          }}
        />
        {busy ? (
          <Button kind="quiet" onClick={() => stop.current?.abort()}>
            Stop
          </Button>
        ) : (
          <Button kind="primary" disabled={!file || tooLarge} onClick={put}>
            Put the file
          </Button>
        )}
      </div>
      {tooLarge && (
        <Note>
          This file is {formatBytes(file.size)}. The wallet encrypts a whole file in memory
          before sending it, so it takes at most {formatBytes(ROOM_FILE_MAX_BYTES)}; use{" "}
          <code style={{ fontFamily: font.mono }}>pnm rooms file put</code> for this one.
        </Note>
      )}
      <Progress line={line} />
      {!busy && !done && !error && (
        <p style={{ margin: 0, fontSize: t.xs, color: c.faint }}>
          Encrypted in this wallet under a key only the room&rsquo;s members can get, and sent to
          the host. The host stores it without being able to read it; your agent never sees the
          bytes.
        </p>
      )}
      {done && <Note tone="accent">{done}</Note>}
      {error && <Note tone="danger">{error}</Note>}
    </div>
  );
}

/** Get the file a record carries, and hand it over only once it checks out. */
export function GetRoomFile({
  room,
  host,
  prepared,
  recordKey,
  claim,
}: {
  room: HeldRoom;
  host: string;
  prepared: RoomFilesPrepared | null;
  recordKey: string;
  claim: RoomFileClaim;
}) {
  const [line, setLine] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [got, setGot] = useState<GetResult | null>(null);
  const [busy, setBusy] = useState(false);
  const stop = useRef<AbortController | null>(null);

  const get = useCallback(() => {
    if (!prepared) return;
    const allowed = askForHost(prepared); // first — see the module comment
    const ctl = new AbortController();
    stop.current = ctl;
    setBusy(true);
    setError(null);
    setLine(null);
    void (async () => {
      try {
        if (!(await allowed)) throw new Error(REFUSED_HOST);
        const res = await getRoomFileIntoConsole(
          { roomId: room.roomId, hostDid: host, ...(room.member !== undefined ? { member: room.member } : {}) },
          recordKey,
          {
            signal: ctl.signal,
            onProgress: (p) => setLine(describeProgress(p)),
          },
        );
        setGot(res);
        save(res);
      } catch (e) {
        setError(e instanceof Error ? e.message : String(e));
      }
      stop.current = null;
      setLine(null);
      setBusy(false);
    })();
  }, [prepared, room, host, recordKey]);

  const shown = got ? got.file : claim;
  return (
    <div style={{ display: "grid", gap: 8 }}>
      <div style={{ fontSize: t.sm }}>
        {(got?.title ?? claim.title) && <div style={{ fontWeight: 600 }}>{got?.title ?? claim.title}</div>}
        <code style={{ fontFamily: font.mono, fontSize: t.xs, wordBreak: "break-all" }}>
          {safeFileName(shown.name)}
        </code>{" "}
        <span style={{ color: c.muted }}>
          · {formatBytes(shown.size)}
          {shown.mediaType ? ` · ${shown.mediaType}` : ""}
        </span>
      </div>
      {got ? (
        <Note tone="accent">
          Saved. It hashed to the digest its author signed, and the record is signed by{" "}
          <code style={{ fontFamily: font.mono, wordBreak: "break-all" }}>{got.author}</code>. Its
          type is the author&rsquo;s word for it — open it with that in mind.
        </Note>
      ) : (
        <div style={{ display: "flex", gap: 8, alignItems: "center" }}>
          {busy ? (
            <Button kind="quiet" onClick={() => stop.current?.abort()}>
              Stop
            </Button>
          ) : (
            <Button disabled={!prepared} onClick={get}>
              Download the file
            </Button>
          )}
          <Progress line={line} />
        </div>
      )}
      {!got && !busy && !error && (
        <p style={{ margin: 0, fontSize: t.xs, color: c.faint }}>
          Name, size and type are what the record says; nothing has checked them yet. The file
          is saved only after every byte matches the digest its author signed.
        </p>
      )}
      {error && <Note tone="danger">{error}</Note>}
    </div>
  );
}
