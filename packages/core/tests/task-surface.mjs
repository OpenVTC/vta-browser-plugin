// This library against the agent's canonical Trust-Task surface.
//
// Every VTA call this package makes names a task URI. Three ways that goes
// wrong, none of which any other test here would catch:
//
//   - a **typo or a rename**: the URI is well-formed, the agent has never heard
//     of it, and the failure arrives as a rejected request at a user;
//   - a **version left behind**: the agent still accepts `vault/list/0.1`
//     during its deprecation window, so everything works right up until the
//     release that drops it;
//   - a **gap nobody can see**: the agent grows tasks, this library does not,
//     and the distance is invisible until somebody goes looking.
//
// The first two fail this test. The third is reported as a number that moves in
// a diff, because a library heading for general use should make its own
// coverage reviewable rather than a thing you discover by grepping.
//
// The canonical side is `../task-surface.json`, a committed snapshot of
// `vta-sdk` — refresh it with `npm run tasks:sync`. It is a snapshot because
// `vta-sdk` is in another repository and CI here builds from a cold checkout of
// this one; a test that needed the sibling checkout would not run where it
// counts.

import { test } from "node:test";
import assert from "node:assert/strict";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, resolve } from "node:path";

const PKG_ROOT = resolve(import.meta.dirname, "..");
const SRC = join(PKG_ROOT, "src");
const SURFACE = JSON.parse(readFileSync(join(PKG_ROOT, "task-surface.json"), "utf8"));

const CANONICAL = new Map(SURFACE.tasks.map((t) => [t.uri, t]));

/**
 * Task URIs this library references that are **not** `vta-sdk` client
 * constants, with the reason each is legitimate. Same discipline as the module
 * boundary list: every entry is justified, and the test fails when one stops
 * being needed, so it can only shrink.
 */
const NOT_IN_SDK = [
  {
    prefix: "https://trusttasks.org/spec/trust-task-error/",
    why:
      "The error envelope the *service* emits (vta-service/src/trust_tasks/wire_v0_2.rs). " +
      "This library parses it, never sends it, so it is not part of the SDK's client surface.",
  },
  {
    prefix: "https://trusttasks.org/spec/push/register/",
    why:
      "Defined in the vta-mobile-core crate, not vta-sdk. The wallet registers a push " +
      "handle with a gateway; the agent is not the counterparty.",
  },
  {
    prefix: "https://trusttasks.org/spec/auth/step-up/approve-request/",
    why:
      "Emitted by the relying party during a step-up and consumed here. The RP side lives " +
      "in did-hosting, so vta-sdk carries the approve-*response* half only.",
  },
  {
    prefix: "https://trusttasks.org/spec/task-consent/granted/",
    why:
      "Inbound notification from the agent once an approver decided. Not a request this " +
      "library can send, so it has no client constant.",
  },
];

// ── what this library references ────────────────────────────────────────────

function tsFiles(dir) {
  const out = [];
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) out.push(...tsFiles(full));
    else if (entry.endsWith(".ts")) out.push(full);
  }
  return out;
}

