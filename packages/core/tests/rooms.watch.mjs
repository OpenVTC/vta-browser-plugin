// Watching rooms through the member's own VTA (`rooms/keys/watch/0.1`,
// `rooms/keys/changed/0.1`; trust-tasks-tf #1040), and what is unread after a
// read (`rooms/changed/0.1`, *What a reader does with a signal*).

import { test } from "node:test";
import assert from "node:assert/strict";

import {
  assembleRoomRecords,
  latestMessageTime,
  parseRoomsKeysChanged,
  ROOMS_KEYS_WATCH_MAX_ROOMS,
  RoomWatcher,
  roomsKeysWatch,
  unreadMessages,
  watchCovers,
  WATCH_RETRY_REFUSED_MS,
  WATCH_RETRY_UNREACHABLE_MS,
} from "../dist/rooms/index.js";

const WALLET = { did: "did:key:zWallet" };
const VTA = "did:webvh:QmAgent:agent.example";
const MEMBER = "did:webvh:QmAlice:personas.example:northwind";
const OTHER = "did:webvh:QmBob:personas.example:bob";
const HOST = "did:web:rooms.northwind.example";
const HOST2 = "did:web:rooms.elsewhere.example";
const room = (n) => `did:webvh:QmRoom:rooms.northwind.example:r${n}`;
const ENVELOPE = "https://trusttasks.org/binding/didcomm/0.1/envelope";

// ── The request and its answer ──────────────────────────────────────────────

test("watch: one request names the member, the host and each room with its watermark, sent to the VTA", async () => {
  const asked = [];
  const sender = {
    async send(envelope, opts) {
      asked.push({ envelope, opts });
      return {
        member: MEMBER,
        host: HOST,
        watches: envelope.payload.rooms.map((r) => ({ roomId: r.roomId, armed: true, expiresAt: "2027-02-08T09:00:01Z" })),
      };
    },
  };
  const out = await roomsKeysWatch(sender, {
    holder: WALLET,
    service: { did: VTA },
    member: MEMBER,
    host: HOST,
    rooms: [{ roomId: room(1), sinceVersion: 412 }, { roomId: room(2) }],
    leaseSeconds: 86400,
  });
  const [{ envelope, opts }] = asked;
  assert.equal(envelope.type, "https://trusttasks.org/spec/rooms/keys/watch/0.1");
  assert.equal(envelope.issuer, WALLET.did);
  assert.equal(envelope.recipient, VTA);
  assert.deepEqual(envelope.payload, {
    member: MEMBER,
    host: HOST,
    rooms: [{ roomId: room(1), sinceVersion: 412 }, { roomId: room(2) }],
    leaseSeconds: 86400,
  });
  assert.equal(opts.expectedResponseType, "https://trusttasks.org/spec/rooms/keys/watch/0.1#response");
  assert.deepEqual(out.map((w) => w.armed), [true, true]);
});

test("watch: a cancel carries no watermark and no lease", async () => {
  let payload;
  await roomsKeysWatch(
    { async send(e) { payload = e.payload; return { member: MEMBER, host: HOST, watches: [{ roomId: room(1), armed: false }] }; } },
    { holder: WALLET, service: { did: VTA }, member: MEMBER, host: HOST, rooms: [{ roomId: room(1), sinceVersion: 9 }], leaseSeconds: 60, cancel: true },
  );
  assert.deepEqual(payload, { member: MEMBER, host: HOST, rooms: [{ roomId: room(1) }], cancel: true });
});

test("watch: an answer that is not the rooms asked, in order, or for another member or host, is refused", async () => {
  const params = { holder: WALLET, service: { did: VTA }, member: MEMBER, host: HOST, rooms: [{ roomId: room(1) }, { roomId: room(2) }] };
  const answering = (res) => ({ async send() { return res; } });
  const ok = (a, b) => ({ member: MEMBER, host: HOST, watches: [{ roomId: a, armed: true }, { roomId: b, armed: true }] });
  await assert.rejects(roomsKeysWatch(answering(ok(room(2), room(1))), params), /in order/);
  await assert.rejects(roomsKeysWatch(answering({ ...ok(room(1), room(2)), member: OTHER }), params), /in order/);
  await assert.rejects(roomsKeysWatch(answering({ ...ok(room(1), room(2)), host: HOST2 }), params), /in order/);
  await assert.rejects(roomsKeysWatch(answering({ member: MEMBER, host: HOST, watches: [{ roomId: room(1), armed: true }] }), params));
});

