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
import { contextLabel } from "./format.js";
import { Icon } from "./icons.js";
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
  // The id is what joins this tree to every table beside it, so it is shown
  // whenever it differs from the label — never dropped in favour of the label.
  const label = node.record
    ? contextLabel(node.record)
    : { primary: node.name, id: undefined };

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
          fontSize: t.sm,
          lineHeight: 1,
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
        }}
      >
        <span style={{ display: "block", overflow: "hidden", textOverflow: "ellipsis" }}>
          {label.primary}
        </span>
        {label.id && (
          <span
            style={{
              display: "block",
              fontFamily: font.mono,
              fontSize: t.xs,
              fontWeight: 400,
              color: selected ? "var(--m-act-identity)" : c.faint,
              overflow: "hidden",
              textOverflow: "ellipsis",
            }}
          >
            {label.id}
          </span>
        )}
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
  const [query, setQuery] = useState("");
  const roots = useMemo(() => buildContextTree(records), [records]);
  const all = useMemo(() => flattenContextTree(roots, collapsed), [roots, collapsed]);

  /**
   * Rows matching the filter, with the tree flattened while one is typed.
   *
   * **Ancestors are ignored while filtering**, deliberately. Keeping the
   * hierarchy would mean drawing every unmatched parent of a match, so a search
   * for "eng" returns `work` and `work/platform` too — rows the person did not
   * ask for and cannot tell apart from ones they did. A filtered tree is a
   * list, and the id under each row is what says where it sits.
   *
   * Matched on the id as well as the label because the id is what joins this
   * column to every table beside it, and an operator who has one in hand from a
   * task response has nothing but the id to search by.
   */
  const rows = useMemo(() => {
    const q = query.trim().toLowerCase();
    if (!q) return all;
    return all.filter(({ node }) => {
      const label = node.record ? contextLabel(node.record).primary : node.name;
      return label.toLowerCase().includes(q) || (node.id ?? "").toLowerCase().includes(q);
    });
  }, [all, query]);

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

      {/* Shown once there are enough contexts for the column to be a scroll
          rather than a glance. Below that a search box is a control that costs
          more attention than the list it filters. */}
      {records.length >= 8 && (
        <div style={{ padding: "0 14px 8px", position: "relative", display: "flex", alignItems: "center" }}>
          <Icon name="search" size={13} style={{ position: "absolute", left: 21, color: c.faint, pointerEvents: "none" }} />
          <input
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            placeholder="Filter"
            aria-label="Filter contexts"
            style={{
              width: "100%",
              boxSizing: "border-box",
              padding: "5px 8px 5px 24px",
              background: c.ground,
              color: c.text,
              border: `1px solid ${c.line}`,
              borderRadius: "var(--w-r-sm)",
              fontSize: t.sm,
              fontFamily: font.sans,
            }}
          />
        </div>
      )}

      {loading && (
        <span style={{ padding: "6px 14px", fontSize: t.sm, color: c.faint }}>Loading…</span>
      )}
      {error && (
        <span style={{ padding: "6px 14px", fontSize: t.sm, color: c.danger, lineHeight: 1.5 }}>
          {error}
        </span>
      )}
      {/* A filter that matched nothing is not the same state as an agent with
          no contexts, and must not borrow its sentence — that one tells the
          operator to go and ask for a grant they may already have. */}
      {!loading && !error && rows.length === 0 && query.trim() !== "" && (
        <span style={{ padding: "6px 14px", fontSize: t.sm, color: c.faint, lineHeight: 1.5 }}>
          No context matches “{query.trim()}”. {all.length} {all.length === 1 ? "is" : "are"} here.
        </span>
      )}
      {!loading && !error && rows.length === 0 && query.trim() === "" && (
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
