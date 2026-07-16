// Unit tests for the approver-surface effect diff formatting.
//
// The approver popup renders these strings verbatim, and a human bases an
// irreversible, biometric-gated approval on them — so "added" must never look
// like "unchanged", a giant document must not flood the popup, and a
// non-serialisable value must not throw and blank the screen.

import { test } from "node:test";
import assert from "node:assert/strict";

import {
  formatEffectValue,
  effectHasDiff,
  effectDiffView,
  EFFECT_VALUE_MAX,
  ABSENT_VALUE,
} from "../dist/inbound/effect-format.js";

test("strings pass through verbatim", () => {
  assert.equal(formatEffectValue("did:example:123"), "did:example:123");
  assert.equal(formatEffectValue(""), "");
});

test("non-strings render as compact JSON", () => {
  assert.equal(formatEffectValue(["a", "b"]), '["a","b"]');
  assert.equal(formatEffectValue({ x: 1 }), '{"x":1}');
  assert.equal(formatEffectValue(42), "42");
  assert.equal(formatEffectValue(true), "true");
});

test("an absent value renders as a concrete marker, not an empty string", () => {
  // The whole point: removed (value → ∅) must be visibly different from added.
  assert.equal(formatEffectValue(undefined), ABSENT_VALUE);
  assert.notEqual(formatEffectValue(undefined), "");
});

test("long values are truncated with an ellipsis", () => {
  const big = "x".repeat(EFFECT_VALUE_MAX + 50);
  const out = formatEffectValue(big);
  assert.equal(out.length, EFFECT_VALUE_MAX + 1); // + the ellipsis char
  assert.ok(out.endsWith("…"));
  assert.ok(out.startsWith("x"));
});

test("a value exactly at the cap is not truncated", () => {
  const exact = "y".repeat(EFFECT_VALUE_MAX);
  assert.equal(formatEffectValue(exact), exact);
});

test("a non-serialisable value falls back to String() instead of throwing", () => {
  const cyclic = {};
  cyclic.self = cyclic;
  // Must not throw — a thrown formatter would blank the approval screen.
  const out = formatEffectValue(cyclic);
  assert.equal(typeof out, "string");
  assert.ok(out.length > 0);
});

test("effectHasDiff is true when any of path/before/after is set", () => {
  assert.equal(effectHasDiff({ path: "service" }), true);
  assert.equal(effectHasDiff({ before: "a" }), true);
  assert.equal(effectHasDiff({ after: "b" }), true);
  assert.equal(effectHasDiff({}), false);
});

test("effectDiffView returns null for a summary-only effect", () => {
  assert.equal(effectDiffView({ kind: "note", summary: "just a note" }), null);
});

test("effectDiffView projects a change (before → after)", () => {
  const view = effectDiffView({
    kind: "keyRotation",
    summary: "rotates the update key",
    path: "updateKeys",
    before: ["z6MkOld"],
    after: ["z6MkNew"],
  });
  assert.deepEqual(view, {
    path: "updateKeys",
    before: '["z6MkOld"]',
    after: '["z6MkNew"]',
  });
});

test("effectDiffView marks an addition (no before) and a removal (no after)", () => {
  const added = effectDiffView({
    kind: "serviceAdd",
    summary: "adds a service",
    path: "service.#files",
    after: "https://files.example.com",
  });
  assert.equal(added.before, undefined, "an addition has no before side");
  assert.equal(added.after, "https://files.example.com");

  const removed = effectDiffView({
    kind: "serviceRemove",
    summary: "removes a service",
    path: "service.#files",
    before: "https://files.example.com",
  });
  assert.equal(removed.after, undefined, "a removal has no after side");
  assert.equal(removed.before, "https://files.example.com");
});
