#!/usr/bin/env node
// Produce the Chrome Web Store upload zip from an existing `dist/`.
//
//   npm run package --workspace @openvtc/pnm-extension
//
// Emits `release/vta-wallet-<version>.zip`, whose *contents* are the contents
// of `dist/` — `manifest.json` must sit at the archive root, not inside a
// `dist/` folder, or the Store rejects the package.
//
// The zip is staged rather than zipped in place because its manifest differs
// from the one in `dist/`: the Store's "+ New item" upload rejects a manifest
// carrying a `key` field, while local unpacked installs need one to hold the
// extension ID still. Staging keeps `dist/` loadable at all times instead of
// mutating and restoring it, which would leave a keyless `dist/` behind on
// any mid-run failure.

import { execFileSync } from "node:child_process";
import { cpSync, mkdirSync, rmSync, writeFileSync, existsSync } from "node:fs";
import { join } from "node:path";
import { buildManifest, PKG_ROOT } from "./manifest.mjs";

const DIST = join(PKG_ROOT, "dist");
const RELEASE = join(PKG_ROOT, "release");
const STAGING = join(RELEASE, "staging");

if (!existsSync(join(DIST, "background.js"))) {
  console.error(
    `${DIST} looks unbuilt (no background.js). Run the build first:\n` +
      `  npm run build --workspace @openvtc/pnm-extension`,
  );
  process.exit(1);
}

const manifest = buildManifest({ includeKey: false });
const zipPath = join(RELEASE, `vta-wallet-${manifest.version}.zip`);

rmSync(STAGING, { recursive: true, force: true });
mkdirSync(STAGING, { recursive: true });

// `.DS_Store` and friends are noise the Store reviewer sees in the package
// listing; `filter` drops them at copy time so the zip never carries them.
cpSync(DIST, STAGING, {
  recursive: true,
  filter: (src) => !src.endsWith("/.DS_Store"),
});
writeFileSync(
  join(STAGING, "manifest.json"),
  `${JSON.stringify(manifest, null, 2)}\n`,
);

rmSync(zipPath, { force: true });
// `-X` drops the platform extra-attribute records, so the same input produces
// the same archive on a developer's macOS box and on the Linux CI runner.
execFileSync("zip", ["-r", "-X", "-q", zipPath, "."], { cwd: STAGING });
rmSync(STAGING, { recursive: true, force: true });

console.log(`packaged ${zipPath}`);
console.log(`  name    ${manifest.name}`);
console.log(`  version ${manifest.version}`);
console.log(`  key     omitted (the Store issues its own)`);
