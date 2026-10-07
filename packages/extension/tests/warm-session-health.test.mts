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
  isReusable,
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
