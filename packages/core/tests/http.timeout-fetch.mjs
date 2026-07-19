import { test } from "node:test";
import assert from "node:assert/strict";

import {
  withFetchTimeout,
  isFetchTimeout,
  DEFAULT_FETCH_TIMEOUT_MS,
} from "../dist/http/timeout-fetch.js";
import { registerPushChannel } from "../dist/index.js";

/** A fetch that never resolves until its signal aborts — a blackholed VTA.
 *  This is the case an unbounded fetch waits on forever.
 *
 *  The `keepAlive` interval is load-bearing, not defensive noise. Node unrefs
 *  the timer behind `AbortSignal.timeout`, so a pending abort does NOT hold the
 *  event loop open. With nothing else queued the process can drain and exit
 *  before the deadline fires, and the runner reports every test in the file as
 *  "Promise resolution is still pending but the event loop has already
 *  resolved". That is exactly what happened on CI while this file passed
 *  locally — the local run had other work in flight to keep the loop alive. A
 *  ref'd timer removes the dependency on that accident. */
function blackhole() {
  return (_input, init) =>
    new Promise((_resolve, reject) => {
      const keepAlive = setInterval(() => {}, 1_000);
      init?.signal?.addEventListener("abort", () => {
        clearInterval(keepAlive);
        reject(init.signal.reason);
      });
    });
}

test("a blackholed peer aborts instead of hanging forever", async () => {
  const f = withFetchTimeout(blackhole(), 25);
  const err = await f("https://vta.example/x").then(
    () => null,
    (e) => e,
  );
  assert.ok(err, "must reject rather than hang");
  assert.equal(isFetchTimeout(err), true, "and be identifiable as a timeout");
});

test("isFetchTimeout matches the platform's stable name, not message text", async () => {
  assert.equal(isFetchTimeout(new DOMException("whatever", "TimeoutError")), true);
  // An ordinary abort is NOT a timeout — conflating them would make a user
  // cancellation look like an unreachable VTA.
  assert.equal(isFetchTimeout(new DOMException("aborted", "AbortError")), false);
  assert.equal(isFetchTimeout(new Error("timed out")), false, "no string matching");
  assert.equal(isFetchTimeout(undefined), false);
});

test("a fast response is untouched by the timeout", async () => {
  const f = withFetchTimeout(async () => new Response("ok", { status: 200 }), 10_000);
  const res = await f("https://vta.example/x");
  assert.equal(res.status, 200);
  assert.equal(await res.text(), "ok");
});

test("a signal is always attached, even when the caller passed no init", async () => {
  let seen;
  const f = withFetchTimeout(async (_i, init) => {
    seen = init?.signal;
    return new Response("ok");
  });
  await f("https://vta.example/x");
  assert.ok(seen instanceof AbortSignal, "every request must carry a deadline");
  assert.equal(seen.aborted, false);
});

test("the caller's own signal still cancels — the timeout does not replace it", async () => {
  // Dropping a caller's signal would silently disable their cancellation:
  // a worse bug than the one being fixed.
  const controller = new AbortController();
  // Long enough that the caller's abort clearly wins, short enough that the
  // pending timer doesn't linger on the event loop after the test.
  const f = withFetchTimeout(blackhole(), 500);
  const p = f("https://vta.example/x", { signal: controller.signal });
  controller.abort(new DOMException("user cancelled", "AbortError"));
  const err = await p.then(
    () => null,
    (e) => e,
  );
  assert.equal(err?.name, "AbortError", "caller's abort must win");
  assert.equal(isFetchTimeout(err), false, "and must not look like a timeout");
});

test("the timeout still fires when the caller supplied a signal it never aborts", async () => {
  const controller = new AbortController(); // never aborted
  const f = withFetchTimeout(blackhole(), 25);
  const err = await f("https://vta.example/x", { signal: controller.signal }).then(
    () => null,
    (e) => e,
  );
  assert.equal(isFetchTimeout(err), true, "combining must not lose the deadline");
});

test("other init fields survive the wrapper", async () => {
  let seen;
  const f = withFetchTimeout(async (_i, init) => {
    seen = init;
    return new Response("ok");
  });
  await f("https://vta.example/x", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: '{"a":1}',
  });
  assert.equal(seen.method, "POST");
  assert.equal(seen.body, '{"a":1}');
  assert.equal(seen.headers["content-type"], "application/json");
});

test("the default bound is finite and shared with the extension proxy", () => {
  assert.ok(Number.isFinite(DEFAULT_FETCH_TIMEOUT_MS));
  assert.equal(DEFAULT_FETCH_TIMEOUT_MS, 20_000);
});

test("falls back to the global fetch when no impl is injected", async () => {
  // The production call is `withFetchTimeout(opts.fetch)` where `opts.fetch`
  // is usually undefined — that path must still produce a working, bounded
  // fetch. Stub the global rather than making a real request: a genuinely
  // unroutable address leaves a socket pending long after the abort, which
  // would add ~10s to every CI run.
  const original = globalThis.fetch;
  let seenUrl;
  let seenSignal;
  globalThis.fetch = async (input, init) => {
    seenUrl = String(input);
    seenSignal = init?.signal;
    return new Response("ok");
  };
  try {
    const f = withFetchTimeout(undefined, 1_000);
    const res = await f("https://vta.example/x");
    assert.equal(await res.text(), "ok");
    assert.equal(seenUrl, "https://vta.example/x");
    assert.ok(seenSignal instanceof AbortSignal, "the fallback path is bounded too");
  } finally {
    globalThis.fetch = original;
  }
});

// ── Wiring ───────────────────────────────────────────────────────────────────
// The helper being correct is not the same as it being APPLIED. These assert
// that a real exported call path actually hands a deadline to the underlying
// fetch — the injection-point wrapping, not the wrapper itself.

test("registerPushChannel bounds its request (R1.2 wiring)", async () => {
  let seenSignal = "absent";
  const fetchStub = async (_url, init) => {
    seenSignal = init?.signal;
    return {
      ok: true,
      json: async () => ({
        type: "https://trusttasks.org/spec/push/register/0.2#response",
        payload: { wakeHandle: { gateway: "https://gw.example", handle: "z6MkHandle" } },
      }),
    };
  };

  await registerPushChannel({
    gatewayUrl: "https://gw.example",
    registration: {
      platform: "webpush",
      endpoint: "https://push.example/abc",
      keys: { p256dh: "p256dh-key", auth: "auth-secret" },
    },
    controllerVtaDid: "did:webvh:example:vta",
    fetch: fetchStub,
  });

  assert.ok(
    seenSignal instanceof AbortSignal,
    "an injected fetch must still receive a deadline — otherwise the wrapper " +
      "was never applied at the injection point",
  );
  assert.equal(seenSignal.aborted, false);
});
