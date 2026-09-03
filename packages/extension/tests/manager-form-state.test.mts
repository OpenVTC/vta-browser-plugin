// A form seeded from a prop must be keyed on that prop's identity.
//
// ## The bug this exists for
//
// `EditContext` seeds its fields with `useState(record.name)`. That runs on
// mount and never again. The context detail panel is a *single* instance that
// swaps records as the operator moves through the tree, so React reused it —
// and every context showed the FIRST context's name, in an editable field,
// sitting directly above the correct id, DID and timestamps.
//
// It reads as a display glitch and is not one. The field is the input to
// `contextsUpdate`, so an operator pressing Save would have renamed the context
// they were looking at to the name of one they were not — a write, from a
// screen that showed them the right record everywhere else.
//
// Nothing could have caught it. It typechecks, every unit test passes, and the
// panel renders perfectly for whichever context you happen to open first.
//
// ## The rule
//
// If a component seeds state from a prop, its call sites must either pass
// `key`, or be listed in [`KEYED_ELSEWHERE`] with the reason. There is one
// legitimate reason today: `Table` renders per-row editors under `rowKey`, so
// the key is already on the row.
//
// Source-level, because the alternative is a DOM and a render loop to catch a
// bug whose whole nature is that it looks fine on first render.

import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = fileURLToPath(new URL("../src/manager", import.meta.url));

/**
 * Components whose call sites need no explicit `key`, with the reason.
 *
 * An entry is a claim that something else already establishes identity — not
 * that adding a key is inconvenient.
 */
const KEYED_ELSEWHERE: Record<string, string> = {
  RenameKey: "rendered per row by `Table`, which keys each <tr> on rowKey",
  ChangeRole: "rendered per row by `Table`, which keys each <tr> on rowKey",
};

const files = (dir: string): string[] =>
  readdirSync(dir, { withFileTypes: true }).flatMap((e) =>
    e.isDirectory()
      ? files(join(dir, e.name))
      : /\.tsx?$/.test(e.name)
        ? [join(dir, e.name)]
        : [],
  );

const sources = files(ROOT).map((f) => ({ rel: f.slice(ROOT.length + 1), src: readFileSync(f, "utf8") }));

/** Components that seed state from one of their props. */
function seededComponents(): { name: string; where: string }[] {
  const found: { name: string; where: string }[] = [];
  for (const { rel, src } of sources) {
    // `function Name({ a, b }: {...}) {`  … then `useState(a.something)`
    for (const m of src.matchAll(/function ([A-Z][A-Za-z0-9]*)\(\{([^}]*)\}/g)) {
      const name = m[1] as string;
      const props = (m[2] as string)
        .split(",")
        .map((p) => p.trim().split(/[:=]/)[0]!.trim())
        .filter(Boolean);
      // Scope stops at the NEXT top-level declaration, and that has to include
      // `export function` — stopping only at `\nfunction ` let one component's
      // scope run past its own closing brace into a sibling's `useState`, and
      // report a component with no state at all. A guard that cries wolf is one
      // people learn to skip.
      const body = src.slice(m.index + m[0].length);
      const end = body.search(/\n(?:export )?function /);
      const scope = end === -1 ? body : body.slice(0, end);
      const seeds = props.some((p) =>
        new RegExp(`useState\\(\\s*${p}\\.`).test(scope) || new RegExp(`useState\\(\\s*${p}\\?\\.`).test(scope),
      );
      if (seeds) found.push({ name, where: rel });
    }
  }
  return found;
}

test("the sweep finds the components it is meant to, so it cannot pass vacuously", () => {
  const names = seededComponents().map((c) => c.name);
  assert.ok(
    names.includes("EditContext"),
    `did not find EditContext among prop-seeded components (${names.join(", ") || "none"}) — ` +
      `the pattern match is stale and this test now checks nothing`,
  );
});

test("every prop-seeded form is keyed at its call site", () => {
  const offenders: string[] = [];

  for (const { name } of seededComponents()) {
    if (name in KEYED_ELSEWHERE) continue;
    for (const { rel, src } of sources) {
      for (const m of src.matchAll(new RegExp(`<${name}\\b[\\s\\S]{0,400}?/?>`, "g"))) {
        if (!/\bkey=/.test(m[0])) offenders.push(`${name}  (rendered in ${rel})`);
      }
    }
  }

  assert.deepEqual(
    [...new Set(offenders)].sort(),
    [],
    `these components seed state from a prop and are rendered without a \`key\`:\n  ` +
      `${[...new Set(offenders)].join("\n  ")}\n\n` +
      `\`useState(prop.field)\` runs on mount and never again, so React reuses the ` +
      `instance when the prop changes and the form keeps showing — and saving — the ` +
      `previous record's values. Pass \`key={record.id}\`, or add the component to ` +
      `KEYED_ELSEWHERE if something else already establishes identity.`,
  );
});

test("every KEYED_ELSEWHERE entry still names a prop-seeded component", () => {
  const names = new Set(seededComponents().map((c) => c.name));
  const stale = Object.keys(KEYED_ELSEWHERE).filter((n) => !names.has(n));
  assert.deepEqual(
    stale,
    [],
    `these exemptions no longer name a component that seeds state from a prop — ` +
      `remove them: ${stale.join(", ")}`,
  );
});
