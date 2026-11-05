// An open room learns of changes through the member's own VTA
// (`rooms/keys/watch/0.1`, `rooms/keys/changed/0.1`; trust-tasks-tf #1040),
// rendered.
//
// What is asserted is what the member and the VTA see: the watch armed after
// the first read at the version read, a signal answered by reading from the
// watermark and re-arming, unread decided from the records read and said with
// no content in the notification, a signal from anywhere but the offscreen
// document ignored, a refusal leaving the room to polling, and the watch
// cancelled when the pane closes.

import { test } from "node:test";
import assert from "node:assert/strict";
import { agent, h, render, PARTIES } from "./harness/dom.mjs";
import { RoomRecords } from "../src/manager/panes/rooms-records.js";
import { fromOffscreen, UNREAD_NOTIFICATION } from "../src/manager/room-watch.js";

const BASE = "chrome-extension://walletid/";
const HOST = "did:web:rooms.northwind.example";
const MEMBER = "did:webvh:QmAlice:personas.example:northwind";
const OTHER = "did:webvh:QmBob:personas.example:bob";
const BROWSE = "rooms/keys/browse/0.4";
const READ = "rooms/keys/read/0.2";
const WATCH = "rooms/keys/watch/0.1";

const row = (key: string, version: number, author: string, createdAt: string) => ({ key, version, author, createdAt, updatedAt: createdAt, status: "active", kind: "message" });
const result = (key: string, version: number, author: string, createdAt: string, body: string) => ({
  key,
  version,
  author,
  createdAt,
  updatedAt: createdAt,
  cleartext: { kind: "message", body },
});
const VERIFIED = { priorRoots: "noneHeld" };

/**
 * One chrome for the whole file: the console's listener for signals is
 * registered once per page, as in the browser. Each test swaps the agent.
 */
let current: { sendMessage: (m: unknown) => Promise<unknown> } = { sendMessage: async () => ({}) };
const notified: unknown[] = [];
const listeners: ((m: unknown, sender: unknown) => unknown)[] = [];
const storage: Record<string, unknown> = {};
const chromeStub = {
  runtime: {
    getURL: (p: string) => `${BASE}${p}`,
    sendMessage: (m: { type?: string }) => {
      if (m?.type === "vta-wallet/notify") {
        notified.push(m);
        return Promise.resolve();
      }
      return current.sendMessage(m);
    },
    onMessage: { addListener: (fn: (m: unknown, sender: unknown) => unknown) => listeners.push(fn) },
  },
  storage: {
    local: {
      get: async (k: string) => (k in storage ? { [k]: storage[k] } : {}),
      set: async (v: Record<string, unknown>) => void Object.assign(storage, v),
    },
  },
};

const wait = (ms: number) => new Promise((r) => setTimeout(r, ms));
const signal = (roomId: string, latestVersion: number, sender: unknown = { id: "walletid", url: `${BASE}offscreen.html` }) => {
  for (const fn of listeners) {
    fn({ type: "vta-wallet/rooms-keys-changed", vtaDid: PARTIES.service.did, signal: { roomId, member: MEMBER, host: HOST, latestVersion } }, sender);
  }
};
const setHidden = (hidden: boolean) =>
  Object.defineProperty(document, "visibilityState", { value: hidden ? "hidden" : "visible", configurable: true });

/** A room on an open host: `rows` listed first, `later` listed from the watermark. */
function roomAgent(roomId: string, opts: { watch?: (p: Record<string, unknown>) => unknown } = {}) {
  let rows = [row("a", 3, OTHER, "2026-11-05T09:00:00Z")];
  const bodies: Record<string, ReturnType<typeof result>> = { a: result("a", 3, OTHER, "2026-11-05T09:00:00Z", "hello") };
  const a = agent({
    [BROWSE]: (p: { sinceVersion?: number }) => ({
      roomId,
      records: rows.filter((r) => p.sinceVersion === undefined || r.version > p.sinceVersion),
      complete: true,
      verification: VERIFIED,
    }),
    [READ]: (p: { keys: string[] }) => ({ roomId, results: p.keys.map((k) => bodies[k]) }),
    [WATCH]:
      opts.watch ??
      ((p: { member: string; host: string; rooms: { roomId: string }[]; cancel?: boolean }) => ({
        member: p.member,
        host: p.host,
        watches: p.rooms.map((r) => (p.cancel ? { roomId: r.roomId, armed: false } : { roomId: r.roomId, armed: true, expiresAt: "2099-01-01T00:00:00Z" })),
      })),
  });
  const add = (key: string, version: number, author: string, body: string) => {
    const at = new Date(Date.parse("2026-11-05T10:00:00Z") + version * 1000).toISOString();
    rows = [...rows, row(key, version, author, at)];
    bodies[key] = result(key, version, author, at, body);
  };
  const wrapped = {
    ...a,
    sendMessage: async (m: { type?: string }) =>
      m?.type === "vta-wallet/manager-task" ? a.sendMessage(m) : Promise.reject(new Error(`not served here: ${m?.type}`)),
  };
  current = wrapped;
  return { a, add };
}

async function open(roomId: string) {
  const screen = await render(h(RoomRecords, { parties: PARTIES, room: { roomId, member: MEMBER }, host: HOST } as never), {
    chrome: chromeStub as never,
  });
  await screen.settle();
  await wait(80); // the watcher gathers arm requests for 50 ms
  await screen.settle();
  return screen;
}

