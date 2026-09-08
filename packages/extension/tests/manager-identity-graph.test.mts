// The identity map's reach — what lights up, and in which direction.
//
// An attribute's reach is where it goes; a context's reach is what it holds. Get the
// direction wrong and the picture claims a context holds an attribute it was never
// given, or that an attribute reaches a context it does not — the second being the
// holder concluding no linkage exists when one does. Every case here has a
// paired positive, because a reach function that lights nothing satisfies every
// "does not light" assertion there is.

import { test } from "node:test";
import assert from "node:assert/strict";
import {
  buildGraph,
  attributeReach,
  flowOf,
  personaKey,
  reachOf,
  standingOf,
  tallyContexts,
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

test("a face's attribute ids are its live references only", () => {
  // A pinned entry still reaches a context, but it does not draw to the live
  // card — that card would then read as "changes when the attribute does".
  assert.deepEqual(G.faces.find((f) => f.id === "F-pub")?.attributeIds, ["f-name"]);
  assert.equal(G.faces.find((f) => f.id === "F-pub")?.preserved, 1);
});

test("a face worn by two personas is a link; a face worn by one is not", () => {
  assert.deepEqual(G.links.map((l) => l.faceId), ["F-dev"]);
  assert.deepEqual(
    G.links[0]!.wearers.map((w) => `${w.contextId}/${w.did}`),
    ["openvtc/did:a", "vta/did:b"],
  );
});

test("an attribute reaches down: its faces, their wearers, their contexts", () => {
  const r = reachOf(G, { kind: "attribute", id: "f-phone" });
  assert.deepEqual([...r.faceIds], ["F-dev"]);
  assert.deepEqual([...r.contextIds].sort(), ["openvtc", "vta"]);
  assert.ok(r.personaKeys.has(personaKey("openvtc", "did:a")));
  assert.ok(r.personaKeys.has(personaKey("vta", "did:b")));
  // …and not the persona in vta that wears nothing.
  assert.ok(!r.personaKeys.has(personaKey("vta", "did:c")));
});

test("an attribute in two faces reaches through both", () => {
  const r = reachOf(G, { kind: "attribute", id: "f-name" });
  assert.deepEqual([...r.faceIds].sort(), ["F-dev", "F-pub"]);
});

test("an attribute only pinned, in a face nobody wears, reaches nowhere", () => {
  const r = reachOf(G, { kind: "attribute", id: "f-signal" });
  assert.equal(r.faceIds.size, 0);
  assert.equal(r.contextIds.size, 0);
});

test("a context reaches up: its personas' faces and those faces' attributes — not every attribute", () => {
  const r = reachOf(G, { kind: "context", id: "openvtc" });
  assert.deepEqual([...r.faceIds], ["F-dev"]);
  assert.deepEqual([...r.attributeIds].sort(), ["f-name", "f-phone"]);
  assert.ok(!r.attributeIds.has("f-signal"), "a context must not light an attribute it was never given");
});

test("a context where nobody is known lights only itself", () => {
  const r = reachOf(G, { kind: "context", id: "webvh" });
  assert.deepEqual([...r.contextIds], ["webvh"]);
  assert.equal(r.faceIds.size + r.attributeIds.size + r.personaKeys.size, 0);
});

test("a face reaches both ways", () => {
  const r = reachOf(G, { kind: "face", id: "F-dev" });
  assert.deepEqual([...r.attributeIds].sort(), ["f-name", "f-phone"]);
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
  assert.equal(r.attributeIds.size + r.faceIds.size + r.contextIds.size + r.personaKeys.size, 0);
});

test("an unreadable context is carried as unreadable, not as empty", () => {
  const g = buildGraph(ATTRS, FACES, [
    { id: "dark", label: "dark", bindings: { ok: false, error: "refused" } },
  ]);
  assert.equal(g.contexts[0]?.unreadable, "refused");
  assert.equal(g.contexts[0]?.personas.length, 0);
});

test("attributeReach says where an attribute goes in the words the strip uses", () => {
  const r = attributeReach(G, "f-phone");
  assert.deepEqual(r.faces.map((f) => f.name), ["Developer"]);
  assert.deepEqual(r.contextIds.sort(), ["openvtc", "vta"]);
  assert.equal(r.wearers.length, 2);
});

// ── Which way the light travelled ───────────────────────────────────────────
//
// The map paints the two directions in two colours, so a wrong flow is a
// picture that says a copy left the holder when a context merely holds one, or
// the reverse. Every case below names the direction as well as the node,
// because "lit" was what the pane used to know and it was not enough.

test("selecting an attribute sends everything below it downwards", () => {
  const r = reachOf(G, { kind: "attribute", id: "f-phone" });
  assert.equal(flowOf(r, "attribute", "f-phone"), "self");
  assert.equal(flowOf(r, "face", "F-dev"), "down");
  assert.equal(flowOf(r, "persona", personaKey("openvtc", "did:a")), "down");
  assert.equal(flowOf(r, "context", "openvtc"), "down");
});

test("selecting a context pulls everything above it upwards", () => {
  const r = reachOf(G, { kind: "context", id: "openvtc" });
  assert.equal(flowOf(r, "context", "openvtc"), "self");
  assert.equal(flowOf(r, "persona", personaKey("openvtc", "did:a")), "up");
  assert.equal(flowOf(r, "face", "F-dev"), "up");
  assert.equal(flowOf(r, "attribute", "f-phone"), "up");
});

test("a face is the one selection that splits — up to its attributes, down to its wearers", () => {
  const r = reachOf(G, { kind: "face", id: "F-dev" });
  assert.equal(flowOf(r, "face", "F-dev"), "self");
  assert.equal(flowOf(r, "attribute", "f-name"), "up");
  assert.equal(flowOf(r, "persona", personaKey("vta", "did:b")), "down");
  assert.equal(flowOf(r, "context", "vta"), "down");
});

test("a node nothing reaches has no flow at all", () => {
  const r = reachOf(G, { kind: "attribute", id: "f-phone" });
  assert.equal(flowOf(r, "attribute", "f-signal"), null, "not lit is not a direction");
  assert.equal(flowOf(reachOf(G, null), "context", "openvtc"), null);
});

// ── One predicate for what a context is ─────────────────────────────────────

test("a persona wearing nothing leaves its context identified, not known and not absent", () => {
  // This is the vta card in the live console: the face was unbound, the
  // persona record stayed, and `binding/list` keeps enumerating it. The
  // context knows an identifier and holds no attributes — a third answer.
  const g = buildGraph(ATTRS, FACES, [ctx("vta", [{ did: "did:c", faceId: null }])]);
  assert.equal(standingOf(g.contexts[0]!), "identified");
});

test("every context is counted exactly once, so the header's numbers close", () => {
  const g = buildGraph(ATTRS, FACES, [
    ...CTXS,
    { id: "dark", label: "dark", bindings: { ok: false, error: "refused" } },
  ]);
  const tally = tallyContexts(g);
  assert.deepEqual(tally, { known: 2, identified: 0, absent: 1, unreadable: 1, total: 4 });
  assert.equal(
    tally.known + tally.identified + tally.absent + tally.unreadable,
    tally.total,
    "the band, the header and the fold all read this — they cannot be allowed to disagree",
  );
});

test("a context holding one bound and one unbound persona is known, not identified", () => {
  // `vta` in the fixture holds both. Whichever way it were counted twice, one
  // of the two numbers on screen would be wrong.
  assert.equal(standingOf(G.contexts.find((x) => x.id === "vta")!), "known");
  assert.deepEqual(tallyContexts(G), { known: 2, identified: 0, absent: 1, unreadable: 0, total: 3 });
});

test("an unreadable context is never counted as absent", () => {
  // "Could not ask" folded in with "holds nothing about you" is the one wrong
  // answer this page must not give, and the tally is now where that is decided.
  const g = buildGraph(ATTRS, FACES, [{ id: "dark", label: "dark", bindings: { ok: false, error: "refused" } }]);
  assert.deepEqual(tallyContexts(g), { known: 0, identified: 0, absent: 0, unreadable: 1, total: 1 });
});
