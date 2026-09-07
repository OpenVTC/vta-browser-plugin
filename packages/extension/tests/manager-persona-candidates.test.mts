// A context's persona picker may only offer that context's personas.
//
// Reported from the live console: switching between contexts, the list offered
// identifiers belonging to other contexts. The agent filters (`list_dids_webvh`
// drops any record whose `context_id` differs), so the promise was already
// there — and a promise is not the same as a list that cannot contain one.
//
// Why it matters more than a tidiness bug: a binding is context-scoped, and the
// same DID in two contexts is two unrelated bindings. Offering an identifier
// from elsewhere invites a holder to be known in one place by a name another
// place already knows them by — the exact correlation this family exists to let
// them avoid — under a label reading "the identifier this context knows you by".

import { test } from "node:test";
import assert from "node:assert/strict";
import { personaCandidates } from "../src/manager/persona-candidates.ts";

const pub = (did: string, contextId: string) => ({ did, contextId });

test("a published DID from another context is not offered", () => {
  const out = personaCandidates("vta", [pub("did:a", "openvtc"), pub("did:b", "vta")], []);
  assert.deepEqual(out.map((c) => c.did), ["did:b"]);
});

test("a published DID from this context is offered", () => {
  // The pair. Without it the assertion above is satisfied by a function that
  // offers nothing at all — which is precisely the dead end #181 fixed.
  const out = personaCandidates("vta", [pub("did:b", "vta"), pub("did:c", "vta")], []);
  assert.deepEqual(out.map((c) => c.did), ["did:b", "did:c"]);
  assert.deepEqual(out.map((c) => c.note), ["published here", "published here"]);
});

test("a persona that is not a published DID still appears", () => {
  // A `did:key` the VTA minted or a `did:peer` never reaches the published
  // list, and a picker built from that alone would hide the personas already
  // in use here.
  const out = personaCandidates("vta", [], [{ personaDid: "did:key:zA", bound: true, profileName: "test" }]);
  assert.deepEqual(out, [{ did: "did:key:zA", note: "wears test" }]);
});

test("an unbound persona says so rather than looking like a face", () => {
  const out = personaCandidates("vta", [], [{ personaDid: "did:key:zA", bound: false }]);
  assert.equal(out[0]?.note, "known here, wearing nothing");
});

test("a persona already known wins the label over its published entry", () => {
  const out = personaCandidates(
    "vta",
    [pub("did:b", "vta")],
    [{ personaDid: "did:b", bound: true, profileName: "Developer" }],
  );
  assert.deepEqual(out, [{ did: "did:b", note: "wears Developer" }], "one row, and the useful label");
});

test("nothing is offered twice", () => {
  const out = personaCandidates(
    "vta",
    [pub("did:b", "vta"), pub("did:b", "vta")],
    [{ personaDid: "did:b", bound: false }],
  );
  assert.equal(out.length, 1);
});

test("a context with nothing of its own offers nothing, even beside a busy neighbour", () => {
  // The reported shape: several contexts hold DIDs, the selected one holds
  // none. "Nothing here" is the answer, and it is what routes the holder to
  // creating one.
  const out = personaCandidates("agent-memory", [pub("did:a", "openvtc"), pub("did:b", "vta")], []);
  assert.deepEqual(out, []);
});
