// The persistent context column.
//
// This is navigation, not a pane: the selection made here scopes Keys, DIDs,
// Access and Audit, because `contextId` is a filter parameter on all of them.
// Which is why it sits beside the sections rather than inside one — an operator
// picks `work/eng` once and every question they ask afterwards is about
// `work/eng` until they say otherwise.

import { useMemo, useState } from "react";
import { c, t, font } from "../theme.js";
import { buildContextTree, flattenContextTree, type ContextNode } from "./context-tree.js";
import type { ContextRecord } from "@openvtc/pnm-core";

/** `null` means "all contexts" — the filter cleared, not a context named null. */
export type ContextSelection = string | null;

function Row({
  node,
  depth,
  hasChildren,
  collapsed,
  selected,
  onToggle,
  onSelect,
}: {
  node: ContextNode;
  depth: number;
  hasChildren: boolean;
  collapsed: boolean;
  selected: boolean;
  onToggle: () => void;
  onSelect: () => void;
}) {
  // A placeholder stands for a parent this caller's ACL does not reach. It is
  // drawn so its reachable children are not silently orphaned, but there is no
  // record behind it — nothing to scope a pane to, nothing to rename, nothing
  // to delete. So it is not selectable, and says why.
  const unreachable = !node.record;

  return (
    <div style={{ display: "flex", alignItems: "center", paddingLeft: 8 + depth * 14 }}>
      <button
        onClick={onToggle}
        aria-label={collapsed ? `Expand ${node.name}` : `Collapse ${node.name}`}
        style={{
          width: 16,
          border: "none",
          background: "none",
          padding: 0,
          cursor: hasChildren ? "pointer" : "default",
          color: c.faint,
          fontSize: t.xs,
          visibility: hasChildren ? "visible" : "hidden",
        }}
      >
        {collapsed ? "▸" : "▾"}
      </button>
      <button
        onClick={unreachable ? undefined : onSelect}
        disabled={unreachable}
        title={
          unreachable
            ? "You do not have access to this context. It is shown because you administer " +
              "contexts inside it."
            : node.basePath
        }
        style={{
          flex: 1,
          minWidth: 0,
          textAlign: "left",
          border: "none",
          borderRadius: "var(--w-r-sm)",
          padding: "5px 8px",
          margin: "1px 6px 1px 0",
          cursor: unreachable ? "default" : "pointer",
          background: selected ? "var(--m-act-identity-soft)" : "transparent",
          color: unreachable ? c.faint : selected ? "var(--m-act-identity)" : c.text,
          fontFamily: font.sans,
          fontSize: t.sm,
          fontWeight: selected ? 640 : 440,
          fontStyle: unreachable ? "italic" : "normal",
          overflow: "hidden",
          textOverflow: "ellipsis",
          whiteSpace: "nowrap",
        }}
      >
        {node.name}
      </button>
    </div>
  );
}

export function ContextTree({
  records,
  selected,
  onSelect,
  loading,
  error,
}: {
  records: ContextRecord[];
  selected: ContextSelection;
  onSelect: (id: ContextSelection) => void;
  loading: boolean;
  error: string | null;
}) {
  const [collapsed, setCollapsed] = useState<ReadonlySet<string>>(new Set());
  const roots = useMemo(() => buildContextTree(records), [records]);
  const rows = useMemo(() => flattenContextTree(roots, collapsed), [roots, collapsed]);

  const toggle = (id: string | undefined) => {
    if (!id) return;
    setCollapsed((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  };

  return (
    <nav
      aria-label="Trust contexts"
      style={{
        background: "var(--m-tree)",
        borderRight: `1px solid ${c.line}`,
        overflowY: "auto",
        padding: "12px 0",
        display: "grid",
        gridAutoRows: "min-content",
      }}
    >
      <h2
        style={{
          margin: "0 14px 8px",
          fontSize: t.xs,
          textTransform: "uppercase",
          letterSpacing: 0.5,
          color: c.faint,
          fontWeight: 640,
        }}
      >
        Trust contexts
      </h2>

      <div style={{ paddingLeft: 8 }}>
        <button
          onClick={() => onSelect(null)}
          style={{
            width: "calc(100% - 14px)",
            textAlign: "left",
            border: "none",
            borderRadius: "var(--w-r-sm)",
            padding: "5px 8px",
            margin: "1px 6px 6px 16px",
            cursor: "pointer",
            background: selected === null ? "var(--m-act-identity-soft)" : "transparent",
            color: selected === null ? "var(--m-act-identity)" : c.muted,
            fontFamily: font.sans,
            fontSize: t.sm,
            fontWeight: selected === null ? 640 : 440,
          }}
        >
          All contexts
        </button>
      </div>

      {loading && (
        <span style={{ padding: "6px 14px", fontSize: t.sm, color: c.faint }}>Loading…</span>
      )}
      {error && (
        <span style={{ padding: "6px 14px", fontSize: t.sm, color: c.danger, lineHeight: 1.5 }}>
          {error}
        </span>
      )}
      {!loading && !error && rows.length === 0 && (
        <span style={{ padding: "6px 14px", fontSize: t.sm, color: c.faint, lineHeight: 1.5 }}>
          No contexts you can reach. Contexts you administer appear here — ask an admin at this
          agent for a grant, or create one below.
        </span>
      )}

      {rows.map(({ node, depth, hasChildren }, i) => (
        <Row
          key={node.id ?? `placeholder:${node.name}:${i}`}
          node={node}
          depth={depth}
          hasChildren={hasChildren}
          collapsed={Boolean(node.id && collapsed.has(node.id))}
          selected={Boolean(node.id && node.id === selected)}
          onToggle={() => toggle(node.id)}
          onSelect={() => node.id && onSelect(node.id)}
        />
      ))}
    </nav>
  );
}
