// `src/specs/` is exactly what `trust-tasks-gen-ts` writes from
// `trust-tasks.lock`, and nothing else.
//
// The task modules are generated in this repository rather than taken from
// `@openvtc/trust-tasks`'s prebuilt tree, which deprecated every non-framework
// module (dtgwg-trust-tasks-tf #954) so that an application pins the tasks it
// speaks and generates those. Pinning is also what keeps this library on one
// version of each task: the lock holds one version per slug, so a second
// version can only be imported by moving the pin — which is the cutover the
// "no compatibility folds" rule asks for, made structural.
//
// Generated code is only worth having if it is the generator's output. A hand
// edit under `src/specs/` reads as a schema the registry published, and the
// next `npm run tasks:generate` silently reverts it; a pin moved in the lock
// without regenerating leaves `src/` typechecking against the old schema. Both
// are caught here by regenerating into a temporary directory and comparing.
//
// The generator verifies each vendored bundle against its locked digest before
// writing anything, so this also fails on a bundle edited in place.

import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, readdirSync, readFileSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const PKG_ROOT = resolve(import.meta.dirname, "..");
const SPECS = join(PKG_ROOT, "src", "specs");

function filesUnder(root, dir = root) {
  const out = [];
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) out.push(...filesUnder(root, full));
    else out.push(relative(root, full));
  }
  return out.sort();
}

test("src/specs is the generator's output for trust-tasks.lock", () => {
  // The package exports only its library entry (`dist/index.js`); the CLI sits beside it.
  const bin = join(dirname(fileURLToPath(import.meta.resolve("@openvtc/trust-tasks-gen"))), "cli.js");
  const out = mkdtempSync(join(tmpdir(), "pnm-specs-"));
  try {
    execFileSync(process.execPath, [bin, "--lock", "trust-tasks.lock", "--out", out], {
      cwd: PKG_ROOT,
      stdio: "pipe",
    });
    const want = filesUnder(out);
    const have = filesUnder(SPECS);
    assert.ok(want.length > 200, `the generator wrote only ${want.length} files`);
    assert.deepEqual(
      have,
      want,
      "src/specs does not hold the files trust-tasks.lock generates — run `npm run tasks:generate`",
    );
    const differ = want.filter(
      (f) => readFileSync(join(out, f), "utf8") !== readFileSync(join(SPECS, f), "utf8"),
    );
    assert.deepEqual(
      differ,
      [],
      "these generated files differ from the generator's output — never edit src/specs by hand; " +
        "move the pin (`trust-tasks add <slug>/<M.N>`) and run `npm run tasks:generate`",
    );
  } finally {
    rmSync(out, { recursive: true, force: true });
  }
});
