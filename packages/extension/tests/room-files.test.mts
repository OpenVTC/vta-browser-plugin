// Room files across the console ↔ offscreen port.
//
// The flow itself — seal, upload, write, read, open, verify — is tested in core
// against the real cipher (`packages/core/tests/rooms.file-engine.mjs`). What is
// pinned here is the boundary: a download reaches a pane only once it is
// verified, and is dropped otherwise; an upload is held to the size it
// declared; and a name another member chose cannot choose where a file lands.

import test from "node:test";
import assert from "node:assert/strict";

import {
  describeProgress,
  formatBytes,
  getRoomFileIntoConsole,
  putRoomFileFromConsole,
  ROOM_FILE_MAX_BYTES,
  roomFileClaimOf,
  safeFileName,
} from "../src/manager/room-files.ts";
import { serveRoomFilesPort } from "../src/room-files-offscreen.ts";
import { ROOM_FILE_MAX_BYTES as CORE_MAX } from "@openvtc/pnm-core/rooms/files";

const TARGET = { roomId: "did:webvh:QmRoom:rooms.example", hostDid: "did:webvh:QmHost:host.example" };
const PREPARED = async () => ({ endpoint: "https://host.example/v1/trust-tasks", granted: true, vtaDid: "did:webvh:QmAgent:agent.example" });
const b64u = (bytes: Uint8Array) => Buffer.from(bytes).toString("base64url");

type Listener = (m: unknown) => void;

/** Two ends of a `chrome.runtime.Port`, as Chrome links them: a message posted on one
 *  arrives (as JSON) on the other, and a disconnect is heard only by the other end. */
function portPair() {
  const end = () => {
    const msg: Listener[] = [];
    const disc: Array<() => void> = [];
    const port = {
      name: "vta-wallet/room-files",
      sender: { url: "chrome-extension://wallet/manager.html" },
      connected: true,
      /** This end called `disconnect` itself, and so hears nothing more. */
      hungUp: false,
      other: undefined as unknown as ReturnType<typeof end>,
      posted: [] as unknown[],
      onMessage: { addListener: (f: Listener) => msg.push(f), removeListener: () => undefined },
      onDisconnect: { addListener: (f: () => void) => disc.push(f) },
      postMessage(m: unknown) {
        if (!port.connected) throw new Error("Attempting to use a disconnected port object");
        port.posted.push(m);
        const copy = JSON.parse(JSON.stringify(m));
        // Delivered even if this end hangs up next: Chrome keeps the order, a
        // message before the disconnect.
        queueMicrotask(() => !port.other.hungUp && port.other.fire(copy));
      },
      disconnect() {
        if (!port.connected) return;
        port.connected = false;
        port.hungUp = true;
        port.other.connected = false;
        queueMicrotask(() => port.other.hangUp());
      },
      fire: (m: unknown) => msg.forEach((f) => f(m)),
      hangUp: () => disc.forEach((f) => f()),
    };
    return port;
  };
  const a = end();
  const b = end();
  a.other = b;
  b.other = a;
  return { console: a, offscreen: b };
}

/** Wait until the offscreen end has received `n` messages. */
async function received(end: { posted: unknown[] }, other: { posted: unknown[] }, n: number) {
  for (let i = 0; i < 100 && other.posted.length < n; i++) await new Promise((r) => setTimeout(r, 1));
  return end;
}

// ── names ───────────────────────────────────────────────────────────────────

test("a file name chosen by another member cannot leave the directory or hide", () => {
  assert.equal(safeFileName("../../etc/passwd"), "passwd");
  assert.equal(safeFileName("C:\\Users\\x\\evil.exe"), "evil.exe");
  assert.equal(safeFileName(".bashrc"), "bashrc");
  assert.equal(safeFileName("term sheet.pdf"), "term sheet.pdf");
  assert.equal(safeFileName("../"), "room-file");
  assert.equal(safeFileName("a\nb.txt"), "a b.txt");
  assert.equal(safeFileName("a\u001b[2Jb.txt"), "a[2Jb.txt");
});

test("the console's ceiling is core's", () => {
  assert.equal(ROOM_FILE_MAX_BYTES, CORE_MAX);
});

// ── what a record says it carries ─────────────────────────────────────────

const signedBody = (file: unknown, extra: Record<string, unknown> = {}) =>
  JSON.stringify({ roomId: "r", key: "k", version: 2, author: "did:key:zA", ...extra, file, proof: { type: "DataIntegrityProof" } });

test("an opened file record is offered as a file, by what it claims", () => {
  const claim = roomFileClaimOf(
    signedBody({ fileId: "f", name: "term sheet.pdf", mediaType: "application/pdf", size: 1234, blobRef: "zRef" }, { title: "Terms" }),
  );
  assert.deepEqual(claim, { name: "term sheet.pdf", size: 1234, mediaType: "application/pdf", title: "Terms" });
});

