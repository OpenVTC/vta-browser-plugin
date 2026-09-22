import { test } from "node:test";
import assert from "node:assert/strict";

import {
  untilFromLocalInput,
  untilToLocalInput,
} from "../src/manager/binding-until.ts";

test("an empty end is no end", () => {
  assert.deepEqual(untilFromLocalInput(""), { ok: true, until: null });
  assert.equal(untilToLocalInput(undefined), "");
});

test("a local time round-trips through the instant the agent takes", () => {
  const now = new Date("2026-01-01T00:00:00Z");
  const r = untilFromLocalInput("2026-10-05T18:00", now);
  assert.equal(r.ok, true);
  if (!r.ok || r.until === null) throw new Error("expected an instant");
  assert.equal(untilToLocalInput(r.until), "2026-10-05T18:00", "shown back as it was typed");
});

test("an end already past is refused before the agent refuses it", () => {
  const now = new Date("2026-10-05T19:00:00");
  const r = untilFromLocalInput("2026-10-05T18:00", now);
  assert.equal(r.ok, false);
});

test("something that is not a time is refused, not sent", () => {
  assert.equal(untilFromLocalInput("next week").ok, false);
});
