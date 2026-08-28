// The consent payload, against the schema the registry publishes.
//
// These are the cases a hand-written `typeof` block cannot express, and every
// one of them reached a human before this was validated. The first is the
// reason the rest were worth doing: a `sideEffects` value outside the schema's
// enum is not rejected by a `typeof === "string"` check, and the consent
// surface renders severity by comparing against the three known values —
// `destructive` gets the danger colour, `mutating` the warning colour, and
// **anything else falls through to the reassuring one**. So a schema violation
// arrived looking like the safest thing the UI can draw.

import { test } from "node:test";
import assert from "node:assert/strict";

import { validateAgainstSchema, describeViolations } from "../dist/trust-tasks/validate.js";
import { PAYLOAD_SCHEMA } from "@openvtc/trust-tasks/task-consent/request/0.1/payload";

/** A payload the published schema accepts. Overrides are applied on top. */
function payload(over = {}) {
  return {
    challenge: "9c1f4b7a2e6d80f35a4c9b1e7d2f6083",
    taskType: "https://trusttasks.org/spec/webvh/dids/update/1.0",
    payloadDigest: "zQmSK9pGKFnmc77pqyNAPJyPKt8rMqctngfg3vwuMArwGYZ",
    sideEffects: "mutating",
    exposure: { discloses: "none", actsAsSubject: false },
    effects: [{ kind: "documentChange", summary: "Adds a FileStore endpoint." }],
    requester: "did:key:zRequesterBrowser",
    approverSet: "operators",
    minApprovals: 1,
    excludeRequester: true,
    expiresAt: "2030-01-01T00:00:00Z",
    ...over,
  };
}

const check = (over) => validateAgainstSchema(PAYLOAD_SCHEMA, payload(over));

test("the baseline fixture satisfies the published schema", () => {
  const res = check({});
  assert.equal(res.valid, true, res.valid ? "" : describeViolations(res.violations));
});

test("a sideEffects outside the enum is refused — the fail-open this closes", () => {
  // `typeof === "string"` accepted every one of these. The UI's severity
  // comparison then failed to match `destructive` or `mutating` and painted the
  // calm colour, so the worst possible value rendered as the most reassuring.
  for (const bad of ["destructiv", "DESTRUCTIVE", "catastrophic", ""]) {
    const res = check({ sideEffects: bad });
    assert.equal(res.valid, false, `accepted sideEffects: ${JSON.stringify(bad)}`);
  }
  // And the three the schema does define still pass.
  for (const ok of ["none", "mutating", "destructive"]) {
    assert.equal(check({ sideEffects: ok }).valid, true, ok);
  }
});

test("minApprovals below 1 is refused — a threshold nothing has to meet", () => {
  // Checked as `typeof === "number"` before, which admits 0. A consent surface
  // showing "0 of 1 approvals needed" is describing a gate that is already open.
  for (const bad of [0, -1, 1.5]) {
    assert.equal(check({ minApprovals: bad }).valid, false, `accepted ${bad}`);
  }
  assert.equal(check({ minApprovals: 1 }).valid, true);
});

test("a payloadDigest that is not a digestMultibase is refused", () => {
  // This one was live: the test fixtures for this family carried the *hex*
  // form of the shared cross-repo digest long after the multibase cutover, and
  // the `typeof === "string"` check accepted it every time. The schema's
  // `DigestMultibase` pattern is what noticed.
  const hex = "3b0c7f1d9e2a5648c1f30b7ae4d2986153ca0f7b8d41e6295af03c8bd71e4a62";
  assert.equal(check({ payloadDigest: hex }).valid, false, "bare hex accepted");
});

test("a member the schema forbids is refused, not ignored", () => {
  // `additionalProperties: false`. An unknown member is a producer and consumer
  // disagreeing about the contract, and letting it through means the disagreement
  // surfaces somewhere further along with no trace of where it entered.
  assert.equal(check({ surprise: "hello" }).valid, false);
});

test("free-text members are bounded, per framework 0.5 §7.3 item 19", () => {
  // `note` is 500. The bound exists so a consent surface is never handed
  // unbounded prose to render — the schema is where that is enforced, and there
  // was no check for it here at all.
  assert.equal(check({ note: "x".repeat(500) }).valid, true);
  assert.equal(check({ note: "x".repeat(501) }).valid, false);
});

test("a rejection reports every violation, not just the first", () => {
  // `shortCircuit: false`. Reporting one member at a time makes a human fix
  // them one round-trip at a time.
  const res = check({ sideEffects: "nope", minApprovals: 0 });
  assert.equal(res.valid, false);
  const text = describeViolations(res.violations);
  assert.match(text, /sideEffects/);
  assert.match(text, /minApprovals/);
});

test("an unusable schema refuses rather than passes", () => {
  // The silent skip this module exists to remove: "nothing to check" must never
  // read as "checked, fine".
  for (const notASchema of [undefined, null, "{}", 42]) {
    assert.equal(validateAgainstSchema(notASchema, payload()).valid, false);
  }
});

test("no shipped schema requires a member it does not define", async () => {
  // A guard on the schemas themselves, now that this package executes them
  // rather than merely shipping them.
  //
  // `@openvtc/trust-tasks` 0.16.0 shipped `provision/integration/0.3` with
  // `$defs/Response` requiring `digest` while its `properties` carried only
  // `digestMultibase` — the member the 0.2 -> 0.3 rename replaced. With
  // `additionalProperties: false` that schema is unsatisfiable: no document can
  // validate against it, so a consumer that validated would have rejected every
  // conforming response. It went unnoticed because nothing here ran the schemas.
  // Fixed upstream in 0.16.2 (#326) after `check-bindings` caught the Rust and
  // TypeScript halves disagreeing — only the Rust generator had been re-run.
  //
  // This is the cheap, decidable half of "is the schema satisfiable": a
  // `required` naming a member no `properties` defines, where the object is
  // closed. It is not general satisfiability, and is not meant to be.
  const { readdirSync, statSync } = await import("node:fs");
  const { join, resolve, dirname } = await import("node:path");
  const { fileURLToPath } = await import("node:url");

  const root = resolve(
    dirname(fileURLToPath(import.meta.url)),
    "../../../node_modules/@openvtc/trust-tasks/dist",
  );

  const problems = [];
  const scan = (s, file, key, path = "#") => {
    if (!s || typeof s !== "object") return;
    if (Array.isArray(s.required) && s.properties && s.additionalProperties === false) {
      const missing = s.required.filter((r) => !(r in s.properties));
      if (missing.length) problems.push(`${file} ${key}${path}: requires ${missing.join(", ")}`);
    }
    for (const [k, v] of Object.entries(s)) {
      if (Array.isArray(v)) v.forEach((x, i) => scan(x, file, key, `${path}/${k}/${i}`));
      else if (v && typeof v === "object") scan(v, file, key, `${path}/${k}`);
    }
  };

  const files = [];
  (function walk(d) {
    for (const e of readdirSync(d)) {
      const f = join(d, e);
      if (statSync(f).isDirectory()) walk(f);
      else if (e === "payload.js") files.push(f);
    }
  })(root);

  assert.ok(files.length > 300, `only ${files.length} schemas found — did the layout move?`);
  for (const f of files) {
    const m = await import(f);
    for (const key of ["PAYLOAD_SCHEMA", "RESPONSE_PAYLOAD_SCHEMA"]) {
      if (m[key]) scan(m[key], f.slice(root.length + 1), key);
    }
  }
  assert.deepEqual(problems, [], "unsatisfiable schema — report upstream, do not work around it here");
});
