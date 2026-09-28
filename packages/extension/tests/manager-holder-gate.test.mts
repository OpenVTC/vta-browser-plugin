// The persona caution reads the capability, not the role.
//
// The agent admits a caller to the holder's pool on `persona-holder` granted by
// name and on nothing else — since verifiable-trust-infrastructure #1673, not
// even an admin with no context restriction. The caution used to stay silent
// for exactly that admin, which is the credential most likely to be refused,
// and offered "no context restriction" as a way in. `auth/whoami` now reports
// effective capabilities, so the console can say which case it is in.

import { test } from "node:test";
import assert from "node:assert/strict";
import { holderGate, holdsPersonaHolder, personaHolderGrantCommand } from "../src/manager/holder-gate.ts";
import type { Authority } from "../src/manager/use-vta.ts";

const HOLDER_DID = "did:key:z6MkWalletHolder";
const authority = (roles: string[], scopes: string[], capabilities: string[] = []): Authority =>
  ({ session: { subject: HOLDER_DID } as Authority["session"], roles, scopes, capabilities });

test("a credential granted persona-holder is told nothing, whatever its scope", () => {
  for (const scopes of [[], ["work"]]) {
    const a = authority(["admin"], scopes, ["vault-read", "persona-holder"]);
    assert.equal(holdsPersonaHolder(a), true);
    assert.equal(holderGate(a), null);
  }
});

test("an unrestricted admin without the grant is cautioned — no role reaches the pool", () => {
  // The old gate returned null here. After #1673 the agent refuses this caller.
  const a = authority(["admin"], [], ["vault-read", "acl-write"]);
  assert.equal(holdsPersonaHolder(a), false);
  const note = holderGate(a);
  assert.ok(note, "an unscoped admin without the grant will be refused and must be told");
  assert.match(note!, /persona-holder/);
});

test("the caution names the grant, not a wider credential, as the way in", () => {
  const note = holderGate(authority(["admin"], ["work"]))!;
  // Widening to "no context restriction" does not help any more; the note must
  // not send an operator to do it.
  assert.doesNotMatch(note, /an agent credential with no context restriction, or/);
  assert.ok(note.includes(personaHolderGrantCommand(HOLDER_DID)), note);
});

test("the grant command is pnm's real syntax, and names this wallet's own DID", () => {
  // `pnm acl update` takes the DID positionally; `--did` is not one of its flags.
  assert.equal(
    personaHolderGrantCommand(HOLDER_DID),
    `pnm acl update ${HOLDER_DID} --capabilities persona-holder`,
  );
});

test("the caution speaks the agreed vocabulary", () => {
  const note = holderGate(authority(["application"], ["work"]))!;
  // `attribute` came *off* this list: the table now uses the spec word on
  // screen too, because the word it used to translate to — `fact` — asserted
  // a truth the model cannot promise and already meant a verified policy input
  // in `vtc-service`. See "Why not 'fact'" in the vocabulary guide.
  for (const banned of ["fact", "profile", "binding", "disclosure", "provenance"]) {
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
