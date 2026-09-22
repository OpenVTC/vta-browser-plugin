#!/usr/bin/env node
// Refresh `task-surface.json` — the checked-in snapshot of the VTA's canonical
// Trust-Task surface, and the thing `tests/task-surface.mjs` checks this
// library against.
//
//   npm run tasks:sync --workspace @openvtc/pnm-core
//   npm run tasks:sync --workspace @openvtc/pnm-core -- ../path/to/vta-sdk
//
// Why a snapshot rather than reading the Rust at test time: `vta-sdk` lives in
// another repository, and CI here builds from a cold checkout of this one. A
// test that needed the sibling checkout would simply not run in CI, which is
// where it matters. So the surface is committed, refreshed deliberately by a
// human running this, and the refresh shows up in a diff someone reviews.
//
// The snapshot records where it came from and when. A stale one is not a
// silent failure — `tests/task-surface.mjs` reports the version it is checking
// against, and a task this library targets that the SDK has since renamed or
// deprecated fails the test rather than the deployment.
//
// ## Not every constant is a literal, and the ones that are not were vanishing
//
// `vta-sdk` increasingly derives a task constant from the generated payload
// type rather than writing the URI out:
//
//     pub const JOIN_REQUEST_MANIFEST_TYPE: &str =
//         <manifest::v0_1::Payload as trust_tasks_rs::Payload>::TYPE_URI;
//
// There is no string to match, so the scan missed it and the task simply was
// not in the snapshot — and `tests/task-surface.mjs` then reports it as a URI
// this library names that **the SDK does not have**, which is the sentence it
// uses for a typo or a task that was dropped. That is the worst possible
// wording for a scanner limitation: it is indistinguishable from a real
// version-left-behind, and the one it was mistaken for
// (`vtc/join-requests/manifest/0.1`) is still exported by the SDK and still
// dispatched by vtc-service.
//
// So the resolver below follows the `pub use trust_tasks_rs::specs::…` aliases
// and reconstructs the URI from the module path. And where it **cannot**
// resolve one, this script now fails rather than writing a snapshot with a hole
// in it. Silent omission is what made the limitation look like a finding; a
// loud stop is a scanner that says "I do not understand this", which is the
// true statement.

import { readFileSync, writeFileSync, readdirSync, statSync, existsSync } from "node:fs";
import { join, resolve } from "node:path";

const PKG_ROOT = resolve(import.meta.dirname, "..");

// Where the snapshot is written. The checked-in file by default; a second
// argument overrides it.
//
// **The override is what lets `tests/task-surface-sync.mjs` run this script
// without touching the real snapshot**, and that is a correctness constraint
// rather than a convenience. `node --test` runs test FILES in parallel
// processes, and `tests/task-surface.mjs` reads the checked-in snapshot at
// module scope — so a sync test that wrote the real file and restored it
// afterwards raced the test next door, which read either the fixture's handful
// of tasks or a half-written file. It failed as "task-surface.json looks
// truncated" in CI and passed on every developer machine, because whether the
// two files overlap depends on core count.
const OUT = process.argv[3] ? resolve(process.argv[3]) : join(PKG_ROOT, "task-surface.json");

const DEFAULT_SDK = resolve(
  PKG_ROOT,
  "../../../verifiable-trust-infrastructure/vta-sdk",
);
const sdkRoot = resolve(process.argv[2] ?? DEFAULT_SDK);
const sdkSrc = join(sdkRoot, "src");

if (!existsSync(sdkSrc)) {
  console.error(
    `No vta-sdk source at ${sdkSrc}.\n` +
      `Pass the path: npm run tasks:sync --workspace @openvtc/pnm-core -- /path/to/vta-sdk`,
  );
  process.exit(1);
}

function rustFiles(dir) {
  const out = [];
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) out.push(...rustFiles(full));
    else if (entry.endsWith(".rs")) out.push(full);
  }
  return out;
}

