// Reading a cursor-paginated listing to the end.
//
// The defect this closes is invisible from the outside — a short array that
// looks exactly like a complete one — so the assertions here are mostly about
// *how many times the far side was asked*, which is the only observable
// difference between reading a listing and reading the first page of one.

import { test } from "node:test";
import assert from "node:assert/strict";
import { collectPages, MAX_PAGES } from "../dist/util/index.js";

/** Serves `pages` in order, recording the cursor it was asked with each time. */
function pager(pages) {
  const asked = [];
  return {
    asked,
    fetch: async (cursor) => {
      asked.push(cursor);
      return pages[asked.length - 1];
    },
  };
}

test("a single page with no cursor is the whole answer", async () => {
  const p = pager([{ items: [1, 2, 3] }]);
  assert.deepEqual(await collectPages("x", p.fetch), [1, 2, 3]);
  assert.deepEqual(p.asked, [undefined], "no cursor was invented for a listing that ended");
});

test("every page is followed, and the pages are concatenated in order", async () => {
  const p = pager([
    { items: [1, 2], nextCursor: "c1" },
    { items: [3, 4], nextCursor: "c2" },
    { items: [5] },
  ]);
  assert.deepEqual(await collectPages("x", p.fetch), [1, 2, 3, 4, 5]);
  assert.deepEqual(p.asked, [undefined, "c1", "c2"]);
});

test("a short page is not the end — only an absent cursor is", async () => {
  // The specification says this outright, and it is the exact inference the
  // old clients made: they took the first page and stopped.
  const p = pager([
    { items: [1], nextCursor: "c1" },
    { items: [2, 3, 4] },
  ]);
  assert.deepEqual(await collectPages("x", p.fetch), [1, 2, 3, 4]);
});

test("an empty page carrying a cursor is followed, not treated as the end", async () => {
  // A legal answer: the agent filtered a page down to nothing and has more.
  const p = pager([
    { items: [], nextCursor: "c1" },
    { items: [7] },
  ]);
  assert.deepEqual(await collectPages("x", p.fetch), [7]);
});

test("a cursor that does not move is reported as the agent looping", async () => {
  const p = pager([
    { items: [1], nextCursor: "same" },
    { items: [2], nextCursor: "same" },
  ]);
  await assert.rejects(() => collectPages("persona/attribute/list", p.fetch), /same page cursor twice/);
});

test("a listing that will not end throws rather than returning a short answer", async () => {
  // Returning what was collected would reintroduce the very defect this exists
  // to fix — a caller cannot tell a truncated array from a complete one.
  let n = 0;
  const endless = async () => ({ items: [n], nextCursor: `c${++n}` });
  await assert.rejects(() => collectPages("persona/profile/list", endless, 3), /still more after 3 pages/);
  await assert.rejects(() => collectPages("persona/profile/list", endless, 3), /persona\/profile\/list/);
});

test("the default bound is high enough that reaching it means a fault", async () => {
  // 50 pages at the specification's maximum page size is 25,000 records. The
  // number matters: a bound low enough to be reached by a real pool would be
  // the truncation bug with an error message.
  assert.ok(MAX_PAGES >= 50);
});
