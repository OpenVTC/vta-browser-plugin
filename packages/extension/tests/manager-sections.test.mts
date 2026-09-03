// Three lists describe the console's navigation, and they must agree.
//
// `SectionId` (the union), `ACTS` (what the nav renders), and the `switch` in
// `renderPane` (what each id draws). Nothing forces them together: the union
// makes the *switch* exhaustive, so a case cannot name an id that does not
// exist — but neither the compiler nor any existing test notices an id that is
// in the union and the nav and has **no case**.
//
// That is the asymmetry worth guarding. The failure is silent: the section
// appears in the sidebar, the operator clicks it, and the pane renders nothing
// at all. No error, no console message, no failed request — a blank column that
// reads as "this agent has none of those" rather than as a bug. It is the same
// shape as the pane that died on an `unknown field` error, except quieter,
// because at least that one said something.
//
// Reads the source rather than importing it: `shell.tsx` pulls in every pane,
// and those reach `chrome` at module scope. Same approach as
// `manager-surface.test.mts`, for the same reason.

import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

const SRC = readFileSync(
  fileURLToPath(new URL("../src/manager/shell.tsx", import.meta.url)),
  "utf8",
);

const all = (re: RegExp) => [...SRC.matchAll(re)].map((m) => m[1] as string);

/** The `SectionId` union members. */
const union = () => {
  const block = /export type SectionId =([\s\S]*?);/.exec(SRC);
  assert.ok(block, "could not find the SectionId union — has it been renamed?");
  return [...block[1]!.matchAll(/"([a-z-]+)"/g)].map((m) => m[1] as string);
};

/** What the nav renders. */
const sections = () => all(/\{\s*id:\s*"([a-z-]+)",\s*label:/g);

/** What `renderPane` draws. */
const cases = () => all(/^\s+case "([a-z-]+)":/gm);

const sorted = (xs: string[]) => [...xs].sort();

test("the section list is not empty, so none of this passes vacuously", () => {
  assert.ok(sections().length > 8, `found only ${sections().length} sections — the regex is stale`);
  assert.ok(cases().length > 8, `found only ${cases().length} cases — the regex is stale`);
});

test("every section the nav renders has a pane to draw", () => {
  const missing = sections().filter((id) => !cases().includes(id));
  assert.deepEqual(
    missing,
    [],
    `these sections appear in the sidebar and render nothing when clicked: ${missing.join(", ")}. ` +
      `The union makes the switch exhaustive over ids that EXIST, so nothing else catches an id ` +
      `that was added to the nav without a case.`,
  );
});

test("every pane is reachable from the nav", () => {
  const orphaned = cases().filter((id) => !sections().includes(id));
  assert.deepEqual(
    orphaned,
    [],
    `these panes can never be shown, because no section selects them: ${orphaned.join(", ")}. ` +
      `Either add the section or delete the pane — a pane nothing routes to is code that ` +
      `reads as live and is not.`,
  );
});

test("the union, the nav and the switch name the same set", () => {
  assert.deepEqual(sorted(union()), sorted(sections()), "SectionId and the nav disagree");
  assert.deepEqual(sorted(union()), sorted(cases()), "SectionId and renderPane disagree");
});

test("no section id is declared twice", () => {
  const seen = sections();
  assert.equal(
    new Set(seen).size,
    seen.length,
    `a duplicate section id renders two identical-looking entries and the second is unreachable: ${seen.join(", ")}`,
  );
});
