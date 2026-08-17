/// <reference types="chrome" />

// A picture of who talks to whom.
//
// The wallet's moving parts are spread across four screens and a service
// worker, so "why isn't this working?" usually starts with reconstructing the
// topology from memory: which agent, through which mediator, over which
// transport, signed by which identity. This draws it.
//
// Deliberately a diagram and not a table. The thing a person needs to see is
// the *shape* — that requests reach the agent via a mediator, that the
// approver is a separate identity, that a relying party talks to the browser
// and never to the agent directly. A table of the same fields makes each fact
// available and the relationship invisible.
//
// Every label here is drawn from live state. Nothing is illustrative: if the
// graph shows a mediator, one is configured, and if it shows TSP, that is what
// `activeTransport` says traffic uses.

import type { CSSProperties } from "react";
import { didHost } from "./did-display.js";
import { displayAgentName, type AgentName } from "./agent-name.js";
import { c, t } from "./theme.js";

export type NodeTone = "self" | "agent" | "mediator" | "approver" | "rp" | "entry";

export interface GraphNode {
  id: string;
  /** What this thing is, in the user's terms. */
  role: string;
  /** Verified agent name, or the host. Never a guess — see agent-name.ts. */
  label?: string;
  did?: string;
  /** A short status line: role, lock state, transport. */
  detail?: string;
  tone: NodeTone;
  /** Expanded facts, shown when the node is selected. The graph carries the
   *  shape; this carries the specifics that would otherwise clutter it. */
  facts?: { label: string; value: string }[];
}

/** A frame drawn around several nodes. Edges may target the group id, which
 *  is the point: "in-page" and "confirm requests" are how *every* site reaches
 *  the wallet, and drawing them from one member implied they belonged to that
 *  member alone. */
export interface GraphGroup {
  id: string;
  label: string;
  members: string[];
}

export interface GraphEdge {
  from: string;
  to: string;
  label?: string;
  /** Dashed = a relationship that exists but carries no traffic right now. */
  dashed?: boolean;
}

// Geometry is derived, not hand-tuned per column, so the gaps stay wide
// enough for an edge label at any node width. The previous 54px gaps clipped
// "signs you in to" behind the next box.
const NODE_W = 252;
const NODE_H = 84;
const COL_GAP = 116;
const MARGIN = 16;
const COL = [0, 1, 2].map((i) => MARGIN + i * (NODE_W + COL_GAP));
const CANVAS_W = MARGIN * 2 + 3 * NODE_W + 2 * COL_GAP;

const TONE: Record<NodeTone, { stroke: string; fill: string; accent: string }> = {
  self: { stroke: c.accent, fill: c.accentSoft, accent: c.accent },
  agent: { stroke: c.ok, fill: c.okSoft, accent: c.ok },
  mediator: { stroke: c.line, fill: c.surface, accent: c.muted },
  approver: { stroke: c.warn, fill: c.warnSoft, accent: c.warn },
  rp: { stroke: c.line, fill: c.surface, accent: c.muted },
  // The credential that feeds a sign-in — related to a site, not a peer.
  entry: { stroke: c.line, fill: c.raised, accent: c.faint },
};

/** Truncate for a fixed-width box. The DID is the small print here; the label
 *  above it is what a person reads, so head-and-tail is fine. */
function short(did: string, max = 34): string {
  return did.length <= max ? did : `${did.slice(0, max - 8)}…${did.slice(-6)}`;
}

/** Ellipsise plain text to fit the box. SVG has no wrapping, so an overlong
 *  string simply runs past the border and over whatever is beside it. */
function clip(text: string, max: number): string {
  return text.length <= max ? text : `${text.slice(0, max - 1)}…`;
}

