import { test } from "node:test";
import assert from "node:assert/strict";

import { reachWords, retiredWords, timelineWords, unTellWords } from "../src/manager/face-lifecycle.ts";

test("a face that told no one gets no warning, and one that did is told it cannot un-tell", () => {
  assert.equal(unTellWords({ partyCount: 0, contextCount: 0 }), null);
  assert.equal(unTellWords(undefined), null);
  const w = unTellWords({ partyCount: 3, contextCount: 1 });
  assert.match(w ?? "", /3 parties across 1 context\b/);
  assert.match(w ?? "", /does not un-tell/);
});

test("retiring says where it was taken off and that it is kept", () => {
  assert.match(retiredWords([]), /worn nowhere/);
  assert.match(retiredWords([{}, {}]), /Taken off 2 places/);
});

test("reach reads as a restriction, and absent is anywhere", () => {
  assert.equal(reachWords(undefined), "may be worn anywhere");
  assert.equal(reachWords({ kind: "only", contextIds: ["a"] }), "may be worn only in one context");
});

test("a timeline line names types and parties, never a value", () => {
  const name = (id: string) => (id === "ctx" ? "Co-op" : id);
  assert.equal(
    timelineWords(
      { at: "2026-01-01T00:00:00Z", kind: "disclosed", contextId: "ctx", verifierDid: "did:web:v", claimTypes: ["name.display"] },
      name,
    ),
    "Told did:web:v name.display in Co-op",
  );
  assert.equal(
    timelineWords({ at: "2026-01-01T00:00:00Z", kind: "valueChanged", claimTypes: ["email.work"], version: 7 }, name),
    "email.work changed (version 7)",
  );
  assert.equal(timelineWords({ at: "2026-01-01T00:00:00Z", kind: "promoted", contextId: "ctx" }, name), "Made reusable across your faces, from Co-op");
});
