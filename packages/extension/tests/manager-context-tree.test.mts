// The context tree — and specifically, that an unreachable parent does not
// swallow its children.
//
// A caller sees the contexts their ACL entries reach, and those entries are not
// obliged to cover a whole subtree: `work/eng` can be granted without `work`.
// The obvious tree build (index by id, attach to `byId[parent]`, keep what
// attached) drops exactly those children, and does it invisibly — the console
// renders a shorter, entirely plausible tree and the operator concludes they
// have no access to a context they are in fact administering.

import { test } from "node:test";
import assert from "node:assert/strict";
import {
  buildContextTree,
  flattenContextTree,
  type ContextNode,
} from "../src/manager/context-tree.ts";
import type { ContextRecord } from "@openvtc/pnm-core";

const ctx = (
  id: string,
  extra: Partial<ContextRecord> = {},
): ContextRecord => ({
  id,
  name: id,
  did: null,
  description: null,
  basePath: id,
  createdAt: "2026-01-01T00:00:00Z",
  updatedAt: "2026-01-01T00:00:00Z",
  ...extra,
});

/** Ids in depth-first order, with placeholders shown as `?name`. */
function shape(nodes: ContextNode[]): string[] {
  const out: string[] = [];
  const walk = (n: ContextNode, depth: number) => {
    out.push(`${"  ".repeat(depth)}${n.record ? n.id : `?${n.name}`}`);
    for (const c of n.children) walk(c, depth + 1);
  };
  for (const n of nodes) walk(n, 0);
  return out;
}

test("nests children under the parent they name", () => {
  const tree = buildContextTree([
    ctx("work"),
    ctx("eng", { parent: "work", basePath: "work/eng" }),
    ctx("payroll", { parent: "work", basePath: "work/payroll" }),
    ctx("personal"),
  ]);
  assert.deepEqual(shape(tree), ["personal", "work", "  eng", "  payroll"]);
});

test("a child whose parent is not visible is still shown", () => {
  // The caller administers work/eng but holds no grant on work itself.
  const tree = buildContextTree([ctx("eng", { parent: "work", basePath: "work/eng" })]);
  assert.deepEqual(
    shape(tree),
    ["?work", "  eng"],
    "the reachable child was dropped along with its unreachable parent",
  );
});

test("siblings under one unreachable parent share a single placeholder", () => {
  const tree = buildContextTree([
    ctx("eng", { parent: "work", basePath: "work/eng" }),
    ctx("payroll", { parent: "work", basePath: "work/payroll" }),
  ]);
  assert.deepEqual(shape(tree), ["?work", "  eng", "  payroll"]);
});

test("a placeholder carries no record, so nothing can be done to it", () => {
  const [placeholder] = buildContextTree([ctx("eng", { parent: "work" })]);
  assert.equal(placeholder!.record, undefined);
  assert.equal(placeholder!.id, undefined, "a placeholder with an id would become selectable");
});

test("ordering is by name at every level, so the tree does not reshuffle", () => {
  const tree = buildContextTree([
    ctx("zeta"),
    ctx("alpha"),
    ctx("b", { parent: "alpha" }),
    ctx("a", { parent: "alpha" }),
  ]);
  assert.deepEqual(shape(tree), ["alpha", "  a", "  b", "zeta"]);
});

test("a record with no name falls back to its id rather than rendering blank", () => {
  const [node] = buildContextTree([ctx("work", { name: "" })]);
  assert.equal(node!.name, "work");
});

test("collapsing hides descendants and nothing else", () => {
  const tree = buildContextTree([
    ctx("work"),
    ctx("eng", { parent: "work" }),
    ctx("personal"),
  ]);
  const rows = flattenContextTree(tree, new Set(["work"]));
  assert.deepEqual(
    rows.map((r) => r.node.id ?? `?${r.node.name}`),
    ["personal", "work"],
  );
  assert.equal(rows.find((r) => r.node.id === "work")?.hasChildren, true);
});

test("an unreachable parent cannot be collapsed", () => {
  // It has no id, so there is no key to put in the collapsed set — which is the
  // point: hiding the placeholder would hide the reachable children it exists
  // to reveal.
  const tree = buildContextTree([ctx("eng", { parent: "work" })]);
  const rows = flattenContextTree(tree, new Set(["work", "eng"]));
  assert.deepEqual(rows.map((r) => r.node.id ?? `?${r.node.name}`), ["?work", "eng"]);
});
