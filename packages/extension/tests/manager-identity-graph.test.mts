// The identity map's reach — what lights up, and in which direction.
//
// A fact's reach is where it goes; a context's reach is what it holds. Get the
// direction wrong and the picture claims a context holds a fact it was never
// given, or that a fact reaches a context it does not — the second being the
// holder concluding no linkage exists when one does. Every case here has a
// paired positive, because a reach function that lights nothing satisfies every
// "does not light" assertion there is.

import { test } from "node:test";
import assert from "node:assert/strict";
import {
  buildGraph,
  factReach,
  personaKey,
  reachOf,
  type ContextInput,
} from "../src/manager/identity-graph.ts";

const attr = (id: string, type: string) => ({
  attributeId: id,
  type,
  valueType: "string" as const,
  value: id,
  provenance: { kind: "selfAsserted" as const },
  version: 1,
  updatedAt: "x",
});
const profile = (id: string, name: string, entries: unknown[]) => ({
  profileId: id,
  name,
  entries: entries as never,
  version: 1,
  updatedAt: "x",
});
const ctx = (
  id: string,
  personas: { did: string; faceId: string | null; claimCount?: number }[],
): ContextInput => ({
  id,
  label: id,
  bindings: { ok: true, personas: personas.map((p) => ({ ...p, claimCount: p.claimCount ?? 0 })) },
});

const ATTRS = [attr("f-name", "name"), attr("f-phone", "phone.mobile"), attr("f-signal", "profile.signal")];
const FACES = [
  profile("F-dev", "Developer", [{ ref: "f-name" }, { ref: "f-phone" }]),
  profile("F-pub", "Public", [{ ref: "f-name" }, { ref: "f-signal", pinVersion: 1 }]),
];
const CTXS = [
  ctx("openvtc", [{ did: "did:a", faceId: "F-dev", claimCount: 2 }]),
  ctx("vta", [{ did: "did:b", faceId: "F-dev", claimCount: 2 }, { did: "did:c", faceId: null }]),
  ctx("webvh", []),
];
const G = buildGraph(ATTRS, FACES, CTXS);

test("a face's fact ids are its live references only", () => {
  // A pinned entry still reaches a context, but it does not draw to the live
  // card — that card would then read as "changes when the fact does".
  assert.deepEqual(G.faces.find((f) => f.id === "F-pub")?.factIds, ["f-name"]);
  assert.equal(G.faces.find((f) => f.id === "F-pub")?.preserved, 1);
});

test("a face worn by two personas is a link; a face worn by one is not", () => {
  assert.deepEqual(G.links.map((l) => l.faceId), ["F-dev"]);
  assert.deepEqual(
    G.links[0]!.wearers.map((w) => `${w.contextId}/${w.did}`),
    ["openvtc/did:a", "vta/did:b"],
  );
});

test("a fact reaches down: its faces, their wearers, their contexts", () => {
  const r = reachOf(G, { kind: "fact", id: "f-phone" });
  assert.deepEqual([...r.faceIds], ["F-dev"]);
  assert.deepEqual([...r.contextIds].sort(), ["openvtc", "vta"]);
  assert.ok(r.personaKeys.has(personaKey("openvtc", "did:a")));
  assert.ok(r.personaKeys.has(personaKey("vta", "did:b")));
  // …and not the persona in vta that wears nothing.
  assert.ok(!r.personaKeys.has(personaKey("vta", "did:c")));
});

test("a fact in two faces reaches through both", () => {
  const r = reachOf(G, { kind: "fact", id: "f-name" });
  assert.deepEqual([...r.faceIds].sort(), ["F-dev", "F-pub"]);
});

test("a fact only pinned, in a face nobody wears, reaches nowhere", () => {
  const r = reachOf(G, { kind: "fact", id: "f-signal" });
  assert.equal(r.faceIds.size, 0);
  assert.equal(r.contextIds.size, 0);
});

test("a context reaches up: its personas' faces and those faces' facts — not every fact", () => {
  const r = reachOf(G, { kind: "context", id: "openvtc" });
  assert.deepEqual([...r.faceIds], ["F-dev"]);
  assert.deepEqual([...r.factIds].sort(), ["f-name", "f-phone"]);
  assert.ok(!r.factIds.has("f-signal"), "a context must not light a fact it was never given");
});

test("a context where nobody is known lights only itself", () => {
  const r = reachOf(G, { kind: "context", id: "webvh" });
  assert.deepEqual([...r.contextIds], ["webvh"]);
  assert.equal(r.faceIds.size + r.factIds.size + r.personaKeys.size, 0);
});

test("a face reaches both ways", () => {
  const r = reachOf(G, { kind: "face", id: "F-dev" });
  assert.deepEqual([...r.factIds].sort(), ["f-name", "f-phone"]);
  assert.deepEqual([...r.contextIds].sort(), ["openvtc", "vta"]);
});

test("a persona lights its own context and face, not its neighbours'", () => {
  const r = reachOf(G, { kind: "persona", contextId: "vta", did: "did:b" });
  assert.deepEqual([...r.contextIds], ["vta"]);
  assert.deepEqual([...r.faceIds], ["F-dev"]);
  assert.ok(
    !r.personaKeys.has(personaKey("openvtc", "did:a")),
    "the other wearer is a link, not a reach",
  );
});

test("no selection lights nothing", () => {
  const r = reachOf(G, null);
  assert.equal(r.factIds.size + r.faceIds.size + r.contextIds.size + r.personaKeys.size, 0);
});

test("an unreadable context is carried as unreadable, not as empty", () => {
  const g = buildGraph(ATTRS, FACES, [
    { id: "dark", label: "dark", bindings: { ok: false, error: "refused" } },
  ]);
  assert.equal(g.contexts[0]?.unreadable, "refused");
  assert.equal(g.contexts[0]?.personas.length, 0);
});

test("factReach says where a fact goes in the words the strip uses", () => {
  const r = factReach(G, "f-phone");
  assert.deepEqual(r.faces.map((f) => f.name), ["Developer"]);
  assert.deepEqual(r.contextIds.sort(), ["openvtc", "vta"]);
  assert.equal(r.wearers.length, 2);
});
