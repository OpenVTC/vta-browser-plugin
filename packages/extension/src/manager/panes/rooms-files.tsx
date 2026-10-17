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
//
// ## A preview is chosen by the bytes
//
// Only once verified, and only as a raster image or plain text recognised from
// the bytes themselves (`file-preview.ts`) — never by the type the record
// claims, and never framed, since a `blob:` URL here has the extension's origin.

import { useCallback, useEffect, useRef, useState } from "react";
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
import {
  imageBlob,
  mayPreview,
  previewKind,
  textOf,
  TEXT_PREVIEW_MAX_CHARS,
  worthAutoPreview,
} from "../file-preview.js";
import { createLimiter } from "../limit.js";

/**
 * The click's first act. Resolves `true` when the wallet may reach the host.
 * Must be called synchronously from the handler — see the module comment.
 */
function askForHost(prepared: RoomFilesPrepared): Promise<boolean> {
  return prepared.granted ? Promise.resolve(true) : requestOriginPermission(prepared.endpoint);
}

/** Thumbnails fetched unasked: one at a time, so a click's download is not stuck behind them. */
const THUMBNAILS = createLimiter(1);

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

/** What a fetched file is shown as: a picture, its text, or nothing but a download. */
type Shown =
  | { kind: "image"; url: string }
  | { kind: "text"; text: string; cut: boolean }
  | { kind: "none" };

/** A full-size picture over the console. Escape, the backdrop or Close dismisses it. */
function Enlarged({ url, name, onClose }: { url: string; name: string; onClose: () => void }) {
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") onClose();
    };
    addEventListener("keydown", onKey);
    return () => removeEventListener("keydown", onKey);
  }, [onClose]);
  return (
    <div
      role="dialog"
      aria-label={name}
      onClick={onClose}
      style={{
        position: "fixed",
        inset: 0,
        zIndex: 50,
        background: "rgba(10, 12, 18, 0.82)",
        display: "grid",
        placeItems: "center",
        padding: 24,
        cursor: "zoom-out",
      }}
    >
      <img src={url} alt={name} style={{ maxWidth: "92vw", maxHeight: "86vh", objectFit: "contain", borderRadius: 4 }} />
      <span style={{ color: "#e8ebf2", fontSize: t.sm, marginTop: 10 }}>{name} — click anywhere or press Escape to close</span>
    </div>
  );
}

/**
 * Get the file a record carries, and hand it over only once it checks out.
 *
 * One verified fetch serves both a preview and a download: the bytes reach this
 * page only after the offscreen document has matched every one against the
 * digest the author signed, and a preview is chosen from those bytes, never
 * from the record's claimed type (`file-preview.ts`). `autoPreview` fetches a
 * small picture without a click, and only where the host is already allowed —
 * the permission itself is only ever asked for in a click.
 */
