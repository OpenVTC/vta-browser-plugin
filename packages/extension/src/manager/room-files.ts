/// <reference types="chrome" />

// Room files — the console's half.
//
// The console never holds a file key, a presentation or a host's reply. It
// asks the offscreen document to put a file or get one, sends the bytes or
// receives them, and shows progress. See `ROOM_FILES_PORT` in
// `bridge-protocol.ts`.
//
// ## Using it from a pane
//
//  1. When the pane learns the host, `prepareRoomFiles(hostDid)` — the host's
//     endpoint, and whether the wallet may reach it.
//  2. In the click, **first**, `requestOriginPermission(prepared.endpoint)` when
//     `!prepared.granted`. Nothing may be awaited before it, or the gesture is
//     spent (see `host-permissions.ts`).
//  3. `putRoomFileFromConsole` / `getRoomFileIntoConsole`. Each prepares again
//     before connecting, so a document that went away meanwhile is started.
//
// ## A download is released only once it is verified
//
// Pieces arrive as they open, before the whole file has hashed to its author's
// digest. They are kept here, out of the pane's reach, and become a `Blob` only
// when the offscreen document reports the file verified. Anything else — a
// failure, a closed port, an abort — and they are dropped. A pane cannot hand a
// half-checked file to the user because it is never given one.

import { base64url } from "@openvtc/vti-didcomm-js";

import {
  ROOM_FILES_PORT,
  RUNTIME_ROOM_FILES_PREPARE,
  type RoomFilesMessage,
  type RoomFilesOpen,
  type RoomFilesPrepared,
  type RoomFilesUpload,
  type RuntimeRoomFilesPrepareResponse,
} from "../bridge-protocol.js";
import { sendToBackground } from "../send-message.js";

/**
 * The largest file the wallet seals in one piece. Core's `ROOM_FILE_MAX_BYTES`,
 * restated rather than imported: that module also names the file-key task, and
 * importing it here would put that task in the console's bundle. A test pins
 * the two together.
 */
export const ROOM_FILE_MAX_BYTES = 64 * 1024 * 1024;

/** How much of a file goes in one port message. */
const SLICE_BYTES = 192 * 1024;

export class RoomFilesError extends Error {
  constructor(
    message: string,
    readonly code?: string,
  ) {
    super(message);
    this.name = "RoomFilesError";
  }
}

export async function prepareRoomFiles(hostDid: string): Promise<RoomFilesPrepared> {
  const reply = await sendToBackground<RuntimeRoomFilesPrepareResponse>({ type: RUNTIME_ROOM_FILES_PREPARE, hostDid });
  if (!reply.ok) throw new RoomFilesError(reply.error);
  return reply.result;
}

export type RoomFilesProgress = Extract<RoomFilesMessage, { kind: "progress" }>;

export interface RoomFileTarget {
  roomId: string;
  hostDid: string;
}

export interface TransferOptions {
  onProgress?: (p: RoomFilesProgress) => void;
  signal?: AbortSignal;
  /** Replaced only by tests. */
  connect?: () => chrome.runtime.Port;
  /** Replaced only by tests. */
  prepare?: (hostDid: string) => Promise<RoomFilesPrepared>;
}

export type PutResult = Omit<Extract<RoomFilesMessage, { kind: "put" }>, "kind">;
export type GetResult = Omit<Extract<RoomFilesMessage, { kind: "got" }>, "kind"> & {
  /** The verified plaintext. Typed `application/octet-stream` whatever the
   *  author said: the media type is another member's claim, and a console that
   *  rendered by it would let that member choose how their file is handled. */
  blob: Blob;
};

/**
 * Run one transfer: connect, send `open` (and then `upload`, if any), and
 * settle on the first terminal message. `onTerminal` turns that message into a
 * result; a `failed`, a disconnect or an abort rejects.
 */
