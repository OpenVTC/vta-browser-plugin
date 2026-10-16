/// <reference types="chrome" />

// Room files — the offscreen document's half. See `ROOM_FILES_PORT` in
// `bridge-protocol.ts` for the protocol and `@openvtc/pnm-core/rooms/files` for
// the flow itself.
//
// ## Why here and only here
//
// A file's key is material that never expires: whoever holds it opens that
// file's ciphertext for as long as the ciphertext exists. This document is the
// one context the extension owns that is not a page, so it is where the key is
// asked for, used and dropped. The console sends intents and bytes and gets back
// progress and plaintext — never a key, a presentation or a host reply.
// Everything that names `rooms/keys/file-key` is imported from this module,
// which only `offscreen.ts` imports, and CI holds the built bundles to that.
//
// The cipher (`@openvtc/vti-rooms-wasm`, ~2.6 MB of wasm) is loaded on the
// first transfer rather than with the document, which starts on every wake.

import {
  getRoomFile,
  putRoomFile,
  RoomHostChannel,
  roomHostEndpoint,
  ROOM_FILE_MAX_BYTES,
  type RoomFileCipher,
  type RoomFileContext,
} from "@openvtc/pnm-core/rooms/files";
import type { SigningIdentity, TrustTaskSender } from "@openvtc/pnm-core";
import type { CompletedDocumentSender } from "@openvtc/pnm-core/rooms";
import { base64url } from "@openvtc/vti-didcomm-js";

import {
  ROOM_FILES_PORT,
  type RoomFilesMessage,
  type RoomFilesOpen,
  type RoomFilesUpload,
} from "./bridge-protocol.js";

export interface RoomFilesDeps {
  /** The agent's session and the wallet's signing identity for it. */
  agent(vtaDid: string, restBaseUrl?: string): Promise<{ sender: TrustTaskSender; signing: SigningIdentity }>;
  /** Whether the port was opened by one of this extension's own pages. */
  fromExtensionPage(port: chrome.runtime.Port): boolean;
  /** The channels to the room's host: one for documents the member's VTA
   *  completed, one per upload key. Defaults to HTTPS at the endpoint the host's
   *  DID document names; replaced only by tests. */
  host?(hostDid: string): Promise<RoomHostChannels>;
}

/** What `run` sends to the host on: completed documents, and an upload key's own. */
export interface RoomHostChannels {
  completed: CompletedDocumentSender;
  signedBy(key: SigningIdentity): TrustTaskSender;
}

async function hostChannels(hostDid: string): Promise<RoomHostChannels> {
  const endpoint = await roomHostEndpoint(hostDid);
  return {
    completed: new RoomHostChannel({ hostDid, endpoint }),
    signedBy: (signing) => new RoomHostChannel({ hostDid, endpoint, signing }),
  };
}

let cipherLoad: Promise<RoomFileCipher> | undefined;

function loadCipher(): Promise<RoomFileCipher> {
  cipherLoad ??= import("@openvtc/vti-rooms-wasm").then(
    (m) => m as unknown as RoomFileCipher,
    (e: unknown) => {
      // Not cached: a load that failed once (a torn-down document mid-fetch)
      // should be retried by the next transfer, not remembered.
      cipherLoad = undefined;
      throw e;
    },
  );
  return cipherLoad;
}

/** The host's dispatcher URL — for the background's permission check. */
export function resolveRoomHostEndpoint(hostDid: string): Promise<string> {
  return roomHostEndpoint(hostDid);
}

/** Listen for transfers. Call once, at document start. */
export function installRoomFilesPort(deps: RoomFilesDeps): void {
  chrome.runtime.onConnect.addListener((port) => {
    if (port.name !== ROOM_FILES_PORT) return;
    if (!deps.fromExtensionPage(port)) {
      console.warn(`[room files] refusing a transfer port from ${port.sender?.url}`);
      port.disconnect();
      return;
    }
    serveRoomFilesPort(port, deps);
  });
}