test("watch: at most 64 rooms, each at most once", async () => {
  const never = { async send() { throw new Error("not sent"); } };
  const base = { holder: WALLET, service: { did: VTA }, member: MEMBER, host: HOST };
  await assert.rejects(roomsKeysWatch(never, { ...base, rooms: [] }), RangeError);
  const many = Array.from({ length: ROOMS_KEYS_WATCH_MAX_ROOMS + 1 }, (_, i) => ({ roomId: room(i) }));
  await assert.rejects(roomsKeysWatch(never, { ...base, rooms: many }), RangeError);
  await assert.rejects(roomsKeysWatch(never, { ...base, rooms: [{ roomId: room(1) }, { roomId: room(1) }] }), RangeError);
});

// ── The signal ──────────────────────────────────────────────────────────────

const signalDoc = (payload, extra = {}) => ({
  type: ENVELOPE,
  body: { type: "https://trusttasks.org/spec/rooms/keys/changed/0.1", issuer: VTA, recipient: WALLET.did, payload, ...extra },
});
const SIGNAL = { roomId: room(1), member: MEMBER, host: HOST, latestVersion: 415 };

test("changed: accepted from the wallet's own VTA, as the transport proved it", () => {
  assert.deepEqual(parseRoomsKeysChanged(signalDoc(SIGNAL), VTA, VTA), SIGNAL);
});

test("changed: refused from anyone else, whatever the document says", () => {
  assert.equal(parseRoomsKeysChanged(signalDoc(SIGNAL), VTA, "did:web:mallory.example"), null, "another sender");
  assert.equal(parseRoomsKeysChanged(signalDoc(SIGNAL), VTA, undefined), null, "an unattributed one");
  assert.equal(parseRoomsKeysChanged(signalDoc(SIGNAL, { issuer: "did:web:mallory.example" }), VTA, VTA), null, "an issuer that is not the VTA");
});

test("changed: refused when the payload is not the closed schema's", () => {
  assert.equal(parseRoomsKeysChanged(signalDoc({ ...SIGNAL, title: "what changed" }), VTA, VTA), null, "nothing beyond the four members");
  assert.equal(parseRoomsKeysChanged(signalDoc({ ...SIGNAL, latestVersion: 0 }), VTA, VTA), null);
  const { host: _h, ...noHost } = SIGNAL;
  assert.equal(parseRoomsKeysChanged(signalDoc(noHost), VTA, VTA), null);
  assert.equal(parseRoomsKeysChanged({ ...signalDoc(SIGNAL), type: "https://didcomm.org/other/1.0/x" }, VTA, VTA), null);
  assert.equal(
    parseRoomsKeysChanged({ type: ENVELOPE, body: { type: "https://trusttasks.org/spec/task-consent/granted/0.1", payload: SIGNAL } }, VTA, VTA),
    null,
  );
});

// ── Which watches are armed ─────────────────────────────────────────────────

/** A watcher with hand-run timers, and a VTA answering by `answer(batch)`. */
function harness(answer = (b) => b.rooms.map((r) => ({ roomId: r.roomId, armed: true, expiresAt: "2027-01-02T00:00:00Z" }))) {
  let now = Date.parse("2027-01-01T00:00:00Z");
  const timers = [];
  const sent = [];
  const w = new RoomWatcher({
    send: async (batch) => {
      sent.push(structuredClone(batch));
      return answer(batch);
    },
    now: () => now,
    setTimer: (fn, ms) => {
      const t = { fn, at: now + ms, live: true };
      timers.push(t);
      return t;
    },
    clearTimer: (t) => {
      if (t) t.live = false;
    },
  });
  const tick = async (ms = 0) => {
    now += ms;
    for (const t of timers.filter((x) => x.live && x.at <= now)) {
      t.live = false;
      t.fn();
    }
    for (let i = 0; i < 5; i++) await Promise.resolve();
    await new Promise((r) => setImmediate(r));
  };
  return { w, sent, tick, advance: (ms) => (now += ms) };
}
const key = (n, host = HOST, member = MEMBER) => ({ vtaDid: VTA, member, host, roomId: room(n) });