const LITERAL = /"(https:\/\/trusttasks\.org\/spec\/[^"]*)"/g;
/** `const NAME = "https://…"` — a prefix other URIs are built from. */
const PREFIX_CONST = /const\s+([A-Z0-9_]+)\s*=\s*"(https:\/\/trusttasks\.org\/spec\/[^"]*)"/g;
/** `` `${NAME}/suffix/0.1` `` — the concatenated form (see vta/protocol.ts). */
const TEMPLATE = /`\$\{([A-Z0-9_]+)\}([^`]*)`/g;
/**
 * `from "@openvtc/trust-tasks/acl/grant/0.1/payload"` — the admin modules take
 * their URIs from the generated bindings rather than spelling them out, which
 * is the point of those bindings. Resolving the import is how this test still
 * sees what they target: the module's own `TYPE_URI` is the answer, and it
 * cannot disagree with the schema it was generated from.
 */
const BINDING_IMPORT = /from "(@openvtc\/trust-tasks\/[^"]+)"/g;

/** Every task URI this library can emit or match on, with where it came from. */
async function referencedTasks() {
  const found = new Map(); // uri → Set(file)
  const add = (uri, file) => {
    const base = uri.replace(/#response$/, "");
    // A bare prefix (`…/spec/vta/passkey-vms`) is a building block, not a task.
    if (!/\/\d+\.\d+$/.test(base)) return;
    if (!found.has(base)) found.set(base, new Set());
    found.get(base).add(file);
  };

  for (const file of tsFiles(SRC)) {
    const rel = file.slice(SRC.length + 1);
    const source = readFileSync(file, "utf8");

    const prefixes = new Map();
    for (const m of source.matchAll(PREFIX_CONST)) prefixes.set(m[1], m[2]);
    for (const m of source.matchAll(LITERAL)) add(m[1], rel);
    for (const m of source.matchAll(TEMPLATE)) {
      const base = prefixes.get(m[1]);
      if (base) add(base + m[2], rel);
    }
    for (const m of source.matchAll(BINDING_IMPORT)) {
      const mod = await import(m[1]);
      if (typeof mod.TYPE_URI === "string") add(mod.TYPE_URI, rel);
    }
  }
  return found;
}

const REFERENCED = await referencedTasks();

function allowedOutsideSdk(uri) {
  return NOT_IN_SDK.find((e) => uri.startsWith(e.prefix));
}

// ── the checks ──────────────────────────────────────────────────────────────

test("the snapshot it is checking against is a real one", () => {
  assert.ok(SURFACE.tasks.length > 100, "task-surface.json looks truncated");
  assert.match(SURFACE.source.version, /^\d+\.\d+/, "no vta-sdk version recorded");
});

test("every task this library names exists in the agent's surface", () => {
  const unknown = [...REFERENCED.entries()]
    .filter(([uri]) => !CANONICAL.has(uri) && !allowedOutsideSdk(uri))
    .map(([uri, files]) => `${uri}  (${[...files].join(", ")})`);

  assert.deepEqual(
    unknown.sort(),
    [],
    `these URIs are in no vta-sdk constant — a typo, a rename, or a task that ` +
      `moved. If one is legitimately outside the SDK's client surface, add it ` +
      `to NOT_IN_SDK with the reason. If the SDK moved on, run: ` +
      `npm run tasks:sync --workspace @openvtc/pnm-core`,
  );
});

test("this library targets no deprecated task version", () => {
  // The window between "the agent still accepts 0.1" and "the agent dropped
  // 0.1" is exactly when this is cheap to fix, and it is invisible without a
  // check — everything works.
  const stale = [...REFERENCED.entries()]
    .map(([uri, files]) => ({ uri, files, task: CANONICAL.get(uri) }))
    .filter((r) => r.task?.deprecated)
    .map((r) => `${r.uri} — ${r.task.deprecated} (${[...r.files].join(", ")})`);

  assert.deepEqual(stale.sort(), [], "move to the superseding version");
});

test("every NOT_IN_SDK entry is still needed", () => {
  const stale = NOT_IN_SDK.filter(
    (e) => ![...REFERENCED.keys()].some((uri) => uri.startsWith(e.prefix)),
  ).map((e) => e.prefix);
  assert.deepEqual(stale, [], "delete these from NOT_IN_SDK — nothing references them");
});

