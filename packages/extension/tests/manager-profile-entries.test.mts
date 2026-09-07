// What a profile presents after an edit.
//
// The console's profile editor can express one of the four entry forms — a live
// reference — and has to carry the other three through an edit without changing
// what they say. Both failure modes are silent: the profile saves, keeps its
// name, keeps working, and presents a different set of claims than the operator
// ticked. Nothing surfaces until a disclosure.
//
// So the composition is a pure function and this file is the thing that tests
// it. Every assertion here has a paired positive: "the pinned entry survives"
// is worthless next to a composer that returns its input, and "the ticks are
// written" is worthless next to one that writes everything.

import { test } from "node:test";
import assert from "node:assert/strict";

import {
  composeEntries,
  isPlainRef,
  lockedRefs,
  preservedEntries,
  refOf,
  tickedFrom,
} from "../src/manager/profile-entries.ts";

/** One of each of the four forms, so nothing here can pass by only ever seeing
 *  the easy one. */
const LIVE = { ref: "a-live" };
const PINNED = { ref: "a-pinned", pinVersion: 3 };
const OVERRIDDEN = { ref: "a-overridden", override: { value: "different here" } };
const INLINE = {
  inline: {
    type: "note",
    valueType: "string" as const,
    value: "held only by this profile",
    provenance: { kind: "selfAsserted" as const },
  },
};
const ALL = [LIVE, PINNED, OVERRIDDEN, INLINE];

test("the four forms are told apart by shape, not by whether they have a ref", () => {
  assert.equal(isPlainRef(LIVE), true);
  // The two that make "has a ref" the wrong test.
  assert.equal(isPlainRef(PINNED), false);
  assert.equal(isPlainRef(OVERRIDDEN), false);
  assert.equal(isPlainRef(INLINE), false);

  assert.equal(refOf(PINNED), "a-pinned");
  assert.equal(refOf(INLINE), null, "an inline value names no pool attribute");
});

test("only live references start ticked", () => {
  assert.deepEqual(tickedFrom(ALL), ["a-live"]);
});

test("everything the editor cannot express is preserved", () => {
  assert.deepEqual(preservedEntries(ALL), [PINNED, OVERRIDDEN, INLINE]);
});

test("an unchanged edit round-trips the profile exactly", () => {
  // The whole point, and the case both bugs looked fine in. Open a profile,
  // change nothing, save: what comes out must be what went in — one entry per
  // attribute, all four forms intact.
  const out = composeEntries(ALL, tickedFrom(ALL));
  assert.equal(out.length, ALL.length, `expected ${ALL.length} entries, got ${out.length}`);
  for (const entry of ALL) {
    assert.ok(
      out.some((e) => JSON.stringify(e) === JSON.stringify(entry)),
      `${JSON.stringify(entry)} did not survive an unchanged edit`,
    );
  }
});

test("no attribute is ever named twice", () => {
  // The duplicate bug: a pinned entry has a `ref`, so seeding the ticks from
  // every ref ticks its attribute AND carries the pinned entry through. The
  // profile then presents one fact through two entries, from an edit in which
  // the operator touched nothing.
  const ticked = ["a-live", "a-pinned", "a-overridden"];
  const out = composeEntries(ALL, ticked);
  const refs = out.map(refOf).filter((r): r is string => r !== null);
  assert.equal(new Set(refs).size, refs.length, `duplicated: ${refs.join(", ")}`);

  // …and the preserved form is the one that survives, not the live one it
  // would have been flattened to. A pinned entry replaced by a live reference
  // is a profile that starts presenting a version the holder pinned away from.
  assert.deepEqual(
    out.find((e) => refOf(e) === "a-pinned"),
    PINNED,
  );
});

test("unticking a live reference removes it", () => {
  const out = composeEntries(ALL, []);
  assert.equal(
    out.some((e) => refOf(e) === "a-live"),
    false,
    "an untick that does not remove the entry makes the tick list decorative",
  );
  // Paired: the three it cannot express are NOT removed by the same untick.
  assert.deepEqual(out, [PINNED, OVERRIDDEN, INLINE]);
});

test("ticking a new attribute adds a live reference", () => {
  const out = composeEntries([LIVE], ["a-live", "a-new"]);
  assert.deepEqual(out, [{ ref: "a-live" }, { ref: "a-new" }]);
});

test("a locked tick cannot smuggle a second entry in", () => {
  // `lockedRefs` is what the UI disables. If it and `composeEntries` ever
  // disagreed, the box would be clickable and the click would duplicate — so
  // the composer drops a locked ref regardless of what the UI sent.
  assert.deepEqual([...lockedRefs(ALL)].sort(), ["a-overridden", "a-pinned"]);
  const out = composeEntries(ALL, ["a-pinned"]);
  assert.equal(out.filter((e) => refOf(e) === "a-pinned").length, 1);
});

test("a profile with nothing to preserve composes exactly the ticks", () => {
  // Without this the assertions above are satisfied by a composer that always
  // returns `existing`.
  assert.deepEqual(composeEntries([], ["x", "y"]), [{ ref: "x" }, { ref: "y" }]);
  assert.deepEqual(composeEntries([LIVE], []), []);
});

test("a repeated tick is written once", () => {
  assert.deepEqual(composeEntries([], ["x", "x"]), [{ ref: "x" }]);
});
