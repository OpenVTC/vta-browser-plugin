// A type the registry declares must not be declared here as well.
//
// ## What went wrong
//
// `ContextRecord` and `WebvhDidRecord` were written out by hand in this
// library, alongside the generated ones in `@openvtc/trust-tasks`. Both had
// drifted, in opposite directions, and neither drift could fail anything:
//
//   * `ContextRecord.did` was typed `string | null`. The schema makes it
//     OPTIONAL — a conforming agent omits the member — so a caller guarding
//     with `=== null` never matches, and TypeScript agrees with the caller.
//   * `WebvhDidRecord` marked `serverId` and `portable` optional where the
//     schema makes them required, and omitted seven members the agent sends
//     (`mnemonic`, `scid`, `logEntryCount`, `createdAt`, …). Data the caller
//     could have used simply was not visible.
//
// Nothing else in this repo would have caught either. `task-surface.mjs` checks
// that the URIs this library names exist and are current; it says nothing about
// payload SHAPES. The type is the one part of a Trust Task that is checked
// against a copy rather than against the schema.
//
// ## The rule
//
// If `@openvtc/trust-tasks` exports a shared component type, this library uses
// it — it does not restate it. Four more (`WakeHandle`, `WakeTriggerPolicy`,
// `Exposure`, `StatePin`) were byte-identical to the generated ones when this
// test was written, which is not reassuring: identical is the state a type is
// in immediately before it diverges, and a duplicate that has not drifted yet
// is a duplicate that will.
//
// ## The exception, and why it is narrow
//
// A local type MAY narrow a generated one where the browser knows more than the
// schema can say — see `NARROWING`. It must say so, and it must be a
// restriction, never an addition: the schema is the wider contract and a local
// type that ADDS a member is asserting something the agent never promised.

import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const SRC = fileURLToPath(new URL("../src", import.meta.url));
// The shared definitions of exactly the tasks this library pins, as
// `trust-tasks-gen-ts` hoisted them (`npm run tasks:generate`). Their names
// depend on the lock — a definition with one shape among the pinned tasks is
// bare — which is the right set to compare with: it is what `src/` can import.
const SPECS = join(SRC, "specs");
const COMPONENTS = join(SPECS, "_shared/components.ts");

/**
 * Types this library deliberately restates, each with the reason.
 *
 * An entry is a claim that the local declaration says something TRUER for a
 * browser than the schema can — not that importing it would be inconvenient.
 */
const NARROWING = {
  PasskeyVerificationMethod:
    "narrows `webauthnTransports` from the schema's `string[]` to the DOM's " +
    "`AuthenticatorTransport` union. The schema cannot name a browser type, and " +
    "a caller passing these to `navigator.credentials` wants the narrow one.",
};

// `src/specs/` is the generated tree itself, so it is the one place these
// declarations are supposed to be.
const files = (dir) =>
  readdirSync(dir, { withFileTypes: true }).flatMap((e) =>
    e.isDirectory()
      ? join(dir, e.name) === SPECS
        ? []
        : files(join(dir, e.name))
      : e.name.endsWith(".ts")
        ? [join(dir, e.name)]
        : [],
  );

const generated = new Set(
  [...readFileSync(COMPONENTS, "utf8").matchAll(/export (?:interface|type) ([A-Za-z0-9_]+)/g)].map(
    (m) => m[1],
  ),
);

test("the generated component list is real, so none of this passes vacuously", () => {
  assert.ok(
    generated.size > 100,
    `found only ${generated.size} generated component types — the path to ` +
      `components.ts is stale and this test now checks nothing`,
  );
  assert.ok(generated.has("ContextRecord"), "components.ts does not look like the right file");
});

// `export type X = SomeIdentifier;` is the *fix* pattern, not the defect: it
// aliases the generated type, so the shape still has one source. Only an inline
// body — `= {`, `= "a" | "b"`, `= Foo[]` — restates it. This distinction was
// missing when the test was first written, and it hid two: `KeyRecord` (a
// correct alias) and `PushRegistration` (an inline restatement of a union the
// schema declares as `Apns | Fcm | WebPush`).
const ALIAS_TO_IDENTIFIER = /^\s*[A-Za-z0-9_.]+(<[^;]*>)?\s*;/;

test("no schema component type is restated by hand", () => {
  const restated = [];
  for (const file of files(SRC)) {
    const rel = file.slice(SRC.length + 1);
    const src = readFileSync(file, "utf8");

    for (const m of src.matchAll(/export interface ([A-Za-z0-9_]+)/g)) {
      if (generated.has(m[1]) && !(m[1] in NARROWING)) restated.push(`${m[1]}  (${rel})`);
    }
    for (const m of src.matchAll(/export type ([A-Za-z0-9_]+)\s*=/g)) {
      if (!generated.has(m[1]) || m[1] in NARROWING) continue;
      const rhs = src.slice(m.index + m[0].length);
      if (!ALIAS_TO_IDENTIFIER.test(rhs)) restated.push(`${m[1]}  (${rel})`);
    }
  }

  assert.deepEqual(
    restated.sort(),
    [],
    `these types are declared here and also generated from a published schema:\n  ` +
      `${restated.join("\n  ")}\n\n` +
      `Import the generated one instead — a hand-written copy drifts silently, ` +
      `because nothing compares the two. Aliasing it (\`export type X = Generated;\`) ` +
      `is fine and is how the narrowing cases are written. If the local type ` +
      `deliberately NARROWS the generated one for a browser caller, add it to ` +
      `NARROWING with the reason.`,
  );
});

test("every NARROWING entry still names a generated type", () => {
  const stale = Object.keys(NARROWING).filter((n) => !generated.has(n));
  assert.deepEqual(
    stale,
    [],
    `these NARROWING entries no longer name a generated component type — the ` +
      `schema moved, so the exception is either unnecessary or now wrong: ${stale.join(", ")}`,
  );
});