test("a record that is not a file, or claims one badly, is shown as a record", () => {
  assert.equal(roomFileClaimOf("plain text"), null);
  assert.equal(roomFileClaimOf(JSON.stringify({ body: "hi" })), null);
  assert.equal(roomFileClaimOf("null"), null);
  assert.equal(roomFileClaimOf(signedBody({ name: "a", size: 1 })), null, "no blob to fetch");
  assert.equal(roomFileClaimOf(signedBody({ name: "a", size: -1, blobRef: "z" })), null);
  assert.equal(roomFileClaimOf(signedBody({ name: "a", size: 1.5, blobRef: "z" })), null);
  assert.equal(roomFileClaimOf(signedBody({ name: 7, size: 1, blobRef: "z" })), null);
});

test("progress and sizes read as words", () => {
  assert.equal(describeProgress({ stage: "uploading", done: 3, total: 9 }), "Uploading — 3 of 9");
  assert.equal(describeProgress({ stage: "sealing" }), "Encrypting…");
  assert.equal(describeProgress({ stage: "somethingNew" }), "somethingNew…");
  assert.equal(formatBytes(512), "512 B");
  assert.equal(formatBytes(1536), "1.5 KiB");
  assert.equal(formatBytes(ROOM_FILE_MAX_BYTES), "64.0 MiB");
});

// ── a download is released only once verified ──────────────────────────────

/** Script the offscreen end: answer the `get` with `replies`, then hang up. */
function scriptedGet(replies: unknown[], hangUp = true) {
  const pair = portPair();
  pair.offscreen.onMessage.addListener(() => {
    for (const r of replies) pair.offscreen.postMessage(r);
    if (hangUp) pair.offscreen.disconnect();
  });
  return pair;
}

const GOT = (size: number) => ({
  kind: "got",
  file: { name: "a.txt", mediaType: "text/html", size },
  author: "did:key:zAuthor",
  version: 1,
});

test("a verified download becomes one blob, typed as bytes whatever its author said", async () => {
  const { console: c } = scriptedGet([
    { kind: "provisional", data: b64u(new TextEncoder().encode("hello ")) },
    { kind: "provisional", data: b64u(new TextEncoder().encode("room")) },
    GOT(10),
  ]);
  const got = await getRoomFileIntoConsole(TARGET, "k", { connect: () => c as never, prepare: PREPARED });
  assert.equal(await got.blob.text(), "hello room");
  assert.equal(got.blob.type, "application/octet-stream", "never rendered by the author's media type");
  assert.equal(got.file.mediaType, "text/html", "the claim is still reported, as a claim");
});

test("pieces that opened but did not verify are never handed out", async () => {
  const { console: c } = scriptedGet([
    { kind: "provisional", data: b64u(new Uint8Array([1, 2, 3])) },
    { kind: "failed", error: "the file did not verify against the digest its author signed", code: "notVerified" },
  ]);
  await assert.rejects(
    getRoomFileIntoConsole(TARGET, "k", { connect: () => c as never, prepare: PREPARED }),
    (e: { code?: string }) => e.code === "notVerified",
  );
});

test("a transfer the offscreen document abandons is a failure, not a short file", async () => {
  const { console: c } = scriptedGet([{ kind: "provisional", data: b64u(new Uint8Array([1, 2, 3])) }]);
  await assert.rejects(
    getRoomFileIntoConsole(TARGET, "k", { connect: () => c as never, prepare: PREPARED }),
    /closed before the transfer finished/,
  );
});

test("a verified size that is not what arrived is refused", async () => {
  const { console: c } = scriptedGet([{ kind: "provisional", data: b64u(new Uint8Array([1, 2, 3])) }, GOT(4)]);
  await assert.rejects(
    getRoomFileIntoConsole(TARGET, "k", { connect: () => c as never, prepare: PREPARED }),
    /reported 4 bytes verified but delivered 3/,
  );
});

test("an aborted download rejects and closes the port", async () => {
  const pair = portPair();
  const stop = new AbortController();
  const pending = getRoomFileIntoConsole(TARGET, "k", { connect: () => pair.console as never, prepare: PREPARED, signal: stop.signal });
  await received(pair.console, pair.console, 1);
  stop.abort();
  await assert.rejects(pending, /stopped/);
  assert.equal(pair.offscreen.connected, false);
});

// ── an upload is held to what it declared ───────────────────────────────────

