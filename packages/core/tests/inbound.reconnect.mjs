import { test } from "node:test";
import assert from "node:assert/strict";

import { ReconnectScheduler } from "../dist/inbound/reconnect.js";

/** A controllable clock. Real timers would make these tests slow and flaky;
 *  worse, the behaviour under test IS the timing, so it has to be observable
 *  rather than waited out. */
function fakeTimers() {
  let now = 0;
  let seq = 0;
  const queued = new Map(); // handle -> { at, fn }
  return {
    timers: {
      setTimeout: (fn, ms) => {
        const handle = ++seq;
        queued.set(handle, { at: now + ms, fn });
        return handle;
      },
      clearTimeout: (handle) => queued.delete(handle),
    },
    /** Advance the clock, firing due callbacks in time order. */
    async advance(ms) {
      const target = now + ms;
      for (;;) {
        let next = null;
        for (const [handle, t] of queued) {
          if (t.at <= target && (next === null || t.at < queued.get(next).at)) next = handle;
        }
        if (next === null) break;
        const { at, fn } = queued.get(next);
        queued.delete(next);
        now = at;
        fn();
        // Let the promise chain inside the callback settle before the next tick.
        await new Promise((r) => setImmediate(r));
      }
      now = target;
    },
    pending: () => queued.size,
  };
}

test("a failing attempt re-arms instead of giving up after one retry", async () => {
  // The original bug: ONE 2s retry, and if it failed nothing ever tried again
  // because no session opened, so onClose could not fire a second time.
  const clock = fakeTimers();
  let attempts = 0;
  const s = new ReconnectScheduler({
    baseMs: 2_000,
    maxMs: 60_000,
    attempt: async () => {
      attempts++;
      return false;
    },
    timers: clock.timers,
  });

  s.schedule("vta");
  await clock.advance(2_000);
  assert.equal(attempts, 1);
  // The whole point: still armed after the first failure.
  assert.equal(s.isArmed("vta"), true, "must re-arm after a failed attempt");

  await clock.advance(4_000);
  assert.equal(attempts, 2);
  await clock.advance(8_000);
  assert.equal(attempts, 3);
});

test("the delay doubles and then caps, so retries never stop", async () => {
  const clock = fakeTimers();
  const s = new ReconnectScheduler({
    baseMs: 2_000,
    maxMs: 16_000,
    attempt: async () => false,
    timers: clock.timers,
  });

  s.schedule("vta");
  const seen = [];
  for (let i = 0; i < 8; i++) {
    // Advance by exactly the queued delay so each pass fires one retry —
    // a coarser jump would run several doublings inside one advance.
    const delay = s.pendingDelayMs("vta");
    seen.push(delay);
    await clock.advance(delay);
  }
  assert.deepEqual(seen, [2_000, 4_000, 8_000, 16_000, 16_000, 16_000, 16_000, 16_000]);
  assert.equal(s.isArmed("vta"), true, "a capped backoff is still a live backoff");
});

test("a mediator down for 60s recovers on its own once it returns", async () => {
  const clock = fakeTimers();
  let mediatorUp = false;
  let connects = 0;
  const s = new ReconnectScheduler({
    baseMs: 2_000,
    maxMs: 60_000,
    attempt: async () => {
      if (!mediatorUp) return false;
      connects++;
      return true;
    },
    timers: clock.timers,
  });

  s.schedule("vta");
  await clock.advance(60_000);
  assert.equal(connects, 0, "still down, so no connect");
  assert.equal(s.isArmed("vta"), true, "but still trying");

  mediatorUp = true;
  await clock.advance(64_000);
  assert.equal(connects, 1, "recovers without a worker reboot");
  assert.equal(s.isArmed("vta"), false, "and stops retrying once connected");
});

test("success resets the delay, so the next outage starts from the base", async () => {
  const clock = fakeTimers();
  let up = false;
  const s = new ReconnectScheduler({
    baseMs: 2_000,
    maxMs: 60_000,
    attempt: async () => up,
    timers: clock.timers,
  });

  s.schedule("vta");
  await clock.advance(14_000); // fail a few times, growing the delay
  up = true;
  await clock.advance(60_000); // connect
  assert.equal(s.isArmed("vta"), false);

  up = false;
  s.schedule("vta"); // next outage
  assert.equal(s.pendingDelayMs("vta"), 2_000, "must not inherit the grown delay");
});

test("timers never stack for one key", async () => {
  const clock = fakeTimers();
  let attempts = 0;
  const s = new ReconnectScheduler({
    baseMs: 2_000,
    maxMs: 60_000,
    attempt: async () => {
      attempts++;
      return false;
    },
    timers: clock.timers,
  });

  s.schedule("vta");
  s.schedule("vta");
  s.schedule("vta");
  assert.equal(clock.pending(), 1, "three schedules, one timer");
  await clock.advance(2_000);
  assert.equal(attempts, 1);
});

test("shouldRetry=false abandons the loop — a lock beats a retry in flight", async () => {
  // The operator locking the approver must win: resurrecting the session would
  // defeat an explicit security act.
  const clock = fakeTimers();
  let unlocked = true;
  let attempts = 0;
  const s = new ReconnectScheduler({
    baseMs: 2_000,
    maxMs: 60_000,
    attempt: async () => {
      attempts++;
      unlocked = false; // locked during the attempt
      return false;
    },
    shouldRetry: () => unlocked,
    timers: clock.timers,
  });

  s.schedule("vta");
  await clock.advance(2_000);
  assert.equal(attempts, 1);
  assert.equal(s.isArmed("vta"), false, "must not re-arm after a lock");

  await clock.advance(60_000);
  assert.equal(attempts, 1, "and must never attempt again");
});

test("scheduling while already locked does not arm anything", async () => {
  const clock = fakeTimers();
  let attempts = 0;
  const s = new ReconnectScheduler({
    baseMs: 2_000,
    maxMs: 60_000,
    attempt: async () => {
      attempts++;
      return false;
    },
    shouldRetry: () => false,
    timers: clock.timers,
  });

  s.schedule("vta");
  assert.equal(clock.pending(), 0);
  await clock.advance(60_000);
  assert.equal(attempts, 0);
});

test("clear() cancels a queued retry and a retry in flight cannot revive it", async () => {
  const clock = fakeTimers();
  let attempts = 0;
  let release;
  const gate = new Promise((r) => (release = r));
  const s = new ReconnectScheduler({
    baseMs: 2_000,
    maxMs: 60_000,
    attempt: async () => {
      attempts++;
      await gate; // still in flight when clear() lands
      return false;
    },
    timers: clock.timers,
  });

  s.schedule("vta");
  await clock.advance(2_000);
  assert.equal(attempts, 1);
  s.clear("vta"); // cancelled mid-attempt
  release();
  await new Promise((r) => setImmediate(r));
  assert.equal(s.isArmed("vta"), false, "a cancelled backoff must stay cancelled");

  await clock.advance(60_000);
  assert.equal(attempts, 1);
});

test("independent keys back off independently", async () => {
  const clock = fakeTimers();
  const attempts = { a: 0, b: 0 };
  const s = new ReconnectScheduler({
    baseMs: 2_000,
    maxMs: 60_000,
    attempt: async (key) => {
      attempts[key]++;
      return key === "b"; // b connects, a keeps failing
    },
    timers: clock.timers,
  });

  s.schedule("a");
  s.schedule("b");
  await clock.advance(2_000);
  assert.deepEqual(attempts, { a: 1, b: 1 });
  assert.equal(s.isArmed("a"), true, "a is still retrying");
  assert.equal(s.isArmed("b"), false, "b connected and stopped");
});
