// The identity map — one picture of facts, faces and contexts.
//
// Three bands, top to bottom: the facts you hold, the faces that select among
// them, the contexts where a persona wears one. Between the second and third
// runs the line the whole family is built around, drawn rather than described:
// copies go down, nothing reads up.
//
// Select anything and everything it reaches lights up — see `reachOf` in
// `identity-graph.ts` for what "reaches" means in each direction, and why a
// fact's reach is where it *goes* while a context's is what it *holds*. The
// two red arrows from one face to two personas ARE a link: every wearer shows
// the same values, so anyone who sees two of them knows they are one person.
// That is shown where it happens, not reported at the bottom.
//
// The edges are drawn in an SVG laid over the bands, from card positions the
// component measures after layout. That is the only reason this file touches
// the DOM directly; the model it draws is computed in `identity-graph.ts`, with
// tests, and nothing here decides what connects to what.

import { useCallback, useLayoutEffect, useMemo, useRef, useState, type ReactNode } from "react";
import {
  personaAttributeDelete,
  personaCorrelationAnalyze,
  personaProfileList,
  type CorrelationFinding,
  type DisclosureRecord,
  type PoolAttribute,
  type PoolProfile,
} from "@openvtc/pnm-core/admin";
import type { ContextRecord } from "@openvtc/pnm-core";
import { Button, Note, Pill } from "../../ui.js";
import { c, t, font } from "../../theme.js";
import { splitDid } from "../../did-display.js";
import { managerSender } from "../sender.js";
import { Destructive } from "../destructive.js";
import { formatInstant } from "../format.js";
import type { Authority, Parties } from "../use-vta.js";
import {
  factReach,
  personaKey,
  reachOf,
  type FactNode,
  type IdentityGraph,
  type PersonaNode,
  type Selection,
} from "../identity-graph.js";
import {
  AttributeEditor,
  BindingForm,
  DeleteProfile,
  PersonaClaims,
  ProfileEditor,
  ResolvedProfile,
  formatValue,
} from "./persona-editors.js";
import { holderGate } from "../holder-gate.js";

// ── Words for what the agent knows ──────────────────────────────────────────

/** Provenance as a trust level in plain words — `design-docs/persona-vocabulary.md`. */
function provenanceWords(p: FactNode["provenance"]): { text: string; tone: "off" | "accent" | "ok" } {
  switch (p.kind) {
    case "credentialBacked": {
      const issuer = p.issuerDid ? issuerLabel(p.issuerDid) : null;
      return { text: issuer ? `credential · ${issuer}` : "credential", tone: "accent" };
    }
    case "generated":
      return { text: p.perVerifier ? "made per verifier" : "generated", tone: "ok" };
    default:
      return { text: "you said so", tone: "off" };
  }
}

function issuerLabel(did: string): string {
  const host = splitDid(did).find((part) => part.role === "host")?.text;
  return host ?? did.slice(0, 18) + "…";
}

/**
 * How a persona is labelled on a card.
 *
 * The last path segment of a `did:webvh` (`…:webvh.storm.ws:opinion-emotion`)
 * is the name the holder gave it, and it is a *segment of the DID* — a fact
 * about the identifier, shown as such. This is not an agent name: those come
 * only from a resolved document's `alsoKnownAs` (see `agent-name.ts`), and
 * nothing here pretends otherwise. The full DID is always rendered beneath.
 */
function personaLabel(did: string): string {
  const parts = splitDid(did);
  const path = parts.filter((p) => p.role === "path").map((p) => p.text.replace(/^:/, ""));
  if (path.length > 0) return path[path.length - 1]!;
  const host = parts.find((p) => p.role === "host")?.text;
  if (host) return host;
  return did.length > 22 ? `${did.slice(0, 22)}…` : did;
}

function staleWords(reason: string | undefined): string {
  switch (reason) {
    case "expired":
      return "stale · expired";
    case "revoked":
      return "stale · revoked";
    default:
      return "stale";
  }
}

// ── Measuring cards so edges can be drawn between them ──────────────────────

interface Box {
  x: number;
  y: number;
  w: number;
  h: number;
}

function useBoxes(stage: React.RefObject<HTMLDivElement | null>, deps: unknown[]) {
  const nodes = useRef(new Map<string, HTMLElement>());
  const [boxes, setBoxes] = useState<Map<string, Box>>(new Map());
  const [size, setSize] = useState({ w: 0, h: 0 });

  const register = useCallback(
    (id: string) => (el: HTMLElement | null) => {
      if (el) nodes.current.set(id, el);
      else nodes.current.delete(id);
    },
    [],
  );

  const measure = useCallback(() => {
    const s = stage.current;
    if (!s) return;
    const origin = s.getBoundingClientRect();
    const next = new Map<string, Box>();
    for (const [id, el] of nodes.current) {
      const r = el.getBoundingClientRect();
      next.set(id, { x: r.left - origin.left, y: r.top - origin.top, w: r.width, h: r.height });
    }
    setBoxes(next);
    setSize({ w: s.scrollWidth, h: s.scrollHeight });
  }, [stage]);

  // eslint-disable-next-line react-hooks/exhaustive-deps
  useLayoutEffect(measure, [measure, ...deps]);
  useLayoutEffect(() => {
    const s = stage.current;
    if (!s || typeof ResizeObserver === "undefined") return;
    const ro = new ResizeObserver(() => measure());
    ro.observe(s);
    return () => ro.disconnect();
  }, [stage, measure]);

  return { boxes, size, register };
}

