// The manifest limits that are silent locally and fatal at upload.
//
// Chrome loads an unpacked extension whose `description` runs past 132
// characters without a word of complaint, so nothing in the dev loop catches
// it — the Web Store rejects the upload instead. `assertStoreListingLimits`
// exists to move that failure to build time; these tests exist so the guard
// itself cannot quietly stop guarding.

import { test } from "node:test";
import assert from "node:assert/strict";

// @ts-expect-error — plain .mjs helper, no type declarations
import { assertStoreListingLimits, buildManifest } from "../scripts/manifest.mjs";

test("accepts a description at the 132-character limit", () => {
  assertStoreListingLimits({ name: "VTA Wallet", description: "d".repeat(132) });
});

test("rejects a description one character over", () => {
  assert.throws(
    () => assertStoreListingLimits({ name: "VTA Wallet", description: "d".repeat(133) }),
    /133 characters/,
  );
});

test("rejects a name over 75 characters", () => {
  assert.throws(
    () => assertStoreListingLimits({ name: "n".repeat(76), description: "ok" }),
    /caps it at 75/,
  );
});

test("the real manifest is within both limits", () => {
  // buildManifest runs the guard itself, so this fails loudly if the shipped
  // template ever drifts past a limit.
  const m = buildManifest({ includeKey: false });
  assert.ok(m.description.length <= 132, `description is ${m.description.length} chars`);
  assert.ok(m.name.length <= 75);
});
