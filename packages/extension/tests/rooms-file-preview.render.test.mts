// A room file's preview, rendered against a fake transfer port.
//
// Two things a person sees and a model would not: a small picture previews
// itself without a click, once, even under React's development double mount
// (which used to abort the fetch and never restart it); and what is drawn is
// decided by the verified bytes, so a record claiming `image/png` over bytes
// that are not one gets a download, not a rendering.

import { test } from "node:test";
import assert from "node:assert/strict";
import { StrictMode } from "react";
import { h, render } from "./harness/dom.mjs";
import { GetRoomFile } from "../src/manager/panes/rooms-files.js";
import { ROOM_FILES_PORT, RUNTIME_ROOM_FILES_PREPARE } from "../src/bridge-protocol.js";

const PNG = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 0]);
const b64url = (b: Uint8Array) => Buffer.from(b).toString("base64url");

const PREPARED = { endpoint: "https://host.example/trust-tasks", granted: true, vtaDid: "did:webvh:QmAgent:agent.example" };

/** A transfer port that answers a `get` with `bytes`, verified — from a signed body unless `signed` is false. */
function chromeServing(bytes: Uint8Array, signed = true) {
  const opened: string[] = [];
  const connect = ({ name }: { name: string }) => {
    assert.equal(name, ROOM_FILES_PORT);
    const onMessage: ((m: unknown) => void)[] = [];
    const onDisconnect: (() => void)[] = [];
    let closed = false;
    return {
      name,
      onMessage: { addListener: (f: (m: unknown) => void) => onMessage.push(f) },
      onDisconnect: { addListener: (f: () => void) => onDisconnect.push(f) },
      disconnect: () => {
        closed = true;
      },
      postMessage: (m: { kind: string; key: string }) => {
        opened.push(m.key);
        setTimeout(() => {
          if (closed) return;
          for (const f of onMessage) f({ kind: "provisional", data: b64url(bytes) });
          for (const f of onMessage) {
            f({ kind: "got", file: { name: "design.png", size: bytes.length, mediaType: "image/png" }, author: "did:example:author", signed, version: 2 });
          }
        }, 1);
      },
    };
  };
  return {
    opened,
    chrome: {
      runtime: {
        connect,
        sendMessage: async (m: { type: string }) =>
          m.type === RUNTIME_ROOM_FILES_PREPARE ? { ok: true, result: PREPARED } : { ok: false, error: "unexpected" },
      },
    },
  };
}

const props = (size: number) => ({
  room: { roomId: "did:webvh:QmRoom:rooms.example", member: "did:example:me", epoch: 2, earliestReadableEpoch: 1 },
  host: "did:webvh:QmHost:host.example",
  prepared: PREPARED,
  recordKey: "k1",
  claim: { name: "design.png", size, mediaType: "image/png" },
  autoPreview: true,
});

const wait = () => new Promise((r) => setTimeout(r, 20));

test("a small picture previews itself once, under the development double mount", async () => {
  const { chrome, opened } = chromeServing(PNG);
  const screen = await render(h(StrictMode, null, h(GetRoomFile, props(PNG.length) as never)), { chrome: chrome as never });
  await wait();
  await screen.settle();
  assert.equal(screen.all("img").length, 1, "the thumbnail is drawn");
  assert.doesNotMatch(screen.text(), /stopped|closed before/, "the aborted first mount leaves no error behind");
  assert.match(screen.text(), /Every byte matches the digest its author signed/);
  assert.ok(opened.length >= 1);
});

test("bytes that are not a picture are not drawn as one, whatever the record claims", async () => {
  const notPng = new Uint8Array([0x25, 0x50, 0x44, 0x46, 0x2d, 0x31, 0, 1]); // %PDF-1
  const { chrome } = chromeServing(notPng);
  const screen = await render(h(GetRoomFile, props(notPng.length) as never), { chrome: chrome as never });
  await wait();
  await screen.settle();
  assert.equal(screen.all("img").length, 0);
  assert.match(screen.text(), /No preview for this kind of file/);
});

// An open room's record is not signed by its author: the file matched the digest
// the record states, and the preview says so rather than claiming a signature.
test("an open room's file says it matched its record's digest, not a signature", async () => {
  const { chrome } = chromeServing(PNG, false);
  const screen = await render(h(GetRoomFile, props(PNG.length) as never), { chrome: chrome as never });
  await wait();
  await screen.settle();
  assert.match(screen.text(), /Every byte matches the digest its record states/);
  assert.doesNotMatch(screen.text(), /its author signed/);
});
