import { test } from "node:test";
import assert from "node:assert/strict";

import { composeClaimsFrom, composedWords } from "../src/manager/compose-claims.ts";

test("a typed value is local unless the holder shares it", () => {
  const r = composeClaimsFrom([
    { kind: "new", type: "name.display", value: "Ada", share: false },
    { kind: "new", type: "email.personal", value: "a@p.test", share: true },
    { kind: "held", attributeId: "01J" },
  ]);
  assert.equal(r.ok, true);
  if (!r.ok) return;
  assert.deepEqual(r.claims, [
    { type: "name.display", valueType: "string", value: "Ada" },
    { type: "email.personal", valueType: "string", value: "a@p.test", share: "pool" },
    { attributeId: "01J" },
  ]);
});

test("blank rows are dropped and a half-filled one is refused", () => {
  assert.equal(composeClaimsFrom([{ kind: "new", type: "", value: "", share: false }]).ok, false);
  assert.equal(composeClaimsFrom([{ kind: "new", type: "name.display", value: "", share: false }]).ok, false);
  assert.equal(composeClaimsFrom([{ kind: "new", type: "Name Display", value: "x", share: false }]).ok, false);
});

test("the outcome says where the face lives and when it now shares a fact", () => {
  assert.match(composedWords({ scope: "local" }), /Made here/);
  const w = composedWords({ scope: "pool", pooled: [{ created: false }], binding: { personaDid: "did:x" } });
  assert.match(w, /already kept/);
  assert.match(w, /worn here now/);
});
