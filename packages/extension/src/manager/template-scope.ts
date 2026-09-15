// Which namespace a DID template lives in.
//
// **Scope is part of a template's identity, not a label on it.** `builtin`,
// `global` and one named `context` are three different namespaces, and the same
// name can exist in all three as three different documents. Every call in the
// family takes `contextId` to say which one it means — so reading the scope off
// a record and sending the right selector back is what stops an operator editing
// the global `room` while looking at their context's.
//
// It is a `{ type }` object on the wire rather than a bare string, which is easy
// to get wrong by one property name and impossible to notice: `"context" in
// scope` is false for every variant, so a test for it silently routes every
// context template to the global namespace.
//
// A plain module rather than part of a pane so a test can reach it.

import type { DidTemplateRecord } from "@openvtc/pnm-core/admin";

export type TemplateScope =
  | { kind: "builtin" }
  | { kind: "global" }
  | { kind: "context"; contextId: string };

/** A record's scope, read structurally. An unrecognised one reads as `global`,
 *  which is the namespace the calls address when no selector is sent — so the
 *  fallback and the request agree rather than pointing at different sets. */
export function scopeOf(template: DidTemplateRecord): TemplateScope {
  const s: unknown = template.scope;
  if (typeof s !== "object" || s === null) return { kind: "global" };
  const type = (s as { type?: unknown }).type;
  if (type === "builtin") return { kind: "builtin" };
  if (type === "context") {
    const contextId = (s as { contextId?: unknown }).contextId;
    if (typeof contextId === "string" && contextId !== "") return { kind: "context", contextId };
    // A context scope with no context is not a context scope. Reading it as
    // global at least addresses a namespace that exists.
    return { kind: "global" };
  }
  return { kind: "global" };
}

/**
 * The `contextId` selector for a call about this template.
 *
 * `undefined` for `global` **and for `builtin`**: a built-in belongs to no
 * context and is addressed without a selector. It is also not writable — see
 * {@link isEditable} — so the only calls that reach here for one are `get` and
 * `render`.
 */
export function scopeSelector(template: DidTemplateRecord): string | undefined {
  const scope = scopeOf(template);
  return scope.kind === "context" ? scope.contextId : undefined;
}

/**
 * Whether this template can be written to.
 *
 * A built-in ships with the agent: `room` and `room-host` are what the rooms
 * flow stamps from, and they are not the operator's to edit or delete. The
 * agent refuses; saying so on the button is the difference between a disabled
 * control and a refusal that arrives after the form was filled in.
 */
export function isEditable(template: DidTemplateRecord): boolean {
  return scopeOf(template).kind !== "builtin";
}

/** How the scope reads on screen. */
export function scopeWord(template: DidTemplateRecord): string {
  const scope = scopeOf(template);
  switch (scope.kind) {
    case "builtin":
      return "built in";
    case "context":
      return `in ${scope.contextId}`;
    case "global":
      return "global";
  }
}

/** A key unique across the three namespaces, for a list that shows all of
 *  them: the name alone collides exactly where the collision matters. */
export function scopeKey(template: DidTemplateRecord): string {
  const scope = scopeOf(template);
  return scope.kind === "context" ? `context:${scope.contextId}` : scope.kind;
}

/**
 * One list from the global listing and a context's, with nothing shown twice.
 *
 * **A context listing is not disjoint from the global one.** The agent may
 * answer a context-scoped call with a global template of the same name — the
 * fallback is in the specification — so asking both namespaces and concatenating
 * lists every global template twice. On screen that is two identical cards, and
 * in React two children with one key, which is how one of them stops responding
 * to a click.
 *
 * The key is scope *and* name, not name alone: a template called `room` in a
 * context and a different one called `room` globally are two documents, and
 * collapsing them would hide whichever came second behind a name that looks
 * familiar. That is the case the badge on the card exists to tell apart.
 *
 * The context's own record wins a tie, because a context-scoped call is the one
 * that reaches it.
 */
export function mergeTemplates(
  scoped: DidTemplateRecord[],
  global: DidTemplateRecord[],
): DidTemplateRecord[] {
  const seen = new Map<string, DidTemplateRecord>();
  for (const tpl of [...scoped, ...global]) {
    const key = `${scopeKey(tpl)}:${tpl.name}`;
    if (!seen.has(key)) seen.set(key, tpl);
  }
  return [...seen.values()];
}