function curve(from: Box, to: Box): string {
  const x1 = from.x + from.w / 2;
  const y1 = from.y + from.h;
  const x2 = to.x + to.w / 2;
  const y2 = to.y;
  const ym = (y1 + y2) / 2;
  return `M${x1} ${y1} C${x1} ${ym}, ${x2} ${ym}, ${x2} ${y2}`;
}

// ── Cards ───────────────────────────────────────────────────────────────────

type Mood = "plain" | "lit" | "selected" | "dim";

function cardStyle(mood: Mood, extra?: React.CSSProperties): React.CSSProperties {
  const ring =
    mood === "selected"
      ? { border: `2px solid ${c.accent}`, boxShadow: `0 0 0 4px ${c.accentSoft}` }
      : mood === "lit"
        ? { border: `1px solid ${c.accent}` }
        : { border: `1px solid ${c.line}` };
  return {
    background: c.surface,
    borderRadius: "var(--w-r-md)",
    padding: "10px 12px",
    display: "flex",
    flexDirection: "column",
    gap: 4,
    cursor: "pointer",
    opacity: mood === "dim" ? 0.45 : 1,
    transition: "opacity 120ms ease, border-color 120ms ease",
    boxSizing: "border-box",
    ...ring,
    ...extra,
  };
}

function moodOf(selected: boolean, lit: boolean, anySelection: boolean): Mood {
  if (selected) return "selected";
  if (lit) return "lit";
  return anySelection ? "dim" : "plain";
}

function BandLabel({ text, sub, action }: { text: string; sub: string; action?: ReactNode }) {
  return (
    <div style={{ display: "flex", alignItems: "baseline", gap: 10, justifyContent: "space-between" }}>
      <div style={{ display: "flex", alignItems: "baseline", gap: 10 }}>
        <span style={{ fontSize: t.xs, textTransform: "uppercase", letterSpacing: 0.5, fontWeight: 650 }}>
          {text}
        </span>
        <span style={{ fontSize: t.sm, color: c.faint }}>{sub}</span>
      </div>
      {action}
    </div>
  );
}

function AddTile({ label, onClick, disabled }: { label: string; onClick: () => void; disabled: string | null }) {
  return (
    <button
      onClick={onClick}
      disabled={Boolean(disabled)}
      {...(disabled ? { title: disabled } : {})}
      style={{
        border: `1px dashed ${c.line}`,
        background: "transparent",
        color: c.muted,
        borderRadius: "var(--w-r-md)",
        padding: "10px 14px",
        fontSize: t.sm,
        fontWeight: 600,
        cursor: disabled ? "default" : "pointer",
        minWidth: 140,
        opacity: disabled ? 0.5 : 1,
        font: "inherit",
      }}
    >
      {label}
    </button>
  );
}

/** Which context, when "Be known somewhere else…" was pressed rather than a
 *  card's own button. Offers the empty ones first: that is what the row it
 *  came from was about. */
function ChooseContext({
  contexts,
  onChoose,
  onCancel,
}: {
  contexts: IdentityGraph["contexts"];
  onChoose: (contextId: string) => void;
  onCancel: () => void;
}) {
  const [chosen, setChosen] = useState(contexts[0]?.id ?? "");
  return (
    <div style={{ background: c.surface, border: `1px solid ${c.line}`, borderRadius: "var(--w-r-md)", padding: "16px 18px", display: "grid", gap: 10, maxWidth: 560 }}>
      <span style={{ fontSize: t.md, fontWeight: 640 }}>Where?</span>
      <select
        value={chosen}
        onChange={(e) => setChosen(e.target.value)}
        style={{ boxSizing: "border-box", padding: "6px 9px", background: c.ground, color: c.text, border: `1px solid ${c.line}`, borderRadius: "var(--w-r-sm)", fontSize: t.sm }}
      >
        {contexts.map((ctx) => (
          <option key={ctx.id} value={ctx.id}>{ctx.label}</option>
        ))}
      </select>
      <div style={{ display: "flex", gap: 8 }}>
        <Button kind="primary" disabled={!chosen} onClick={() => onChoose(chosen)}>Next</Button>
        <Button kind="quiet" onClick={onCancel}>Cancel</Button>
      </div>
    </div>
  );
}

// ── The map ─────────────────────────────────────────────────────────────────

type Editing =
  | { kind: "fact"; existing?: PoolAttribute }
  | { kind: "face"; existing?: PoolProfile }
  /** `contextId: null` means "somewhere" — the form asks which context first. */
  | { kind: "bind"; contextId: string | null; personaDid?: string };

