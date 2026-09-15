// A template's variable contract, and which namespace it lives in.
//
// Both of these are cheap to get wrong and expensive when wrong. The agent
// checks `requiredVars` **after** it has derived the DID's keys, so a name the
// form failed to ask for is not a free refusal — it can leave key material
// behind. And scope is part of a template's identity: the same name in the
// global namespace and in a context is two different documents, so a selector
// read wrongly edits or renders the wrong one.

import { test } from "node:test";
import assert from "node:assert/strict";
import type { DidTemplateRecord } from "@openvtc/pnm-core/admin";
import {
  AMBIENT_VARS,
  missingVars,
  seedVars,
  templateDefaults,
  templateVars,
  varsToSend,
} from "../src/manager/template-vars.js";
import {
  isEditable,
  scopeKey,
  scopeOf,
  scopeSelector,
  scopeWord,
} from "../src/manager/template-scope.js";

const tpl = (over: Partial<DidTemplateRecord> = {}): DidTemplateRecord =>
  ({
    schemaVersion: 1,
    name: "room",
    kind: "app",
    document: { id: "{DID}" },
    scope: { type: "global" },
    createdAt: 0,
    updatedAt: 0,
    createdBy: "did:key:zAdmin",
    ...over,
  }) as DidTemplateRecord;

// ── The variable contract ──

test("required variables come before optional ones", () => {
  const vars = templateVars(
    tpl({ requiredVars: ["WEBVH_SERVER"], optionalVars: { LABEL: "a room" } }),
  );
  assert.deepEqual(vars.map((v) => v.name), ["WEBVH_SERVER", "LABEL"]);
  assert.equal(vars[0]!.required, true);
  assert.equal(vars[1]!.required, false);
  assert.equal(vars[1]!.fallback, "a room");
});

// The specification says requiredVars MUST NOT name these, and the agent
// injects them regardless. A field for one is an operator typing a value that
// is then overwritten, with nothing on screen ever saying so.
test("ambient names are never asked for, however a template declares them", () => {
  const vars = templateVars(
    tpl({ requiredVars: ["DID", "VTA_URL", "REAL"], optionalVars: { NOW: "x", ALSO: "y" } }),
  );
  assert.deepEqual(vars.map((v) => v.name), ["REAL", "ALSO"]);
  for (const name of AMBIENT_VARS) {
    assert.ok(!vars.some((v) => v.name === name), `${name} reached the form`);
  }
});

test("a name in both lists is required, which is the stricter reading", () => {
  const vars = templateVars(tpl({ requiredVars: ["X"], optionalVars: { X: "default" } }));
  assert.equal(vars.length, 1);
  assert.equal(vars[0]!.required, true);
});

test("a non-string default still reaches the field as text", () => {
  const vars = templateVars(tpl({ optionalVars: { COUNT: 3, FLAGS: { a: 1 } } }));
  assert.equal(vars.find((v) => v.name === "COUNT")!.fallback, "3");
  assert.equal(vars.find((v) => v.name === "FLAGS")!.fallback, '{"a":1}');
});

// `room` wants WEBVH_SERVER and MEDIATOR_DID, which the form asks for elsewhere
// as real choices. Making the operator retype them into a second field is how
// those two answers come to disagree.
test("a variable the form already holds an answer for is seeded from it", () => {
  const vars = templateVars(tpl({ requiredVars: ["WEBVH_SERVER", "OTHER"] }));
  const seeded = seedVars(vars, { WEBVH_SERVER: "prod", MEDIATOR_DID: "did:web:m" });
  assert.equal(seeded["WEBVH_SERVER"], "prod");
  assert.equal(seeded["OTHER"], undefined, "nothing is invented for a name the form has no answer to");
});

test("an optional variable is seeded from its own default when the form has none", () => {
  const vars = templateVars(tpl({ optionalVars: { LABEL: "a room" } }));
  assert.equal(seedVars(vars, {})["LABEL"], "a room");
});

test("an empty answer from the form does not beat the template's default", () => {
  const vars = templateVars(tpl({ optionalVars: { WEBVH_SERVER: "fallback" } }));
  assert.equal(seedVars(vars, { WEBVH_SERVER: "" })["WEBVH_SERVER"], "fallback");
});

test("an empty required variable blocks the mint and is named", () => {
  const vars = templateVars(tpl({ requiredVars: ["A", "B"] }));
  assert.deepEqual(missingVars(vars, { A: "set", B: "   " }), ["B"]);
  assert.deepEqual(missingVars(vars, { A: "x", B: "y" }), []);
});

