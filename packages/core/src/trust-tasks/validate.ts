// SPEC §7.2 item 2 — evaluating a payload against its published schema.
//
// Every generated binding ships its own `PAYLOAD_SCHEMA`: a JSON Schema 2020-12
// document with all cross-file `$ref`s already inlined. This module is what
// actually runs one, so a consumer enforces what the registry publishes rather
// than an approximation of it hand-written at the call site.
//
// ## Why the hand-written checks it replaces were not enough
//
// A hand-rolled `typeof payload.sideEffects !== "string"` is not a cheap
// version of the schema's `enum: ["none", "mutating", "destructive"]` — it is a
// different, weaker check, and the difference is invisible until it matters. It
// admits *any* string, and every consumer downstream then has to guess what to
// do with a value the schema would have refused. In this package the consent
// surface answered that question by falling through to its least alarming
// rendering, so the most dangerous case a schema violation can produce arrived
// looking like the safest one.
//
// The same asymmetry runs through the rest of the vocabulary the registry
// actually uses: `minimum` (a `minApprovals` of 0 is a `number`), `maxLength`
// (framework 0.5 §7.3 item 19 bounds every free-text member precisely so a
// renderer is not handed unbounded prose), `additionalProperties: false`, and
// `unevaluatedProperties: false` — the last being the one a *generated type*
// cannot express at all, in either language, which is why validating the schema
// is not the same as trusting the type.
//
// ## Why a real validator rather than a subset of one
//
// A survey of the 349 payload schemas this package ships finds `$ref` 2583
// times, `oneOf` 141, `propertyNames` 669, `pattern` 1036, `format` 944, plus
// `not`, `uniqueItems`, `dependentRequired` and `minProperties`. A partial
// implementation of that would under-enforce silently, which is worse than not
// validating: it reports success it did not establish. `@cfworker/json-schema`
// is a complete 2020-12 implementation with no dependencies of its own, and
// costs ~6 kB gzipped.
//
// `@openvtc/trust-tasks` deliberately ships no validator — it has zero runtime
// dependencies so it can load anywhere — and defines the consumer seam instead.
// This module fills that seam for this package, and {@link PayloadValidator}
// lets a consumer substitute another.

import { Validator } from "@cfworker/json-schema";

/** Why a payload was refused: JSON Pointer to the offending location, and what
 *  the schema said about it. */
export interface SchemaViolation {
  /** RFC 6901 pointer into the payload, e.g. `/effects/0/summary`. */
  instanceLocation: string;
  /** The keyword that refused it, and its message. */
  error: string;
}

export type SchemaValidationResult =
  | { valid: true }
  | { valid: false; violations: SchemaViolation[] };

/**
 * The seam `@openvtc/trust-tasks` defines for SPEC §7.2 item 2.
 *
 * Supply one to substitute a different validator — a stricter build, a shared
 * instance with a warmed cache, or a no-op where an upstream gateway has
 * already validated the same bytes. {@link validateAgainstSchema} is the
 * default and needs no configuration.
 */
export type PayloadValidator = (
  schema: unknown,
  payload: unknown,
) => SchemaValidationResult;

/**
 * Compiled validators, keyed by the schema object itself.
 *
 * A `WeakMap` rather than a `Map`: the keys are the module-level
 * `PAYLOAD_SCHEMA` constants of whichever bindings a caller imported, so they
 * live exactly as long as those modules do and pinning them in a strong map
 * would keep every schema a process ever validated against resident forever.
 *
 * Compilation is the expensive half, and the inbound path runs this once per
 * delivered message — including on every mediator redelivery after an MV3
 * worker respawn.
 */
const compiled = new WeakMap<object, Validator>();

/**
 * Validate `payload` against a binding's `PAYLOAD_SCHEMA`.
 *
 * ```ts
 * import { PAYLOAD_SCHEMA } from "@openvtc/trust-tasks/task-consent/request/0.1/payload";
 * const result = validateAgainstSchema(PAYLOAD_SCHEMA, doc.payload);
 * ```
 *
 * Draft 2020-12, and **short-circuit: false**, so a rejection carries every
 * violation rather than only the first. A caller reporting "payload is
 * malformed" one member at a time makes a human fix them one round-trip at a
 * time.
 */
export function validateAgainstSchema(
  schema: unknown,
  payload: unknown,
): SchemaValidationResult {
  if (typeof schema !== "object" || schema === null) {
    // A caller that passed something other than a schema gets a refusal, not a
    // pass. Treating an unusable schema as "nothing to check" is the silent
    // skip this module exists to remove.
    return {
      valid: false,
      violations: [{ instanceLocation: "", error: "no schema to validate against" }],
    };
  }

  let validator = compiled.get(schema);
  if (!validator) {
    validator = new Validator(schema as Record<string, unknown>, "2020-12", false);
    compiled.set(schema, validator);
  }

  const result = validator.validate(payload);
  if (result.valid) return { valid: true };
  return {
    valid: false,
    violations: result.errors.map((e) => ({
      instanceLocation: e.instanceLocation,
      error: e.error,
    })),
  };
}

/** One-line summary of a rejection, for a log or an error message. */
export function describeViolations(violations: readonly SchemaViolation[]): string {
  return violations
    .map((v) => `${v.instanceLocation || "(root)"}: ${v.error}`)
    .join("; ");
}
