// What the console lets an operator type into the rename field.
//
// The rule is the agent's (`vti_common::identifier`), applied here so a refusal
// arrives as a sentence under the field rather than as
// `new_key_id is 86 bytes; maximum is 64` after the fact. Every assertion is a
// shape the live console produced: a DID-URL key id pre-filled into the field,
// and the suggestion offered in its place.

import { strict as assert } from "node:assert";
import { test } from "node:test";

import {
  isNameable,
  keyNameProblem,
  suggestKeyName,
  MAX_KEY_NAME_BYTES,
} from "../src/manager/key-name.js";

const DID_KEY = "did:webvh:QmRqxWCVUE6Y474EPdNZmR9m3giTRyDgmXSdidvEy7iSwq:webvh.storm.ws:vdr-host#key-1";

test("an ordinary slug is accepted", () => {
  for (const ok of ["app-signing-key-2026", "vdr.host", "_private", "CamelCase", "0"]) {
    assert.equal(keyNameProblem(ok), null, ok);
    assert.equal(isNameable(ok), true, ok);
  }
});

test("the id the field used to be pre-filled with is refused, and says why", () => {
  // The bug this module ends: the only thing pressing Save could do was fail.
  assert.equal(isNameable(DID_KEY), false);
  const why = keyNameProblem(DID_KEY);
  assert.ok(why?.includes("not a DID URL"), why ?? "no reason given");
});

test("a separator is refused whatever its length", () => {
  // These are the agent's own attack shapes — a key id lands as a store key.
  for (const bad of ["global:evil", "../../etc", "my/ctx", "with space", "quote\"it"]) {
    assert.notEqual(keyNameProblem(bad), null, bad);
  }
});

test("the length cap is the agent's, and counts bytes", () => {
  assert.equal(keyNameProblem("a".repeat(MAX_KEY_NAME_BYTES)), null);
  const over = keyNameProblem("a".repeat(MAX_KEY_NAME_BYTES + 1));
  assert.ok(over?.includes(String(MAX_KEY_NAME_BYTES)), over ?? "no reason given");
});

test("empty is a state, not a violation of the character rule", () => {
  assert.ok(keyNameProblem("")?.includes("empty"));
});

test("the suggestion names the identity and the key, and would be accepted", () => {
  const s = suggestKeyName(DID_KEY);
  assert.equal(s, "vdr-host-key-1");
  assert.equal(keyNameProblem(s), null);
});

test("a suggestion is derived from the last path segment, not the SCID", () => {
  const s = suggestKeyName(
    "did:webvh:Qma9EKoeEJqtWpvAdGdrsZMcEFL5QpKrVYsJDyVxd87pCd:webvh.storm.ws:rooms:open-demo#key-0",
  );
  assert.equal(s, "open-demo-key-0");
});

test("every suggestion is a name the agent would take", () => {
  // The placeholder is read as an offer. One the agent refuses is worse than
  // none — it teaches the rule wrongly at exactly the moment it is being read.
  for (const id of [
    DID_KEY,
    "did:key:z6MkExample#z6MkExample",
    "did:webvh:Qm:host#key-0",
    "did:peer:2.Ez6LS.Vz6Mk#key-1",
  ]) {
    const s = suggestKeyName(id);
    assert.notEqual(s, "", id);
    assert.equal(keyNameProblem(s), null, `${id} → ${s}`);
  }
});