export function IdentityMap({
  parties,
  authority,
  graph,
  attributes,
  profiles,
  records,
  history,
  onChanged,
  banner,
}: {
  parties: Parties;
  authority: Authority | null;
  graph: IdentityGraph;
  attributes: PoolAttribute[];
  profiles: PoolProfile[];
  records: ContextRecord[];
  /** Everything that has left, for "last left" on a selected fact. Null while
   *  loading or refused — the strip then says nothing rather than "never". */
  history: DisclosureRecord[] | null;
  onChanged: () => void;
  /** Shown once, above the map — the guided setup's hand-off. */
  banner?: ReactNode;
}) {
  const [selection, setSelection] = useState<Selection | null>(null);
  const [showLinks, setShowLinks] = useState(true);
  const [editing, setEditing] = useState<Editing | null>(null);
  const [showing, setShowing] = useState<"claims" | null>(null);
  const [findings, setFindings] = useState<CorrelationFinding[] | null>(null);
  const [checking, setChecking] = useState<string | null>(null);
  const [showEmpty, setShowEmpty] = useState(false);
  const denied = holderGate(authority);

  // The band promises "where you are known". A context where nobody is known
  // is not that, and on an agent with a dozen contexts eleven cards saying
  // "nobody" drown the one that matters. So the empty ones fold into a single
  // row unless asked for — but a context the agent would not answer for stays
  // visible, because "could not ask" is not "nobody is known here".
  const isKnown = (ctx: (typeof graph.contexts)[number]) => ctx.personas.length > 0 || ctx.unreadable !== undefined;
  const knownContexts = graph.contexts.filter(isKnown);
  const emptyContexts = graph.contexts.filter((ctx) => !isKnown(ctx));
  const shownContexts = showEmpty ? graph.contexts : knownContexts;

  const stage = useRef<HTMLDivElement | null>(null);
  const { boxes, size, register } = useBoxes(stage, [graph, editing, selection?.kind]);

  const reach = useMemo(() => reachOf(graph, selection), [graph, selection]);
  const any = selection !== null;
  const linkedFaces = useMemo(() => new Set(graph.links.map((l) => l.faceId)), [graph.links]);
  const known = graph.contexts.filter((ctx) => ctx.personas.some((p) => p.faceId)).length;

  const select = (next: Selection) =>
    setSelection((cur) => (cur && JSON.stringify(cur) === JSON.stringify(next) ? null : next));

  /** The persona selected in this context, if the selection is one. */
  const selectedPersonaIn = (contextId: string): string | null =>
    selection?.kind === "persona" && selection.contextId === contextId ? selection.did : null;

  const done = useCallback(() => {
    setEditing(null);
    onChanged();
  }, [onChanged]);

  const checkValues = useCallback(async () => {
    setChecking("Asking your agent…");
    try {
      setFindings(await personaCorrelationAnalyze(managerSender, parties));
      setChecking(null);
    } catch (e) {
      setChecking(`Your agent would not check — ${e instanceof Error ? e.message : String(e)}`);
    }
  }, [parties]);
  const valueLinked = useMemo(
    () => new Map((findings ?? []).filter((f) => f.attributeId).map((f) => [f.attributeId!, f])),
    [findings],
  );

  // ── edges ──
  const edges = useMemo(() => {
    const out: { d: string; kind: "fact" | "wear" | "link"; lit: boolean }[] = [];
    for (const face of graph.faces) {
      const fb = boxes.get(`face:${face.id}`);
      if (!fb) continue;
      for (const factId of face.factIds) {
        const ab = boxes.get(`fact:${factId}`);
        if (!ab) continue;
        out.push({
          d: curve(ab, fb),
          kind: "fact",
          lit: reach.factIds.has(factId) && reach.faceIds.has(face.id),
        });
      }
      for (const ctx of graph.contexts) {
        for (const p of ctx.personas) {
          if (p.faceId !== face.id) continue;
          const pb = boxes.get(`persona:${personaKey(ctx.id, p.did)}`);
          if (!pb) continue;
          const isLink = showLinks && linkedFaces.has(face.id);
          out.push({
            d: curve(fb, pb),
            kind: isLink ? "link" : "wear",
            lit: reach.faceIds.has(face.id) && reach.personaKeys.has(personaKey(ctx.id, p.did)),
          });
        }
      }
    }
    return out;
  }, [graph, boxes, reach, showLinks, linkedFaces]);

  const stroke = (e: (typeof edges)[number]) =>
    e.kind === "link" ? c.danger : e.lit ? c.accent : e.kind === "wear" ? "var(--m-act-data)" : c.line;

  return (
    <div style={{ display: "grid", gap: 16, alignContent: "start" }}>
      {banner}

      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "flex-start", gap: 16, flexWrap: "wrap" }}>
        <div style={{ display: "grid", gap: 3 }}>
          <h1 style={{ margin: 0, fontSize: t.lg, fontWeight: 640 }}>Your identity</h1>
          <span style={{ fontSize: t.sm, color: c.muted }}>
            Facts above the line are yours alone. A context only ever gets a copy.
          </span>
        </div>
        <div style={{ display: "flex", gap: 8, alignItems: "center", flexWrap: "wrap" }}>
          <Pill tone="off">{graph.facts.length} fact{graph.facts.length === 1 ? "" : "s"}</Pill>
          <Pill tone="off">{graph.faces.length} face{graph.faces.length === 1 ? "" : "s"}</Pill>
          <Pill tone={known > 0 ? "accent" : "off"}>
            known in {known} of {graph.contexts.length} context{graph.contexts.length === 1 ? "" : "s"}
          </Pill>
          {graph.links.length > 0 && (
            <Pill tone="danger">{graph.links.length} link{graph.links.length === 1 ? "" : "s"}</Pill>
          )}
          <label style={{ display: "inline-flex", alignItems: "center", gap: 6, fontSize: t.sm, marginLeft: 6, cursor: "pointer" }}>
            <input type="checkbox" checked={showLinks} onChange={(e) => setShowLinks(e.target.checked)} />
            Show links
          </label>
          <Button
            kind="quiet"
            disabled={checking === "Asking your agent…"}
            {...(denied ? { title: denied } : {})}
            onClick={() => void checkValues()}
          >
            {findings ? "Check values again" : "Check values with your agent"}
          </Button>
        </div>
      </div>
      {checking && checking !== "Asking your agent…" && <Note tone="danger">{checking}</Note>}
      {findings && findings.length === 0 && (
        <Note tone="accent">Your agent finds no two facts holding the same value. That is an answer, not an empty result.</Note>
      )}
      {denied && <Note tone="warn">{denied}</Note>}

      <div ref={stage} style={{ position: "relative", display: "grid", gap: 26 }} onClick={(e) => {
        if (e.target === e.currentTarget) setSelection(null);
      }}>
        <svg
          style={{ position: "absolute", left: 0, top: 0, pointerEvents: "none", overflow: "visible" }}
          width={size.w}
          height={size.h}
          fill="none"
        >
          {edges.filter((e) => !e.lit && e.kind !== "link").map((e, i) => (
            <path key={`u${i}`} d={e.d} stroke={stroke(e)} strokeWidth={1.5} opacity={any ? 0.5 : 1} />
          ))}
          {edges.filter((e) => e.kind === "link").map((e, i) => (
            <path key={`l${i}`} d={e.d} stroke={c.danger} strokeWidth={2.5} strokeDasharray="6 5" opacity={any && !e.lit ? 0.5 : 1} />
          ))}
          {edges.filter((e) => e.lit && e.kind !== "link").map((e, i) => (
            <path key={`t${i}`} d={e.d} stroke={c.accent} strokeWidth={2.5} />
          ))}
        </svg>

        {/* ── Facts ── */}
        <section style={{ display: "grid", gap: 10 }}>
          <BandLabel text="Facts" sub="yours alone — nothing below can read these" />
          <div style={{ display: "flex", flexWrap: "wrap", gap: 14 }}>
            {graph.facts.map((f) => {
              const selected = selection?.kind === "fact" && selection.id === f.id;
              const prov = provenanceWords(f.provenance);
              const linked = valueLinked.get(f.id);
              const { text, withheld } = formatValue(f.value);
              return (
                <div
                  key={f.id}
                  ref={register(`fact:${f.id}`)}
                  onClick={() => select({ kind: "fact", id: f.id })}
                  style={cardStyle(moodOf(selected, reach.factIds.has(f.id), any), { width: 222, ...(f.stale ? { opacity: any && !reach.factIds.has(f.id) && !selected ? 0.35 : 0.72 } : {}) })}
                >
                  <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", gap: 8 }}>
                    <span style={{ fontFamily: font.mono, fontSize: t.xs, color: c.muted }}>{f.type}</span>
                    {f.stale && <Pill tone="warn">{staleWords(f.staleReason)}</Pill>}
                  </div>
                  <div style={{ fontSize: t.base, fontWeight: 600, whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis", color: withheld ? c.faint : c.text }}>
                    {f.label ? `${f.label} · ` : ""}{text}
                  </div>
                  <div style={{ display: "flex", gap: 6, alignItems: "center", flexWrap: "wrap" }}>
                    <Pill tone={prov.tone}>{prov.text}</Pill>
                    {linked && <Pill tone="danger">{linked.severity === "high" ? "links" : "may link"}</Pill>}
                  </div>
                </div>
              );
            })}
            <AddTile label="+ Add a fact" onClick={() => setEditing({ kind: "fact" })} disabled={null} />
          </div>
        </section>

        {/* ── Faces ── */}
        <section style={{ display: "grid", gap: 10 }}>
          <BandLabel text="Faces" sub="which facts you show together" />
          <div style={{ display: "flex", flexWrap: "wrap", gap: 14, justifyContent: "center" }}>
            {graph.faces.map((face) => {
              const selected = selection?.kind === "face" && selection.id === face.id;
              const wearers = graph.contexts.flatMap((ctx) => ctx.personas.filter((p) => p.faceId === face.id));
              const linked = linkedFaces.has(face.id);
              return (
                <div
                  key={face.id}
                  ref={register(`face:${face.id}`)}
                  onClick={() => select({ kind: "face", id: face.id })}
                  style={cardStyle(moodOf(selected, reach.faceIds.has(face.id), any), { width: 330, padding: "12px 14px", gap: 8 })}
                >
                  <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", gap: 8 }}>
                    <span style={{ fontSize: t.base, fontWeight: 640 }}>{face.name}</span>
                    {linked && showLinks && <Pill tone="danger">links {wearers.length} personas</Pill>}
                  </div>
                  <div style={{ display: "flex", gap: 6, flexWrap: "wrap" }}>
                    {face.factIds.map((id) => {
                      const fact = graph.facts.find((f) => f.id === id);
                      const lit = reach.factIds.has(id) && reach.faceIds.has(face.id);
                      return (
                        <span key={id} style={{ fontFamily: font.mono, fontSize: t.xs, padding: "3px 8px", borderRadius: "var(--w-r-sm)", background: lit ? c.accentSoft : c.raised, color: lit ? c.accent : c.text, border: `1px solid ${lit ? c.accentSoft : c.line}` }}>
                          {fact?.type ?? id}
                        </span>
                      );
                    })}
                    {face.preserved > 0 && (
                      <span style={{ fontSize: t.xs, padding: "3px 8px", borderRadius: "var(--w-r-sm)", background: c.raised, color: c.muted, border: `1px solid ${c.line}` }}>
                        +{face.preserved} pinned, shown differently, or only here
                      </span>
                    )}
                  </div>
                  <span style={{ fontSize: t.sm, color: c.faint }}>
                    {wearers.length === 0
                      ? "worn by nobody yet"
                      : `worn by ${wearers.length} persona${wearers.length === 1 ? "" : "s"} in ${new Set(wearers.map((w) => w.contextId)).size} context${new Set(wearers.map((w) => w.contextId)).size === 1 ? "" : "s"}`}
                  </span>
                </div>
              );
            })}
            <AddTile label="+ New face" onClick={() => setEditing({ kind: "face" })} disabled={graph.facts.length === 0 ? "Add a fact first — a face is a selection over facts." : null} />
          </div>
        </section>

        {/* ── The line ── */}
        <div style={{ position: "relative", height: 1, borderTop: `1px dashed ${c.faint}`, margin: "4px 0" }}>
          <span style={{ position: "absolute", right: 0, top: -12, display: "inline-flex", alignItems: "center", gap: 7, padding: "3px 10px", borderRadius: 999, background: c.ground, border: `1px solid ${c.line}`, fontSize: t.xs, color: c.muted, fontWeight: 600 }}>
            <svg width="12" height="12" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth={1.6} strokeLinecap="round" strokeLinejoin="round"><path d="M8 2v11M3.5 8.5 8 13l4.5-4.5" /></svg>
            Copies go down. Nothing reads up.
          </span>
        </div>

        {/* ── Contexts ── */}
        <section style={{ display: "grid", gap: 10 }}>
          <BandLabel
            text="Contexts"
            sub="where you are known, and as whom"
            action={
              emptyContexts.length > 0 && showEmpty ? (
                <Button kind="quiet" onClick={() => setShowEmpty(false)}>
                  Hide the {emptyContexts.length} where nobody knows you
                </Button>
              ) : undefined
            }
          />
          {knownContexts.length === 0 && !showEmpty && (
            <div style={{ fontSize: t.sm, color: c.faint, lineHeight: 1.55, padding: "6px 0" }}>
              You are not known anywhere yet. Nothing below the line holds a copy of anything.
            </div>
          )}
          <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fill, minmax(300px, 1fr))", gap: 14 }}>
            {shownContexts.map((ctx) => {
              const selected = selection?.kind === "context" && selection.id === ctx.id;
              return (
                <div
                  key={ctx.id}
                  onClick={() => select({ kind: "context", id: ctx.id })}
                  style={cardStyle(moodOf(selected, reach.contextIds.has(ctx.id), any), { padding: "12px 14px", gap: 10, minHeight: 120 })}
                >
                  <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
                    <span style={{ color: "var(--m-act-data)", display: "inline-flex" }}>
                      <svg width="14" height="14" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth={1.6} strokeLinecap="round" strokeLinejoin="round"><path d="M3 14V2h7v12M10 2l3 1.5V14" /><circle cx="7.7" cy="8" r=".6" fill="currentColor" /></svg>
                    </span>
                    <span style={{ fontSize: t.base, fontWeight: 640 }}>{ctx.label}</span>
                    {ctx.label !== ctx.id && <span style={{ fontFamily: font.mono, fontSize: t.xs, color: c.faint }}>{ctx.id}</span>}
                  </div>
                  {ctx.unreadable ? (
                    <span style={{ fontSize: t.sm, color: c.warn }}>Your agent would not say who is known here — {ctx.unreadable}</span>
                  ) : ctx.personas.length === 0 ? (
                    <span style={{ fontSize: t.sm, color: c.faint }}>Nobody yet. This context knows nothing about you.</span>
                  ) : (
                    <div style={{ display: "grid", gap: 6 }}>
                      <span style={{ fontSize: t.xs, color: c.faint, textTransform: "uppercase", letterSpacing: 0.4 }}>Known here as</span>
                      {ctx.personas.map((p) => {
                        const key = personaKey(ctx.id, p.did);
                        const pSelected = selection?.kind === "persona" && selection.contextId === ctx.id && selection.did === p.did;
                        const lit = reach.personaKeys.has(key);
                        const linked = showLinks && p.faceId !== null && linkedFaces.has(p.faceId);
                        return (
                          <div
                            key={p.did}
                            ref={register(`persona:${key}`)}
                            onClick={(e) => {
                              e.stopPropagation();
                              select({ kind: "persona", contextId: ctx.id, did: p.did });
                            }}
                            style={{ display: "grid", gap: 3, padding: "6px 8px", borderRadius: "var(--w-r-sm)", background: pSelected || lit ? c.accentSoft : c.raised, border: `1px solid ${pSelected ? c.accent : lit ? c.accentSoft : c.line}`, cursor: "pointer" }}
                          >
                            <div style={{ display: "flex", alignItems: "center", gap: 8, flexWrap: "wrap" }}>
                              <span style={{ fontSize: t.sm, fontWeight: 640 }}>{personaLabel(p.did)}</span>
                              {p.faceId ? (
                                <span style={{ fontSize: t.sm, color: c.muted }}>wears <strong style={{ color: c.text }}>{p.faceName ?? "a face"}</strong> · {p.claimCount} fact{p.claimCount === 1 ? "" : "s"}</span>
                              ) : (
                                <Pill tone="off">wears nothing</Pill>
                              )}
                              {linked && <Pill tone="danger">linked</Pill>}
                            </div>
                            <span style={{ fontFamily: font.mono, fontSize: t.xs, color: c.faint, wordBreak: "break-all" }}>{p.did}</span>
                          </div>
                        );
                      })}
                    </div>
                  )}
                  <div>
                    {/* A persona selected in this context is the one the
                        holder is asking about, so the button acts on it rather
                        than opening an empty form beside a highlighted row —
                        which read as the selection having been ignored. The
                        label changes with it: "be known as" and "change what
                        this one wears" are different acts, and only one of them
                        is what a selected persona invites. */}
                    <Button
                      kind="quiet"
                      disabled={graph.faces.length === 0}
                      {...(graph.faces.length === 0 ? { title: "Make a face first." } : denied ? { title: denied } : {})}
                      onClick={() =>
                        setEditing({
                          kind: "bind",
                          contextId: ctx.id,
                          ...(selectedPersonaIn(ctx.id) ? { personaDid: selectedPersonaIn(ctx.id)! } : {}),
                        })
                      }
                    >
                      {selectedPersonaIn(ctx.id)
                        ? `Change what ${personaLabel(selectedPersonaIn(ctx.id)!)} wears`
                        : "Be known here as…"}
                    </Button>
                  </div>
                </div>
              );
            })}
          </div>
          {emptyContexts.length > 0 && !showEmpty && (
            <div style={{ display: "flex", alignItems: "center", gap: 12, flexWrap: "wrap", padding: "10px 14px", border: `1px dashed ${c.line}`, borderRadius: "var(--w-r-md)", fontSize: t.sm, color: c.muted }}>
              <span>
                Not known in <strong style={{ color: c.text }}>{emptyContexts.length}</strong> other context{emptyContexts.length === 1 ? "" : "s"}. They hold nothing about you.
              </span>
              <div style={{ display: "flex", gap: 6, marginLeft: "auto" }}>
                <Button
                  kind="default"
                  disabled={graph.faces.length === 0}
                  {...(graph.faces.length === 0 ? { title: "Make a face first." } : denied ? { title: denied } : {})}
                  onClick={() => setEditing({ kind: "bind", contextId: null })}
                >
                  Be known somewhere else…
                </Button>
                <Button kind="quiet" onClick={() => setShowEmpty(true)}>
                  Show them
                </Button>
              </div>
            </div>
          )}
        </section>
      </div>

      {/* ── Detail strip ── */}
      {selection && !editing && (
        <DetailStrip
          parties={parties}
          authority={authority}
          graph={graph}
          selection={selection}
          attributes={attributes}
          profiles={profiles}
          records={records}
          history={history}
          finding={selection.kind === "fact" ? (valueLinked.get(selection.id) ?? null) : null}
          showing={showing}
          onShow={setShowing}
          onEdit={setEditing}
          onChanged={() => {
            setSelection(null);
            onChanged();
          }}
        />
      )}

      {/* ── Editors ── */}
      {editing?.kind === "fact" && (
        <AttributeEditor
          key={editing.existing?.attributeId ?? "new"}
          parties={parties}
          authority={authority}
          {...(editing.existing ? { existing: editing.existing } : {})}
          onDone={done}
          onCancel={() => setEditing(null)}
        />
      )}
      {editing?.kind === "face" && (
        <ProfileEditor
          key={editing.existing?.profileId ?? "new"}
          parties={parties}
          authority={authority}
          attributes={attributes}
          {...(editing.existing ? { existing: editing.existing } : {})}
          onDone={done}
          onCancel={() => setEditing(null)}
        />
      )}
      {editing?.kind === "bind" && editing.contextId === null && (
        <ChooseContext
          contexts={emptyContexts.length > 0 ? emptyContexts : graph.contexts}
          onChoose={(contextId) => setEditing({ kind: "bind", contextId })}
          onCancel={() => setEditing(null)}
        />
      )}
      {editing?.kind === "bind" && editing.contextId !== null && (
        <BindingForm
          key={`${editing.contextId}:${editing.personaDid ?? "new"}`}
          parties={parties}
          authority={authority}
          contextId={editing.contextId}
          contextLabel={graph.contexts.find((x) => x.id === editing.contextId)?.label ?? editing.contextId}
          profiles={profiles}
          personaDid={editing.personaDid}
          onDone={done}
          onCancel={() => setEditing(null)}
        />
      )}
    </div>
  );
}