test("coverage against the agent's surface is recorded, not discovered", () => {
  // Not a threshold — a snapshot. The number moves in a diff when a family is
  // added or dropped, which is the point: the gap should be reviewed, not
  // stumbled upon. Update `expected` in the same commit that changes coverage.
  const family = (uri) => uri.replace(/\/\d+\.\d+$/, "");
  const canonicalFamilies = new Set([...CANONICAL.keys()].map(family));
  const implemented = new Set(
    [...REFERENCED.keys()].map(family).filter((f) => canonicalFamilies.has(f)),
  );

  // 161 of 178 as of vta-sdk 0.32.3. It was 130 until the specced-but-
  // unimplemented gap was closed in one pass: `trust-task-discovery/0.1`,
  // `acl/update/0.1`, `vta/webvh/servers/retire-orphan/0.1`,
  // `vtc/members/removal-notice/0.1`, `vta/app-state/*` (6), `vta/services/*`
  // (8), `vta/credentials/{issue,revoke}/0.1`, and
  // `auth/passkey/login/{start,finish}/0.2`.
  //
  // 160 -> 161 is `vta/credentials/list/0.1`, and the canonical total moved
  // with it (177 -> 178) because the task did not exist on either side before.
  // Specified at trustoverip/dtgwg-trust-tasks-tf#342 and implemented at
  // OpenVTC/verifiable-trust-infrastructure#1235, in response to a gap this
  // console surfaced: `revoke` is keyed on a `credentialId` that `issue`
  // returns exactly once, so an issuer that had not recorded it could not ask.
  // Unlike the eight below, this is not a family that moved off the unspecced
  // list — it is new.
  //
  // 152 -> 160 is the whole `vault/credentials/*` sub-family — receive, query,
  // get, archive, unarchive, delete, restore, purge — which moved here from
  // the unspecced list rather than from a backlog. The agent had been
  // dispatching all eight with no schema in the registry; specifying them
  // (trustoverip/dtgwg-trust-tasks-tf#338, shipped in @openvtc/trust-tasks
  // 0.16.4) is what produced bindings to implement against.
  //
  // 161 -> 163 is `vta/backup/abort` and `vta/management/reload-services`,
  // specced at trustoverip/dtgwg-trust-tasks-tf#347 and shipped in
  // @openvtc/trust-tasks 0.16.8. Same shape as the eight before them: the
  // agent was already dispatching both with no schema in the registry.
  //
  // **`vta/backup/*` is now specced in full and deliberately implemented in
  // part**, which makes it the first family whose absence is a decision rather
  // than a gap upstream. All five verbs have bindings; this library exposes
  // `abort` alone. `initiate-export` and `finalize-import` carry a `password`
  // — the key to a complete copy of the agent, travelling inbound — and a
  // browser is the wrong place to collect it, for reasons `admin/backup.ts`
  // sets out at length. Do not "finish" the family to make this number
  // rounder; the four that are missing are missing on purpose.
  //
  // **The other 15 outstanding are unspecced** — no schema in the registry, so
  // no binding in @openvtc/trust-tasks to implement against: `vault/*`'s own
  // archive/restore/purge/unarchive (the *secrets* lifecycle, distinct from
  // the credential one above), `vta/attestation/*`, `vta/seeds/*` and
  // `vta/audit/*-retention`.
  //
  // `vta/seeds/*` is a third category again, and will never move: it returns
  // key material, and CI bans its URIs from every extension bundle including
  // the console. A spec landing upstream would not change that.
  //
  // **Nothing is behind any more.** Every implemented family names the newest
  // version `vta-sdk` publishes: `vault/{list,get,upsert}` and
  // `provision/integration` at 0.3 (both the hex-digest -> `digestMultibase`
  // change), `device/wipe` at 0.2, `vta/credentials/issue` at 0.2. The last of
  // those was a *removal* rather than a deprecation — VTI dropped the 0.1
  // constant outright — which is why it surfaced in the check above as a URI
  // the agent does not name, rather than as a deprecation warning. That is the
  // expected shape of a cutover here: nothing is deployed, so neither side
  // keeps an old version alive.
  const expected = 163;
  assert.equal(
    implemented.size,
    expected,
    `this library implements ${implemented.size} of ${canonicalFamilies.size} canonical ` +
      `task families; the checked-in expectation is ${expected}. If you added or removed ` +
      `one, update \`expected\` here in the same commit.`,
  );
});