export function GetRoomFile({
  room,
  host,
  prepared,
  recordKey,
  claim,
  showTitle = true,
  autoPreview = false,
}: {
  room: HeldRoom;
  host: string;
  prepared: RoomFilesPrepared | null;
  recordKey: string;
  claim: RoomFileClaim;
  /** Off where the record's title is already the heading above. */
  showTitle?: boolean;
  /** Fetch a small picture's thumbnail without being asked (`worthAutoPreview`). */
  autoPreview?: boolean;
}) {
  const [line, setLine] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [got, setGot] = useState<GetResult | null>(null);
  const [saved, setSaved] = useState(false);
  const [shown, setShown] = useState<Shown | null>(null);
  const [enlarged, setEnlarged] = useState(false);
  const [busy, setBusy] = useState(false);
  const [auto, setAuto] = useState(false);
  const stop = useRef<AbortController | null>(null);

  // Leaving the room stops a transfer nobody is waiting for.
  useEffect(() => () => stop.current?.abort(), []);

  // A picture's URL holds its bytes in memory until revoked.
  useEffect(() => {
    if (shown?.kind !== "image") return;
    const url = shown.url;
    return () => URL.revokeObjectURL(url);
  }, [shown]);

  const show = useCallback(async (res: GetResult) => {
    const bytes = new Uint8Array(await res.blob.arrayBuffer());
    const kind = previewKind(bytes);
    if (kind === null) setShown({ kind: "none" });
    else if (kind === "text") {
      const text = textOf(bytes) ?? "";
      setShown({ kind: "text", text: text.slice(0, TEXT_PREVIEW_MAX_CHARS), cut: text.length > TEXT_PREVIEW_MAX_CHARS });
    } else setShown({ kind: "image", url: URL.createObjectURL(imageBlob(bytes, kind)) });
  }, []);

  /** Fetch the verified file once; `then` says what the person asked for. */
  const run = useCallback(
    (then: "save" | "preview", allowed: Promise<boolean>, queued = false) => {
      if (got) {
        if (then === "save") {
          save(got);
          setSaved(true);
        } else void show(got);
        return;
      }
      const ctl = new AbortController();
      stop.current = ctl;
      setBusy(true);
      setError(null);
      setLine(null);
      void (async () => {
        try {
          if (!(await allowed)) throw new Error(REFUSED_HOST);
          const fetchIt = () =>
            getRoomFileIntoConsole(
              { roomId: room.roomId, hostDid: host, ...(room.member !== undefined ? { member: room.member } : {}) },
              recordKey,
              {
                signal: ctl.signal,
                onProgress: (p) => setLine(describeProgress(p)),
              },
            );
          const res = await (queued ? THUMBNAILS.run(fetchIt) : fetchIt());
          setGot(res);
          if (then === "save") {
            save(res);
            setSaved(true);
          }
          await show(res);
        } catch (e) {
          // A transfer stopped because its row was left, or its effect was
          // re-run (React's development double mount), is not a failure, and
          // must not overwrite what the run that replaced it says.
          if (ctl.signal.aborted && stop.current !== ctl) return;
          setError(e instanceof Error ? e.message : String(e));
        }
        if (stop.current !== ctl) return;
        stop.current = null;
        setLine(null);
        setBusy(false);
      })();
    },
    [got, show, room, host, recordKey],
  );

  // The click's first act is the permission request — see the module comment.
  const download = () => prepared && run("save", askForHost(prepared));
  const preview = () => prepared && run("preview", askForHost(prepared));

  const started = useRef(false);
  useEffect(() => {
    if (started.current || !autoPreview || !prepared?.granted || !worthAutoPreview(claim)) return;
    started.current = true;
    setAuto(true);
    run("preview", Promise.resolve(true), true);
    // Undone with the effect, so a re-run starts it again rather than finding
    // it marked started and aborted.
    return () => {
      if (stop.current) {
        const ctl = stop.current;
        stop.current = null;
        ctl.abort();
      }
      started.current = false;
    };
    // Keyed on the claim's fields, not the object: the record row parses a new
    // one every render, and re-running this would abort the fetch each time.
    // `run` changes when the fetch lands (`got`), which must not re-run it either.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [autoPreview, prepared?.granted, claim.name, claim.size, claim.mediaType]);

  const file = got ? got.file : claim;
  const name = safeFileName(file.name);
  return (
    <div style={{ display: "grid", gap: 8 }}>
      <div style={{ fontSize: t.sm }}>
        {showTitle && (got?.title ?? claim.title) && <div style={{ fontWeight: 600 }}>{got?.title ?? claim.title}</div>}
        <code style={{ fontFamily: font.mono, fontSize: t.xs, wordBreak: "break-all" }}>{name}</code>{" "}
        <span style={{ color: c.muted }}>
          · {formatBytes(file.size)}
          {file.mediaType ? ` · ${file.mediaType}` : ""}
        </span>
      </div>

      {/* Held at a thumbnail's size while it loads, so the list does not jump. */}
      {auto && busy && !shown && (
        <div
          aria-label="Loading a preview"
          style={{
            width: 220,
            height: 140,
            borderRadius: "var(--w-r-sm)",
            border: `1px solid ${c.line}`,
            background: c.raised,
            display: "grid",
            placeItems: "center",
            fontSize: t.xs,
            color: c.faint,
          }}
        >
          Loading preview…
        </div>
      )}
      {shown?.kind === "image" && (
        <button
          onClick={() => setEnlarged(true)}
          aria-label={`Show ${name} full size`}
          style={{ all: "unset", cursor: "zoom-in", justifySelf: "start" }}
        >
          <img
            src={shown.url}
            alt={name}
            decoding="async"
            style={{
              display: "block",
              maxWidth: "min(100%, 520px)",
              maxHeight: 260,
              objectFit: "contain",
              borderRadius: "var(--w-r-sm)",
              border: `1px solid ${c.line}`,
              background: c.raised,
            }}
          />
        </button>
      )}
      {shown?.kind === "image" && enlarged && <Enlarged url={shown.url} name={name} onClose={() => setEnlarged(false)} />}
      {shown?.kind === "text" && (
        <pre
          style={{
            margin: 0,
            maxHeight: 280,
            overflow: "auto",
            padding: 10,
            background: c.ground,
            border: `1px solid ${c.line}`,
            borderRadius: "var(--w-r-sm)",
            fontFamily: font.mono,
            fontSize: t.xs,
            whiteSpace: "pre-wrap",
            wordBreak: "break-word",
          }}
        >
          {shown.text}
          {shown.cut ? "\n…" : ""}
        </pre>
      )}
      {shown?.kind === "none" && (
        <span style={{ fontSize: t.xs, color: c.muted }}>
          No preview for this kind of file. Download it to open it.
        </span>
      )}

      <div style={{ display: "flex", gap: 8, alignItems: "center", flexWrap: "wrap" }}>
        {busy ? (
          <Button kind="quiet" onClick={() => stop.current?.abort()}>
            Stop
          </Button>
        ) : (
          <>
            <Button disabled={!prepared} onClick={download}>
              {saved ? "Download again" : "Download"}
            </Button>
            {!shown && mayPreview(claim) && (
              <Button kind="quiet" disabled={!prepared} onClick={preview}>
                Preview
              </Button>
            )}
          </>
        )}
        <Progress line={line} />
      </div>

      {got ? (
        saved ? (
          <Note tone="accent">
            Saved. It hashed to the digest its author signed, and the record is signed by{" "}
            <code style={{ fontFamily: font.mono, wordBreak: "break-all" }}>{got.author}</code>. Its
            type is the author&rsquo;s word for it — open it with that in mind.
          </Note>
        ) : (
          <span style={{ fontSize: t.xs, color: c.ok }}>
            ✓ Every byte matches the digest its author signed.
          </span>
        )
      ) : (
        !busy &&
        !error && (
          <p style={{ margin: 0, fontSize: t.xs, color: c.faint }}>
            Name, size and type are what the record says; nothing has checked them yet. A preview or a download
            happens only after every byte matches the digest its author signed.
          </p>
        )
      )}
      {error && <Note tone="danger">{error}</Note>}
    </div>
  );
}