/** Run one transfer over `port`. Exported for tests; `installRoomFilesPort` gates the port first. */
export function serveRoomFilesPort(port: chrome.runtime.Port, deps: RoomFilesDeps): void {
  const abort = new AbortController();
  let open = true;
  const post = (m: RoomFilesMessage) => {
    if (!open) return;
    try {
      port.postMessage(m);
    } catch {
      // Nobody is reading; stop rather than finish a transfer for no one.
      open = false;
      abort.abort();
    }
  };
  // Registered before anything awaits: Chrome does not replay a disconnect to a
  // listener added later, and an upload nobody is waiting for must still
  // release what the host reserved.
  port.onDisconnect.addListener(() => {
    // Read so Chrome does not log it as unchecked.
    void globalThis.chrome?.runtime?.lastError;
    open = false;
    abort.abort();
  });
  const finish = (m: RoomFilesMessage) => {
    post(m);
    if (open) {
      open = false;
      port.disconnect();
    }
  };
  const fail = (e: unknown) => {
    const code = (e as { code?: unknown })?.code;
    finish({
      kind: "failed",
      error: e instanceof Error ? e.message : String(e),
      ...(typeof code === "string" ? { code } : {}),
    });
  };

  let upload: { into: Uint8Array; filled: number; begin: RoomFilesOpen & { kind: "put" } } | undefined;
  let started = false;

  port.onMessage.addListener((raw: unknown) => {
    const msg = raw as RoomFilesOpen | RoomFilesUpload;
    try {
      if (!started) {
        started = true;
        if (msg.kind === "get") {
          void run(deps, msg, abort.signal, post).then(finish, fail);
        } else if (msg.kind === "put") {
          // Allocated once, at the size declared, so a console that sends more
          // than it said is refused rather than grown into.
          if (!Number.isSafeInteger(msg.size) || msg.size < 0 || msg.size > ROOM_FILE_MAX_BYTES) {
            throw new Error(`a file of ${msg.size} bytes is not one this wallet seals (at most ${ROOM_FILE_MAX_BYTES})`);
          }
          upload = { into: new Uint8Array(msg.size), filled: 0, begin: msg };
        } else {
          throw new Error("a transfer starts with put or get");
        }
        return;
      }
      if (!upload) throw new Error("only an upload takes data");
      if (msg.kind === "data") {
        const bytes = base64url.decode(msg.data);
        if (upload.filled + bytes.length > upload.into.length) throw new Error("more bytes than the file was declared to hold");
        upload.into.set(bytes, upload.filled);
        upload.filled += bytes.length;
      } else if (msg.kind === "end") {
        if (upload.filled !== upload.into.length) {
          throw new Error(`the file ended after ${upload.filled} of ${upload.into.length} bytes`);
        }
        const { begin, into } = upload;
        upload = undefined;
        void run(deps, begin, abort.signal, post, into).then(finish, fail);
      }
    } catch (e) {
      upload = undefined;
      fail(e);
    }
  });
}

async function run(
  deps: RoomFilesDeps,
  open: RoomFilesOpen,
  signal: AbortSignal,
  post: (m: RoomFilesMessage) => void,
  bytes?: Uint8Array,
): Promise<RoomFilesMessage> {
  const [{ sender: vtaSender, signing }, cipher] = await Promise.all([
    deps.agent(open.vtaDid, open.restBaseUrl),
    loadCipher(),
  ]);
  const host = await (deps.host ?? hostChannels)(open.hostDid);
  const ctx: RoomFileContext = {
    roomId: open.roomId,
    // The wallet asks its VTA; the VTA acts as the member. The wallet's own DID
    // reaches no host.
    holder: { did: signing.did },
    vta: { did: open.vtaDid, sender: vtaSender },
    host: { did: open.hostDid, sender: host.completed },
    uploadChannel: host.signedBy,
    cipher,
    onProgress: (p) => post({ kind: "progress", ...p }),
    signal,
  };
  if (open.kind === "put") {
    const put = await putRoomFile(ctx, {
      name: open.name,
      bytes: bytes!,
      ...(open.mediaType !== undefined ? { mediaType: open.mediaType } : {}),
      ...(open.title !== undefined ? { title: open.title } : {}),
      ...(open.description !== undefined ? { description: open.description } : {}),
      ...(open.tags !== undefined ? { tags: open.tags } : {}),
      ...(open.padme !== undefined ? { padme: open.padme } : {}),
    });
    return { kind: "put", ...put };
  }
  const got = await getRoomFile(ctx, open.key, (provisional) =>
    post({ kind: "provisional", data: base64url.encode(provisional) }),
  );
  return {
    kind: "got",
    file: {
      name: got.file.name,
      size: got.file.size,
      ...(got.file.mediaType !== undefined ? { mediaType: got.file.mediaType } : {}),
    },
    author: got.author,
    version: got.version,
    ...(got.title !== undefined ? { title: got.title } : {}),
    ...(got.description !== undefined ? { description: got.description } : {}),
    ...(got.tags !== undefined ? { tags: got.tags } : {}),
  };
}