function Node({
  node,
  x,
  y,
  selected,
  onSelect,
}: {
  node: GraphNode;
  x: number;
  y: number;
  selected: boolean;
  onSelect: (id: string) => void;
}) {
  const tone = TONE[node.tone];
  return (
    <g
      onClick={() => onSelect(node.id)}
      style={{ cursor: "pointer" }}
      tabIndex={0}
      role="button"
      aria-pressed={selected}
      aria-label={`${node.role}: ${node.label ?? node.did ?? "unknown"}`}
      onKeyDown={(e) => {
        if (e.key === "Enter" || e.key === " ") {
          e.preventDefault();
          onSelect(node.id);
        }
      }}
    >
      <rect
        x={x}
        y={y}
        width={NODE_W}
        height={NODE_H}
        rx={9}
        fill={tone.fill}
        stroke={tone.stroke}
        strokeWidth={selected ? 2.4 : 1.2}
      />
      <text x={x + 14} y={y + 20} fontSize={9.5} fill={tone.accent} letterSpacing="0.08em" fontWeight={700}>
        {node.role.toUpperCase()}
      </text>
      <text x={x + 14} y={y + 39} fontSize={12.5} fill={c.text} fontWeight={640}>
        {clip(node.label ?? "—", 30)}
      </text>
      {node.did && (
        <text x={x + 14} y={y + 56} fontSize={9.5} fill={c.muted} fontFamily="var(--w-mono)">
          {short(node.did)}
        </text>
      )}
      {node.detail && (
        <text x={x + 14} y={y + 72} fontSize={9.5} fill={c.faint}>
          {clip(node.detail, 42)}
        </text>
      )}
    </g>
  );
}

interface Seg {
  x1: number;
  y1: number;
  x2: number;
  y2: number;
  label?: string | undefined;
  dashed?: boolean | undefined;
}

function EdgeLine({ x1, y1, x2, y2, dashed }: Seg) {
  return (
    <line
      x1={x1}
      y1={y1}
      x2={x2}
      y2={y2}
      stroke={c.line}
      strokeWidth={1.4}
      strokeDasharray={dashed ? "4 3" : undefined}
      markerEnd="url(#tg-arrow)"
    />
  );
}

/** Labels paint in a final pass, above the nodes. Drawn with the lines they
 *  were hidden behind whichever box happened to overlap the midpoint — which
 *  is most of them once the columns are close together. */
function EdgeLabel({ x1, y1, x2, y2, label }: Seg) {
  if (!label) return null;
  const midX = (x1 + x2) / 2;
  const midY = (y1 + y2) / 2;
  const w = label.length * 5.9 + 12;
  return (
    <g>
      <rect x={midX - w / 2} y={midY - 8.5} width={w} height={17} rx={5} fill={c.ground} />
      <text x={midX} y={midY + 3.5} fontSize={9.5} fill={c.muted} textAnchor="middle">
        {label}
      </text>
    </g>
  );
}

