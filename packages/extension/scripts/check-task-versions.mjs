#!/usr/bin/env node
// Every Trust Task this build can send is at the version `trust-tasks.lock` pins.
//
// The lock (`packages/core/trust-tasks.lock`) holds one version per slug, and
// `src/specs/` is generated from it, so a task imported from a generated module
// is pinned by construction. What the lock cannot see is a URI spelled out by
// hand, or one a dependency carries into the bundle — and that is exactly what
// let a superseded version linger after the cutover: the agents keep serving a
// version for as long as a wallet is known to send it (VTI #2315 kept six for
// this one), so a stray literal here holds back their retirement while every
// test stays green.
//
// So this reads what ships — the built `dist/` of the extension and the PWA —
// rather than the source, and requires each `https://trusttasks.org/spec/<slug>/<version>`
// in it to be the lock's version of that slug. A slug the lock does not pin at
// all is an error too, unless it is listed below with its reason.
//
// Usage (after `npm run build`): node packages/extension/scripts/check-task-versions.mjs

import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative, resolve } from "node:path";

const ROOT = resolve(import.meta.dirname, "../../..");
const LOCK = join(ROOT, "packages/core/trust-tasks.lock");
const DISTS = ["packages/extension/dist", "packages/pwa/dist"].map((d) => join(ROOT, d));

/**
 * Slugs that may appear in a bundle without a pin, each because the wallet
 * never sends a document of that type to a counterparty.
 */
const UNPINNED = new Map([
  [
    "trust-task-error",
    "The framework's error document. The wallet reads it from an agent and matches it by slug " +
      "across every 0.x (`isTrustTaskErrorType`, SPEC.md §5.2's forward-minor rule), so it names " +
      "earlier versions on purpose; it never sends one to an agent.",
  ],
]);

const pinned = new Map();
for (const block of readFileSync(LOCK, "utf8").split("[[task]]").slice(1)) {
  const slug = /^slug = "([^"]+)"/m.exec(block)?.[1];
  const version = /^version = "([^"]+)"/m.exec(block)?.[1];
  if (!slug || !version) throw new Error(`unreadable [[task]] block in ${LOCK}:\n${block}`);
  pinned.set(slug, version);
}
if (pinned.size < 200) throw new Error(`${LOCK} pins only ${pinned.size} tasks — wrong file?`);

function filesUnder(dir) {
  const out = [];
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) out.push(...filesUnder(full));
    else if (/\.(m?js|html|json)$/.test(entry)) out.push(full);
  }
  return out;
}

// A version is the last path segment; `_shared/<v>/…` and the framework's own
// `trust-task/<v>/framework` are schema ids, not task types, and never end there.
const URI = /https:\/\/trusttasks\.org\/spec\/([a-z0-9][a-z0-9/_-]*?)\/(\d+\.\d+)(?![\d./A-Za-z_-])/g;

const problems = [];
let seen = 0;
for (const dist of DISTS) {
  let files;
  try {
    files = filesUnder(dist);
  } catch {
    problems.push(`${relative(ROOT, dist)} is missing — run \`npm run build\` first`);
    continue;
  }
  for (const file of files) {
    const text = readFileSync(file, "utf8");
    for (const [, slug, version] of text.matchAll(URI)) {
      seen++;
      if (UNPINNED.has(slug)) continue;
      const want = pinned.get(slug);
      if (want === undefined) {
        problems.push(`${relative(ROOT, file)} names ${slug}/${version}, a task trust-tasks.lock does not pin`);
      } else if (want !== version) {
        problems.push(`${relative(ROOT, file)} names ${slug}/${version}; trust-tasks.lock pins ${slug} at ${want}`);
      }
    }
  }
}

if (seen === 0) problems.push("no task URIs found in any bundle — the scan is not reading what ships");

const unique = [...new Set(problems)];
if (unique.length > 0) {
  for (const p of unique) console.log(`::error::${p}`);
  process.exit(1);
}
console.log(`OK: ${seen} task URIs across the extension and PWA bundles, each at its pinned version`);