function transfer<T>(
  open: RoomFilesOpen,
  opts: TransferOptions,
  onMessage: (m: RoomFilesMessage) => T | undefined,
  upload?: (post: (m: RoomFilesUpload) => void) => Promise<void>,
): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const port = (opts.connect ?? (() => chrome.runtime.connect({ name: ROOM_FILES_PORT })))();
    let settled = false;
    const settle = (fn: () => void) => {
      if (settled) return;
      settled = true;
      opts.signal?.removeEventListener("abort", onAbort);
      fn();
      try {
        port.disconnect();
      } catch {
        /* already gone */
      }
    };
    const onAbort = () => settle(() => reject(new RoomFilesError("stopped", "aborted")));
    if (opts.signal?.aborted) return onAbort();
    opts.signal?.addEventListener("abort", onAbort);

    port.onMessage.addListener((raw: unknown) => {
      const m = raw as RoomFilesMessage;
      if (settled) return;
      if (m.kind === "progress") {
        opts.onProgress?.(m);
        return;
      }
      if (m.kind === "failed") {
        settle(() => reject(new RoomFilesError(m.error, m.code)));
        return;
      }
      try {
        const done = onMessage(m);
        if (done !== undefined) settle(() => resolve(done));
      } catch (e) {
        settle(() => reject(e));
      }
    });
    port.onDisconnect.addListener(() => {
      void globalThis.chrome?.runtime?.lastError;
      settle(() => reject(new RoomFilesError("the wallet's background document closed before the transfer finished")));
    });

    port.postMessage(open);
    if (upload) {
      upload((m) => {
        if (!settled) port.postMessage(m);
      }).catch((e: unknown) => settle(() => reject(e)));
    }
  });
}

/** Put `file` in the room as a new record. */
export async function putRoomFileFromConsole(
  target: RoomFileTarget,
  file: Blob & { name?: string },
  meta: { name?: string; title?: string; description?: string; tags?: string[]; padme?: boolean },
  opts: TransferOptions = {},
): Promise<PutResult> {
  if (file.size > ROOM_FILE_MAX_BYTES) {
    throw new RoomFilesError(
      `this file is ${file.size} bytes; the wallet seals at most ${ROOM_FILE_MAX_BYTES}. Use \`pnm rooms file put\` for larger files.`,
      "tooLarge",
    );
  }
  const prepared = await (opts.prepare ?? prepareRoomFiles)(target.hostDid);
  const name = meta.name ?? file.name ?? "file";
  const open: RoomFilesOpen = {
    kind: "put",
    vtaDid: prepared.vtaDid,
    ...(prepared.restBaseUrl ? { restBaseUrl: prepared.restBaseUrl } : {}),
    roomId: target.roomId,
    hostDid: target.hostDid,
    name,
    size: file.size,
    ...(file.type ? { mediaType: file.type } : {}),
    ...(meta.title !== undefined ? { title: meta.title } : {}),
    ...(meta.description !== undefined ? { description: meta.description } : {}),
    ...(meta.tags !== undefined ? { tags: meta.tags } : {}),
    ...(meta.padme !== undefined ? { padme: meta.padme } : {}),
  };
  return transfer<PutResult>(
    open,
    opts,
    (m) => (m.kind === "put" ? { key: m.key, version: m.version, blobRef: m.blobRef, size: m.size } : undefined),
    async (post) => {
      for (let at = 0; at < file.size; at += SLICE_BYTES) {
        const slice = new Uint8Array(await file.slice(at, at + SLICE_BYTES).arrayBuffer());
        post({ kind: "data", data: base64url.encode(slice) });
      }
      post({ kind: "end" });
    },
  );
}

