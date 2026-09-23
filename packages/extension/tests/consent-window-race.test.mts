// Keyring VTI-40: an Approve that became a Deny because the consent window's
// removal reached the background before the popup's result did.
//
// The fix has two halves, and each is tested on its own terms:
//
//   - the popup awaits the result's acknowledgement before closing
//     (`consent-result.ts`), so a well-behaved popup is never removed first;
//   - the background's close-means-deny waits a grace period
//     (`consent-window.ts`), so a result already in flight still wins if it is.
//
// The chrome APIs are replaced with a small in-memory stand-in that lets each
// test choose the order events reach the worker — which is the whole bug.

import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import {
  CLOSE_GRACE_MS,
  deliverConsentResult,
  openConsentWindow,
  type ConsentDecision,
  type ConsentWindowDeps,
} from "../src/consent-window.ts";
import { consentResultSender } from "../src/consent-result.ts";
import { RUNTIME_CONSENT_RESULT } from "../src/bridge-protocol.ts";

// ── chrome stand-ins ─────────────────────────────────────────────────────────

/** `chrome.windows`, plus a manual timer queue so the grace is stepped, not slept. */
function fakeChrome(opts: { createFails?: boolean } = {}) {
  const listeners = new Set<(id: number) => void>();
  const timers: Array<() => void> = [];
  let nextId = 100;
  const opened: number[] = [];
  const deps: ConsentWindowDeps = {
    windows: {
      create(_data, cb) {
        if (opts.createFails) return cb(undefined);
        const id = nextId++;
        opened.push(id);
        cb({ id });
      },
      onRemoved: {
        addListener: (l) => void listeners.add(l),
        removeListener: (l) => void listeners.delete(l),
      },
    },
    lastError: () => (opts.createFails ? "simulated failure" : undefined),
    setTimer: (fn, ms) => {
      assert.equal(ms, CLOSE_GRACE_MS);
      timers.push(fn);
    },
    graceMs: CLOSE_GRACE_MS,
  };
  return {
    deps,
    opened,
    listenerCount: () => listeners.size,
    /** The browser reports a window gone. */
    remove(id: number) {
      for (const l of [...listeners]) l(id);
    },
    /** The grace period elapses. */
    elapse() {
      for (const fn of timers.splice(0)) fn();
    },
  };
}

/** A consent shaped exactly as the background builds one: an idempotent
 *  `settle`, registered in `pendingConsents`, with the window's close wired to
 *  a denial through `openConsentWindow`. */
function raiseConsent(chromeFake: ReturnType<typeof fakeChrome>, pending: Map<string, ConsentDecision>) {
  const consentId = crypto.randomUUID();
  const outcome: { approved?: boolean; settles: number } = { settles: 0 };
  let settled = false;
  const settle = (approved: boolean) => {
    if (settled) return;
    settled = true;
    outcome.settles++;
    pending.delete(consentId);
    outcome.approved = approved;
  };
  pending.set(consentId, (approved) => settle(approved));
  openConsentWindow(
    {
      url: `chrome-extension://x/confirm.html?cid=${consentId}`,
      bounds: { width: 480, height: 560 },
      deny: () => settle(false),
      tag: "[test]",
      what: "consent window",
    },
    chromeFake.deps,
  );
  return { consentId, outcome, winId: chromeFake.opened.at(-1)! };
}

// Keep the helper's logging out of the test output.
const quiet = () => {
  const { info, error } = console;
  console.info = () => {};
  console.error = () => {};
  return () => {
    console.info = info;
    console.error = error;
  };
};

// ── the background half ──────────────────────────────────────────────────────

test("VTI-40: approve racing the window's removal — the approval wins", () => {
  const restore = quiet();
  try {
    const c = fakeChrome();
    const pending = new Map<string, ConsentDecision>();
    const { consentId, outcome, winId } = raiseConsent(c, pending);

    // The bad order: removal reaches the worker before the result.
    c.remove(winId);
    assert.equal(outcome.settles, 0, "the removal must not deny on arrival");

    assert.equal(deliverConsentResult(pending, { consentId, approved: true }), true);
    c.elapse();

    assert.equal(outcome.approved, true);
    assert.equal(outcome.settles, 1);
  } finally {
    restore();
  }
});

test("approve in the expected order — result, then removal — stays approved", () => {
  const restore = quiet();
  try {
    const c = fakeChrome();
    const pending = new Map<string, ConsentDecision>();
    const { consentId, outcome, winId } = raiseConsent(c, pending);

    deliverConsentResult(pending, { consentId, approved: true });
    c.remove(winId);
    c.elapse();

    assert.equal(outcome.approved, true);
    assert.equal(outcome.settles, 1);
  } finally {
    restore();
  }
});

test("a window closed without a decision settles as a denial, after the grace", () => {
  const restore = quiet();
  try {
    const c = fakeChrome();
    const pending = new Map<string, ConsentDecision>();
    const { outcome, winId } = raiseConsent(c, pending);

    c.remove(winId);
    assert.equal(outcome.approved, undefined, "still waiting inside the grace");
    c.elapse();

    assert.equal(outcome.approved, false);
    assert.equal(pending.size, 0, "the pending entry is released");
    assert.equal(c.listenerCount(), 0, "the onRemoved listener is released");
  } finally {
    restore();
  }
});