const SPEC_PREFIX = "https://trusttasks.org/spec/";

const URI = /"(https:\/\/trusttasks\.org\/spec\/[^"]+)"/g;
/** `pub const NAME: &str = "…"` — the constant a deprecation attaches to. */
const CONST_DECL = /(?:pub\s+)?const\s+([A-Z0-9_]+)\s*:\s*&'?\w*\s*str\s*=\s*"([^"]+)"/;
/**
 * The same declaration with the value wrapped onto the next line, which is what
 * rustfmt does the moment name + type + literal passes 100 columns.
 *
 * Without this the URI is still recorded — the generic scan below finds the
 * literal — but its constant's *name* is lost, and with it any `#[deprecated]`
 * attached to it. That is not cosmetic: it silently exempted 130 of the SDK's
 * 234 tasks from the deprecation check, which was every task whose name is long
 * enough to wrap. The check reported green over the half of the surface most
 * likely to be versioned.
 */
const CONST_DECL_OPEN = /(?:pub\s+)?const\s+([A-Z0-9_]+)\s*:\s*&'?\w*\s*str\s*=\s*$/;

/**
 * `<alias::…::vN_M::(Payload|Response) as …Payload>::TYPE_URI` — a constant
 * whose value is the generated type's own URI. `Response` resolves to the same
 * task: `record` folds `#response` onto the base, exactly as it does for the
 * literal pairs.
 */
const COMPUTED_TYPE_URI =
  /<\s*([A-Za-z0-9_:]+)::(v\d+_\d+)::(?:Payload|Response)\s+as\s+[A-Za-z0-9_:]*Payload\s*>::TYPE_URI/;

/**
 * A `&str` const that is not a task: built from a file, or an error code.
 * Recognised so the unresolved-value stop below does not fire on one.
 *
 * `vta-sdk` now takes a specification-declared error code from the generated
 * module (`…::error_codes::ATTRIBUTES_MISSING.code`) rather than writing the
 * `slug:localName` string out. Its value is a code, never a task URI — the
 * literal form of the same constant was always dropped by `record` for that
 * reason — so it is skipped here rather than resolved. `.code` is optional
 * because rustfmt moves it to the next line once the path is long enough.
 */
const NOT_A_TASK_VALUE = /^\s*(?:include_str!|concat!)|::error_codes::[A-Z0-9_]+(?:\.code)?\s*;?\s*$/;

/**
 * Spec-module aliases in one file: `manifest` → `vtc/join_requests/manifest`.
 *
 * A `pub use` that reaches *inside* a version module is importing types, not
 * aliasing a spec — `…::manifest::v0_2::{VettingRequirements, …}` names two
 * structs — so a path carrying a `vN_M` segment is skipped. Without that, the
 * braced names would be registered as spec modules and resolve to invented
 * URIs.
 */
function specAliases(source) {
  const aliases = new Map();
  // `[\s\S]` rather than `.`: rustfmt wraps a braced group across lines the
  // moment it is long enough, and the vetting protocol has one that does.
  for (const m of source.matchAll(/pub\s+use\s+trust_tasks_rs::specs::([\s\S]*?);/g)) {
    const path = m[1].replace(/\s+/g, "");
    const braced = /^(.*?)::\{(.+)\}$/.exec(path);
    const prefix = braced ? braced[1] : path.replace(/::[A-Za-z0-9_]+$/, "");
    const names = braced
      ? braced[2].split(",").filter(Boolean)
      : [path.slice(path.lastIndexOf("::") + 2)];
    const prefixSegs = prefix.split("::").filter(Boolean);
    if (prefixSegs.some((seg) => /^v\d+_\d+$/.test(seg))) continue;
    for (const name of names) {
      if (/^v\d+_\d+$/.test(name)) continue;
      aliases.set(name, [...prefixSegs, name]);
    }
  }
  return aliases;
}

