// UTS #39 `skeleton()` over Unicode's own confusables data (trust-tasks-tf #1038,
// *Showing a name*): what tells look-alike member names apart.

import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

import { confusable, skeleton, CONFUSABLES_VERSION } from "../dist/rooms/index.js";
import { CONFUSABLES_COUNT, CONFUSABLES_DATA, CONFUSABLES_SHA256 } from "../dist/rooms/confusables-data.js";

test("the data is the whole published confusables.txt, by its recorded digest", () => {
  assert.equal(CONFUSABLES_VERSION, "16.0.0");
  const script = readFileSync(resolve(import.meta.dirname, "../scripts/sync-confusables.mjs"), "utf8");
  assert.ok(script.includes(`const SHA256 = "${CONFUSABLES_SHA256}"`), "the module and its generator record the same source");
  const entries = CONFUSABLES_DATA.join(",").split(",");
  assert.equal(entries.length, CONFUSABLES_COUNT);
  assert.ok(CONFUSABLES_COUNT > 6000, "every mapping, not a selection");
  assert.equal(new Set(entries.map((e) => e.split(":")[0])).size, entries.length, "each source mapped once");
});

test("skeleton: look-alikes from other scripts map to one prototype", () => {
  assert.equal(skeleton("а"), "a", "Cyrillic а → Latin a");
  assert.ok(confusable("paypal", "pаypаl"));
  assert.ok(confusable("Alice", "Аlice"), "Cyrillic А");
  assert.ok(confusable("m", "rn"), "rn reads as m");
  assert.ok(confusable("0", "O"), "digit zero and capital O");
  assert.ok(confusable("l", "1"), "ell and one");
});

test("skeleton: names that do not look alike stay apart", () => {
  assert.ok(!confusable("Alice", "Alicia"));
  assert.ok(!confusable("Bob", "Rob"));
});

test("skeleton: default-ignorable code points are removed, and the result is NFD", () => {
  assert.equal(skeleton("a​b"), skeleton("ab"), "a zero-width space does not hide a match");
  assert.equal(skeleton("é"), skeleton("é"), "composed and decomposed agree");
  assert.equal(skeleton("x").normalize("NFD"), skeleton("x"));
});
