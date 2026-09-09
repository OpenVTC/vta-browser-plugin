// The marks a world can wear, and the bound they have to fit.
//
// The grid is hand-picked, and a hand-picked list of emoji is exactly the kind
// of thing that acquires a joined sequence one day and starts handing holders a
// refusal after they press Save. So the bound is asserted rather than trusted.

import { test } from "node:test";
import assert from "node:assert/strict";
import { WORLD_MARKS, MAX_MARK_LENGTH, markFits } from "../src/manager/world-marks.ts";

test("every offered mark fits what the agent will store", () => {
  // The published `maxLength` on `persona/facet/put`'s `icon`, measured the way
  // a JSON Schema validator measures it — UTF-16 code units, not bytes and not
  // grapheme clusters.
  for (const m of WORLD_MARKS) {
    assert.ok(
      markFits(m),
      `${JSON.stringify(m)} is ${m.length} units, over the bound of ${MAX_MARK_LENGTH}`,
    );
  }
});

test("a joined sequence is refused, which is why the grid avoids them", () => {
  // The case the grid exists to keep out of the picker: a family emoji is six
  // code points joined by zero-width joiners. Offering one would hand the
  // holder a refusal at the moment they pressed Save.
  assert.equal(markFits("\u{1F468}‍\u{1F469}‍\u{1F467}‍\u{1F466}"), false);
  assert.equal(markFits(""), false, "an empty mark is not a mark");
});

test("two ordinary emoji still fit, so the bound is not accidentally one", () => {
  assert.ok(markFits("\u{1F4BC}\u{1F3E0}"));
});

test("no mark carries a status meaning", () => {
  // A tick, a cross or a warning triangle would put a judgement on a part of
  // somebody's life — and would collide with the one channel in this console
  // that means something.
  const status = ["✅", "❌", "⚠", "❗", "\u{1F6D1}", "✔", "✖"];
  for (const s of status) {
    assert.ok(!WORLD_MARKS.includes(s), `${JSON.stringify(s)} carries a status meaning`);
  }
});

test("the grid offers no duplicates", () => {
  assert.equal(new Set(WORLD_MARKS).size, WORLD_MARKS.length);
});
