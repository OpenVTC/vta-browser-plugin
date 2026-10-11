// When the warm pool may reuse a mediator connection, and when it must assume
// the machine slept.
//
// The field case these pin: the mediator closed the holder's socket at 06:50:43
// when its token expired, while the laptop slept. After wake the socket still
// read `isOpen`, and a proxy-login sent at 07:06 reached nobody, timing out 30
// seconds later. Reuse was decided on `isOpen` alone.

import { strict as assert } from "node:assert";
import { test } from "node:test";

import {
  EXPIRY_MARGIN_MS,
  RETIRE_GRACE_MS,
  isReusable,
  isSuperseded,
  retireConnection,
  startWakeWatch,
} from "../src/warm-session-health.js";

const T = Date.parse("2026-10-07T07:06:16Z");

test("the field case: an open socket past its token's expiry is not reused", () => {
  const conn = { isOpen: true, expiresAt: Date.parse("2026-10-07T06:50:43Z") };
  assert.equal(isReusable(conn, T), false);
});

test("an open socket well inside its token's lifetime is reused", () => {
  assert.equal(isReusable({ isOpen: true, expiresAt: T + 10 * 60_000 }, T), true);
});

test("a socket about to expire is not handed a request that would outlive it", () => {
  // The margin covers clock skew against the mediator and a request still in
  // flight when the mediator closes.
  assert.equal(isReusable({ isOpen: true, expiresAt: T + EXPIRY_MARGIN_MS - 1 }, T), false);
  assert.equal(isReusable({ isOpen: true, expiresAt: T + EXPIRY_MARGIN_MS + 1 }, T), true);
});

test("a closed socket is never reused, whatever its expiry", () => {
  assert.equal(isReusable({ isOpen: false, expiresAt: T + 10 * 60_000 }, T), false);
  assert.equal(isReusable({ isOpen: false, expiresAt: undefined }, T), false);
});

test("with no reported expiry, an open socket is all there is to go on", () => {
  assert.equal(isReusable({ isOpen: true, expiresAt: undefined }, T), true);
});

/** A clock and an interval the test advances by hand. */
function fakeTimers() {
  let now = T;
  let tick: (() => void) | undefined;
  let cleared = false;
  return {
    now: () => now,
    setInterval: (fn: () => void) => {
      tick = fn;
      return 1;
    },
    clearInterval: () => {
      cleared = true;
    },
    /** Advance the clock and fire one tick, as the first tick after a gap. */
    advance(ms: number) {
      now += ms;
      tick?.();
    },
    get cleared() {
      return cleared;
    },
  };
}

test("ticks on schedule are not a wake", () => {
  const t = fakeTimers();
  const wakes: number[] = [];
  startWakeWatch({ onWake: (g) => wakes.push(g), intervalMs: 5_000, toleranceMs: 20_000, ...t });
  for (let i = 0; i < 10; i++) t.advance(5_000);
  // A throttled background timer runs late, which must not count as a sleep.
  t.advance(15_000);
  assert.deepEqual(wakes, []);
});

test("a tick that arrives long after it was due is a wake, reported once", () => {
  const t = fakeTimers();
  const wakes: number[] = [];
  startWakeWatch({ onWake: (g) => wakes.push(g), intervalMs: 5_000, toleranceMs: 20_000, ...t });
  t.advance(5_000);
  t.advance(16 * 60_000); // the laptop slept through a token expiry
  t.advance(5_000);
  assert.deepEqual(wakes, [16 * 60_000]);
});

test("stopping the watch clears its timer", () => {
  const t = fakeTimers();
  const stop = startWakeWatch({ onWake: () => {}, ...t });
  stop();
  assert.equal(t.cleared, true);
});

// A replaced connection may still carry a concurrent request. Closing it at
// once failed that request with "mediator-transport: not connected"; with the
// local clock ahead of the mediator's, every connection read expired on
// arrival and the console's parallel loads closed each other's sockets.

function fakeConn(isOpen: boolean) {
  const conn = { isOpen, expiresAt: undefined, closed: 0, close() { conn.closed++; } };
  return conn;
}

test("an open connection being replaced is closed only after the grace period", () => {
  const conn = fakeConn(true);
  const timers: Array<{ fn: () => void; ms: number }> = [];
  retireConnection(conn, { setTimeout: (fn, ms) => timers.push({ fn, ms }) });
  assert.equal(conn.closed, 0, "a request already on it must be able to finish");
  assert.equal(timers.length, 1);
  assert.equal(timers[0]!.ms, RETIRE_GRACE_MS);
  timers[0]!.fn();
  assert.equal(conn.closed, 1);
});

test("the grace outlasts the longest reply wait", () => {
  assert.ok(RETIRE_GRACE_MS > 30_000);
});

test("a connection that is no longer open is closed at once", () => {
  const conn = fakeConn(false);
  retireConnection(conn, {
    setTimeout: () => assert.fail("nothing on a closed socket can succeed; do not wait"),
  });
  assert.equal(conn.closed, 1);
});

// ── a replaced connection closing is not a drop ──
//
// The field case: at gt-vta's token expiry the pool replaced the holder's
// socket. The mediator keeps one socket per DID and closed the old one; its
// `onClose` deleted the replacement's pool entry and reconnected, and the two
// kept closing each other every ~2.4 s until a request's reply went to the
// wrong socket and timed out.

test("a connection the pool has replaced is superseded", async () => {
  const old = { id: "old" };
  const replacement = { id: "new" };
  assert.equal(await isSuperseded(Promise.resolve(replacement), () => old), true);
});

test("the pool's own connection closing is a drop", async () => {
  const conn = { id: "conn" };
  assert.equal(await isSuperseded(Promise.resolve(conn), () => conn), false);
});

test("an empty pool slot means nobody holds the pair, so the close is a drop", async () => {
  assert.equal(await isSuperseded(undefined, () => ({ id: "conn" })), false);
});

test("a replacement that failed to connect does not hold the pair", async () => {
  const failed = Promise.reject(new Error("mediator refused"));
  assert.equal(await isSuperseded(failed, () => ({ id: "old" })), false);
});

test("self is read after the entry settles, so a close during connect is not misread", async () => {
  // The pool entry resolves only once the connection has been returned, which
  // is also when the caller's name for it is assigned.
  const conn = { id: "conn" };
  let self: typeof conn | undefined;
  let resolve!: (c: typeof conn) => void;
  const entry = new Promise<typeof conn>((r) => (resolve = r));
  const verdict = isSuperseded(entry, () => self);
  self = conn;
  resolve(conn);
  assert.equal(await verdict, false);
});