// ── What the selected thing is, where it reaches, when it last left ─────────

function DetailStrip({
  parties,
  authority,
  graph,
  selection,
  attributes,
  profiles,
  records,
  history,
  finding,
  showing,
  onShow,
  onEdit,
  onChanged,
}: {
  parties: Parties;
  authority: Authority | null;
  graph: IdentityGraph;
  selection: Selection;
  attributes: PoolAttribute[];
  profiles: PoolProfile[];
  records: ContextRecord[];
  history: DisclosureRecord[] | null;
  finding: CorrelationFinding | null;
  showing: "claims" | null;
  onShow: (s: "claims" | null) => void;
  onEdit: (e: Editing) => void;
  onChanged: () => void;
}) {
  const denied = holderGate(authority);
  const labelOf = (id: string) => graph.contexts.find((x) => x.id === id)?.label ?? id;

  const strip = (children: ReactNode) => (
    <div style={{ background: c.surface, border: `1px solid ${c.line}`, borderLeft: `3px solid ${c.accent}`, borderRadius: "var(--w-r-md)", padding: "12px 16px", display: "grid", gap: 12 }}>
      {children}
    </div>
  );
  const col = (heading: string, children: ReactNode) => (
    <div style={{ display: "grid", gap: 3, fontSize: t.sm, color: c.muted, lineHeight: 1.5, minWidth: 0 }}>
      <span style={{ fontSize: t.xs, textTransform: "uppercase", letterSpacing: 0.4, color: c.faint }}>{heading}</span>
      {children}
    </div>
  );
  const lastLeft = (pred: (d: DisclosureRecord) => boolean) => {
    if (history === null) return <span style={{ color: c.faint }}>—</span>;
    const hit = history.filter(pred).sort((a, b) => b.disclosedAt.localeCompare(a.disclosedAt))[0];
    if (!hit) return <span>Never.</span>;
    return (
      <>
        <span>{formatInstant(hit.disclosedAt)} → <span style={{ fontFamily: font.mono, fontSize: t.xs }}>{hit.verifierDid}</span></span>
        <span>as {personaLabel(hit.personaDid)} in {labelOf(hit.contextId)}{hit.purpose ? ` · “${hit.purpose}”` : ""}</span>
      </>
    );
  };

  if (selection.kind === "fact") {
    const fact = graph.facts.find((f) => f.id === selection.id);
    const raw = attributes.find((a) => a.attributeId === selection.id);
    if (!fact || !raw) return null;
    const reach = factReach(graph, fact.id);
    const linkedFaces = reach.faces.filter((f) => graph.links.some((l) => l.faceId === f.id));
    const prov = provenanceWords(fact.provenance);
    const { text } = formatValue(fact.value);
    return strip(
      <>
        <div style={{ display: "grid", gridTemplateColumns: "minmax(200px, 260px) minmax(0, 1fr) minmax(0, 1fr)", gap: 18 }}>
          <div style={{ display: "grid", gap: 3 }}>
            <span style={{ fontFamily: font.mono, fontSize: t.xs, color: c.muted }}>{fact.type}</span>
            <span style={{ fontSize: t.md, fontWeight: 640, wordBreak: "break-word" }}>{text}</span>
            <span style={{ fontSize: t.sm, color: c.faint }}>
              {fact.label ? `${fact.label} · ` : ""}{prov.text}
              {fact.provenance.kind === "credentialBacked" ? " — provable, and the same signature to everyone who sees it" : fact.provenance.kind === "selfAsserted" ? " — passed on, never proven" : ""}
            </span>
            {fact.stale && <span style={{ fontSize: t.sm, color: c.warn }}>Can no longer be proven ({fact.staleReason ?? "stale"}).</span>}
          </div>
          {col("Reach", reach.faces.length === 0 ? (
            <span>No face shows it. It reaches nowhere.</span>
          ) : (
            <>
              <span>
                Reaches <strong style={{ color: c.text }}>{reach.contextIds.length} context{reach.contextIds.length === 1 ? "" : "s"}</strong> through{" "}
                <strong style={{ color: c.text }}>{reach.faces.map((f) => f.name).join(", ")}</strong>
                {reach.contextIds.length === 0 ? " — which nobody wears yet." : "."}
              </span>
              {linkedFaces.length > 0 && (
                <span style={{ color: c.danger }}>{reach.wearers.length} personas carry this exact value — that is the link.</span>
              )}
              {finding && <span style={{ color: c.danger }}>{finding.why}</span>}
            </>
          ))}
          {col("Last left", lastLeft((d) => d.claimTypes.includes(fact.type)))}
        </div>
        <div style={{ display: "flex", gap: 6, flexWrap: "wrap" }}>
          <Button kind="quiet" onClick={() => onEdit({ kind: "fact", existing: raw })}>Edit</Button>
          <Destructive<PoolProfile[]>
            label="Delete"
            preview={async () => {
              // Asked again rather than read off the map, so the answer is
              // current at the moment of the decision.
              const current = await personaProfileList(managerSender, parties);
              return current.filter((p) => p.entries.some((e) => "ref" in e && e.ref === fact.id));
            }}
            renderPreview={(faces) => (
              <>
                <strong>Deleting a fact cannot be undone.</strong>
                <span style={{ fontFamily: font.mono, fontSize: t.xs }}>{fact.type}</span>
                {faces.length === 0 ? (
                  <span>No face shows it, so nothing stops showing anything.</span>
                ) : (
                  <>
                    <span>{faces.length} face(s) show it and will stop: {faces.map((f) => f.name).join(", ")}</span>
                    <span>Every persona wearing one of those shows one fact fewer from the next hand-over onwards. Nothing already shared is affected — that has left.</span>
                  </>
                )}
              </>
            )}
            needsForce={(faces) => faces.length > 0}
            forceLabel="Remove it from those faces too"
            commit={async (force) => {
              await personaAttributeDelete(managerSender, { ...parties, attributeId: fact.id, cascade: force });
            }}
            onDone={onChanged}
          />
        </div>
      </>,
    );
  }

  if (selection.kind === "face") {
    const face = graph.faces.find((f) => f.id === selection.id);
    const raw = profiles.find((p) => p.profileId === selection.id);
    if (!face || !raw) return null;
    const wearers = graph.contexts.flatMap((ctx) => ctx.personas.filter((p) => p.faceId === face.id));
    const link = graph.links.find((l) => l.faceId === face.id);
    return strip(
      <>
        <div style={{ display: "grid", gridTemplateColumns: "minmax(200px, 260px) minmax(0, 1fr) minmax(0, 1fr)", gap: 18 }}>
          <div style={{ display: "grid", gap: 3 }}>
            <span style={{ fontSize: t.xs, color: c.faint, textTransform: "uppercase", letterSpacing: 0.4 }}>Face</span>
            <span style={{ fontSize: t.md, fontWeight: 640 }}>{face.name}</span>
            <span style={{ fontSize: t.sm, color: c.faint }}>
              shows {face.entries.length} fact{face.entries.length === 1 ? "" : "s"}{face.preserved > 0 ? ` (${face.preserved} pinned, shown differently, or only here)` : ""}
            </span>
          </div>
          {col("Worn by", wearers.length === 0 ? (
            <span>Nobody yet. No context receives these facts.</span>
          ) : (
            <>
              {wearers.map((w) => (
                <span key={personaKey(w.contextId, w.did)}>
                  <strong style={{ color: c.text }}>{personaLabel(w.did)}</strong> in {labelOf(w.contextId)}
                </span>
              ))}
              {link && (
                <span style={{ color: c.danger }}>
                  {link.wearers.length} personas wear this face. They show the same values, so anyone who sees two of them knows they are the same person — permanently.
                </span>
              )}
            </>
          ))}
          {col("Last left", lastLeft((d) => wearers.some((w) => w.did === d.personaDid && w.contextId === d.contextId)))}
        </div>
        <div style={{ display: "flex", gap: 6, flexWrap: "wrap", alignItems: "flex-start" }}>
          <Button kind="quiet" onClick={() => onShow(showing === "claims" ? null : "claims")}>
            {showing === "claims" ? "Hide" : "What it shows"}
          </Button>
          <Button kind="quiet" onClick={() => onEdit({ kind: "face", existing: raw })}>Edit</Button>
          <DeleteProfile parties={parties} profile={raw} onDone={onChanged} />
        </div>
        {showing === "claims" && <ResolvedProfile parties={parties} profileId={face.id} name={face.name} />}
      </>,
    );
  }

  if (selection.kind === "context") {
    const ctx = graph.contexts.find((x) => x.id === selection.id);
    if (!ctx) return null;
    return strip(
      <>
        <div style={{ display: "grid", gridTemplateColumns: "minmax(200px, 260px) minmax(0, 1fr) minmax(0, 1fr)", gap: 18 }}>
          <div style={{ display: "grid", gap: 3 }}>
            <span style={{ fontSize: t.xs, color: c.faint, textTransform: "uppercase", letterSpacing: 0.4 }}>Context</span>
            <span style={{ fontSize: t.md, fontWeight: 640 }}>{ctx.label}</span>
            <span style={{ fontFamily: font.mono, fontSize: t.xs, color: c.faint }}>{ctx.id}</span>
          </div>
          {col("Holds", ctx.unreadable ? (
            <span style={{ color: c.warn }}>Unknown — your agent would not answer for this context.</span>
          ) : ctx.personas.filter((p) => p.faceId).length === 0 ? (
            <span>Nothing. No persona wears a face here.</span>
          ) : (
            ctx.personas.filter((p) => p.faceId).map((p) => (
              <span key={p.did}>
                a copy of <strong style={{ color: c.text }}>{p.faceName ?? "a face"}</strong>, worn by {personaLabel(p.did)} · {p.claimCount} fact{p.claimCount === 1 ? "" : "s"}
              </span>
            ))
          ))}
          {col("Last left from here", lastLeft((d) => d.contextId === ctx.id))}
        </div>
        <div style={{ display: "flex", gap: 6 }}>
          <Button
            kind="quiet"
            disabled={Boolean(denied) || graph.faces.length === 0}
            {...(denied ? { title: denied } : graph.faces.length === 0 ? { title: "Make a face first." } : {})}
            onClick={() => onEdit({ kind: "bind", contextId: ctx.id })}
          >
            Be known here as…
          </Button>
        </div>
      </>,
    );
  }

  // persona
  const ctx = graph.contexts.find((x) => x.id === selection.contextId);
  const p: PersonaNode | undefined = ctx?.personas.find((x) => x.did === selection.did);
  if (!ctx || !p) return null;
  const link = p.faceId ? graph.links.find((l) => l.faceId === p.faceId) : undefined;
  return strip(
    <>
      <div style={{ display: "grid", gridTemplateColumns: "minmax(200px, 300px) minmax(0, 1fr) minmax(0, 1fr)", gap: 18 }}>
        <div style={{ display: "grid", gap: 3 }}>
          <span style={{ fontSize: t.xs, color: c.faint, textTransform: "uppercase", letterSpacing: 0.4 }}>In {ctx.label} you are</span>
          <span style={{ fontSize: t.md, fontWeight: 640 }}>{personaLabel(p.did)}</span>
          <span style={{ fontFamily: font.mono, fontSize: t.xs, color: c.faint, wordBreak: "break-all" }}>{p.did}</span>
        </div>
        {col("Wears", p.faceId ? (
          <>
            <span><strong style={{ color: c.text }}>{p.faceName ?? "a face"}</strong> · {p.claimCount} fact{p.claimCount === 1 ? "" : "s"} copied into this context</span>
            {link && (
              <span style={{ color: c.danger }}>
                {link.wearers.filter((w) => !(w.did === p.did && w.contextId === p.contextId)).map((w) => `${personaLabel(w.did)} in ${labelOf(w.contextId)}`).join(", ")} wear{link.wearers.length === 2 ? "s" : ""} the same face — same person to anyone who sees both.
              </span>
            )}
          </>
        ) : (
          <span>Nothing. This persona is known here but shows no facts.</span>
        ))}
        {col("Last left", lastLeft((d) => d.personaDid === p.did && d.contextId === ctx.id))}
      </div>
      <div style={{ display: "flex", gap: 6, flexWrap: "wrap", alignItems: "flex-start" }}>
        {p.faceId && (
          <Button kind="quiet" onClick={() => onShow(showing === "claims" ? null : "claims")}>
            {showing === "claims" ? "Hide" : "What it shows"}
          </Button>
        )}
        <Button
          kind="quiet"
          disabled={Boolean(denied)}
          {...(denied ? { title: denied } : {})}
          onClick={() => onEdit({ kind: "bind", contextId: ctx.id, personaDid: p.did })}
        >
          {p.faceId ? "Change face" : "Put on a face"}
        </Button>
      </div>
      {showing === "claims" && p.faceId && (
        <PersonaClaims parties={parties} contextId={ctx.id} personaDid={p.did} profileName={p.faceName ?? "this face"} />
      )}
    </>,
  );
}
