// The snapshot scanner, over fixture SDKs.
//
// `sync-task-surface.mjs` grew real logic — it follows `pub use
// trust_tasks_rs::specs::…` aliases to resolve a constant whose value is a
// generated type rather than a string — and the failure it replaced was silent:
// a task the scanner could not see simply was not in the snapshot, and
// `task-surface.mjs` then reported it as a URI **the SDK does not have**. That
// is the wording for a typo or a dropped task, so a scanner limitation read as
// a live finding. It cost an investigation before it was recognised.
//
// So the property under test is not only "resolves the forms we know" but
// "stops rather than writing a snapshot with a hole in it".
//
// Driven as a subprocess against a fixture tree rather than by importing the
// helpers, because the thing that went wrong was end-to-end: what lands in the
// file, and what the exit code is.

import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { existsSync, mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

const SCRIPT = resolve(import.meta.dirname, "../scripts/sync-task-surface.mjs");

/**
 * Build a throwaway `vta-sdk` whose `src/` holds `files`, and sync from it.
 *
 * **Into the throwaway directory, never over the checked-in snapshot.** This
 * used to write the real `task-surface.json` and restore it in a `finally`,
 * which is a race rather than a cleanup: `node --test` runs test files in
 * parallel processes, and `tests/task-surface.mjs` reads that same file at
 * module scope. It saw either this fixture's handful of tasks — surfacing as
 * "task-surface.json looks truncated" and "implements 0 of 3 canonical task
 * families" — or a half-written file, as `SyntaxError: Unexpected end of JSON
 * input`. Both reproduced only where the two files happened to overlap, which
 * on a developer machine with cores to spare is rarely, and on a two-core CI
 * runner is often.
 */
function syncFrom(files) {
  const root = mkdtempSync(join(tmpdir(), "fake-sdk-"));
  const out = join(root, "task-surface.json");
  mkdirSync(join(root, "src"), { recursive: true });
  writeFileSync(join(root, "Cargo.toml"), 'version = "9.9.9"\n');
  for (const [name, body] of Object.entries(files)) {
    writeFileSync(join(root, "src", name), body);
  }
  try {
    let status = 0;
    let stderr = "";
    try {
      execFileSync(process.execPath, [SCRIPT, root, out], { stdio: ["ignore", "pipe", "pipe"] });
    } catch (e) {
      status = e.status ?? 1;
      stderr = String(e.stderr ?? "");
    }
    // A run that stopped deliberately writes nothing, which is the property
    // two of these tests are about — so an absent file is reported as `null`
    // rather than throwing here and losing the status that explains it.
    const snapshot = existsSync(out) ? JSON.parse(readFileSync(out, "utf8")) : null;
    return { status, stderr, snapshot };
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}

const uris = (snapshot) => snapshot.tasks.map((t) => t.uri);

test("a constant derived from its generated type is resolved, not dropped", () => {
  const { status, snapshot } = syncFrom({
    "p.rs": `
pub use trust_tasks_rs::specs::vtc::join_requests::manifest;

pub const JOIN_REQUEST_MANIFEST_TYPE: &str =
    <manifest::v0_1::Payload as trust_tasks_rs::Payload>::TYPE_URI;
`,
  });
  assert.equal(status, 0);
  // snake_case module, kebab-case slug — the segment-for-segment rule.
  assert.deepEqual(uris(snapshot), ["https://trusttasks.org/spec/vtc/join-requests/manifest/0.1"]);
  assert.deepEqual(snapshot.tasks[0].consts, ["JOIN_REQUEST_MANIFEST_TYPE"]);
});

test("the response half lands on the same task, as the literal pairs do", () => {
  const { snapshot } = syncFrom({
    "p.rs": `
pub use trust_tasks_rs::specs::vtc::join_requests::manifest;

pub const M_TYPE: &str =
    <manifest::v0_1::Payload as trust_tasks_rs::Payload>::TYPE_URI;
pub const M_RESPONSE_TYPE: &str =
    <manifest::v0_1::Response as trust_tasks_rs::Payload>::TYPE_URI;
`,
  });
  assert.equal(snapshot.tasks.length, 1, "the response was recorded as a second task");
  assert.deepEqual(snapshot.tasks[0].consts, ["M_RESPONSE_TYPE", "M_TYPE"]);
});

test("a braced alias group resolves each of its names, across a wrap", () => {
  const { snapshot } = syncFrom({
    "p.rs": `
pub use trust_tasks_rs::specs::vetting::{
    decline, request, session,
};

pub const A: &str = <request::v0_1::Payload as trust_tasks_rs::Payload>::TYPE_URI;
pub const B: &str = <session::v0_1::Payload as trust_tasks_rs::Payload>::TYPE_URI;
pub const C: &str = <decline::v0_1::Payload as trust_tasks_rs::Payload>::TYPE_URI;
`,
  });
  assert.deepEqual(uris(snapshot).sort(), [
    "https://trusttasks.org/spec/vetting/decline/0.1",
    "https://trusttasks.org/spec/vetting/request/0.1",
    "https://trusttasks.org/spec/vetting/session/0.1",
  ]);
});

test("an alias carries deeper module segments", () => {
  const { snapshot } = syncFrom({
    "p.rs": `
pub use trust_tasks_rs::specs::vtc::vetting::{revoke_statement, vetters};

pub const G: &str = <vetters::grant::v0_1::Payload as trust_tasks_rs::Payload>::TYPE_URI;
pub const R: &str = <revoke_statement::v0_1::Payload as trust_tasks_rs::Payload>::TYPE_URI;
`,
  });
  assert.deepEqual(uris(snapshot).sort(), [
    "https://trusttasks.org/spec/vtc/vetting/revoke-statement/0.1",
    "https://trusttasks.org/spec/vtc/vetting/vetters/grant/0.1",
  ]);
});

// A `pub use` reaching *inside* a version module imports types, not specs.
// Treating `VettingRequirements` as a spec module would invent a URI for it.
test("a use that reaches inside a version module registers no alias", () => {
  const { status, stderr, snapshot } = syncFrom({
    "p.rs": `
pub use trust_tasks_rs::specs::vtc::join_requests::manifest::v0_2::{
    VettingRequirements, Branding,
};
`,
  });
  assert.equal(status, 0, stderr);
  assert.deepEqual(uris(snapshot), []);
});

// The property the whole change exists for.
test("an unresolvable constant stops the sync instead of vanishing from it", () => {
  const { status, stderr, snapshot } = syncFrom({
    "p.rs": `
pub const ORPHAN_TYPE: &str =
    <nowhere::v0_1::Payload as trust_tasks_rs::Payload>::TYPE_URI;
`,
  });
  assert.equal(status, 1, "the sync succeeded with a task missing from the snapshot");
  assert.match(stderr, /nowhere/);
  // The *declaration* line, not the value line below it: that is where the
  // constant is and where someone would edit it.
  assert.match(stderr, /p\.rs:2/, "the message does not say where to look");
  // And nothing was written — a failed sync must not half-write.
  //
  // This used to read "the real snapshot is untouched", because the script had
  // no way to write anywhere else and the fixture ran against the checked-in
  // file. Writing to the run's own path states the property directly: a stop
  // leaves no snapshot at all, rather than leaving one whose survival is only
  // evidence that this particular run did not get as far as the write.
  assert.equal(snapshot, null, "a stopped sync still produced a snapshot");
});

// `include_str!` constants are `&str` and are not tasks. The stop above must
// not fire on them, or no sync ever completes.
test("a &str constant built from a file is not mistaken for a task", () => {
  const { status, stderr } = syncFrom({
    "p.rs": `
pub const CONTEXT: &str =
    include_str!("../../contexts/vta-authorization-v1.jsonld");
`,
  });
  assert.equal(status, 0, stderr);
});

test("literal constants still work, wrapped or not", () => {
  const { snapshot } = syncFrom({
    "p.rs": `
pub const SHORT: &str = "https://trusttasks.org/spec/acl/grant/0.1";
#[deprecated(since = "0.1.0", note = "use grant/0.2")]
pub const WRAPPED_AND_DEPRECATED: &str =
    "https://trusttasks.org/spec/acl/revoke/0.1";
`,
  });
  assert.deepEqual(uris(snapshot).sort(), [
    "https://trusttasks.org/spec/acl/grant/0.1",
    "https://trusttasks.org/spec/acl/revoke/0.1",
  ]);
  const revoke = snapshot.tasks.find((t) => t.uri.endsWith("revoke/0.1"));
  assert.equal(revoke.deprecated, "use grant/0.2");
});
