// Every advertised entry point must actually load — in Node, with no DOM.
//
// The package is built in a browser-shaped repo, so the failure mode is
// specific and easy to miss: a module reaches for `window`, `indexedDB` or
// `navigator` at import time, everything keeps working in the extension, and
// the first server-side consumer discovers it with a `ReferenceError` after
// installing from npm. This runs the import a consumer would run.
//
// It also checks the `exports` map against the source tree, because an entry
// point that exists but is not exported is invisible, and one that is exported
// but does not exist is a broken install.

import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { join, resolve } from "node:path";

const PKG_ROOT = resolve(import.meta.dirname, "..");
const pkg = JSON.parse(readFileSync(join(PKG_ROOT, "package.json"), "utf8"));

const subpaths = Object.keys(pkg.exports).filter(
  (k) => k !== "./package.json" && k !== ".",
);

test("the root entry point loads in Node", async () => {
  const mod = await import(join(PKG_ROOT, pkg.exports["."].import));
  assert.ok(Object.keys(mod).length > 0, "the barrel exports nothing");
});

for (const subpath of subpaths) {
  test(`${subpath} loads in Node on its own`, async () => {
    const target = join(PKG_ROOT, pkg.exports[subpath].import);
    assert.ok(existsSync(target), `${subpath} points at ${target}, which does not exist`);
    const mod = await import(target);
    assert.ok(
      Object.keys(mod).length > 0,
      `${subpath} loaded but exports nothing — check its index.ts`,
    );
  });
}

test("every module directory is reachable as a subpath", () => {
  const moduleDirs = readdirSync(join(PKG_ROOT, "src"))
    .filter((entry) => statSync(join(PKG_ROOT, "src", entry)).isDirectory())
    .filter((entry) => existsSync(join(PKG_ROOT, "src", entry, "index.ts")));

  const exported = new Set(subpaths.map((s) => s.slice(2)));
  const unreachable = moduleDirs.filter((d) => !exported.has(d));

  assert.deepEqual(
    unreachable,
    [],
    "these modules have a barrel but no entry in package.json exports, so a " +
      "consumer can only reach them through the root barrel — which defeats " +
      "importing what you need",
  );
});

test("the package declares itself side-effect free", () => {
  // Tree-shaking a subpath a consumer never imported is only safe if importing
  // a module does nothing on its own. Nothing here patches globals; this is the
  // declaration that lets a bundler act on that.
  assert.equal(pkg.sideEffects, false);
});
