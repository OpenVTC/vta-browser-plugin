// The layering, enforced.
//
// This package is on its way to being a library other people build VTA-enabled
// apps and services on, published from its own repo. Two properties have to
// hold for that to work, and neither survives on good intentions:
//
//   - **Modules import downwards only.** A consumer who wants `vta` should get
//     the VTA protocol, not the wallet's IndexedDB store and WebAuthn ceremony
//     helpers dragged in behind it.
//   - **No cycles.** A cycle between two module directories means neither can be
//     an independent entry point, however the `exports` map is written.
//
// Both were already broken when this test was written: `vta` and `vault` were
// mutually dependent, because the VTA's REST auth bootstrap lived in
// `vault/transport.ts`, so importing the VTA protocol pulled in the whole vault
// surface. That is cheap to fix in one repo and expensive to fix across two,
// which is the entire argument for having this test now rather than later.

import { test } from "node:test";
import assert from "node:assert/strict";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, dirname, resolve, relative } from "node:path";

const SRC = resolve(import.meta.dirname, "../src");

/**
 * Lowest layer first. A module may import from any *lower* layer, and from
 * itself. Same-layer imports are refused: siblings that need each other belong
 * in one module, or the shared part belongs one layer down.
 */
const LAYERS = [
  ["util", "http"], //           0 — no imports of their own
  ["did", "didcomm", "webauthn"], //  1 — identity + crypto primitives
  ["siop"], //                   2 — token formats
  ["vta", "trust-tasks"], //     3 — the VTA protocol: channels, envelopes, auth
  ["store", "vault", "device", "provision", "rp-login", "onboarding", "admin", "credentials", "vtc", "did-hosting"], // 4
  ["inbound"], //                5 — the running session, on top of everything
];

/**
 * Edges that break the rule and are known about. Each one is a bug with a plan,
 * not a dispensation — and the test fails if an entry stops being needed, so the
 * list can only shrink.
 */
const KNOWN_EXCEPTIONS = [
  {
    from: "vta",
    to: "store",
    why:
      "vta/wallet-session.ts is wallet orchestration (it loads the holder " +
      "identity out of a KVStore), and vta/smoke.ts is a test harness using " +
      "InMemoryKVStore. Neither is VTA protocol. Moving wallet-session up to " +
      "its own module and smoke into tests/ closes this.",
  },
];

const layerOf = new Map();
LAYERS.forEach((mods, i) => mods.forEach((m) => layerOf.set(m, i)));

function tsFiles(dir) {
  const out = [];
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) out.push(...tsFiles(full));
    else if (entry.endsWith(".ts")) out.push(full);
  }
  return out;
}

/** Module directory a path belongs to, or null for a file at the src root. */
function moduleOf(absPath) {
  const rel = relative(SRC, absPath);
  const parts = rel.split("/");
  return parts.length > 1 ? parts[0] : null;
}

/** Every cross-module edge in the source tree, with the file that creates it. */
function moduleEdges() {
  const edges = [];
  for (const file of tsFiles(SRC)) {
    const from = moduleOf(file);
    if (!from) continue; // src/index.ts is the barrel; it imports everything by design
    const source = readFileSync(file, "utf8");
    for (const spec of source.matchAll(/from "(\.[^"]*)"/g)) {
      const target = moduleOf(resolve(dirname(file), spec[1]));
      if (target && target !== from) {
        edges.push({ from, to: target, file: relative(SRC, file) });
      }
    }
  }
  return edges;
}

const EDGES = moduleEdges();

test("every module directory has a declared layer", () => {
  const modules = new Set(EDGES.flatMap((e) => [e.from, e.to]));
  const undeclared = [...modules].filter((m) => !layerOf.has(m));
  assert.deepEqual(
    undeclared,
    [],
    `add these to LAYERS — an unplaced module is one nobody decided where to put: ${undeclared.join(", ")}`,
  );
});

test("modules import downwards only", () => {
  const allowed = new Set(KNOWN_EXCEPTIONS.map((e) => `${e.from}→${e.to}`));
  const violations = EDGES.filter((e) => {
    if (allowed.has(`${e.from}→${e.to}`)) return false;
    return layerOf.get(e.to) >= layerOf.get(e.from);
  }).map((e) => `${e.from}→${e.to} (${e.file})`);

  assert.deepEqual(
    [...new Set(violations)].sort(),
    [],
    "these imports point sideways or upwards; move the shared part down a layer " +
      "rather than adding an exception",
  );
});

test("no cycles between modules", () => {
  const graph = new Map();
  for (const { from, to } of EDGES) {
    if (!graph.has(from)) graph.set(from, new Set());
    graph.get(from).add(to);
  }

  const cycles = [];
  const state = new Map(); // 0 = visiting, 1 = done
  const walk = (node, path) => {
    if (state.get(node) === 1) return;
    if (state.get(node) === 0) {
      cycles.push([...path.slice(path.indexOf(node)), node].join(" → "));
      return;
    }
    state.set(node, 0);
    for (const next of graph.get(node) ?? []) walk(next, [...path, next]);
    state.set(node, 1);
  };
  for (const node of graph.keys()) walk(node, [node]);

  assert.deepEqual(
    [...new Set(cycles)],
    [],
    "a cycle means neither module can be an independent entry point",
  );
});

test("every known exception is still real", () => {
  // Otherwise the list rots: an edge gets fixed, nobody removes its exception,
  // and the next violation of the same rule slips in under it.
  const present = new Set(EDGES.map((e) => `${e.from}→${e.to}`));
  const stale = KNOWN_EXCEPTIONS.filter((e) => !present.has(`${e.from}→${e.to}`)).map(
    (e) => `${e.from}→${e.to}`,
  );
  assert.deepEqual(stale, [], "these exceptions are fixed — delete them from KNOWN_EXCEPTIONS");
});