test("watcher: nothing is armed until the room is read; then one request per member and host", async () => {
  const { w, sent, tick } = harness();
  w.hold(key(1));
  w.hold(key(2));
  w.hold(key(3, HOST2));
  await tick(100);
  assert.deepEqual(sent, [], "a watch is armed only after a read");
  w.afterRead(key(1), 10);
  w.afterRead(key(2), 20);
  w.afterRead(key(3, HOST2), 30);
  await tick(100);
  assert.equal(sent.length, 2, "grouped by host");
  const byHost = Object.fromEntries(sent.map((b) => [b.host, b]));
  assert.deepEqual(byHost[HOST].rooms, [{ roomId: room(1), sinceVersion: 10 }, { roomId: room(2), sinceVersion: 20 }]);
  assert.deepEqual(byHost[HOST2].rooms, [{ roomId: room(3), sinceVersion: 30 }]);
  assert.equal(byHost[HOST].member, MEMBER);
  assert.ok(watchCovers(w.state(key(1))));
});

test("watcher: more than 64 rooms at one host go in several requests", async () => {
  const { w, sent, tick } = harness();
  for (let i = 0; i < 70; i++) {
    w.hold(key(i));
    w.afterRead(key(i), i);
  }
  await tick(100);
  assert.deepEqual(sent.map((b) => b.rooms.length).sort((a, b) => b - a), [64, 6]);
});

test("watcher: one signal per arming — a second for the same arming, or one never armed, is dropped", async () => {
  const { w, sent, tick } = harness();
  w.hold(key(1));
  w.afterRead(key(1), 5);
  await tick(100);
  assert.deepEqual(w.accept(VTA, { roomId: room(1), member: MEMBER, host: HOST }), key(1));
  assert.equal(w.state(key(1)).state, "fired");
  assert.equal(w.accept(VTA, { roomId: room(1), member: MEMBER, host: HOST }), undefined, "fired already");
  assert.equal(w.accept(VTA, { roomId: room(9), member: MEMBER, host: HOST }), undefined, "a room not armed");
  assert.equal(w.accept(VTA, { roomId: room(1), member: OTHER, host: HOST }), undefined, "another member");
  assert.equal(w.accept(VTA, { roomId: room(1), member: MEMBER, host: HOST2 }), undefined, "another host");
  assert.equal(w.accept("did:web:other-vta.example", { roomId: room(1), member: MEMBER, host: HOST }), undefined, "another VTA");
  // Re-armed only after the read that follows the signal.
  await tick(100);
  assert.equal(sent.length, 1);
  w.afterRead(key(1), 7);
  await tick(100);
  assert.equal(sent.length, 2);
  assert.deepEqual(sent[1].rooms, [{ roomId: room(1), sinceVersion: 7 }]);
});

test("watcher: an armed watch is not re-armed by reads — never more often than it signals", async () => {
  const { w, sent, tick } = harness();
  w.hold(key(1));
  w.afterRead(key(1), 5);
  await tick(100);
  w.afterRead(key(1), 6);
  w.afterRead(key(1), 7);
  await tick(100);
  assert.equal(sent.length, 1);
});

test("watcher: a signal that beats the answer still fires the arming, and the late answer does not undo it", async () => {
  let release;
  const gate = new Promise((r) => (release = r));
  const { w, tick } = harness(async (b) => {
    await gate;
    return b.rooms.map((r) => ({ roomId: r.roomId, armed: true, expiresAt: "2027-01-02T00:00:00Z" }));
  });
  w.hold(key(1));
  w.afterRead(key(1), 5);
  await tick(100);
  assert.equal(w.state(key(1)).state, "arming");
  assert.deepEqual(w.accept(VTA, { roomId: room(1), member: MEMBER, host: HOST }), key(1));
  release();
  await tick();
  assert.equal(w.state(key(1)).state, "fired");
});

