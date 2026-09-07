// The console must not lock itself out of the configuration it recommends.
//
// `holderGate` used to return a refusal *and* disable every button on the
// persona pane, on the reasoning that an unscoped admin was the only credential
// that could reach the holder-scoped tasks. That stopped being true when the
// agent gained `persona-holder` (verifiable-trust-infrastructure#1286): a
// context-scoped entry granted that capability reaches them too — and it is now
// the recommended shape, since OpenVTC's setup asks for exactly it.
//
// `auth/whoami` reports roles and scopes, not capabilities, so this console
// cannot tell the two apart. What it must therefore not do is claim to know.

import { test } from "node:test";
import assert from "node:assert/strict";
import { holderGate } from "../src/manager/holder-gate.ts";
import type { Authority } from "../src/manager/use-vta.ts";

const authority = (roles: string[], scopes: string[]): Authority =>
  ({ session: {} as Authority["session"], roles, scopes });

test("an unscoped holder is told nothing — it plainly holds what it takes", () => {
  assert.equal(holderGate(authority(["admin"], [])), null);
});

test("a context-scoped admin is cautioned, not refused", () => {
  const note = holderGate(authority(["admin"], ["work"]));
  assert.ok(note, "a scoped admin needs to know this may be refused");
  // The caution must name *both* ways to satisfy the agent. Naming only the
  // unscoped credential is what made the old message wrong: it sent operators
  // to widen their credential when a capability grant was the better answer.
  assert.match(note!, /persona-holder/);
  assert.match(note!, /no context restriction/);
  // And it must be honest that this console cannot tell which they have.
  assert.match(note!, /cannot see/);
});

test("the caution speaks the agreed vocabulary", () => {
  const note = holderGate(authority(["application"], ["work"]))!;
  for (const banned of ["attribute", "profile", "binding", "disclosure", "provenance"]) {
    assert.ok(
      !note.toLowerCase().includes(banned),
      `"${banned}" is kept off the screen (design-docs/persona-vocabulary.md): ${note}`,
    );
  }
});

test("no authority yet says nothing at all", () => {
  // Still loading is not the same as refused, and a caution shown before the
  // answer arrives is one the operator learns to dismiss.
  assert.equal(holderGate(null), null);
});
