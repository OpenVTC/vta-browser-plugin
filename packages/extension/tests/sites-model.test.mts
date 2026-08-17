// Merge rules behind the Sites screen — see src/sites-model.ts.

import test from "node:test";
import assert from "node:assert/strict";
import { mergeSiteRows, relativeDay } from "../src/sites-model.ts";

/** Stand-in for `displayHostFor`, which needs `chrome` to be importable. */
const hostOf = (s: string) =>
  s.replace(/^https?:\/\//, "").replace(/\/\*$/, "").replace(/\/$/, "").replace(/:\d+$/, "");

const rec = (origin: string, trustedAt: number) => ({ origin, trustedAt });

test("a site trusted and granted collapses to one row", () => {
  // The bug this keys on: the two sources spell the same site differently, so
  // naive keying renders two half-permissioned rows for one site.
  const rows = mergeSiteRows(
    [rec("https://app.example", 1000)],
    ["https://app.example/*"],
    hostOf,
  );
  assert.equal(rows.length, 1);
  assert.equal(rows[0]?.host, "app.example");
  assert.ok(rows[0]?.trusted);
  assert.equal(rows[0]?.grantedPattern, "https://app.example/*");
});

test("trust without a grant, and a grant without trust, both appear", () => {
  const rows = mergeSiteRows(
    [rec("https://trusted.example", 2000)],
    ["https://reachable.example/*"],
    hostOf,
  );
  assert.equal(rows.length, 2);
  const byHost = Object.fromEntries(rows.map((r) => [r.host, r]));
  assert.ok(byHost["trusted.example"]?.trusted);
  assert.equal(byHost["trusted.example"]?.grantedPattern, undefined);
  assert.equal(byHost["reachable.example"]?.trusted, undefined);
  assert.ok(byHost["reachable.example"]?.grantedPattern);
});

test("rows sort most-recently-connected first", () => {
  const rows = mergeSiteRows(
    [rec("https://old.example", 1000), rec("https://new.example", 9000)],
    [],
    hostOf,
  );
  assert.deepEqual(rows.map((r) => r.host), ["new.example", "old.example"]);
});

test("grant-only rows settle alphabetically below connected ones", () => {
  // No timestamp means no meaningful recency; alphabetical keeps the list
  // stable instead of reshuffling on each refresh.
  const rows = mergeSiteRows(
    [rec("https://connected.example", 5000)],
    ["https://zeta.example/*", "https://alpha.example/*"],
    hostOf,
  );
  assert.deepEqual(rows.map((r) => r.host), [
    "connected.example",
    "alpha.example",
    "zeta.example",
  ]);
});

test("differing ports on one host merge rather than split", () => {
  // Match patterns carry no port, so a grant for localhost covers every port;
  // showing separate rows would imply a distinction that does not exist.
  const rows = mergeSiteRows(
    [rec("http://localhost:5173", 1000)],
    ["http://localhost/*"],
    hostOf,
  );
  assert.equal(rows.length, 1);
  assert.ok(rows[0]?.trusted && rows[0]?.grantedPattern);
});

test("empty inputs produce no rows", () => {
  assert.deepEqual(mergeSiteRows([], [], hostOf), []);
});

test("relativeDay reads as a person would say it", () => {
  const now = Date.UTC(2026, 7, 17);
  const day = 86_400_000;
  assert.equal(relativeDay(now, now), "today");
  assert.equal(relativeDay(now - day, now), "yesterday");
  assert.equal(relativeDay(now - 3 * day, now), "3 days ago");
  assert.equal(relativeDay(now - 45 * day, now), "a month ago");
  assert.equal(relativeDay(now - 200 * day, now), "6 months ago");
});