test("watcher: a refused room stays quiet, is polled, and is tried again only after a while, on a read", async () => {
  const { w, sent, tick, advance } = harness((b) =>
    b.rooms.map((r) =>
      r.roomId === room(1)
        ? { roomId: r.roomId, armed: false, refused: "hostRefused", hostCode: "rooms/watch:limitReached" }
        : r.roomId === room(2)
          ? { roomId: r.roomId, armed: false, refused: "hostUnreachable" }
          : { roomId: r.roomId, armed: true },
    ),
  );
  for (const n of [1, 2, 3]) {
    w.hold(key(n));
    w.afterRead(key(n), n);
  }
  await tick(100);
  assert.deepEqual(w.state(key(1)), { state: "refused", refused: "hostRefused", hostCode: "rooms/watch:limitReached" });
  assert.equal(watchCovers(w.state(key(1))), false, "the surface polls it");
  assert.equal(w.state(key(3)).state, "armed", "the others are armed all the same");

  w.afterRead(key(1), 4);
  w.afterRead(key(2), 4);
  await tick(100);
  assert.equal(sent.length, 1, "not retried at once");

  advance(WATCH_RETRY_UNREACHABLE_MS);
  w.afterRead(key(1), 4);
  w.afterRead(key(2), 4);
  await tick(100);
  assert.deepEqual(sent[1].rooms.map((r) => r.roomId), [room(2)], "an unreachable host is tried again sooner");

  advance(WATCH_RETRY_REFUSED_MS);
  w.afterRead(key(1), 4);
  await tick(100);
  assert.deepEqual(sent.at(-1).rooms.map((r) => r.roomId), [room(1)]);
});

test("watcher: a request the VTA refuses as a whole leaves every room to polling", async () => {
  const { w, tick } = harness(() => {
    throw new Error("unsupportedType: rooms/keys/watch/0.1");
  });
  w.hold(key(1));
  w.afterRead(key(1), 1);
  await tick(100);
  assert.equal(w.state(key(1)).state, "unavailable");
  assert.match(w.state(key(1)).reason, /unsupportedType/);
});

test("watcher: closing the pane cancels its watch at the VTA", async () => {
  const { w, sent, tick } = harness();
  w.hold(key(1));
  w.hold(key(2));
  w.afterRead(key(1), 1);
  w.afterRead(key(2), 2);
  await tick(100);
  w.release(key(1));
  await tick(100);
  const cancel = sent.find((b) => b.cancel);
  assert.deepEqual(cancel.rooms, [{ roomId: room(1) }]);
  assert.equal(w.accept(VTA, { roomId: room(1), member: MEMBER, host: HOST }), undefined, "and its signal is dropped after");
  assert.ok(watchCovers(w.state(key(2))), "the other pane's watch stands");
});

test("watcher: a watch held by two panes is cancelled only when the last closes", async () => {
  const { w, sent, tick } = harness();
  w.hold(key(1));
  w.hold(key(1));
  w.afterRead(key(1), 1);
  await tick(100);
  w.release(key(1));
  await tick(100);
  assert.equal(sent.filter((b) => b.cancel).length, 0);
  w.release(key(1));
  await tick(100);
  assert.equal(sent.filter((b) => b.cancel).length, 1);
});

test("watcher: a pane closed while its watch is being armed cancels it once the VTA says it is armed", async () => {
  let release;
  const gate = new Promise((r) => (release = r));
  const { w, sent, tick } = harness(async (b) => {
    if (!b.cancel) await gate;
    return b.rooms.map((r) => ({ roomId: r.roomId, armed: !b.cancel }));
  });
  w.hold(key(1));
  w.afterRead(key(1), 1);
  await tick(100);
  w.release(key(1));
  await tick(100);
  assert.equal(sent.filter((b) => b.cancel).length, 0, "no cancel to overtake the arming");
  release();
  await tick();
  await tick(100);
  assert.deepEqual(sent.filter((b) => b.cancel).map((b) => b.rooms), [[{ roomId: room(1) }]]);
});

test("watcher: a watch that reaches expiresAt unsignalled lapses, and is re-armed after the next read", async () => {
  const { w, sent, tick } = harness();
  const states = [];
  w.subscribe((_, s) => states.push(s?.state));
  w.hold(key(1));
  w.afterRead(key(1), 1);
  await tick(100);
  await tick(24 * 3600_000);
  assert.equal(w.state(key(1)).state, "lapsed");
  assert.ok(states.includes("lapsed"), "the surface hears it, and reads");
  w.afterRead(key(1), 2);
  await tick(100);
  assert.equal(sent.length, 2);
});

// ── What is unread ──────────────────────────────────────────────────────────

