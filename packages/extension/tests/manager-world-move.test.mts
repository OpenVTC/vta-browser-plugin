// Moving a face between worlds — the ordering the agent enforces.
//
// `facet/put` replaces, and the agent refuses to place a face that already
// belongs somewhere. So a move is two writes and the order is not a style
// choice: source first, destination second. These assert that, and that the
// writes carry live membership rather than echoing dangling ids back.

import { test } from "node:test";
import assert from "node:assert/strict";
import { movePlan } from "../src/manager/world-model.js";

const world = (facetId: string, name: string, faceIds: string[], attributeIds: string[] = []) =>
  ({ facetId, name, colour: "teal", faceIds, attributeIds, version: 1, updatedAt: "x" }) as never;
const face = (profileId: string) => ({ profileId, name: profileId, entries: [], version: 1, updatedAt: "x" }) as never;

const FACES = [face("f1"), face("f2")];
const ATTRS = [{ attributeId: "a1" }, { attributeId: "a2" }];

test("a move rewrites the source before the destination", () => {
  const worlds = [world("w1", "Work", ["f1", "f2"]), world("w2", "Home", [])];
  const plan = movePlan(worlds, FACES, ATTRS, "f1", "w2");
  assert.equal(plan.length, 2);
  assert.equal(plan[0]!.facetId, "w1", "the world losing the face is written first");
  assert.deepEqual(plan[0]!.faceIds, ["f2"]);
  assert.equal(plan[1]!.facetId, "w2");
  assert.deepEqual(plan[1]!.faceIds, ["f1"]);
});

test("dropping a face onto the world it is already in does nothing", () => {
  const worlds = [world("w1", "Work", ["f1"])];
  assert.deepEqual(movePlan(worlds, FACES, ATTRS, "f1", "w1"), []);
});

test("moving an unplaced face writes only the destination", () => {
  const worlds = [world("w1", "Work", [])];
  const plan = movePlan(worlds, FACES, ATTRS, "f1", "w1");
  assert.equal(plan.length, 1);
  assert.equal(plan[0]!.facetId, "w1");
});

test("moving a face out of every world writes only the source", () => {
  const worlds = [world("w1", "Work", ["f1"])];
  const plan = movePlan(worlds, FACES, ATTRS, "f1", null);
  assert.equal(plan.length, 1);
  assert.deepEqual(plan[0]!.faceIds, []);
});

test("a write carries live membership, never a dangling id", () => {
  // `facet/list` returns ids whose records are gone, deliberately, so a client
  // can offer to tidy. Echoing one back is refused with `unresolvedReference`
  // and leaves the world uneditable — the defect that shipped as plugin #216.
  const worlds = [world("w1", "Work", ["f1", "GONE"], ["a1", "ALSO-GONE"])];
  const plan = movePlan(worlds, FACES, ATTRS, "f1", null);
  assert.deepEqual(plan[0]!.faceIds, [], "the vanished face id is dropped, not resent");
  assert.deepEqual(plan[0]!.attributeIds, ["a1"], "and so is the vanished attribute id");
});

test("the world's own name, colour and mark survive a move", () => {
  // A move is a membership change. A put that omitted them would rename the
  // world to undefined and reset its colour, which is a data loss nothing on
  // screen would explain.
  const worlds = [
    { facetId: "w1", name: "Working life", colour: "plum", icon: "\u{1F4BC}", faceIds: ["f1"], attributeIds: [], version: 1, updatedAt: "x" } as never,
    world("w2", "Home", []),
  ];
  const plan = movePlan(worlds, FACES, ATTRS, "f1", "w2");
  assert.equal(plan[0]!.name, "Working life");
  assert.equal(plan[0]!.colour, "plum");
  assert.equal(plan[0]!.icon, "\u{1F4BC}");
});
