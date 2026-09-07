// A store's write counter must not be rendered as a record's revision number.
//
// ## The bug this exists for
//
// The persona pane rendered `v{a.version} · {formatInstant(a.updatedAt)}` in a
// column headed "Updated". It reads as "revision 2, updated at 10:48" and it is
// not: `version` is a value of the **store's** monotonic write counter, not the
// record's own. The schema says so — "a value of the store's monotonic write
// counter. Server-assigned; a producer never chooses one" — and the store's
// header explains why it has to be store-wide: the same number serves as the
// optimistic-concurrency token and as the change-feed watermark, which
// per-record counters could not do, because two records' counters are not
// comparable to each other.
//
// So adding a second attribute to an empty pool produced a record labelled
// `v2` that had never been edited. Reported within minutes of the pane going
// live, by someone who reasonably read it as an edit count.
//
// `vta/app-state` has the same shape — its version is a *namespace*-wide
// counter — which is why this is a rule rather than a one-line fix.
//
// ## The rule
//
// A `version` may be **carried** (as `expectedVersion`, which is exactly what
// an opaque token is for) and it may be **shown under its own name**, next to
// an explanation, the way the app-state and policy editors show what they are
// compare-and-swapping against. It may not be given a `v` prefix and set beside
// a timestamp, which is the form that makes it read as a revision.
//
// Source-level, because the alternative is asserting on rendered DOM to catch a
// bug whose whole nature is that the wrong number looks exactly like the right
// one.

import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = fileURLToPath(new URL("../src/manager", import.meta.url));

const files = (dir: string): string[] =>
  readdirSync(dir, { withFileTypes: true }).flatMap((e) =>
    e.isDirectory() ? files(join(dir, e.name)) : /\.tsx?$/.test(e.name) ? [join(dir, e.name)] : [],
  );

/**
 * `v` immediately followed by an interpolated expression naming a version.
 *
 * Both JSX (`v{a.version}`) and template-literal (`` `v${p.version}` ``) forms,
 * because the pane could be rewritten into either. Deliberately narrow: it
 * targets the *prefix* that turns an opaque counter into a revision label, not
 * every mention of the word.
 *
 * Built fresh on every use rather than shared. A global regex carries
 * `lastIndex` between calls, and `assert.match` and `.test()` both advance it —
 * so a shared one would resume mid-string on the second file and quietly skip
 * matches, which in a guard is indistinguishable from finding none.
 */
const versionAsRevision = () => /\bv\$?\{[^}]*\bversion\b[^}]*\}/gi;

test("the sweep reads real files, so it cannot pass vacuously", () => {
  const found = files(ROOT);
  assert.ok(found.length > 15, `found only ${found.length} console sources — the path is stale`);
  assert.ok(
    found.some((f) => f.endsWith("persona.tsx")),
    "the pane this rule was written for is not in the sweep",
  );
  // The pattern must actually match the shape it bans, or the assertion below
  // is a regex that finds nothing anywhere.
  assert.match("v{a.version} · {formatInstant(a.updatedAt)}", versionAsRevision());
  assert.match("`v${p.version}`", versionAsRevision());
  // …and must not fire on the legitimate forms.
  assert.doesNotMatch("expectedVersion: existing.version", versionAsRevision());
  assert.doesNotMatch("render: (r) => <span>{r.version}</span>", versionAsRevision());
});

test("no console pane labels a write counter as a revision", () => {
  const offenders: string[] = [];
  for (const file of files(ROOT)) {
    const src = readFileSync(file, "utf8");
    for (const m of src.matchAll(versionAsRevision())) {
      // A mention inside a comment is how the rule is explained, not broken.
      const lineStart = src.lastIndexOf("\n", m.index) + 1;
      const line = src.slice(lineStart, src.indexOf("\n", m.index));
      if (/^\s*(\/\/|\*|\/\*)/.test(line)) continue;
      offenders.push(`${file.slice(ROOT.length + 1)}: ${line.trim()}`);
    }
  }

  assert.deepEqual(
    offenders,
    [],
    `these render a version with a "v" prefix, which reads as a revision number:\n  ` +
      `${offenders.join("\n  ")}\n\n` +
      `A version in these families is a value of the STORE's monotonic write counter, not ` +
      `the record's own — a freshly created record can arrive at v7 because six other ` +
      `records were written first. Carry it as expectedVersion, or show it under its own ` +
      `name next to an explanation; do not prefix it and set it beside a timestamp.`,
  );
});
