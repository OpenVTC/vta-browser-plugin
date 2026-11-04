// An untitled record's label: its own first line, not "Untitled record".

import test from "node:test";
import assert from "node:assert/strict";

import { LABEL_MAX, untitledLabel } from "../src/manager/room-record-text.ts";

test("a one-line message is its own label, with nothing left to preview", () => {
  assert.deepEqual(untitledLabel("Hello"), { label: "Hello", rest: "" });
});

test("the first line with something to say names it, and the rest previews", () => {
  assert.deepEqual(untitledLabel("\n  \nLunch at one?\nBring the slides.\n"), {
    label: "Lunch at one?",
    rest: "Bring the slides.",
  });
});

test("a markdown marker is markup, not part of the name", () => {
  assert.equal(untitledLabel("## Minutes\nbody")?.label, "Minutes");
  assert.equal(untitledLabel("> quoted")?.label, "quoted");
  assert.equal(untitledLabel("- first item")?.label, "first item");
  // A line that is only a marker says nothing; the next one names it.
  assert.equal(untitledLabel("#\nReal title")?.label, "Real title");
});

test("a long line is cut at the limit, and the preview still carries all of it", () => {
  const long = "é".repeat(LABEL_MAX + 30);
  const got = untitledLabel(long)!;
  assert.equal([...got.label].length, LABEL_MAX);
  assert.ok(got.label.endsWith("…"));
  assert.equal(got.rest, long);
});

test("a body with nothing to say has no label", () => {
  assert.equal(untitledLabel(""), null);
  assert.equal(untitledLabel(" \n\t\n"), null);
});