/**
 * Turn a resolved module path and version module into a task URI.
 *
 * Rust modules are snake_case and spec slugs are kebab-case, segment for
 * segment (`join_requests` → `join-requests`); `v0_1` → `0.1`.
 */
function uriFromModulePath(segments, versionMod) {
  const slug = segments.map((seg) => seg.replace(/_/g, "-")).join("/");
  const version = versionMod.slice(1).replace("_", ".");
  return `${SPEC_PREFIX}${slug}/${version}`;
}

/** @type {Map<string, {uri: string, consts: Set<string>, deprecated?: string, files: Set<string>}>} */
const tasks = new Map();

/** Constants whose value this script could not turn into a URI. Fatal — see
 *  the header. */
const unresolved = [];

function record(uri, file) {
  // Only task URIs. `CONST_DECL` matches every `const NAME: &str = "…"` in the
  // crate, which is most of a string table — service names, DID examples, error
  // codes — and an earlier version of this script recorded all of them. That
  // inflated the snapshot by a third and, worse, inflated the denominator the
  // coverage check reports, so the gap looked bigger than it is.
  if (!uri.startsWith(SPEC_PREFIX)) return null;
  // A `#response` URI is the same task; the response half is derived, and
  // recording both would double the surface for no gain.
  const base = uri.replace(/#response$/, "");
  // A canonical task URI ends in its version. What does not is a family prefix
  // other constants are built from (`…/spec/acl/`), which is a building block
  // rather than something callable.
  if (!/\/\d+\.\d+$/.test(base)) return null;
  if (!tasks.has(base)) {
    tasks.set(base, { uri: base, consts: new Set(), files: new Set() });
  }
  tasks.get(base).files.add(file);
  return tasks.get(base);
}

/** Name a task's constant, and carry over any `#[deprecated]` it wore. */
function attach(entry, constName, deprecation) {
  if (!entry) return;
  entry.consts.add(constName);
  if (deprecation) {
    const note = /note\s*=\s*"([^"]*)"/.exec(deprecation);
    // Rust wraps long notes with a trailing backslash; fold those away too,
    // or the snapshot carries line-continuation artefacts.
    entry.deprecated =
      note?.[1]?.replace(/\\\s*/g, " ").replace(/\s+/g, " ").trim() ?? "deprecated";
  }
}

