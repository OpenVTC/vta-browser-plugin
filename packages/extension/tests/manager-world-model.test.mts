// What the worlds screen knows, tested away from the screen.
//
// Two of these are about a refusal, and they are the ones that matter: the
// agent's `faceAlreadyPlaced` code exists so a pane can say *where* a face
// already is, and a client that read it loosely would either miss the refusal
// entirely or report half of it as the whole.

import { test } from "node:test";
import assert from "node:assert/strict";
import {
  worldOfFace,
  worldsOfAttribute,
  unplacedFaces,
  placedElsewhere,
  seedMembership,
} from "../src/manager/world-model.ts";
import { ConsentRequiredError, RelayTaskError } from "../src/manager/carrier.ts";

const world = (id: string, name: string, faceIds: string[], attributeIds: string[] = []) =>
  ({ facetId: id, name, colour: "teal", faceIds, attributeIds, version: 1, updatedAt: "x" }) as never;
const face = (id: string, name: string) =>
  ({ profileId: id, name, entries: [], version: 1, updatedAt: "x" }) as never;

const WORLDS = [world("w1", "Work", ["f1", "f2"]), world("w2", "Home", ["f3"])];
const FACES = [face("f1", "Acme"), face("f2", "LinkedIn"), face("f3", "Family"), face("f4", "Loose")];

test("a face reports the world already holding it", () => {
  assert.equal(worldOfFace(WORLDS, "f3")?.name, "Home");
  assert.equal(worldOfFace(WORLDS, "f4"), undefined);
});

test("a world being edited does not conflict with its own members", () => {
  // Without the exclusion every checkbox in an edit is disabled the moment the
  // world holds anything — the same self-clash the agent's placement check
  // excludes on its own side.
  assert.equal(worldOfFace(WORLDS, "f1", "w1"), undefined);
  assert.equal(worldOfFace(WORLDS, "f3", "w1")?.name, "Home");
});

test("faces belonging to no world are reported, not hidden", () => {
  // Belonging nowhere is a perfectly good state, and most faces are in it
  // before anyone arranges anything. A screen listing only arranged faces
  // under-reports what the holder has.
  assert.deepEqual(unplacedFaces(WORLDS, FACES).map((f) => f.name), ["Loose"]);
});

test("every face placed means nothing is loose", () => {
  assert.deepEqual(unplacedFaces(WORLDS, FACES.slice(0, 3)), []);
});

test("the refusal is matched on the code, never on a message", () => {
  // R3.7. A string match breaks the first time the agent rewords itself, and
  // the failure is silent: the flow falls through to a generic error and the
  // holder is told to go and find the face themselves.
  const refusal = new RelayTaskError(
    "persona/facet/put/1.0",
    "one or more faces already belong to another facet",
    { code: "persona/facet/put:faceAlreadyPlaced", details: { placed: [{ faceId: "f1", facetId: "w2" }] } },
  );
  assert.deepEqual(placedElsewhere(refusal), [{ faceId: "f1", facetId: "w2" }]);

  // The same words, carried by an error with no code at all.
  const sameWordsNoCode = new RelayTaskError(
    "persona/facet/put/1.0",
    "one or more faces already belong to another facet",
    {},
  );
  assert.equal(placedElsewhere(sameWordsNoCode), null, "a message was read as a refusal");
});

test("a different extended code is not this refusal", () => {
  const other = new RelayTaskError("persona/facet/put/1.0", "nope", {
    code: "persona/facet/put:versionConflict",
    details: { placed: [{ faceId: "f1", facetId: "w2" }] },
  });
  assert.equal(placedElsewhere(other), null);
});

test("a consent ceremony is never swallowed as a placement refusal", () => {
  // It has its own surface and must reach it. Catching it here would discard
  // the ceremony at the moment the human was meant to act.
  const consent = new ConsentRequiredError("persona/facet/put/1.0", {
    payloadDigest: "z".repeat(64),
    challenge: "c",
    approverSet: "a",
    minApprovals: 1,
    consentRequests: [],
  });
  assert.equal(placedElsewhere(consent), null);
});

