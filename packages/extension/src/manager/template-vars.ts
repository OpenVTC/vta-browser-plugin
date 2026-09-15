// What a DID template asks the operator for, and what the form can answer itself.
//
// `templateVars` is checked at the agent, and **every `requiredVars` name must
// be present or the render fails** — including names the document never
// substitutes. That check runs after the agent has derived the DID's keys, so a
// missing variable is not a free refusal: it can leave key material behind. The
// form's job is to ask for all of them before anything is sent.
//
// **The ambient names are the agent's and are never asked for.** `DID`,
// `SIGNING_KEY_MB`, `KA_KEY_MB`, `VTA_DID`, `VTA_URL`, `CONTEXT_ID`,
// `CONTEXT_DID` and `NOW` are injected by the agent at render time; a template
// declaring one in `requiredVars` is malformed (the specification says it MUST
// NOT), and a field for one would be an operator typing a value the agent then
// overwrites. They are filtered out here rather than trusted not to appear.
//
// A plain module rather than part of the form so a test can reach it.

import type { DidTemplateRecord } from "@openvtc/pnm-core/admin";

/** Names the agent fills in itself. Not asked, not sent. */
export const AMBIENT_VARS: readonly string[] = [
  "DID",
  "SIGNING_KEY_MB",
  "KA_KEY_MB",
  "VTA_DID",
  "VTA_URL",
  "CONTEXT_ID",
  "CONTEXT_DID",
  "NOW",
];

/** One variable the form draws a field for. */
export interface TemplateVar {
  name: string;
  /** Whether the render fails without it. An optional one has a default the
   *  agent would use, which is why the field is seeded rather than blank. */
  required: boolean;
  /** The template's default, as text, for an optional variable. */
  fallback?: string;
}

/** A template's `optionalVars`/`defaults` values are `unknown`. A string is
 *  itself; anything else is its JSON, because a field has to hold text and
 *  `[object Object]` is worse than the shape it stands for. */
function asText(value: unknown): string {
  if (typeof value === "string") return value;
  if (value === undefined || value === null) return "";
  return JSON.stringify(value);
}

/**
 * The variables the operator is asked for, required ones first.
 *
 * Required before optional because the required ones are what block the mint —
 * an operator scanning the form should meet the fields that must be answered
 * before the ones that need not be.
 */
export function templateVars(template: DidTemplateRecord): TemplateVar[] {
  const required = (template.requiredVars ?? [])
    .filter((name) => !AMBIENT_VARS.includes(name))
    .map((name) => ({ name, required: true }));

  const requiredNames = new Set(required.map((v) => v.name));
  const optional = Object.entries(template.optionalVars ?? {})
    // A name in both lists is required — that is the stricter reading, and the
    // agent's check is on `requiredVars` alone.
    .filter(([name]) => !AMBIENT_VARS.includes(name) && !requiredNames.has(name))
    .map(([name, value]) => ({ name, required: false, fallback: asText(value) }));

  return [...required, ...optional];
}

/**
 * Values the form already holds, offered for variables of the same name.
 *
 * The `room` and `room-host` built-ins want `WEBVH_SERVER` and `MEDIATOR_DID`,
 * which the form asks for elsewhere as real choices — the hosting server and
 * the mediator. Making the operator retype them into a second field is how
 * those two answers come to disagree.
 *
 * **Seeded, not bound.** The value lands in the field and the operator can
 * change it: matching on a name is a guess about what a template meant, and a
 * guess that silently overrode a typed value would be worse than no seeding at
 * all.
 */
export function seedVars(
  vars: TemplateVar[],
  known: Record<string, string | undefined>,
): Record<string, string> {
  const seeded: Record<string, string> = {};
  for (const v of vars) {
    const fromForm = known[v.name];
    if (fromForm !== undefined && fromForm !== "") {
      seeded[v.name] = fromForm;
    } else if (v.fallback !== undefined) {
      seeded[v.name] = v.fallback;
    }
  }
  return seeded;
}

/** Required variables with nothing in them. The mint is refused until this is
 *  empty, and it is empty for a template that asks for nothing. */
export function missingVars(
  vars: TemplateVar[],
  values: Record<string, string>,
): string[] {
  return vars
    .filter((v) => v.required && (values[v.name] ?? "").trim() === "")
    .map((v) => v.name);
}

/**
 * The variables actually sent.
 *
 * An optional variable left at its default is **omitted**, not sent as the text
 * the field was seeded with. The reason is the same one the persona editor
 * gives for writing an absent `sensitivity`: sending today's default freezes
 * it, so a later change to the template would apply to every DID minted after
 * it and not to this one. An emptied required field is sent as the empty
 * string, so the agent's own check is what refuses it rather than this form
 * quietly dropping the name.
 */
export function varsToSend(
  vars: TemplateVar[],
  values: Record<string, string>,
): Record<string, string> {
  const out: Record<string, string> = {};
  for (const v of vars) {
    const value = values[v.name] ?? "";
    if (v.required) {
      out[v.name] = value.trim();
    } else if (value.trim() !== "" && value.trim() !== (v.fallback ?? "").trim()) {
      out[v.name] = value.trim();
    }
  }
  return out;
}

/**
 * A template's `defaults` hint, read for the one thing it is for.
 *
 * `defaults` is declared as hints "for CLI / setup wizards" — `portable`,
 * `preRotationCount`, `addMediatorService` — so this console is exactly its
 * audience. It is read **once, when a template is chosen**, and applied as a
 * seed to the form's own controls. A hint that kept overriding the controls
 * would make the checkboxes beside it lie.
 */
export interface TemplateDefaults {
  portable?: boolean;
  addMediatorService?: boolean;
  addTspService?: boolean;
  preRotationCount?: number;
}

export function templateDefaults(template: DidTemplateRecord): TemplateDefaults {
  const d = template.defaults ?? {};
  const out: TemplateDefaults = {};
  for (const key of ["portable", "addMediatorService", "addTspService"] as const) {
    if (typeof d[key] === "boolean") out[key] = d[key];
  }
  // Read as a number only where the hint *is* one. `Number(null)` is 0 and
  // `Number("")` is 0, so a looser test turns an absent or empty hint into
  // "pre-rotation off" — the one setting that makes a stolen key unrecoverable,
  // arrived at by a template that never asked for it.
  const hint = d["preRotationCount"];
  if (typeof hint === "number" && Number.isInteger(hint) && hint >= 0) {
    out.preRotationCount = hint;
  }
  return out;
}