test("a result arriving after the grace cannot overturn the denial", () => {
  const restore = quiet();
  try {
    const c = fakeChrome();
    const pending = new Map<string, ConsentDecision>();
    const { consentId, outcome, winId } = raiseConsent(c, pending);

    c.remove(winId);
    c.elapse();
    assert.equal(deliverConsentResult(pending, { consentId, approved: true }), false);
    assert.equal(outcome.approved, false);
  } finally {
    restore();
  }
});

test("another window closing does not touch the consent", () => {
  const restore = quiet();
  try {
    const c = fakeChrome();
    const pending = new Map<string, ConsentDecision>();
    const { outcome, winId } = raiseConsent(c, pending);

    c.remove(winId + 999);
    c.elapse();
    assert.equal(outcome.settles, 0);
    assert.equal(c.listenerCount(), 1);
  } finally {
    restore();
  }
});

test("a window that could not be opened settles as a denial at once", () => {
  const restore = quiet();
  try {
    const c = fakeChrome({ createFails: true });
    const pending = new Map<string, ConsentDecision>();
    const { outcome } = raiseConsent(c, pending);
    assert.equal(outcome.approved, false);
    assert.equal(c.listenerCount(), 0);
  } finally {
    restore();
  }
});

test("disclosure consent: a closed window settles as a denial", () => {
  // The disclosure surface used to register no onRemoved at all, so a prompt
  // closed with the X hung forever. It now goes through `openConsentWindow`
  // like the others; this is its settle, shape for shape.
  const restore = quiet();
  try {
    const c = fakeChrome();
    const pending = new Map<string, ConsentDecision>();
    const consentId = crypto.randomUUID();
    let result: boolean | undefined;
    let settled = false;
    const settle = (approved: boolean) => {
      if (settled) return;
      settled = true;
      pending.delete(consentId);
      result = approved;
    };
    pending.set(consentId, (approved) => settle(approved));
    openConsentWindow(
      {
        url: `chrome-extension://x/confirm.html?cid=${consentId}&kind=disclosure`,
        bounds: { width: 480, height: 680 },
        deny: () => settle(false),
        tag: "[pnm disclose]",
        what: "disclosure window",
      },
      c.deps,
    );

    c.remove(c.opened[0]!);
    c.elapse();
    assert.equal(result, false);
    assert.equal(pending.size, 0);
  } finally {
    restore();
  }
});

test("every consent surface in the background opens its window through openConsentWindow", () => {
  // The helper is only a fix if nothing goes around it. Each of the three
  // raisers must use it, and no consent window may wire its own onRemoved —
  // that is the immediate-denial shape VTI-40 was.
  const src = readFileSync(new URL("../src/background.ts", import.meta.url), "utf8");
  for (const fn of ["requestConsent", "raiseDisclosureConsent", "requestTaskConsent"]) {
    const at = src.indexOf(`async function ${fn}(`);
    assert.ok(at >= 0, `${fn} exists`);
    const next = src.indexOf("\nasync function ", at + 1);
    const body = src.slice(at, next < 0 ? undefined : next);
    assert.match(body, /openConsentWindow\(/, `${fn} opens its window through openConsentWindow`);
  }
  assert.doesNotMatch(src, /chrome\.windows\.onRemoved/, "no consent window wires its own onRemoved");
  assert.doesNotMatch(src, /chrome\.windows\.create\(/, "no consent window is created outside the helper");
  // The result handler must acknowledge, or the popup's await has nothing to wait for.
  const handler = src.slice(src.indexOf("=== RUNTIME_CONSENT_RESULT"));
  assert.match(handler.slice(0, 600), /deliverConsentResult\([\s\S]*?sendResponse\(/);
});

// ── the popup half ───────────────────────────────────────────────────────────

test("the popup closes only after the result is acknowledged", async () => {
  const events: string[] = [];
  let ack!: () => void;
  const send = consentResultSender("cid-1", {
    send: (m) => {
      events.push(`send:${m.approved}`);
      return new Promise<void>((r) => (ack = () => (events.push("ack"), r())));
    },
    close: () => events.push("close"),
  });

  const done = send({ approved: true, remember: false });
  await Promise.resolve();
  assert.deepEqual(events, ["send:true"], "must not close while the result is unacknowledged");
  ack();
  await done;
  assert.deepEqual(events, ["send:true", "ack", "close"]);
});

test("the popup still closes when the send fails", async () => {
  const events: string[] = [];
  const reject = consentResultSender("cid-2", {
    send: () => Promise.reject(new Error("Receiving end does not exist")),
    close: () => events.push("close"),
  });
  await reject({ approved: true });
  const thrower = consentResultSender("cid-3", {
    send: () => {
      throw new Error("Extension context invalidated");
    },
    close: () => events.push("close"),
  });
  await thrower({ approved: true });
  assert.deepEqual(events, ["close", "close"]);
});

test("the popup reports one decision, even if clicked twice during the round trip", async () => {
  const sent: boolean[] = [];
  const send = consentResultSender("cid-4", {
    send: async (m) => void sent.push(m.approved),
    close: () => {},
  });
  await Promise.all([send({ approved: true }), send({ approved: false })]);
  assert.deepEqual(sent, [true]);
});

test("the popup's message carries the consent id and the decision fields", async () => {
  let got: unknown;
  const send = consentResultSender("cid-5", {
    send: async (m) => void (got = m),
    close: () => {},
  });
  await send({ approved: true, remember: true, selectedDid: "did:key:z6Mk" });
  assert.deepEqual(got, {
    type: RUNTIME_CONSENT_RESULT,
    consentId: "cid-5",
    approved: true,
    remember: true,
    selectedDid: "did:key:z6Mk",
  });
});