test("a refusal with no usable details falls through rather than claiming zero", () => {
  // An empty list renders as "0 faces already belong elsewhere", which is a
  // claim. The honest answer is to show the generic error.
  for (const details of [undefined, {}, { placed: [] }, { placed: "nope" }]) {
    const refusal = new RelayTaskError("persona/facet/put/1.0", "x", {
      code: "persona/facet/put:faceAlreadyPlaced",
      ...(details !== undefined ? { details } : {}),
    });
    assert.equal(placedElsewhere(refusal), null, `details ${JSON.stringify(details)} was accepted`);
  }
});

test("a mixed array is refused rather than filtered", () => {
  // Half an answer about where the holder's faces are is worse than none,
  // because the missing half is invisible.
  const refusal = new RelayTaskError("persona/facet/put/1.0", "x", {
    code: "persona/facet/put:faceAlreadyPlaced",
    details: { placed: [{ faceId: "f1", facetId: "w2" }, { faceId: 7 }] },
  });
  assert.equal(placedElsewhere(refusal), null);
});

test("an attribute may belong to several worlds, and all of them are reported", () => {
  // The asymmetry with a face, and the reason for it: a mobile number is
  // genuinely part of a working life and a home one at once, so a model that
  // made the holder choose would be asking a question with no answer. The agent
  // enforces no exclusivity here either.
  const worlds = [
    world("w1", "Work", [], ["a1", "a2"]),
    world("w2", "Home", [], ["a1"]),
    world("w3", "Play", [], []),
  ];
  assert.deepEqual(worldsOfAttribute(worlds, "a1").map((w) => w.name), ["Work", "Home"]);
  assert.deepEqual(worldsOfAttribute(worlds, "a2").map((w) => w.name), ["Work"]);
  assert.deepEqual(worldsOfAttribute(worlds, "a9"), []);
});

test("an attribute's worlds come back in listing order, not membership order", () => {
  // Two attributes in the same worlds must draw their dots in the same order:
  // a row whose marks reshuffle between renders reads as a change when nothing
  // changed.
  const worlds = [world("w1", "Work", [], ["a1"]), world("w2", "Home", [], ["a1"])];
  assert.deepEqual(worldsOfAttribute(worlds, "a1").map((w) => w.facetId), ["w1", "w2"]);
  const reversed = [worlds[1]!, worlds[0]!];
  assert.deepEqual(worldsOfAttribute(reversed, "a1").map((w) => w.facetId), ["w2", "w1"]);
});

// ── Dangling membership is repaired, not carried ────────────────────────────

test("an editor opens with only the membership that still exists", () => {
  // The live bug this closes. `facet/list` returns dangling ids on purpose so a
  // consumer can offer to tidy; seeding them raw sends them back into a `put`
  // the agent refuses, naming ULIDs the holder cannot untick — there is no row
  // to untick, because the record is gone. The world becomes permanently
  // uneditable by the only screen that edits it.
  const existing = {
    facetId: "w1",
    name: "Work",
    colour: "teal",
    faceIds: ["f1", "GONE-FACE"],
    attributeIds: ["a1", "GONE-1", "GONE-2"],
    version: 3,
    updatedAt: "x",
  } as never;
  const seeded = seedMembership(existing, [face("f1", "Acme")], [{ attributeId: "a1" }]);
  assert.deepEqual([...seeded.faceIds], ["f1"]);
  assert.deepEqual([...seeded.attributeIds], ["a1"]);
  assert.equal(seeded.droppedFaces, 1);
  assert.equal(seeded.droppedAttributes, 2);
});

test("a world with nothing stale drops nothing and says nothing", () => {
  const existing = {
    facetId: "w1", name: "Work", colour: "teal",
    faceIds: ["f1"], attributeIds: ["a1"], version: 1, updatedAt: "x",
  } as never;
  const seeded = seedMembership(existing, [face("f1", "Acme")], [{ attributeId: "a1" }]);
  assert.equal(seeded.droppedFaces, 0);
  assert.equal(seeded.droppedAttributes, 0);
});

test("a new world starts empty and reports no repair", () => {
  const seeded = seedMembership(undefined, [face("f1", "Acme")], [{ attributeId: "a1" }]);
  assert.equal(seeded.faceIds.size, 0);
  assert.equal(seeded.attributeIds.size, 0);
  assert.equal(seeded.droppedFaces, 0);
  assert.equal(seeded.droppedAttributes, 0);
});
