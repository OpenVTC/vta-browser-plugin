// A did:webvh path the operator chooses, checked before the mint.
//
// Every case here is one the hosting server's `validate_custom_path` decides
// the same way. The point of checking first is that a refused mint can leave
// derived keys behind — so a name this accepts and the server refuses is the
// failure worth a test, and so is a name this refuses that the server would
// have taken.

import { strict as assert } from "node:assert";
import { test } from "node:test";

import { didPath, pathProblem, RESERVED_FIRST_SEGMENTS } from "../src/manager/webvh-path.js";

test("ordinary names are accepted, one segment or several", () => {
  for (const ok of ["northwind", "rooms/northwind", "a1", "room-host", "teams/acme/rooms/q3-plan"]) {
    assert.equal(pathProblem(ok), null, ok);
  }
});

test("a segment is 2 to 63 characters", () => {
  assert.equal(pathProblem("ab"), null);
  assert.equal(pathProblem("a".repeat(63)), null);
  assert.match(pathProblem("a")!, /2 to 63 characters/);
  assert.match(pathProblem("a".repeat(64))!, /2 to 63 characters/);
});

test("the whole path is at most 255 characters", () => {
  const segment = "a".repeat(63);
  const at255 = [segment, segment, segment, "a".repeat(63)].join("/"); // 63*4 + 3
  assert.equal(at255.length, 255);
  assert.equal(pathProblem(at255), null);
  assert.match(pathProblem(`${at255}a`)!, /at most 255/);
});

// Lowercase only is the server's defence against two slots that differ by case
// shadowing each other. Not something to relax here for convenience.
test("uppercase, underscores and spaces are refused", () => {
  for (const bad of ["Rooms", "rooms_x", "rooms northwind", "rooms.northwind"]) {
    assert.match(pathProblem(bad)!, /lowercase letters, digits and hyphens only/, bad);
  }
});

test("a segment starts and ends with a letter or digit", () => {
  assert.match(pathProblem("-rooms")!, /starts and ends/);
  assert.match(pathProblem("rooms-")!, /starts and ends/);
  assert.match(pathProblem("rooms/-x1")!, /starts and ends/);
});

test("slashes at the edges and empty segments are refused", () => {
  assert.match(pathProblem("/rooms")!, /start or end/);
  assert.match(pathProblem("rooms/")!, /start or end/);
  assert.match(pathProblem("rooms//northwind")!, /empty segments/);
  assert.match(pathProblem("")!, /let the hosting server choose/);
});

// A person copying the shape of a DID types `:`. It is refused either way; the
// message says what to type instead.
test("a colon is answered with the slash it stands for", () => {
  assert.match(pathProblem("rooms:northwind")!, /Separate path segments with “\/”/);
});

// Only the first segment collides with the server's routes, so `rooms/api` is a
// perfectly good path and refusing it would be this copy being stricter than
// the rule it mirrors.
test("reserved names are refused only as the first segment", () => {
  assert.match(pathProblem("api")!, /reserved/);
  assert.match(pathProblem("dids/northwind")!, /reserved/);
  assert.equal(pathProblem("rooms/api"), null);
});

test("the reserved names are the hosting server's list, all of them", () => {
  assert.deepEqual(
    [...RESERVED_FIRST_SEGMENTS].sort(),
    [".well-known", "acl", "api", "auth", "dids", "health", "stats"],
  );
});

test("a path reads in the DID with colons between its segments", () => {
  assert.equal(didPath("rooms/northwind"), "rooms:northwind");
  assert.equal(didPath("northwind"), "northwind");
});