export function TrustGraph({
  nodes,
  edges,
  positions,
  height,
  selectedId,
  onSelect,
  groups = [],
}: {
  nodes: GraphNode[];
  edges: GraphEdge[];
  groups?: GraphGroup[];
  selectedId?: string | undefined;
  onSelect: (id: string) => void;
  /** id → column/row. Layout is fixed rather than force-directed: the shape is
   *  always the same handful of roles, and a stable picture is easier to learn
   *  than an optimal one that moves. */
  positions: Record<string, { col: number; row: number }>;
  height: number;
}) {
  const PAD = 14;

  /** Bounding box of a group's members, in the same coordinate space nodes
   *  use, so an edge can attach to the frame instead of to one member. */
  const groupBox = (g: GraphGroup) => {
    const pts = g.members.map((m) => positions[m]).filter((v): v is NonNullable<typeof v> => !!v);
    if (pts.length === 0) return null;
    const xs = pts.map((v) => COL[v.col] ?? 0);
    const ys = pts.map((v) => v.row);
    const x = Math.min(...xs) - PAD;
    const y = Math.min(...ys) - PAD - 12;
    return {
      x,
      y,
      w: Math.max(...xs) + NODE_W + PAD - x,
      h: Math.max(...ys) + NODE_H + PAD - y,
    };
  };

  const at = (id: string) => {
    const p = positions[id];
    if (p) return { x: COL[p.col] ?? 0, y: p.row, w: NODE_W, h: NODE_H };
    const g = groups.find((gr) => gr.id === id);
    if (g) {
      const b = groupBox(g);
      // Treat the frame as a node so the existing edge maths applies.
      if (b) return { x: b.x, y: b.y, w: b.w, h: b.h };
    }
    return null;
  };

  const vertical = edges.filter((e) => {
    const a = at(e.from);
    const b = at(e.to);
    return a && b && !(a.y === b.y && a.h === b.h);
  });

  const segments: Seg[] = edges
    .map((e): Seg | null => {
      const a = at(e.from);
      const b = at(e.to);
      if (!a || !b) return null;
      const sameRow = a.y === b.y && a.h === b.h;
      if (sameRow) {
        // Direction matters now that some rows read right-to-left: a
        // credential stored at the agent signs you in to a site on the left.
        const rightward = a.x < b.x;
        return {
          x1: rightward ? a.x + a.w : a.x,
          y1: a.y + a.h / 2,
          x2: rightward ? b.x - 4 : b.x + b.w + 4,
          y2: b.y + b.h / 2,
          label: e.label,
          dashed: e.dashed,
        };
      }
      // Several edges can leave the same box upward — "in the page" and
      // "confirm requests" both do. Spread them across the source's width so
      // the lines and their labels don't stack on one another.
      const peers = vertical.filter((v) => v.from === e.from);
      const slot = peers.indexOf(e);
      const spread = peers.length > 1 ? (slot + 1) / (peers.length + 1) : 0.5;
      const up = a.y > b.y;
      return {
        x1: a.x + a.w * spread,
        y1: up ? a.y : a.y + a.h,
        x2: b.x + b.w / 2,
        y2: up ? b.y + b.h + 4 : b.y - 4,
        label: e.label,
        dashed: e.dashed,
      };
    })
    .filter((v): v is Seg => v !== null);

  return (
    <div style={{ overflowX: "auto" }}>
      <svg
        viewBox={`0 0 ${CANVAS_W} ${height}`}
        // Same ceiling as the sequence diagram: scale down, never up.
        style={{ width: "100%", maxWidth: CANVAS_W, minWidth: 860, display: "block" }}
        role="img"
        aria-label="Diagram of the wallet's connections"
      >
        <defs>
          <marker id="tg-arrow" viewBox="0 0 8 8" refX="7" refY="4" markerWidth="6" markerHeight="6" orient="auto">
            <path d="M0 0 L8 4 L0 8 z" fill={c.line} />
          </marker>
        </defs>

        {/* Group frames sit behind everything. */}
        {groups.map((g) => {
          const b = groupBox(g);
          if (!b) return null;
          return (
            <g key={g.id}>
              <rect
                x={b.x}
                y={b.y}
                width={b.w}
                height={b.h}
                rx={12}
                fill="none"
                stroke={c.line}
                strokeWidth={1}
                strokeDasharray="5 4"
              />
              <text x={b.x + 12} y={b.y + 14} fontSize={9.5} fill={c.faint} letterSpacing="0.08em" fontWeight={700}>
                {g.label.toUpperCase()}
              </text>
            </g>
          );
        })}

        {segments.map((seg, i) => (
          <EdgeLine key={i} {...seg} />
        ))}

        {nodes.map((n) => {
          const p = at(n.id);
          return p ? (
            <Node
              key={n.id}
              node={n}
              x={p.x}
              y={p.y}
              selected={selectedId === n.id}
              onSelect={onSelect}
            />
          ) : null;
        })}

        {segments.map((seg, i) => (
          <EdgeLabel key={i} {...seg} />
        ))}
      </svg>
    </div>
  );
}

/** Preferred display label for a DID: the verified agent name, else the host,
 *  else nothing. Never a name inferred from DID structure. */
export function displayLabel(
  did: string | undefined,
  names: Record<string, AgentName>,
): string | undefined {
  if (!did) return undefined;
  const name = names[did];
  return name ? displayAgentName(name) : didHost(did);
}

export const graphLegend: CSSProperties = { fontSize: t.xs, color: c.faint };
