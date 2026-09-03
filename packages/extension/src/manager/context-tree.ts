// Flat `ContextRecord[]` → the tree the console navigates by.
//
// Contexts are the spine of this surface, not one section of it: `contextId` is
// already a filter parameter on `keysList`, `aclList` and `auditList`, so the
// selection made here scopes every pane to its right. That is why the tree is a
// persistent column rather than the content of a "Contexts" page.
//
// ## Why an unreachable parent is drawn rather than dropped
//
// A caller sees the contexts their ACL entries reach, and those entries are not
// obliged to cover a whole subtree — `work/eng` can be granted without `work`.
// So `parent` routinely names a context this caller cannot list, and the
// obvious tree build (index by id, attach to `byId[parent]`, keep what
// attached) silently loses exactly those children.
//
// That failure is invisible in the worst way: the console renders a shorter,
// entirely plausible tree, and an operator concludes they have no access to a
// context they are in fact administering. So an orphan gets a **placeholder**
// parent instead — drawn, named by the DID-less id the record itself carries,
// and marked unreachable. A placeholder is not selectable: there is no record
// behind it, so there is nothing to scope a pane to and nothing to delete.
//
// The placeholder stands for the parent and nothing more. It deliberately does
// not try to reconstruct the chain above it from `basePath`, whose segmentation
// this code does not own — `basePath` is shown verbatim as the node's path
// instead, which is the agent's own answer and cannot drift from it.

import type { ContextRecord } from "@openvtc/pnm-core";

export interface ContextNode {
  /** Context id — the value panes filter on. Absent on a placeholder. */
  id?: string;
  /** What to draw. A placeholder shows the id its child named as its parent. */
  name: string;
  /** The agent's own resolved path, shown verbatim. Absent on a placeholder. */
  basePath?: string;
  /** The record behind this node. Absent on a placeholder, which is the test
   *  for "this node is real" — a node with no record can be expanded and read
   *  but never selected, renamed or deleted. */
  record?: ContextRecord;
  children: ContextNode[];
}

/** Depth-first order with the tree's shape flattened for rendering. */
export interface FlatContextNode {
  node: ContextNode;
  depth: number;
  /** Whether any descendant exists — drives the disclosure triangle. */
  hasChildren: boolean;
}

function byName(a: ContextNode, b: ContextNode): number {
  return a.name.localeCompare(b.name);
}

/**
 * Build the forest.
 *
 * Roots are records with no `parent`, plus one placeholder per distinct
 * unreachable parent. Order is by name at every level, so the tree does not
 * reshuffle between reads of the same agent.
 */
export function buildContextTree(records: readonly ContextRecord[]): ContextNode[] {
  const nodes = new Map<string, ContextNode>();
  for (const record of records) {
    nodes.set(record.id, {
      id: record.id,
      name: record.name || record.id,
      basePath: record.basePath,
      record,
      children: [],
    });
  }

  const roots: ContextNode[] = [];
  const placeholders = new Map<string, ContextNode>();

  for (const record of records) {
    const node = nodes.get(record.id);
    if (!node) continue;
    if (!record.parent) {
      roots.push(node);
      continue;
    }
    const parent = nodes.get(record.parent);
    if (parent) {
      parent.children.push(node);
      continue;
    }
    // Unreachable parent — see the header. One placeholder per parent id, so
    // two siblings under the same invisible parent share a node rather than
    // producing two identical roots.
    let stand = placeholders.get(record.parent);
    if (!stand) {
      stand = { name: record.parent, children: [] };
      placeholders.set(record.parent, stand);
      roots.push(stand);
    }
    stand.children.push(node);
  }

  const sortDeep = (list: ContextNode[]): void => {
    list.sort(byName);
    for (const n of list) sortDeep(n.children);
  };
  sortDeep(roots);
  return roots;
}

/**
 * Depth-first flatten, honouring a collapsed set.
 *
 * `collapsed` holds node ids; a placeholder has none and so can never be
 * collapsed — hiding an unreachable parent would hide the reachable children it
 * exists to reveal.
 */
export function flattenContextTree(
  roots: readonly ContextNode[],
  collapsed: ReadonlySet<string>,
): FlatContextNode[] {
  const out: FlatContextNode[] = [];
  const walk = (node: ContextNode, depth: number): void => {
    const hasChildren = node.children.length > 0;
    out.push({ node, depth, hasChildren });
    if (node.id && collapsed.has(node.id)) return;
    for (const child of node.children) walk(child, depth + 1);
  };
  for (const root of roots) walk(root, 0);
  return out;
}