// Sending today's default freezes it: a later change to the template would
// apply to every DID minted after it and not to this one. Same reasoning as an
// absent `sensitivity` on a persona attribute.
test("an optional variable left at its default is omitted, not frozen", () => {
  const vars = templateVars(tpl({ optionalVars: { LABEL: "a room" } }));
  assert.deepEqual(varsToSend(vars, { LABEL: "a room" }), {});
  assert.deepEqual(varsToSend(vars, { LABEL: "changed" }), { LABEL: "changed" });
});

// The agent's own check is what should refuse an empty required name, not this
// form quietly dropping it — a dropped name and a blank one produce different
// errors, and only one of them says which variable.
test("an emptied required variable is still sent, so the agent refuses it by name", () => {
  const vars = templateVars(tpl({ requiredVars: ["A"] }));
  assert.deepEqual(varsToSend(vars, { A: "" }), { A: "" });
});

// ── The `defaults` hints ──

test("hints seed the form's own controls", () => {
  const d = templateDefaults(
    tpl({ defaults: { portable: true, addMediatorService: true, preRotationCount: 2 } }),
  );
  assert.deepEqual(d, { portable: true, addMediatorService: true, preRotationCount: 2 });
});

// `Number(undefined)` is NaN but `Number(null)` is 0, so an absent hint must not
// read as "pre-rotation off" — which is the setting that makes a stolen key
// unrecoverable.
test("an absent pre-rotation hint is absent, never zero", () => {
  assert.equal(templateDefaults(tpl({})).preRotationCount, undefined);
  assert.equal(templateDefaults(tpl({ defaults: {} })).preRotationCount, undefined);
  assert.equal(templateDefaults(tpl({ defaults: { preRotationCount: null } })).preRotationCount, undefined);
  assert.equal(templateDefaults(tpl({ defaults: { preRotationCount: 0 } })).preRotationCount, 0);
});

test("a hint of the wrong type is ignored rather than coerced", () => {
  const d = templateDefaults(tpl({ defaults: { portable: "yes", preRotationCount: "two" } }));
  assert.equal(d.portable, undefined);
  assert.equal(d.preRotationCount, undefined);
});

// ── Scope ──

// The wire shape is `{ type }`, not a bare string and not `{ context }`. A test
// for the wrong property name is false for every variant, which silently routes
// every context template to the global namespace.
test("a context template carries its context, and that is the selector", () => {
  const t = tpl({ scope: { type: "context", contextId: "rooms" } as never });
  assert.deepEqual(scopeOf(t), { kind: "context", contextId: "rooms" });
  assert.equal(scopeSelector(t), "rooms");
  assert.equal(scopeWord(t), "in rooms");
});

test("global and built-in are addressed with no selector", () => {
  assert.equal(scopeSelector(tpl({ scope: { type: "global" } as never })), undefined);
  assert.equal(scopeSelector(tpl({ scope: { type: "builtin" } as never })), undefined);
});

// `room` and `room-host` ship with the agent and the rooms flow stamps from
// them. The agent refuses the write; the button refusing first is the difference
// between a disabled control and a refusal after the form was filled in.
test("a built-in is not editable, and the others are", () => {
  assert.equal(isEditable(tpl({ scope: { type: "builtin" } as never })), false);
  assert.equal(isEditable(tpl({ scope: { type: "global" } as never })), true);
  assert.equal(isEditable(tpl({ scope: { type: "context", contextId: "x" } as never })), true);
});

// Reading it as global at least addresses a namespace that exists, and it is
// the one a call with no selector reaches — so the fallback and the request
// agree rather than pointing at different sets.
test("an unrecognisable scope falls back to the one a selectorless call reaches", () => {
  assert.deepEqual(scopeOf(tpl({ scope: undefined as never })), { kind: "global" });
  assert.deepEqual(scopeOf(tpl({ scope: "global" as never })), { kind: "global" });
  assert.deepEqual(
    scopeOf(tpl({ scope: { type: "context" } as never })),
    { kind: "global" },
    "a context scope with no context is not a context scope",
  );
});

// The name alone collides exactly where the collision matters — two templates
// called `room` in two namespaces are two rows, and React needs to tell them
// apart.
test("the same name in two scopes gives two keys", () => {
  const a = tpl({ scope: { type: "global" } as never });
  const b = tpl({ scope: { type: "context", contextId: "rooms" } as never });
  assert.notEqual(scopeKey(a), scopeKey(b));
});
