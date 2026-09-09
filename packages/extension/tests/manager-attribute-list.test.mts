// The list view's model: grouping, the selection set, and what a bulk delete
// would take.
//
// Every case here is a way the naive version of a multi-select is wrong in a
// way a type checker cannot see and a single-click test does not reach: a range
// computed over the pool instead of the screen, a half-ticked heading that
// clears the work under it, a selection that keeps counting rows the agent has
// already deleted.

import { test } from "node:test";
import assert from "node:assert/strict";
import {
  groupRows,
  flatOrder,
  toggle,
  selectRange,
  groupState,
  toggleGroup,
  pruneSelection,
  selectedRows,
  previewDelete,
  BULK_ACTIONS,
  whyNoBulkVisibility,
} from "../src/manager/attribute-list.ts";
import type { AttributeNode } from "../src/manager/identity-graph.ts";

const REGISTRY = {
  registryVersion: "0.1",
  entries: [
    "name", "name.given", "name.family", "email", "email.personal",
    "phone", "phone.mobile", "account", "account.handle",
  ].map((type) => ({ type, sensitivity: "normal", release: "consent", mask: "none" })),
  unregistered: { sensitivity: "high", release: "consent", mask: "full" },
  strictness: {
    sensitivity: ["high", "normal"],
    release: ["stepUp", "consent"],
    mask: ["full", "last2", "last4", "emailLocal", "none"],
  },
} as never;

function attr(id: string, type: string, extra: Partial<AttributeNode> = {}): AttributeNode {
  return {
    id,
    type,
    value: "x",
    provenance: { kind: "selfAsserted" },
    stale: false,
    version: 1,
    ...extra,
  } as AttributeNode;
}

/** Two names, one email, one phone, one invented token. */
function pool(): AttributeNode[] {
  return [
    attr("a1", "name.given"),
    attr("a2", "name.family"),
    attr("a3", "email.personal"),
    attr("a4", "phone.mobile"),
    attr("a5", "x:gamertag"),
  ];
}

test("groups follow FAMILY_ORDER and drop the empty ones", () => {
  const groups = groupRows(pool(), REGISTRY);
  // A heading over nothing reads as a category the holder failed to fill in.
  assert.ok(groups.every((g) => g.rows.length > 0), "an empty family was drawn");
  // identity before contact before unregistered — the order the map uses.
  const families = groups.map((g) => g.family);
  assert.deepEqual(
    families,
    [...families].sort((a, b) => families.indexOf(a) - families.indexOf(b)),
    "groups came back out of FAMILY_ORDER",
  );
  assert.ok(families.includes("unregistered"), "the invented token was classified into a family");
});

test("creation order survives inside a group", () => {
  // A list that re-sorted by label would move a row under the cursor the moment
  // someone renamed it.
  const withLabels = [attr("a1", "name.given", { label: "zzz" }), attr("a2", "name.family", { label: "aaa" })];
  const [group] = groupRows(withLabels, REGISTRY);
  assert.deepEqual(group?.rows.map((r) => r.id), ["a1", "a2"]);
});

test("a range selects what was between the two rows ON SCREEN", () => {
  // The defect this pins: computing the range over the unsorted pool selects
  // attributes that were never between the two the person clicked, because
  // grouping reorders them.
  const groups = groupRows(pool(), REGISTRY);
  const order = flatOrder(groups);
  const picked = selectRange(new Set(), order, order[0]!, order[2]!);
  assert.deepEqual([...picked].sort(), order.slice(0, 3).sort());
});

test("a range is additive", () => {
  const order = ["a", "b", "c", "d"];
  const first = selectRange(new Set(["d"]), order, "a", "b");
  assert.ok(first.has("d"), "an earlier selection was thrown away by a range");
  assert.deepEqual([...first].sort(), ["a", "b", "d"]);
});

test("a range runs in both directions", () => {
  const order = ["a", "b", "c", "d"];
  assert.deepEqual([...selectRange(new Set(), order, "d", "b")].sort(), ["b", "c", "d"]);
});

test("a stale anchor selects one row rather than surprising anyone", () => {
  const order = ["a", "b", "c"];
  // The anchor's row was deleted since it was clicked.
  const picked = selectRange(new Set(), order, "gone", "c");
  assert.deepEqual([...picked], ["c"]);
});

test("toggle adds then removes", () => {
  assert.deepEqual([...toggle(new Set(), "a")], ["a"]);
  assert.deepEqual([...toggle(new Set(["a"]), "a")], []);
});

test("a heading has three states and 'some' is not a rounding of 'all'", () => {
  const groups = groupRows(pool(), REGISTRY);
  const identity = groups.find((g) => g.family === "identity")!;
  assert.equal(groupState(new Set(), identity), "none");
  assert.equal(groupState(new Set(["a1"]), identity), "some");
  assert.equal(groupState(new Set(["a1", "a2"]), identity), "all");
});

test("a half-ticked heading selects the rest rather than clearing it", () => {
  // Clicking it is reaching for "all of these". A click that instead threw away
  // the ones picked one at a time is destructive of work.
  const groups = groupRows(pool(), REGISTRY);
  const identity = groups.find((g) => g.family === "identity")!;
  assert.equal(groupState(toggleGroup(new Set(["a1"]), identity), identity), "all");
  assert.equal(groupState(toggleGroup(new Set(["a1", "a2"]), identity), identity), "none");
});

test("a selection is pruned to what the pool still holds", () => {
  // Without this the bulk bar keeps counting rows the agent already deleted,
  // and the next action sends their ids back to be refused one at a time.
  const after = pruneSelection(new Set(["a1", "a4", "deleted"]), pool());
  assert.deepEqual([...after].sort(), ["a1", "a4"]);
});

test("selected rows come back in visible order, not selection order", () => {
  const groups = groupRows(pool(), REGISTRY);
  const order = flatOrder(groups);
  const rows = selectedRows(new Set([order[2]!, order[0]!]), groups);
  assert.deepEqual(rows.map((r) => r.id), [order[0], order[2]]);
});

test("the delete preview counts the last of a type", () => {
  // The one thing a count cannot say: deleting your third phone number is
  // tidying, deleting your only email address changes what a face presents.
  const groups = groupRows(pool(), REGISTRY);
  const preview = previewDelete(new Set(["a3"]), groups, pool());
  assert.equal(preview.count, 1);
  assert.equal(preview.lastOfType, 1, "the only email was not reported as the last of its type");

  const both = previewDelete(new Set(["a1"]), groups, pool());
  assert.equal(both.lastOfType, 1, "name.given and name.family are different types");
});

test("the delete preview counts credential-backed attributes separately", () => {
  const withCred = [
    ...pool(),
    attr("a6", "name.legal", {
      provenance: { kind: "credentialBacked", credentialId: "c1", claimPath: "/n" },
    }),
  ];
  const groups = groupRows(withCred, REGISTRY);
  const preview = previewDelete(new Set(["a1", "a6"]), groups, withCred);
  assert.equal(preview.credentialBacked, 1);
});

test("bulk visibility is not offered, and the refusal has words", () => {
  // `attribute/put` is a replace and this console does not hold the values it
  // masks, so a bulk visibility change would blank every sensitive attribute in
  // the selection. Adding a third action has to delete this assertion.
  assert.deepEqual([...BULK_ACTIONS], ["delete", "addToFace"]);
  assert.match(whyNoBulkVisibility(), /one attribute at a time/);
});