test("only the offscreen document's own messages are taken as signals", () => {
  assert.equal(fromOffscreen({ id: "walletid", url: `${BASE}offscreen.html` }, BASE), true);
  assert.equal(fromOffscreen({ id: "walletid", url: "https://evil.example/", tab: { id: 1 } }, BASE), false, "a content script");
  assert.equal(fromOffscreen({ id: "walletid", url: `${BASE}manager.html` }, BASE), false, "another page");
  assert.equal(fromOffscreen(undefined, BASE), false);
});

test("an open room is watched through the agent after its first read, at the version read", async () => {
  const ROOM = "did:webvh:QmRoom:rooms.northwind.example:one";
  const { a } = roomAgent(ROOM);
  const screen = await open(ROOM);
  const [watch] = a.of("keys/watch");
  assert.ok(watch, "a watch was asked for");
  assert.deepEqual(watch.payload, { member: MEMBER, host: HOST, rooms: [{ roomId: ROOM, sinceVersion: 3 }], leaseSeconds: 86400 });
  assert.match(screen.text(), /signalled through your agent/);
  await screen.unmount();
});

test("a signal is answered by reading from the watermark, batch-reading what changed, then re-arming", async () => {
  const ROOM = "did:webvh:QmRoom:rooms.northwind.example:two";
  const { a, add } = roomAgent(ROOM);
  const screen = await open(ROOM);
  add("b", 5, OTHER, "news");
  signal(ROOM, 5);
  await screen.settle();
  await wait(80);
  await screen.settle();
  const browses = a.of("keys/browse");
  assert.equal(browses.length, 2);
  assert.equal(browses[1]!.payload.sinceVersion, 3, "listed from the watermark");
  const reads = a.of("keys/read");
  assert.deepEqual(reads.at(-1)!.payload.keys, ["b"], "only what changed is read");
  const watches = a.of("keys/watch").filter((w) => !w.payload.cancel);
  assert.equal(watches.length, 2, "re-armed after the read");
  assert.deepEqual(watches[1]!.payload.rooms, [{ roomId: ROOM, sinceVersion: 5 }]);
  assert.match(screen.text(), /news/);
  await screen.unmount();
});

test("a second signal for the same arming, or one from a content script, reads nothing", async () => {
  const ROOM = "did:webvh:QmRoom:rooms.northwind.example:three";
  const { a, add } = roomAgent(ROOM);
  const screen = await open(ROOM);
  add("b", 5, OTHER, "x");
  signal(ROOM, 5, { id: "walletid", url: "https://evil.example/", tab: { id: 3 } });
  signal("did:webvh:QmRoom:rooms.northwind.example:not-armed", 9);
  await screen.settle();
  assert.equal(a.of("keys/browse").length, 1, "neither is read on");
  await screen.unmount();
});

test("unread is decided after reading, and the notification says nothing of the room or the message", async () => {
  const ROOM = "did:webvh:QmRoom:rooms.northwind.example:four";
  notified.length = 0;
  const { add } = roomAgent(ROOM);
  const screen = await open(ROOM);
  setHidden(true);
  try {
    add("mine", 4, MEMBER, "my own words");
    signal(ROOM, 4);
    await screen.settle();
    await wait(80);
    await screen.settle();
    assert.equal(notified.length, 0, "the member's own message is not unread");
    assert.doesNotMatch(screen.text(), /new message/);

    add("theirs", 6, OTHER, "the secret plan");
    signal(ROOM, 6);
    await screen.settle();
    await wait(80);
    await screen.settle();
    assert.match(screen.text(), /1 new message/);
    assert.equal(notified.length, 1);
    const n = notified[0] as { title: string; message: string };
    assert.deepEqual({ title: n.title, message: n.message }, UNREAD_NOTIFICATION);
    assert.doesNotMatch(JSON.stringify(n), /secret|four|Bob|QmBob/, "no content, no room, no author");
  } finally {
    setHidden(false);
    document.dispatchEvent(new Event("visibilitychange"));
  }
  await screen.settle();
  assert.doesNotMatch(screen.text(), /new message/, "seen once the member is back");
  await screen.unmount();
});

test("a room the agent will not watch is checked by polling, quietly", async () => {
  const ROOM = "did:webvh:QmRoom:rooms.northwind.example:five";
  roomAgent(ROOM, {
    watch: (p) => ({
      member: p.member,
      host: p.host,
      watches: (p.rooms as { roomId: string }[]).map((r) => ({ roomId: r.roomId, armed: false, refused: "hostRefused", hostCode: "rooms/watch:limitReached" })),
    }),
  });
  const screen = await open(ROOM);
  assert.match(screen.text(), /Checked for new records every 60 seconds/);
  assert.doesNotMatch(screen.text(), /limitReached|refused/i, "the refusal is not shouted");
  await screen.unmount();
});

test("closing the pane cancels its watch", async () => {
  const ROOM = "did:webvh:QmRoom:rooms.northwind.example:six";
  const { a } = roomAgent(ROOM);
  const screen = await open(ROOM);
  await screen.unmount();
  await wait(80);
  const cancels = a.of("keys/watch").filter((w) => w.payload.cancel);
  assert.equal(cancels.length, 1);
  assert.deepEqual(cancels[0]!.payload.rooms, [{ roomId: ROOM }]);
});