const NOW = Date.parse("2026-11-05T12:00:00Z");
function input(key, content, meta = {}) {
  return {
    key,
    version: meta.version ?? 1,
    status: meta.status ?? "active",
    createdAt: meta.createdAt,
    updatedAt: meta.updatedAt ?? "2026-11-05T11:00:00Z",
    reading: content === null ? { state: "tombstone" } : meta.refused ? { state: "refused", reason: "bad" } : { state: "read", content: { hasFile: false, bodyVersion: 1, ...content } },
  };
}
const MARK = Date.parse("2026-11-05T10:00:00Z");
const NEW = "2026-11-05T11:00:00Z";
const OLD = "2026-11-05T09:00:00Z";

test("unread: a message by someone else, created after the read marker", () => {
  const inputs = [
    input("new", { author: OTHER, kind: "message", body: "hi" }, { createdAt: NEW }),
    input("old", { author: OTHER, kind: "message", body: "before" }, { createdAt: OLD }),
  ];
  const view = assembleRoomRecords(inputs, { now: NOW });
  assert.deepEqual(unreadMessages(view, inputs, { readMarker: MARK, own: new Set([MEMBER]) }), ["new"]);
});

test("unread: never the member's own, a note, a reaction, a name, a withdrawn, retracted, expired or refused record", () => {
  const inputs = [
    input("mine", { author: MEMBER, kind: "message", body: "mine" }, { createdAt: NEW }),
    input("note", { author: OTHER, title: "A note", body: "text" }, { createdAt: NEW }),
    input("target", { author: MEMBER, kind: "message", body: "t" }, { createdAt: OLD }),
    input("react", { author: OTHER, kind: "reaction", body: "👍", inReplyTo: { key: "target" } }, { createdAt: NEW }),
    input("name", { author: OTHER, kind: "memberProfile", title: "Bob", members: ["kind", "title"] }, { createdAt: NEW }),
    input("gone", { author: OTHER, kind: "message", body: "" }, { createdAt: NEW }),
    input("retracted", null, { createdAt: NEW, status: "retracted" }),
    input("expired", { author: OTHER, kind: "message", body: "late", validUntil: "2026-11-01T00:00:00Z" }, { createdAt: NEW }),
    input("refused", { author: OTHER }, { createdAt: NEW, refused: true }),
  ];
  const view = assembleRoomRecords(inputs, { now: NOW });
  assert.deepEqual(unreadMessages(view, inputs, { readMarker: MARK, own: new Set([MEMBER]) }), []);
});

test("unread: an edit of an old message is not new — the host's createdAt is the record's first", () => {
  const inputs = [input("m", { author: OTHER, kind: "message", body: "edited" }, { version: 4, createdAt: OLD, updatedAt: NEW })];
  const view = assembleRoomRecords(inputs, { now: NOW });
  assert.deepEqual(unreadMessages(view, inputs, { readMarker: MARK, own: new Set() }), []);
});

test("unread: the host's time, never the author's writtenAt — a back-dated message still counts", () => {
  const inputs = [input("m", { author: OTHER, kind: "message", body: "hi", writtenAt: "2026-01-01T00:00:00Z" }, { createdAt: NEW })];
  const view = assembleRoomRecords(inputs, { now: NOW });
  assert.deepEqual(unreadMessages(view, inputs, { readMarker: MARK, own: new Set() }), ["m"]);
});

test("unread: without createdAt, updatedAt is the time; and the latest message time is where the marker moves", () => {
  const inputs = [input("m", { author: OTHER, kind: "message", body: "hi" }, { updatedAt: NEW })];
  const view = assembleRoomRecords(inputs, { now: NOW });
  assert.deepEqual(unreadMessages(view, inputs, { readMarker: MARK, own: new Set() }), ["m"]);
  assert.equal(latestMessageTime(view, inputs), Date.parse(NEW));
});

test("watcher: an expiresAt beyond what a timer can hold does not lapse the watch at once", async () => {
  const { w, tick } = harness((b) => b.rooms.map((r) => ({ roomId: r.roomId, armed: true, expiresAt: "2099-01-01T00:00:00Z" })));
  w.hold(key(1));
  w.afterRead(key(1), 1);
  await tick(100);
  await tick(1000);
  assert.equal(w.state(key(1)).state, "armed");
});