for (const file of rustFiles(sdkSrc)) {
  const rel = file.slice(sdkRoot.length + 1);
  const source = readFileSync(file, "utf8");
  const lines = source.split("\n");
  const aliases = specAliases(source);

  /** Resolve a computed `…::TYPE_URI` value, or record why it could not be. */
  const resolveComputed = (value, constName, lineNo) => {
    const m = COMPUTED_TYPE_URI.exec(value);
    if (!m) return null;
    const segs = m[1].split("::").filter(Boolean);
    const head = aliases.get(segs[0]);
    if (!head) {
      unresolved.push(
        `${rel}:${lineNo}  ${constName} — no \`pub use trust_tasks_rs::specs::…\` ` +
          `in this file brings \`${segs[0]}\` into scope`,
      );
      return null;
    }
    return uriFromModulePath([...head, ...segs.slice(1)], m[2]);
  };

  // A `#[deprecated…]` attribute may wrap across lines; hold it until the
  // declaration it applies to arrives, and drop it on any other statement.
  let pendingDeprecation = null;
  let inDeprecation = false;
  /** A `const NAME: &str =` whose literal is on the line still to come. */
  let pendingConst = null;

  for (const [index, line] of lines.entries()) {
    const lineNo = index + 1;
    if (pendingConst) {
      const literal = /^\s*"([^"]+)"/.exec(line);
      const { name, deprecation, lineNo } = pendingConst;
      pendingConst = null;
      if (literal) {
        attach(record(literal[1], rel), name, deprecation);
        continue;
      }
      const computed = resolveComputed(line, name, lineNo);
      if (computed) {
        attach(record(computed, rel), name, deprecation);
        continue;
      }
      // Neither a literal nor a type we can resolve. `include_str!` and friends
      // are `&str` constants that are not tasks at all; anything else is a form
      // this scanner has not been taught, and writing the snapshot without it
      // is the silent omission the header describes.
      if (!NOT_A_TASK_VALUE.test(line) && !COMPUTED_TYPE_URI.test(line)) {
        unresolved.push(`${rel}:${lineNo}  ${name} — unrecognised value: ${line.trim()}`);
      }
    }

    if (inDeprecation || /^\s*#\[deprecated/.test(line)) {
      pendingDeprecation = (pendingDeprecation ?? "") + line.trim();
      inDeprecation = !line.includes("]");
      continue;
    }

    const decl = CONST_DECL.exec(line);
    if (decl) {
      attach(record(decl[2], rel), decl[1], pendingDeprecation);
      pendingDeprecation = null;
      continue;
    }

    // The same declaration, computed and short enough not to wrap.
    const inlineComputed = /(?:pub\s+)?const\s+([A-Z0-9_]+)\s*:\s*&'?\w*\s*str\s*=\s*(<.+)$/.exec(line);
    if (inlineComputed) {
      const uri = resolveComputed(inlineComputed[2], inlineComputed[1], lineNo);
      if (uri) attach(record(uri, rel), inlineComputed[1], pendingDeprecation);
      pendingDeprecation = null;
      continue;
    }

    const open = CONST_DECL_OPEN.exec(line);
    if (open) {
      // Carry the deprecation across the wrap rather than letting the
      // clear-on-any-statement rule below eat it.
      pendingConst = { name: open[1], deprecation: pendingDeprecation, lineNo };
      pendingDeprecation = null;
      continue;
    }

    for (const m of line.matchAll(URI)) record(m[1], rel);
    if (line.trim() && !line.trim().startsWith("//")) pendingDeprecation = null;
  }
}

const sdkVersion =
  /^version\s*=\s*"([^"]+)"/m.exec(
    existsSync(join(sdkRoot, "Cargo.toml"))
      ? readFileSync(join(sdkRoot, "Cargo.toml"), "utf8")
      : "",
  )?.[1] ?? "unknown";

if (unresolved.length > 0) {
  console.error(
    `Cannot resolve ${unresolved.length} \`&str\` constant(s) to a task URI:\n  ` +
      `${unresolved.join("\n  ")}\n\n` +
      `Writing the snapshot without them would drop those tasks, and ` +
      `tests/task-surface.mjs would then report any this library calls as tasks ` +
      `the SDK does not have — which is what it says for a typo or a dropped ` +
      `task, not for a form this script has not been taught. Teach it the form, ` +
      `or fix the constant.`,
  );
  process.exit(1);
}

const snapshot = {
  $comment:
    "Generated by scripts/sync-task-surface.mjs from a vta-sdk checkout. " +
    "Do not hand-edit: re-run the script. Checked by tests/task-surface.mjs.",
  source: {
    crate: "vta-sdk",
    version: sdkVersion,
    // No capture date: it would churn the file on every sync and tell a reader
    // nothing the version and the git history do not.
    scanned: "vta-sdk/src/**/*.rs",
  },
  tasks: [...tasks.values()]
    .sort((a, b) => a.uri.localeCompare(b.uri))
    .map((t) => ({
      uri: t.uri,
      ...(t.consts.size ? { consts: [...t.consts].sort() } : {}),
      ...(t.deprecated ? { deprecated: t.deprecated } : {}),
    })),
};

writeFileSync(OUT, `${JSON.stringify(snapshot, null, 2)}\n`);

const deprecated = snapshot.tasks.filter((t) => t.deprecated).length;
console.log(
  `wrote ${OUT}\n` +
    `  vta-sdk    ${sdkVersion}\n` +
    `  tasks      ${snapshot.tasks.length}\n` +
    `  deprecated ${deprecated}`,
);