/** Get the file a record carries. Resolves only with a verified file. */
export async function getRoomFileIntoConsole(
  target: RoomFileTarget,
  key: string,
  opts: TransferOptions = {},
): Promise<GetResult> {
  const prepared = await (opts.prepare ?? prepareRoomFiles)(target.hostDid);
  const open: RoomFilesOpen = {
    kind: "get",
    vtaDid: prepared.vtaDid,
    ...(prepared.restBaseUrl ? { restBaseUrl: prepared.restBaseUrl } : {}),
    roomId: target.roomId,
    hostDid: target.hostDid,
    key,
  };
  // Provisional until `got`. Held here, never handed out, dropped on failure.
  let pieces: Uint8Array[] = [];
  let received = 0;
  try {
    return await transfer<GetResult>(open, opts, (m) => {
      if (m.kind === "provisional") {
        const piece = base64url.decode(m.data);
        received += piece.length;
        pieces.push(piece);
        return undefined;
      }
      if (m.kind !== "got") return undefined;
      if (received !== m.file.size) {
        throw new RoomFilesError(`the wallet reported ${m.file.size} bytes verified but delivered ${received}`);
      }
      const { kind: _kind, ...rest } = m;
      return { ...rest, blob: new Blob(pieces as BlobPart[], { type: "application/octet-stream" }) };
    });
  } finally {
    pieces = [];
  }
}

/**
 * What an opened record body says about the file it carries, if it carries one.
 *
 * Read from the text `rooms/keys/read` returned, which the console has not
 * verified and cannot: the signature check lives with the file key, offscreen.
 * So this is a **claim**, good for offering a download and nothing else. The
 * name and size shown after a download come from the offscreen document's
 * verified answer, not from here.
 */
export interface RoomFileClaim {
  name: string;
  size: number;
  mediaType?: string;
  title?: string;
}

export function roomFileClaimOf(bodyText: string): RoomFileClaim | null {
  let parsed: unknown;
  try {
    parsed = JSON.parse(bodyText);
  } catch {
    return null;
  }
  if (typeof parsed !== "object" || parsed === null) return null;
  const { file, title } = parsed as { file?: unknown; title?: unknown };
  if (typeof file !== "object" || file === null) return null;
  const { name, size, mediaType, blobRef } = file as Record<string, unknown>;
  if (typeof name !== "string" || typeof blobRef !== "string") return null;
  if (typeof size !== "number" || !Number.isSafeInteger(size) || size < 0) return null;
  return {
    name,
    size,
    ...(typeof mediaType === "string" ? { mediaType } : {}),
    ...(typeof title === "string" ? { title } : {}),
  };
}

const STAGE_WORDS: Record<string, string> = {
  presenting: "Asking your agent for this room's credentials",
  checking: "Checking the room takes files",
  sealing: "Encrypting",
  uploading: "Uploading",
  writing: "Writing the record",
  reading: "Reading the record",
  downloading: "Downloading",
  verifying: "Checking it against its author's digest",
};

/** One line saying where a transfer has got to. */
export function describeProgress(p: { stage: string; done?: number; total?: number }): string {
  const words = STAGE_WORDS[p.stage] ?? p.stage;
  return p.done !== undefined && p.total !== undefined && p.total > 0
    ? `${words} — ${p.done} of ${p.total}`
    : `${words}…`;
}

/** Bytes for a person: 0 B, 12.3 KiB, 4.0 MiB. */
export function formatBytes(n: number): string {
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KiB`;
  return `${(n / (1024 * 1024)).toFixed(1)} MiB`;
}

/**
 * A local file name from one another member chose: its last path component,
 * without leading dots or control characters, never empty. The same rule as
 * `pnm rooms file get` (`local_name`).
 */
export function safeFileName(untrusted: string): string {
  const parts = untrusted.split(/[/\\]/);
  const base = (parts[parts.length - 1] ?? "").replace(/^\.+/, "");
  // eslint-disable-next-line no-control-regex
  const clean = base.replace(/[\n\t]/g, " ").replace(/[\u0000-\u001f\u007f-\u009f]/g, "");
  return clean.trim() === "" ? "room-file" : clean;
}