test("an upload is sent in slices and ended, and resolves on the record", async () => {
  const pair = portPair();
  const file = new Blob([new Uint8Array(500_000).fill(7)], { type: "application/pdf" });
  pair.offscreen.onMessage.addListener((m: unknown) => {
    if ((m as { kind: string }).kind === "end") {
      pair.offscreen.postMessage({ kind: "put", key: "k", version: 3, blobRef: "zRef", size: 500_000, author: "did:webvh:QmAlice:people.example" });
    }
  });
  const put = await putRoomFileFromConsole(TARGET, file, { name: "a.pdf" }, { connect: () => pair.console as never, prepare: PREPARED });
  assert.deepEqual(put, { key: "k", version: 3, blobRef: "zRef", size: 500_000, author: "did:webvh:QmAlice:people.example" });
  const sent = pair.console.posted as Array<{ kind: string; size?: number; mediaType?: string; data?: string }>;
  assert.equal(sent[0]!.kind, "put");
  assert.equal(sent[0]!.size, 500_000);
  assert.equal(sent[0]!.mediaType, "application/pdf");
  const bytes = sent.filter((m) => m.kind === "data").reduce((n, m) => n + Buffer.from(m.data!, "base64url").length, 0);
  assert.equal(bytes, 500_000);
  assert.equal(sent.at(-1)!.kind, "end");
});

test("a file over the ceiling is refused before anything is sent", async () => {
  let connected = false;
  const big = { size: ROOM_FILE_MAX_BYTES + 1 } as Blob;
  await assert.rejects(
    putRoomFileFromConsole(TARGET, big, {}, { connect: () => ((connected = true), portPair().console) as never, prepare: PREPARED }),
    /seals at most/,
  );
  assert.equal(connected, false);
});

/** The offscreen end, served for real, with an agent that must never be reached. */
function served() {
  const pair = portPair();
  let reached = false;
  serveRoomFilesPort(pair.offscreen as never, {
    agent: async () => {
      reached = true;
      throw new Error("the agent was reached");
    },
    fromExtensionPage: () => true,
  });
  return { pair, reached: () => reached };
}

async function failure(pair: ReturnType<typeof portPair>) {
  for (let i = 0; i < 200; i++) {
    const f = (pair.offscreen.posted as Array<{ kind: string; error?: string }>).find((m) => m.kind === "failed");
    if (f) return f.error!;
    await new Promise((r) => setTimeout(r, 1));
  }
  throw new Error("no failure was reported");
}

const PUT_OPEN = { kind: "put", vtaDid: "did:a", roomId: TARGET.roomId, hostDid: TARGET.hostDid, name: "a" };

test("the offscreen document refuses to allocate for a file over the ceiling", async () => {
  const { pair, reached } = served();
  pair.console.postMessage({ ...PUT_OPEN, size: ROOM_FILE_MAX_BYTES + 1 });
  assert.match(await failure(pair), /not one this wallet seals/);
  assert.equal(reached(), false);
});

test("more bytes than declared are refused, not grown into", async () => {
  const { pair, reached } = served();
  pair.console.postMessage({ ...PUT_OPEN, size: 2 });
  pair.console.postMessage({ kind: "data", data: b64u(new Uint8Array(3)) });
  assert.match(await failure(pair), /more bytes than the file was declared/);
  assert.equal(reached(), false);
});

test("an upload that ends short is refused before the agent is asked for anything", async () => {
  const { pair, reached } = served();
  pair.console.postMessage({ ...PUT_OPEN, size: 4 });
  pair.console.postMessage({ kind: "data", data: b64u(new Uint8Array(3)) });
  pair.console.postMessage({ kind: "end" });
  assert.match(await failure(pair), /ended after 3 of 4 bytes/);
  assert.equal(reached(), false);
});

test("a failure in the flow reaches the console with its message", async () => {
  const { pair } = served();
  pair.console.postMessage({ kind: "get", vtaDid: "did:a", roomId: TARGET.roomId, hostDid: TARGET.hostDid, key: "k" });
  assert.match(await failure(pair), /the agent was reached/);
  assert.equal(pair.offscreen.connected, false, "the offscreen end hangs up after a terminal message");
});

// The background worker holds the transfer port too and must not let it go
// (a receiver's disconnect closes the whole channel), so an offscreen document
// that dies mid-transfer would otherwise go unheard. Silence is a failure.
test("a transfer that goes silent is given up, and its port closed", async () => {
  const pair = portPair();
  const pending = getRoomFileIntoConsole(TARGET, "k", { connect: () => pair.console as never, prepare: PREPARED, stallMs: 20 });
  await assert.rejects(pending, /no word from the wallet's background document/);
  assert.equal(pair.console.connected, false);
});

// The bug this file's stall test exists for, pinned at its source. A receiver
// calling `disconnect()` closes the whole channel, so the worker answering this
// port by letting it go failed every console download 1–2 ms in. It may open
// the port (the portal path does); it must never be a receiver that closes it.
test("the background worker never closes a console's transfer port", async () => {
  const { readFile } = await import("node:fs/promises");
  const src = await readFile(new URL("../src/background.ts", import.meta.url), "utf8");
  const code = src
    .split("\n")
    .filter((l) => !/^\s*(\/\/|\*|\/\*)/.test(l))
    .join("\n");
  assert.doesNotMatch(code, /===\s*ROOM_FILES_PORT\b/, "the worker must not single this port out at all");
});
