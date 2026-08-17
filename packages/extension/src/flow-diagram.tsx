/// <reference types="chrome" />

// A reusable swimlane sequence diagram.
//
// Extracted from the sign-in explainer when a second flow needed the same
// treatment (delegated trust-task execution). One renderer rather than two
// copies: these diagrams describe security properties, and two implementations
// would drift on exactly the details that make them legible — the gutter that
// keeps step numbers off the labels, the self-loop that has to grow leftward,
// the clamp that stops a long label running off the canvas.
//
// Callers supply lanes, steps and the guarantees the flow buys. Every label is
// written for someone who has never met the vocabulary; the per-step detail
// carries the real terms, because whoever is debugging needs something to
// search for.

import { useState } from "react";
import { c, t } from "./theme.js";
import { Button, Panel } from "./ui.js";

export interface FlowLane {
  id: string;
  label: string;
}

export interface FlowStep {
  n: number;
  from: string;
  to: string;
  /** Plain-English, no jargon. */
  text: string;
  /** The technical detail, for the troubleshooting reader. */
  detail: string;
  /** Draws as a self-loop rather than a crossing arrow. */
  self?: boolean;
  emphasis?: boolean;
}

export interface FlowBenefit {
  title: string;
  body: string;
}

const TOP = 52;
const GAP = 58;

// Step numbers live in a fixed gutter down the left edge. Positioned beside
// their own arrow they collided with any label long enough to reach them, and
// jumped left and right down the page, which makes a sequence hard to scan.
const GUTTER_X = 40;
const LANE_0 = 108;
const LANE_GAP = 250;


export function FlowDiagram({
  title,
  teaser,
  summary,
  lanes,
  steps,
  benefitsTitle,
  benefits,
}: {
  title: string;
  /** Shown while collapsed — why someone would open this. */
  teaser: string;
  /** Shown once open. */
  summary: string;
  lanes: FlowLane[];
  steps: FlowStep[];
  benefitsTitle: string;
  benefits: FlowBenefit[];
}) {
  const [open, setOpen] = useState(false);
  const [detail, setDetail] = useState<number | null>(null);

  const laneAt = (id: string): number => {
    const i = lanes.findIndex((l) => l.id === id);
    return LANE_0 + Math.max(i, 0) * LANE_GAP;
  };
  const canvasW = LANE_0 + LANE_GAP * (lanes.length - 1) + 52;

  if (!open) {
    return (
      <Panel title={title} description={teaser}>
        <div>
          <Button onClick={() => setOpen(true)}>Show me</Button>
        </div>
      </Panel>
    );
  }

  const height = TOP + steps.length * GAP + 30;

  return (
    <Panel title={title} description={summary}>
      <div style={{ overflowX: "auto" }}>
        <svg
          viewBox={`0 0 ${canvasW} ${height}`}
          style={{ width: "100%", maxWidth: canvasW, minWidth: 760, display: "block" }}
          role="img"
          aria-label={`Sequence diagram: ${title}`}
        >
          <defs>
            <marker id="sf-arrow" viewBox="0 0 8 8" refX="7" refY="4" markerWidth="6" markerHeight="6" orient="auto">
              <path d="M0 0 L8 4 L0 8 z" fill={c.muted} />
            </marker>
          </defs>

          {lanes.map((lane) => {
            const x = laneAt(lane.id);
            return (
              <g key={lane.id}>
                <text x={x} y={18} fontSize={11} fontWeight={700} fill={c.text} textAnchor="middle">
                  {lane.label}
                </text>
                <line x1={x} y1={28} x2={x} y2={height - 12} stroke={c.line} strokeWidth={1} strokeDasharray="3 4" />
              </g>
            );
          })}

          {steps.map((s, i) => {
            const y = TOP + i * GAP;
            const x1 = laneAt(s.from);
            const x2 = laneAt(s.to);
            const active = detail === s.n;
            const stroke = s.emphasis ? c.accent : c.muted;
            const labelAt = s.self
              ? x1 - 46
              : Math.min(
                  Math.max((x1 + x2) / 2, GUTTER_X + 30 + (s.text.length * 5.9) / 2),
                  canvasW - 16 - (s.text.length * 5.9) / 2,
                );
            return (
              <g
                key={s.n}
                onClick={() => setDetail(active ? null : s.n)}
                style={{ cursor: "pointer" }}
                tabIndex={0}
                role="button"
                aria-pressed={active}
                aria-label={`Step ${s.n}: ${s.text}`}
                onKeyDown={(e) => {
                  if (e.key === "Enter" || e.key === " ") {
                    e.preventDefault();
                    setDetail(active ? null : s.n);
                  }
                }}
              >
                <rect x={0} y={y - 22} width={canvasW} height={GAP - 6} fill="transparent" />
                {active && <rect x={0} y={y - 22} width={canvasW} height={GAP - 6} rx={6} fill={c.accentSoft} />}

                {s.self ? (
                  <path
                    d={`M ${x1} ${y - 6} q 34 0 34 12 q 0 12 -34 12`}
                    fill="none"
                    stroke={stroke}
                    strokeWidth={1.4}
                    markerEnd="url(#sf-arrow)"
                  />
                ) : (
                  <line
                    x1={x1}
                    y1={y + 6}
                    x2={x2 + (x2 > x1 ? -6 : 6)}
                    y2={y + 6}
                    stroke={stroke}
                    strokeWidth={1.4}
                    markerEnd="url(#sf-arrow)"
                  />
                )}

                {/* Sized to be findable at a glance down the gutter: these
                    are how a reader keeps their place while looking between
                    the diagram and a step's detail below it. */}
                <circle cx={GUTTER_X} cy={y + 2} r={12} fill={stroke} />
                <text
                  x={GUTTER_X}
                  y={y + 6.5}
                  fontSize={13}
                  fontWeight={700}
                  fill={c.ground}
                  textAnchor="middle"
                >
                  {s.n}
                </text>

                <text
                  x={labelAt}
                  y={y - 4}
                  fontSize={11}
                  fill={s.emphasis ? c.accent : c.text}
                  fontWeight={s.emphasis ? 640 : 400}
                  textAnchor={s.self ? "end" : "middle"}
                >
                  {s.text}
                </text>
              </g>
            );
          })}
        </svg>
      </div>

      {detail !== null && (
        <div
          style={{
            borderLeft: `2px solid ${c.accent}`,
            background: c.accentSoft,
            padding: "10px 13px",
            borderRadius: "0 var(--w-r-sm) var(--w-r-sm) 0",
            fontSize: t.sm,
            lineHeight: 1.55,
          }}
        >
          <strong>Step {detail}.</strong> {steps.find((s) => s.n === detail)?.detail}
        </div>
      )}

      <h3 style={{ margin: "8px 0 0", fontSize: t.base, fontWeight: 640 }}>{benefitsTitle}</h3>
      <div style={{ display: "grid", gap: 10 }}>
        {benefits.map((b) => (
          <div key={b.title} style={{ display: "grid", gap: 2 }}>
            <div style={{ fontSize: t.sm, fontWeight: 620 }}>{b.title}</div>
            <div style={{ fontSize: t.sm, color: c.muted, lineHeight: 1.55, maxWidth: "78ch" }}>{b.body}</div>
          </div>
        ))}
      </div>

      <div>
        <Button kind="quiet" onClick={() => setOpen(false)}>
          Hide
        </Button>
      </div>
    </Panel>
  );
}
