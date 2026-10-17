// Choosing one context, drawn as the tree it is.
//
// A `<select>` flattens the hierarchy into one long column, so a sub-context
// (`openvtc-bob/qme5theer1qr`) reads as a sibling of its parent and an agent
// with thirty contexts is a wall of near-identical lines. This is the same
// tree the console's context column draws (`context-tree.ts`), as a picker:
// collapsed below the roots, searchable, and folded to the one chosen once a
// choice is made.
//
// A placeholder parent — one the caller's ACL does not reach — is drawn so its
// children are not lost, and cannot be chosen: there is no record behind it.

import { useMemo, useState } from "react";
import type { ContextRecord } from "@openvtc/pnm-core";
import { didHost } from "../did-display.js";
import { c, t, font } from "../theme.js";
import { buildContextTree, flattenContextTree, type ContextNode } from "./context-tree.js";
import { contextLabel } from "./format.js";

/** A context's name, made readable where the name is itself a DID. */
export function contextName(record: ContextRecord): string {
  const primary = contextLabel(record).primary;
  if (!primary.startsWith("did:")) return primary;
  const host = didHost(primary);
  const last = primary.split(":").pop();
  return host && last && last !== host ? `${host}/${last}` : (host ?? primary);
}

/** Every node id with children: the starting state, roots showing and nothing below. */
function parentsOf(nodes: readonly ContextNode[], out = new Set<string>()): Set<string> {
  for (const n of nodes) {
    if (n.id && n.children.length > 0) out.add(n.id);
    parentsOf(n.children, out);
  }
  return out;
}

/** How many contexts sit below a node, at any depth. */
function descendants(node: ContextNode): number {
  return node.children.reduce((sum, ch) => sum + 1 + descendants(ch), 0);
}

export function ContextPicker({
  name,
  options,
  value,
  onChange,
}: {
  /** The control's accessible name. */
  name: string;
  options: readonly ContextRecord[];
  value: string;
  onChange: (id: string) => void;
}) {
  const roots = useMemo(() => buildContextTree(options), [options]);
  const [collapsed, setCollapsed] = useState<ReadonlySet<string>>(() => parentsOf(roots));
  const [query, setQuery] = useState("");
  const [browsing, setBrowsing] = useState(value === "");
  const chosen = options.find((o) => o.id === value);

  const rows = useMemo(() => {
    const q = query.trim().toLowerCase();
    // While searching, every match is shown wherever it sits: a filtered tree
    // is a list, and the id under each row says where.
    if (q) {
      return flattenContextTree(roots, new Set())
        .filter(({ node }) => {
          const label = node.record ? contextName(node.record) : node.name;
          return label.toLowerCase().includes(q) || (node.id ?? "").toLowerCase().includes(q);
        })
        .map((r) => ({ ...r, depth: 0 }));
    }
    return flattenContextTree(roots, collapsed);
  }, [roots, collapsed, query]);

  const toggle = (id: string) =>
    setCollapsed((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });

  if (!browsing && chosen) {
    return (
      <div
        role="group"
        aria-label={name}
        style={{
          display: "flex",
          alignItems: "center",
          gap: 10,
          padding: "8px 12px",
          background: c.surface,
          border: `1px solid ${c.line}`,
          borderRadius: "var(--w-r-sm)",
        }}
      >
        <span style={{ display: "grid", gap: 1, flex: 1, minWidth: 0 }}>
          <span style={{ fontSize: t.base, fontWeight: 600 }}>{contextName(chosen)}</span>
          <span style={{ fontFamily: font.mono, fontSize: t.xs, color: c.faint, wordBreak: "break-all" }}>{chosen.id}</span>
        </span>
        <button
          onClick={() => setBrowsing(true)}
          style={{ font: "inherit", fontSize: t.sm, fontWeight: 600, border: "none", background: "transparent", color: c.accent, cursor: "pointer" }}
        >
          Change
        </button>
      </div>
    );
  }

  return (
    <div
      style={{
        border: `1px solid ${c.line}`,
        borderRadius: "var(--w-r-sm)",
        background: c.surface,
        display: "grid",
      }}
    >
      <input
        type="search"
        aria-label={`Search ${name.toLowerCase()}s`}
        placeholder={`Search ${options.length} contexts…`}
        value={query}
        onChange={(e) => setQuery(e.target.value)}
        style={{
          font: "inherit",
          fontSize: t.sm,
          padding: "8px 12px",
          border: "none",
          borderBottom: `1px solid ${c.lineSoft}`,
          background: "transparent",
          color: c.text,
          outline: "none",
        }}
      />
      <div role="radiogroup" aria-label={name} style={{ maxHeight: 320, overflowY: "auto", padding: "4px 0" }}>
        {rows.length === 0 && (
          <div style={{ padding: "8px 12px", fontSize: t.sm, color: c.faint }}>No context matches “{query}”.</div>
        )}
        {rows.map(({ node, depth, hasChildren }) => {
          const real = !!node.record && !!node.id;
          const selected = real && node.id === value;
          const open = hasChildren && !!node.id && !collapsed.has(node.id);
          const below = hasChildren && !open ? descendants(node) : 0;
          return (
            <div
              key={node.id ?? `placeholder:${node.name}`}
              style={{
                display: "flex",
                alignItems: "center",
                gap: 4,
                paddingLeft: 6 + depth * 18,
                background: selected ? c.accentSoft : "transparent",
                boxShadow: selected ? `inset 2px 0 0 ${c.accent}` : "none",
              }}
            >
              {hasChildren && !query ? (
                <button
                  onClick={() => node.id && toggle(node.id)}
                  aria-expanded={open}
                  aria-label={`${open ? "Collapse" : "Expand"} ${node.name}`}
                  disabled={!node.id}
                  style={{
                    width: 22,
                    height: 22,
                    flex: "0 0 auto",
                    border: "none",
                    background: "transparent",
                    color: c.muted,
                    cursor: node.id ? "pointer" : "default",
                    fontSize: 10,
                  }}
                >
                  {open ? "▼" : "▶"}
                </button>
              ) : (
                <span style={{ width: 22, flex: "0 0 auto" }} />
              )}
              <button
                role="radio"
                aria-checked={selected}
                data-context-id={node.id}
                disabled={!real}
                onClick={() => {
                  if (!real) return;
                  onChange(node.id!);
                  setBrowsing(false);
                  setQuery("");
                }}
                title={real ? undefined : "Your access does not reach this context; it is drawn so the ones below it show."}
                style={{
                  all: "unset",
                  boxSizing: "border-box",
                  cursor: real ? "pointer" : "default",
                  flex: 1,
                  minWidth: 0,
                  display: "flex",
                  alignItems: "baseline",
                  gap: 8,
                  padding: "6px 10px 6px 2px",
                }}
              >
                <span style={{ fontSize: t.sm, fontWeight: selected ? 650 : 500, color: real ? c.text : c.faint }}>
                  {node.record ? contextName(node.record) : node.name}
                </span>
                <span style={{ fontFamily: font.mono, fontSize: t.xs, color: c.faint, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
                  {node.id ?? "not reachable"}
                </span>
                {below > 0 && (
                  <span style={{ marginLeft: "auto", fontSize: t.xs, color: c.faint, whiteSpace: "nowrap" }}>
                    {below} inside
                  </span>
                )}
              </button>
            </div>
          );
        })}
      </div>
    </div>
  );
}
