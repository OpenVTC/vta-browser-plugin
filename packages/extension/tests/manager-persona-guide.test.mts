// Guide or map, and the three ways deriving it goes wrong.
//
// This decides which of two whole screens a holder sees, and it has been wrong
// twice: once by flipping to the map when step two created a face (caught by
// reading), once by never flipping back after the last face was deleted (caught
// by someone about to explore the pane by deleting everything, which is the
// first thing anyone does).
//
// Both failures look like a broken page rather than a wrong boolean, which is
// why the rule is a function with a test rather than three terms inline.

import { test } from "node:test";
import assert from "node:assert/strict";
import { showsGuide } from "../src/manager/persona-flow.ts";

const s = (faces: number | null, guiding = false, skipped = false) => showsGuide({ faces, guiding, skipped });

test("a holder with no face is guided", () => {
  assert.equal(s(0), true);
});

test("a holder with a face gets the map", () => {
  // The paired positive. Without it every assertion here is satisfied by a
  // function that always guides.
  assert.equal(s(1), false);
  assert.equal(s(9), false);
});

test("faces not loaded yet is not zero", () => {
  // Treating null as 0 would flash the guide at every holder on every load,
  // then yank it away — the worst possible first impression of the pane.
  assert.equal(s(null), false);
});

test("the guide survives its own second step creating a face", () => {
  // The bug caught by reading: step two makes a face, so `faces` becomes 1
  // while the holder is still mid-guide with step three — the step the whole
  // guide leads to — unreached.
  assert.equal(s(1, true), true);
});

test("the guide lets go once it finishes", () => {
  // `onFinished` clears `guiding`; the face it made then keeps the map on.
  assert.equal(s(1, false), false);
});

test("deleting the last face brings the guide back", () => {
  // The bug this file was written for. A holder exploring the pane deletes
  // their face and lands on a map with nothing to draw, and no way back short
  // of reloading the page.
  assert.equal(s(0, false), true);
});

test("skipping is sticky, even when the last face goes", () => {
  // Someone who said they would build it themselves must not be put back into
  // the guide by deleting a face — which is a thing they may well do next.
  assert.equal(s(0, false, true), false);
  assert.equal(s(1, false, true), false);
  // …and it beats `guiding`, so a skip mid-guide is honoured immediately.
  assert.equal(s(0, true, true), false);
});
