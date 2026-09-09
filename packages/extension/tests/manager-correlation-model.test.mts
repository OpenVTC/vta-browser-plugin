// Which links are worth acting on.
//
// The rule that carries the whole feature is the one about absence: an agent
// that keeps no facets OMITS `crossesFacets`, and a consumer reading that as
// `false` tells the holder their linkage was intentional on the authority of a
// question nobody asked.

import { test } from "node:test";
import assert from "node:assert/strict";
import {
  crossingOf,
  rankFindings,
  tallyCrossings,
  crossingWords,
} from "../src/manager/correlation-model.ts";

const world = (id: string, name: string) =>
  ({ facetId: id, name, colour: "teal", faceIds: [], attributeIds: [], version: 1, updatedAt: "x" }) as never;
const WORLDS = [world("w1", "Work"), world("w2", "Home")];

const finding = (extra: Record<string, unknown> = {}) =>
  ({ severity: "high", why: "the same value is held by 1 other attribute", remedies: [], ...extra }) as never;

test("an absent crossesFacets is unknown, never within", () => {
  // The trap. `false` asserts the holder keeps these identities in one part of
  // their life; an agent with no facets has made no such finding.
  assert.equal(crossingOf(finding()), "unknown");
  assert.equal(crossingOf(finding({ crossesFacets: false })), "within");
  assert.equal(crossingOf(finding({ crossesFacets: true })), "crosses");
});

test("crossings come first, and within-a-world is last but present", () => {
  // Never hidden: the holder may have arranged it and may equally have
  // forgotten they did, and a link they cannot see is one they cannot revisit.
  const ranked = rankFindings(
    [
      finding({ crossesFacets: false, facetIds: ["w1"], why: "a" }),
      finding({ why: "b" }),
      finding({ crossesFacets: true, facetIds: ["w1", "w2"], why: "c" }),
    ],
    WORLDS,
  );
  assert.deepEqual(ranked.map((r) => r.crossing), ["crosses", "unknown", "within"]);
  assert.equal(ranked.length, 3, "a finding was dropped");
});

test("order inside a group is the agent's own", () => {
  // Two runs over an unchanged pool must read the same way.
  const ranked = rankFindings(
    [
      finding({ crossesFacets: true, facetIds: ["w1", "w2"], why: "first" }),
      finding({ crossesFacets: true, facetIds: ["w1", "w2"], why: "second" }),
    ],
    WORLDS,
  );
  assert.deepEqual(ranked.map((r) => r.finding.why), ["first", "second"]);
});

test("every finding is counted once, under exactly one heading", () => {
  const ranked = rankFindings(
    [
      finding({ crossesFacets: true, facetIds: ["w1", "w2"] }),
      finding({ crossesFacets: false, facetIds: ["w1"] }),
      finding({ crossesFacets: false, facetIds: ["w2"] }),
      finding(),
    ],
    WORLDS,
  );
  const tally = tallyCrossings(ranked);
  assert.deepEqual(tally, { crosses: 1, within: 2, unknown: 1 });
  assert.equal(tally.crosses + tally.within + tally.unknown, ranked.length);
});

test("a crossing names the worlds, because a name is actionable and a boundary is not", () => {
  const [row] = rankFindings([finding({ crossesFacets: true, facetIds: ["w1", "w2"] })], WORLDS);
  assert.match(crossingWords(row!)!, /Work and Home share this/);
  assert.match(crossingWords(row!)!, /same person/);
});

test("a crossing the console cannot name still says what it is", () => {
  // The agent's answer decides the crossing; our ability to resolve an id does
  // not. A world created on another device and not yet listed here must not
  // silently downgrade a finding.
  const [row] = rankFindings([finding({ crossesFacets: true, facetIds: ["wX", "wY"] })], WORLDS);
  assert.equal(row!.crossing, "crosses");
  assert.match(crossingWords(row!)!, /two parts of your life/);
});

test("a within-a-world finding says it is still a link", () => {
  // The severity is untouched and the sentence must not imply otherwise: two
  // verifiers who see both faces link the holder however they filed them.
  const [row] = rankFindings([finding({ crossesFacets: false, facetIds: ["w1"] })], WORLDS);
  assert.match(crossingWords(row!)!, /in Work/);
  assert.match(crossingWords(row!)!, /still a link/);
});

test("an unknown crossing says nothing per row", () => {
  // Both alternatives are claims — "stays in one part of your life" asserts
  // what the agent did not answer, and "your agent did not say" is noise on
  // every row when the holder simply keeps no worlds. The summary says it once.
  const [row] = rankFindings([finding()], WORLDS);
  assert.equal(crossingWords(row!), null);
});

test("severity is never touched by any of this", () => {
  const ranked = rankFindings(
    [
      finding({ crossesFacets: false, facetIds: ["w1"], severity: "high" }),
      finding({ crossesFacets: true, facetIds: ["w1", "w2"], severity: "low" }),
    ],
    WORLDS,
  );
  // A within-a-world link keeps `high`; a crossing keeps `low`. The axes are
  // independent and this module reads neither as the other.
  assert.equal(ranked.find((r) => r.crossing === "within")!.finding.severity, "high");
  assert.equal(ranked.find((r) => r.crossing === "crosses")!.finding.severity, "low");
});
