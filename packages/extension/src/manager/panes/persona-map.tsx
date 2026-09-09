// The identity map — one picture of attributes, faces and contexts.
//
// Three bands, top to bottom: the attributes you hold, the faces that select among
// them, the contexts where a persona wears one. Between the second and third
// runs the line the whole family is built around, drawn rather than described:
// copies go down, nothing reads up.
//
// Select anything and everything it reaches lights up — see `reachOf` in
// `identity-graph.ts` for what "reaches" means in each direction, and why a
// attribute's reach is where it *goes* while a context's is what it *holds*. The
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
  personaFacetPut,
  personaFacetDelete,
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
  attributeReach,
  flowOf,
  personaKey,
  reachOf,
  standingOf,
  tallyContexts,
  type AttributeNode,
  type ContextTally,
  type Flow,
  type IdentityGraph,
  type PersonaNode,
  type Selection,
} from "../identity-graph.js";
import type { ClaimTypeRegistry } from "@openvtc/pnm-core/persona";
import type { PoolFacet } from "@openvtc/pnm-core/admin";
import { familyOf, familyStyle, FAMILY_ORDER, type Family } from "../attribute-family.js";
import { worldHue } from "../world-colour.js";
import { worldsOfAttribute, worldOfFace, movePlan } from "../world-model.js";
import { rankFindings, tallyCrossings, crossingWords, type RankedFinding } from "../correlation-model.js";
import { provenanceWords, labelSaysSomethingElse, staleWords } from "../attribute-words.js";
import { unappliedClaimTypes } from "@openvtc/pnm-core/persona";
import {
  AttributeEditor,
  BindingForm,
  DeleteProfile,
  AttributeValue,
  PersonaClaims,
  ProfileEditor,
  ResolvedProfile,
} from "./persona-editors.js";
import { holderGate } from "../holder-gate.js";
import { Popover } from "../popover.js";
import { WorldEditor } from "./worlds.js";
import { Icon } from "../icons.js";
import { isSensitiveFor, maskedValue } from "../claim-sensitivity.js";
import type { RevealTarget } from "../reveal-value.js";

// ── Words for what the agent knows ──────────────────────────────────────────

/**
 * How a persona is labelled on a card.
 *
 * The last path segment of a `did:webvh` (`…:webvh.storm.ws:opinion-emotion`)
 * is the name the holder gave it, and it is a *segment of the DID* — an attribute
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

/**
 * The header's account of the contexts, which has to be exactly that: every
 * context, counted once, under one standing.
 *
 * It used to say "known in 1 of 12" while the band below drew two cards and the
 * fold claimed ten — three numbers from three different tests, one of which
 * quietly denied a card the reader could see. Every clause here comes from
 * `tallyContexts`, so they cannot disagree, and the clauses that are zero are
 * left out rather than printed as an absence nobody asked about.
 */
function standingWords(tally: ContextTally): string {
  const parts = [`known in ${tally.known}`];
  if (tally.identified > 0) parts.push(`an identifier in ${tally.identified}`);
  if (tally.unreadable > 0) parts.push(`${tally.unreadable} unreadable`);
  parts.push(`absent from ${tally.absent}`);
  return parts.join(" · ");
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

/**
 * The two directions, in colour.
 *
 * `reachOf` has always known that a selection reaches asymmetrically — down
 * from an attribute to where copies of it went, up from a context to what it
 * holds — and the map used to paint both in one accent, which told a reader
 * *that* things were connected and left the direction to be worked out from
 * the layout. Two hues say it outright.
 *
 * Down borrows `--m-act-data`, which the contexts band already wears: a
 * downward path is coloured by where it ends, so the hue is the destination
 * rather than a fifth thing to learn. Up keeps the accent. Neither is a
 * semantic colour — `--w-ok` / `--w-warn` / `--w-danger` still mean the only
 * things colour means here — and the words on the cards say the same thing
 * without them.
 */
const FLOW_COLOUR: Record<"down" | "up", { edge: string; wash: string }> = {
  down: { edge: "var(--m-act-data)", wash: "var(--m-act-data-soft)" },
  up: { edge: c.accent, wash: c.accentSoft },
};

/**
 * An edge is lit only when both of its ends are, and it takes its colour from
 * the end the eye travelled *to* — the one that is not the selection. A dark
 * end means the edge is not on the path at all, whatever else its ends happen
 * to be lit by.
 */
function edgeFlow(from: Flow | null, to: Flow | null): "down" | "up" | null {
  if (!from || !to) return null;
  const far = from === "self" ? to : from;
  return far === "self" ? "down" : far;
}

type Mood = "plain" | "self" | "down" | "up" | "dim";

/**
 * `stripe` is the family colour, drawn as an inset shadow rather than a
 * `borderLeft`. Two reasons, and the second is the one that bites: the border
 * is already carrying selection and reach, so a left border in a third colour
 * would break that channel's own rule — and React warns (correctly) about a
 * style object that sets the `border` shorthand on one render and `borderLeft`
 * on another, which is exactly what a mood change does.
 */
function cardStyle(mood: Mood, extra?: React.CSSProperties, stripe?: string): React.CSSProperties {
  const lit = mood === "down" || mood === "up" ? FLOW_COLOUR[mood] : null;
  // **The selection outranks everything it reaches, visually.**
  //
  // Both used to wear a coloured border, so selecting a persona lit its face,
  // its attributes and its context in the same treatment as the row that had
  // been clicked — a dozen outlined boxes and no way to tell which one was the
  // question. "I clicked on the persona DID, but how can you tell?"
  //
  // So the two states stop competing: a reached card is a *wash* with the
  // ordinary border, and only the selection carries a ring. One outline on the
  // screen, and it is always the thing you pressed.
  const ring =
    mood === "self"
      ? { border: `2px solid ${c.accent}`, background: c.accentSoft }
      : lit
        ? { border: `1px solid ${c.line}`, background: lit.wash }
        : { border: `1px solid ${c.line}`, background: c.surface };
  const shadows = [
    stripe ? `inset 3px 0 0 ${stripe}` : null,
    // Two rings rather than one: a hairline of the page's own ground, then the
    // accent. It reads as lifted off the band at any zoom, where a single soft
    // halo disappears against a card that is already tinted.
    mood === "self" ? `0 0 0 2px ${c.ground}, 0 0 0 5px ${c.accent}` : null,
  ].filter(Boolean);
  return {
    borderRadius: "var(--w-r-md)",
    padding: stripe ? "10px 12px 10px 15px" : "10px 12px",
    ...(shadows.length > 0 ? { boxShadow: shadows.join(", ") } : {}),
    display: "flex",
    flexDirection: "column",
    gap: 4,
    cursor: "pointer",
    opacity: mood === "dim" ? 0.45 : 1,
    transition: "opacity 120ms ease, border-color 120ms ease, background 120ms ease",
    boxSizing: "border-box",
    ...ring,
    ...extra,
  };
}

/**
 * What a *closed* attribute card says instead of its value.
 *
 * Three states, and they are three because collapsing any two of them tells a
 * lie the holder cannot detect:
 *
 *   "held back"  the agent sent no value — the pane lists without
 *                `includeSensitive`, so this is the normal state of every
 *                sensitive attribute, and *Show* is a real request for one.
 *   "hidden"     a value is in hand and the mask covers it on screen.
 *   "shown"      a value is in hand and the registry does not mask it, so
 *                opening the card puts it on screen.
 *
 * The first two used to be one word, which claimed a value was being held back
 * when none had arrived — the exact defect the reveal path was built to end,
 * reintroduced one layer up. A closed card must never say less truthfully than
 * an open one.
 */
function collapsedStatus(registry: ClaimTypeRegistry | null, f: AttributeNode): string {
  if (f.value === undefined) return "held back";
  const { masked } = maskedValue(registry, f.type, String(f.value), f.sensitivity);
  return masked ? "hidden" : "shown";
}

/** A node's mood follows its flow exactly: the selection itself, the two
 *  directions, or dimmed because something else is selected. */
function moodOf(flow: Flow | null, anySelection: boolean): Mood {
  if (flow === "self") return "self";
  if (flow) return flow;
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

function AddTile({ label, onClick, disabled }: { label: string; onClick: (e: React.MouseEvent<HTMLButtonElement>) => void; disabled: string | null }) {
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

/**
 * One world, and the faces inside it.
 *
 * `world: null` is the tray for faces that belong nowhere — a real state with
 * its own words, never an omission, and always drawn even when empty.
 *
 * The world's hue is used in three places on this component and **none of them
 * is a face card's border, stripe or pill**: the bubble's ground, its dot, and
 * the ring it wears while a face is hovering over it. Those are surfaces the
 * face cards do not use, which is what lets a fourth categorical colour exist
 * here without colliding with selection, family or status.
 */
function WorldBubble({
  world,
  faces,
  graph,
  reach,
  any,
  registry,
  denied,
  dragging,
  linkedFaces,
  showLinks,
  onDragStart,
  onDragEnd,
  onDrop,
  onSelect,
  onEditWorld,
  parties,
  onChanged,
}: {
  world: PoolFacet | null;
  faces: IdentityGraph["faces"];
  graph: IdentityGraph;
  reach: ReturnType<typeof reachOf>;
  any: boolean;
  registry: ClaimTypeRegistry | null;
  denied: string | null;
  dragging: string | null;
  linkedFaces: Set<string>;
  showLinks: boolean;
  onDragStart: (faceId: string) => void;
  onDragEnd: () => void;
  onDrop: (faceId: string, toFacetId: string | null) => void;
  onSelect: (faceId: string) => void;
  onEditWorld: (world: PoolFacet, anchor: HTMLElement) => void;
  parties: Parties;
  onChanged: () => void;
}) {
  const [over, setOver] = useState(false);
  const hue = world ? worldHue(world.colour) : c.faint;
  // A bubble only offers itself as a target for a face that is not already in
  // it: highlighting the world a face came from invites a no-op.
  const takes = dragging !== null && !faces.some((f) => f.id === dragging);
  const editRef = useRef<HTMLButtonElement | null>(null);
  const attributeCount = world?.attributeIds?.length ?? 0;

  return (
    <div
      onDragOver={(e) => {
        if (!takes) return;
        e.preventDefault();
        setOver(true);
      }}
      onDragLeave={() => setOver(false)}
      onDrop={(e) => {
        e.preventDefault();
        setOver(false);
        const faceId = e.dataTransfer.getData("text/plain");
        if (faceId) onDrop(faceId, world?.facetId ?? null);
      }}
      style={{
        flex: "1 1 300px",
        minWidth: 280,
        maxWidth: 430,
        display: "grid",
        gap: 9,
        padding: "11px 13px 13px",
        borderRadius: "var(--w-r-lg)",
        background: world ? `color-mix(in srgb, ${hue} 8%, ${c.surface})` : "transparent",
        border: `1px ${world ? "solid" : "dashed"} color-mix(in srgb, ${hue} 30%, transparent)`,
        ...(over && takes ? { boxShadow: `0 0 0 2px ${hue}`, background: `color-mix(in srgb, ${hue} 15%, ${c.surface})` } : {}),
        transition: "box-shadow 120ms ease, background 120ms ease",
      }}
    >
      <div style={{ display: "grid", gap: 2 }}>
        <div style={{ display: "flex", alignItems: "center", gap: 8, minHeight: 22 }}>
          {world?.icon ? (
            <span style={{ fontSize: 13, lineHeight: 1, flexShrink: 0 }}>{world.icon}</span>
          ) : (
            <span style={{ width: 11, height: 11, borderRadius: 999, background: hue, flexShrink: 0 }} />
          )}
          <span style={{ fontWeight: 660, fontSize: t.base, flex: "1 1 auto", minWidth: 0 }}>
            {world ? world.name : "Belongs to no world"}
          </span>
          {world && (
            <>
              <button
                ref={editRef}
                onClick={() => editRef.current && onEditWorld(world, editRef.current)}
                {...(denied ? { title: denied } : {})}
                style={{
                  border: `1px solid ${c.line}`, background: c.surface, color: c.muted,
                  borderRadius: "var(--w-r-sm)", padding: "3px 9px", fontSize: t.xs, cursor: "pointer",
                }}
              >
                Edit
              </button>
              {/* The confirm is the most load-bearing copy in the feature, and
                  it says what SURVIVES before it says what goes. A bubble
                  containing cards looks exactly like a folder, and a holder who
                  reads Delete as "and everything in it" will never press it —
                  while one who presses it believing that, and is right, has
                  lost faces they cannot get back. A facet is an arrangement:
                  there is no `cascade` anywhere on the wire, deliberately. */}
              <Destructive<{ released: number; names: string[] }>
                label="Delete"
                disabledReason={denied}
                preview={async () => ({ released: faces.length, names: faces.map((f) => f.name) })}
                renderPreview={(p) => (
                  <div style={{ fontSize: t.sm, color: c.text, display: "grid", gap: 6 }}>
                    <div>
                      <strong>{world.name}</strong> stops being a part of your life on this screen.
                    </div>
                    <div>
                      {p.released === 0
                        ? "No face belongs to it, and nothing else changes."
                        : `${p.released === 1 ? "The face" : `All ${p.released} faces`} in it — ` +
                          `${p.names.join(", ")} — ${p.released === 1 ? "stays" : "stay"} ` +
                          `exactly as ${p.released === 1 ? "it is" : "they are"}. ` +
                          `${p.released === 1 ? "It" : "They"} will simply belong to no world.`}
                    </div>
                    <div style={{ color: c.faint, fontSize: t.xs }}>
                      Nothing already shared is affected — that has left.
                    </div>
                  </div>
                )}
                commit={async () => {
                  await personaFacetDelete(managerSender, {
                    ...parties,
                    facetId: world.facetId,
                    expectedVersion: world.version,
                  });
                }}
                onDone={onChanged}
              />
            </>
          )}
        </div>
        <span style={{ fontSize: t.xs, color: c.muted }}>
          {faces.length} {faces.length === 1 ? "face" : "faces"}
          {world ? ` · ${attributeCount} attribute${attributeCount === 1 ? "" : "s"}` : ""}
        </span>
      </div>

      <div style={{ display: "flex", flexWrap: "wrap", gap: 8, minHeight: 44, alignContent: "flex-start" }}>
        {faces.map((face) => (
          <FaceCard
            key={face.id}
            face={face}
            graph={graph}
            reach={reach}
            any={any}
            registry={registry}
            linked={linkedFaces.has(face.id)}
            showLinks={showLinks}
            onDragStart={onDragStart}
            onDragEnd={onDragEnd}
            onSelect={onSelect}
          />
        ))}
        {faces.length === 0 && (
          <span style={{ fontSize: t.xs, color: c.faint, fontStyle: "italic", alignSelf: "center" }}>
            {world ? "Drop a face here" : "Every face belongs somewhere — that is fine too"}
          </span>
        )}
      </div>
    </div>
  );
}

/** One face, draggable between worlds. */
function FaceCard({
  face,
  graph,
  reach,
  any,
  registry,
  linked,
  showLinks,
  onDragStart,
  onDragEnd,
  onSelect,
}: {
  face: IdentityGraph["faces"][number];
  graph: IdentityGraph;
  reach: ReturnType<typeof reachOf>;
  any: boolean;
  registry: ClaimTypeRegistry | null;
  linked: boolean;
  showLinks: boolean;
  onDragStart: (faceId: string) => void;
  onDragEnd: () => void;
  onSelect: (faceId: string) => void;
}) {
  const wearers = graph.contexts.flatMap((ctx) => ctx.personas.filter((p) => p.faceId === face.id));
  const contexts = new Set(wearers.map((w) => w.contextId)).size;
  return (
    <div
      draggable
      onDragStart={(e) => {
        e.dataTransfer.setData("text/plain", face.id);
        e.dataTransfer.effectAllowed = "move";
        onDragStart(face.id);
      }}
      onDragEnd={onDragEnd}
      onClick={() => onSelect(face.id)}
      // Flexible rather than fixed: a bubble is as wide as the row lets it be,
      // and a fixed 176px card meant two faces stacked vertically inside a
      // 300px bubble while the space beside them stayed empty.
      style={cardStyle(moodOf(flowOf(reach, "face", face.id), any), {
        flex: "1 1 132px",
        minWidth: 128,
        maxWidth: "100%",
        padding: "9px 11px",
        gap: 6,
        cursor: "grab",
      })}
    >
      <div style={{ display: "flex", alignItems: "center", gap: 6 }}>
        <span style={{ fontSize: t.sm, fontWeight: 640, flex: "1 1 auto", minWidth: 0, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
          {face.name}
        </span>
        {linked && showLinks && <Pill tone="danger">links</Pill>}
      </div>
      {/* Family dots rather than the full chip list: four contact dots and a
          gated one is the shape of the offer, and it fits a card a third the
          width. The types themselves are one click away in the strip. */}
      <div style={{ display: "flex", gap: 3, flexWrap: "wrap", alignItems: "center" }}>
        {face.attributeIds.slice(0, 8).map((id) => {
          const attribute = graph.attributes.find((f) => f.id === id);
          const lit = reach.attributeIds.has(id) && reach.faceIds.has(face.id);
          return (
            <span
              key={id}
              title={attribute?.type ?? id}
              style={{
                width: 7, height: 7, borderRadius: 999, flexShrink: 0,
                background: familyStyle(familyOf(attribute?.type ?? "", registry)).hue,
                ...(lit ? { boxShadow: `0 0 0 2px ${c.accentSoft}` } : {}),
              }}
            />
          );
        })}
        <span style={{ fontSize: t.xs, color: c.faint, marginLeft: 2 }}>
          {face.attributeIds.length} attribute{face.attributeIds.length === 1 ? "" : "s"}
        </span>
      </div>
      <span style={{ fontSize: t.xs, color: c.faint }}>
        {wearers.length === 0
          ? "worn by nobody yet"
          : `worn in ${contexts} context${contexts === 1 ? "" : "s"}`}
      </span>
    </div>
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

/**
 * What is being edited, and **where it was opened from**.
 *
 * `anchor` is the element the person actually pressed, and it is not optional
 * decoration: every editor on this map used to render at the bottom of the
 * JSX, which on a populated wallet is ~1700px down a 2450px scroller that does
 * not move. Pressing "Add an attribute" changed nothing anyone could see. The
 * form now opens against the control that summoned it, so carrying that
 * element is what makes the fix possible.
 */
type Editing = (
  | { kind: "attribute"; existing?: PoolAttribute }
  | { kind: "face"; existing?: PoolProfile }
  /** `contextId: null` means "somewhere" — the form asks which context first. */
  | { kind: "bind"; contextId: string | null; personaDid?: string }
) & { anchor: HTMLElement | null };

export function IdentityMap({
  parties,
  authority,
  graph,
  attributes,
  profiles,
  worlds = [],
  registry,
  records,
  history,
  onReveal,
  onChanged,
  banner,
}: {
  parties: Parties;
  authority: Authority | null;
  graph: IdentityGraph;
  attributes: PoolAttribute[];
  profiles: PoolProfile[];
  /** The holder's worlds, for the second axis on a correlation finding. Empty
   *  is the honest answer before anyone has made one, and every finding then
   *  reads as `unknown` rather than as `within`. */
  worlds: readonly PoolFacet[];
  /** The agent's claim-type table, or `null` while it loads. A caller must not
   *  substitute a compiled-in one — that is the copy this replaced. */
  registry: ClaimTypeRegistry | null;

  records: ContextRecord[];
  /** Everything that has left, for "last left" on a selected attribute. Null while
   *  loading or refused — the strip then says nothing rather than "never". */
  history: DisclosureRecord[] | null;
  /** Ask the agent for one withheld value. Threaded down rather than called
   *  here, because the parties belong to the pane and a component that could
   *  ask on its own is one that could ask for all of them. */
  onReveal: (target: RevealTarget) => Promise<unknown>;
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
  /** Which world's editor is open, and the control it points at. `existing`
   *  absent means a new one. */
  const [worldEditing, setWorldEditing] = useState<{ existing?: PoolFacet; anchor: HTMLElement | null } | null>(null);
  /** The face being dragged, so a bubble can light up as a target without
   *  reading `dataTransfer` — which is write-only during `dragover`. */
  const [dragging, setDragging] = useState<string | null>(null);
  const [moveError, setMoveError] = useState<string | null>(null);
  const denied = holderGate(authority);

  /**
   * Move a face into `toFacetId`, or out of every world when it is null.
   *
   * The writes and their ORDER come from `movePlan`, which is tested: the
   * agent refuses to place a face that is already placed, so the world losing
   * it has to be rewritten first. Sequential rather than `Promise.all` for the
   * same reason — the second write is only legal once the first has landed.
   */
  const moveFace = useCallback(
    async (faceId: string, toFacetId: string | null) => {
      setMoveError(null);
      const plan = movePlan(worlds, profiles, attributes, faceId, toFacetId);
      if (plan.length === 0) return;
      try {
        for (const { icon, ...w } of plan) {
          await personaFacetPut(managerSender, { ...parties, ...w, ...(icon ? { icon } : {}) });
        }
        onChanged();
      } catch (e) {
        // Surfaced rather than swallowed: a drag that silently did nothing is
        // the same class of defect as an editor that opens off screen.
        setMoveError(e instanceof Error ? e.message : String(e));
      }
    },
    [worlds, profiles, attributes, parties, onChanged],
  );


  // The band promises "where you are known". A context where nobody is known
  // is not that, and on an agent with a dozen contexts eleven cards saying
  // "nobody" drown the one that matters. So the empty ones fold into a single
  // row unless asked for — but a context the agent would not answer for stays
  // visible, because "could not ask" is not "nobody is known here", and one
  // holding an unbound persona stays visible too, because "knows an identifier
  // of yours" is not that either.
  //
  // Which is which is `standingOf`, in the model with tests, and the header
  // below counts the same predicate. Two tests for one question is how the
  // arithmetic came apart last time.
  const presentContexts = graph.contexts.filter((ctx) => standingOf(ctx) !== "absent");
  const emptyContexts = graph.contexts.filter((ctx) => standingOf(ctx) === "absent");
  const shownContexts = showEmpty ? graph.contexts : presentContexts;

  const stage = useRef<HTMLDivElement | null>(null);
  const { boxes, size, register } = useBoxes(stage, [graph, editing, selection]);

  const reach = useMemo(() => reachOf(graph, selection), [graph, selection]);
  // Grouped rather than one long row: see `attribute-family.ts` for what a
  // family is and why only the registry's own roots get one. A family with no
  // members draws no heading — the point is the shape of *this* pool, not a
  // checklist of the vocabulary.
  const grouped = useMemo(() => {
    const byFamily = new Map<Family, AttributeNode[]>();
    for (const a of graph.attributes) {
      const family = familyOf(a.type, registry);
      byFamily.set(family, [...(byFamily.get(family) ?? []), a]);
    }
    return FAMILY_ORDER.filter((f) => byFamily.has(f)).map((family) => ({
      family,
      members: byFamily.get(family)!,
    }));
  }, [graph.attributes]);
  // The types this agent refused from its own file, as a set of tokens. The
  // banner above the map names them; a card wearing one says so where the
  // person is looking at the value it affects.
  const unapplied = useMemo(
    () => new Set(unappliedClaimTypes(registry).rejected.map((r) => r.type)),
    [registry],
  );
  const any = selection !== null;
  const linkedFaces = useMemo(() => new Set(graph.links.map((l) => l.faceId)), [graph.links]);

  /** Everything every bubble needs. Bundled so the three call sites cannot
   *  drift in what they pass. */
  const bubbleShared = {
    graph,
    reach,
    any,
    registry,
    denied,
    dragging,
    linkedFaces,
    showLinks,
    onDragStart: setDragging,
    onDragEnd: () => setDragging(null),
    onDrop: moveFace,
    onSelect: (id: string) => select({ kind: "face", id }),
    onEditWorld: (existing: PoolFacet, anchor: HTMLElement) => setWorldEditing({ existing, anchor }),
    parties,
    onChanged,
  } as const;

  const tally = tallyContexts(graph);

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
  // Ranked once, here, so the strip and the summary read the same model — two
  // places computing the second axis is how one of them comes to disagree.
  const ranked = useMemo(() => rankFindings(findings ?? [], worlds), [findings, worlds]);
  const valueLinked = useMemo(
    () =>
      new Map(
        ranked.filter((r) => r.finding.attributeId).map((r) => [r.finding.attributeId!, r]),
      ),
    [ranked],
  );

  // ── edges ──
  const edges = useMemo(() => {
    const out: { d: string; kind: "attribute" | "wear" | "link"; flow: "down" | "up" | null }[] = [];
    for (const face of graph.faces) {
      const fb = boxes.get(`face:${face.id}`);
      if (!fb) continue;
      for (const attributeId of face.attributeIds) {
        const ab = boxes.get(`attribute:${attributeId}`);
        if (!ab) continue;
        out.push({
          d: curve(ab, fb),
          kind: "attribute",
          flow: edgeFlow(flowOf(reach, "attribute", attributeId), flowOf(reach, "face", face.id)),
        });
      }
      for (const ctx of graph.contexts) {
        for (const p of ctx.personas) {
          if (p.faceId !== face.id) continue;
          const key = personaKey(ctx.id, p.did);
          const pb = boxes.get(`persona:${key}`);
          if (!pb) continue;
          const isLink = showLinks && linkedFaces.has(face.id);
          out.push({
            d: curve(fb, pb),
            kind: isLink ? "link" : "wear",
            flow: edgeFlow(flowOf(reach, "face", face.id), flowOf(reach, "persona", key)),
          });
        }
      }
    }
    return out;
  }, [graph, boxes, reach, showLinks, linkedFaces]);

  // An unlit edge is now neutral rather than teal. Teal used to mean "a face is
  // worn here" at rest and "this is the path you selected" when lit, which is
  // one hue doing two jobs; at rest the line itself already says it.
  const stroke = (e: (typeof edges)[number]) =>
    e.kind === "link" ? c.danger : e.flow ? FLOW_COLOUR[e.flow].edge : c.line;

  return (
    <div style={{ display: "grid", gap: 16, alignContent: "start" }}>
      {banner}

      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "flex-start", gap: 16, flexWrap: "wrap" }}>
        <div style={{ display: "grid", gap: 3 }}>
          <h1 style={{ margin: 0, fontSize: t.lg, fontWeight: 640 }}>Your identity</h1>
          <span style={{ fontSize: t.sm, color: c.muted }}>
            Attributes above the line are yours alone. A context only ever gets a copy.
          </span>
        </div>
        <div style={{ display: "flex", gap: 8, alignItems: "center", flexWrap: "wrap" }}>
          <Pill tone="off">{graph.attributes.length} attribute{graph.attributes.length === 1 ? "" : "s"}</Pill>
          <Pill tone="off">{graph.faces.length} face{graph.faces.length === 1 ? "" : "s"}</Pill>
          <Pill tone={tally.known > 0 ? "accent" : "off"}>{standingWords(tally)}</Pill>
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
        <Note tone="accent">Your agent finds no two attributes holding the same value. That is an answer, not an empty result.</Note>
      )}
      {findings && findings.length > 0 && (() => {
        // Counted from one place, so the numbers cannot disagree with the rows
        // below them — the same discipline `tallyContexts` exists for.
        const tally = tallyCrossings(ranked);
        return (
          <Note tone={tally.crosses > 0 ? "danger" : "accent"}>
            <div style={{ display: "grid", gap: 6 }}>
              {tally.crosses > 0 && (
                <strong>
                  {tally.crosses === 1
                    ? "One link crosses two parts of your life."
                    : `${tally.crosses} links cross two parts of your life.`}{" "}
                  Anyone who sees both sides knows they are the same person.
                </strong>
              )}
              {tally.within > 0 && (
                <span>
                  {tally.within === 1 ? "One link stays" : `${tally.within} links stay`} inside a
                  single world — you arranged {tally.within === 1 ? "it" : "them"}.{" "}
                  {tally.within === 1 ? "It is" : "They are"} still {tally.within === 1 ? "a link" : "links"}.
                </span>
              )}
              {tally.unknown > 0 && (
                // Said once, here, rather than on every row. Absence is not
                // "stays in one world" — the agent answered no such question.
                <span style={{ color: c.faint }}>
                  {tally.unknown === 1 ? "One link is" : `${tally.unknown} links are`} unsorted:
                  your agent did not say whether {tally.unknown === 1 ? "it crosses" : "they cross"}{" "}
                  a world. Making some worlds is what answers that.
                </span>
              )}
            </div>
          </Note>
        );
      })()}
      {denied && <Note tone="warn">{denied}</Note>}

      {/* The key appears with the first selection and not before: a legend for
          colours that are not yet on screen is noise, and the two hues only
          exist while something is selected. */}
      {any && (
        <div style={{ display: "flex", gap: 16, flexWrap: "wrap", alignItems: "center", fontSize: t.sm, color: c.muted }}>
          <span style={{ display: "inline-flex", alignItems: "center", gap: 7 }}>
            <span style={{ width: 22, height: 3, borderRadius: 2, background: FLOW_COLOUR.down.edge }} />
            goes down — a copy of this leaves you
          </span>
          <span style={{ display: "inline-flex", alignItems: "center", gap: 7 }}>
            <span style={{ width: 22, height: 3, borderRadius: 2, background: FLOW_COLOUR.up.edge }} />
            comes up — what that context holds of yours
          </span>
        </div>
      )}

      <div ref={stage} style={{ position: "relative", display: "grid", gap: 26 }} onClick={(e) => {
        if (e.target === e.currentTarget) setSelection(null);
      }}>
        {/* Behind the cards, not over them.
            The SVG is positioned and the bands are not, so the SVG won a
            stacking contest nobody entered it into: every edge was drawn
            *across* the boxes it connects, through the type and the value. The
            bands become positioned with a higher `zIndex` below, which is the
            whole fix — an edge that disappears under a card reads as going
            behind it, which is what it does. */}
        <svg
          style={{ position: "absolute", left: 0, top: 0, zIndex: 0, pointerEvents: "none", overflow: "visible" }}
          width={size.w}
          height={size.h}
          fill="none"
        >
          {/* Drawn only once something is selected.
              With nothing selected these are twenty-odd low-contrast curves
              crossing the whole page, answering a question nobody asked — and
              `reachOf` has no answer to draw until there is a selection, so
              they were never carrying information at rest. The links below are
              the exception: a link is true whether or not anyone selected
              anything, and suppressing it would be hiding a finding. */}
          {any && edges.filter((e) => !e.flow && e.kind !== "link").map((e, i) => (
            <path key={`u${i}`} d={e.d} stroke={stroke(e)} strokeWidth={1.5} opacity={0.5} />
          ))}
          {edges.filter((e) => e.kind === "link").map((e, i) => (
            <path key={`l${i}`} d={e.d} stroke={c.danger} strokeWidth={2.5} strokeDasharray="6 5" opacity={any && !e.flow ? 0.5 : 1} />
          ))}
          {edges.filter((e) => e.flow && e.kind !== "link").map((e, i) => (
            <path key={`t${i}`} d={e.d} stroke={stroke(e)} strokeWidth={2.5} />
          ))}
        </svg>

        {/* ── Attributes ── */}
        <section style={{ position: "relative", zIndex: 1, display: "grid", gap: 10 }}>
          <BandLabel text="Attributes" sub="yours alone — nothing below can read these" />
          <div style={{ display: "grid", gap: 16 }}>
            {grouped.map(({ family, members }) => {
              const fam = familyStyle(family);
              return (
                <div key={family} style={{ display: "grid", gap: 8 }}>
                  <div style={{ display: "flex", alignItems: "baseline", gap: 8, flexWrap: "wrap" }}>
                    <span style={{ width: 8, height: 8, borderRadius: 999, background: fam.hue, alignSelf: "center", flexShrink: 0 }} />
                    <span style={{ fontSize: t.xs, textTransform: "uppercase", letterSpacing: 0.5, fontWeight: 650 }}>{fam.label}</span>
                    <span style={{ fontSize: t.xs, color: c.faint }}>{fam.note}</span>
                  </div>
                  <div style={{ display: "flex", flexWrap: "wrap", gap: 14 }}>
                    {members.map((f) => {
                      const flow = flowOf(reach, "attribute", f.id);
                      const prov = provenanceWords(f.provenance);
                      const linked = valueLinked.get(f.id);
                      // Expanded means *this* card is the selection — not merely
                      // that something is selected and this one is in its reach.
                      const expanded = flow === "self";
                      const worldOfAttribute = worldsOfAttribute(worlds, f.id)[0];
                      return (
                        <div
                          key={f.id}
                          ref={register(`attribute:${f.id}`)}
                          onClick={() => select({ kind: "attribute", id: f.id })}
                          // The family stripe survives every mood, because which family
                          // a value comes from does not change with what is selected —
                          // and it is the only place a family hue touches a card, so
                          // the border and the pills keep meaning what they meant.
                          style={cardStyle(
                            moodOf(flow, any),
                            {
                              width: expanded ? 268 : undefined,
                              ...(f.stale ? { opacity: any && flow === null ? 0.35 : 0.72 } : {}),
                            },
                            fam.hue,
                          )}
                        >
                          <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
                            {/* The world's hue, and the ONLY place it touches an
                                attribute card — a 6px dot, never the border and
                                never a pill, so selection and status keep the
                                channels they already own. */}
                            {worldOfAttribute && (
                              <span
                                title={`Part of ${worldOfAttribute.name}`}
                                style={{ width: 6, height: 6, borderRadius: 999, background: worldHue(worldOfAttribute.colour), flexShrink: 0 }}
                              />
                            )}
                            <span style={{ fontFamily: font.mono, fontSize: t.xs, color: expanded ? c.muted : c.text, whiteSpace: "nowrap" }}>{f.type}</span>
                            {!expanded && (
                              // Collapsed, a card says what *kind* of answer it
                              // holds, never the answer. Thirteen values drawn
                              // before anyone asked for one is both the density
                              // complaint and a shoulder-surfing surface.
                              <span style={{ fontSize: t.xs, color: c.faint, whiteSpace: "nowrap" }}>
                                {collapsedStatus(registry, f)}
                              </span>
                            )}
                            {f.stale && <Pill tone="warn">{staleWords(f.staleReason)}</Pill>}
                            {!expanded && linked && (
                              <Pill tone="danger">{linked.finding.severity === "high" ? "links" : "may link"}</Pill>
                            )}
                          </div>
                          {expanded && (
                            <>
                              {/* The label and the value are two spans rather than one
                                  string, because the value now carries a control of its
                                  own — and a *Show* that scrolled out of a card clipped to
                                  one line would be a control nobody could press. */}
                              <div style={{ display: "flex", alignItems: "baseline", gap: 5, minWidth: 0, fontSize: t.base, fontWeight: 600 }}>
                                {/* The label steps aside when the agent sent no
                                    value. "Singapore · with your agent" does not
                                    fit a narrow card and truncated to "Singapore ·
                                    with y…", losing the half that says what to do
                                    about it. The label is the holder's own note and
                                    the type above already names the attribute, so
                                    on a card holding nothing the sentence that
                                    matters is the one about where the value is. It
                                    returns the moment the value does. */}
                                {f.value !== undefined && labelSaysSomethingElse(f.label, f.value) && (
                                  <span style={{ color: c.muted, whiteSpace: "nowrap", flexShrink: 0 }}>{f.label} ·</span>
                                )}
                                <AttributeValue registry={registry}
                                  type={f.type}
                                  value={f.value}
                                  sensitivity={f.sensitivity}
                                  reveal={() => onReveal({ attributeId: f.id, type: f.type })}
                                  style={{ minWidth: 0, overflow: "hidden" }}
                                  textStyle={{ whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis" }}
                                />
                              </div>
                              <div style={{ display: "flex", gap: 6, alignItems: "center", flexWrap: "wrap" }}>
                                <Pill tone={prov.tone}>{prov.text}</Pill>
                                {/* Not a property of the value — a property of its
                                    *type*, which the agent declined to apply. Said
                                    here because this is the card whose masking is
                                    wrong as a result, and a banner at the top of a
                                    long page is easy to scroll past on the way to
                                    the thing it is about. */}
                                {unapplied.has(f.type) && <Pill tone="danger">type not applied</Pill>}
                                {/* Severity only. The crossing is the OTHER axis and does not
                                    belong in this channel: two pills side by side
                                    read as one scale, and "links" is about how
                                    strongly, not about whether the holder minds.
                                    The strip and the summary carry the crossing. */}
                                {linked && (
                                  <Pill tone="danger">
                                    {linked.finding.severity === "high" ? "links" : "may link"}
                                  </Pill>
                                )}
                              </div>
                            </>
                          )}
                        </div>
                      );
                    })}
                  </div>
                </div>
              );
            })}
            <div style={{ display: "flex" }}>
              <AddTile label="+ Add an attribute" onClick={(e) => setEditing({ kind: "attribute", anchor: e.currentTarget })} disabled={null} />
            </div>
          </div>
        </section>

        {/* ── Worlds & faces ──
            The faces band is grouped by world rather than laid out flat, and
            the separate Worlds screen is gone: a grouping you cannot see beside
            the things it groups is a list of names, and arranging faces on one
            screen while looking at them on another is the same act done twice.
            A world's hue lives on the bubble's GROUND — a surface that did not
            exist before — so the three channels a card already spends (border
            for selection and reach, stripe for family, pills for status) are
            untouched. */}
        <section style={{ position: "relative", zIndex: 1, display: "grid", gap: 10 }}>
          <BandLabel
            text="Worlds & faces"
            sub="the parts of your life, and the faces that belong to them — drag a face to move it"
          />
          <div style={{ display: "flex", flexWrap: "wrap", gap: 14, alignItems: "flex-start" }}>
            {worlds.map((world) => (
              <WorldBubble
                key={world.facetId}
                world={world}
                faces={graph.faces.filter((f) => worldOfFace(worlds, f.id)?.facetId === world.facetId)}
                {...bubbleShared}
              />
            ))}
            {/* Belonging nowhere is a real state and is always drawn, even
                empty. A band that listed only arranged faces would under-report
                what the holder has — the same defect as a context tally that
                omits a standing. */}
            <WorldBubble
              key="__unplaced"
              world={null}
              faces={graph.faces.filter((f) => !worldOfFace(worlds, f.id))}
              {...bubbleShared}
            />
            <AddTile
              label="+ New world"
              onClick={(e) => setWorldEditing({ anchor: e.currentTarget })}
              disabled={denied}
            />
            <AddTile
              label="+ New face"
              onClick={(e) => setEditing({ kind: "face", anchor: e.currentTarget })}
              disabled={graph.attributes.length === 0 ? "Add an attribute first — a face is a selection over attributes." : null}
            />
          </div>
          {moveError && <Note tone="danger">{moveError}</Note>}
        </section>

        {/* ── The line ── */}
        <div style={{ position: "relative", zIndex: 1, height: 1, borderTop: `1px dashed ${c.faint}`, margin: "4px 0" }}>
          <span style={{ position: "absolute", right: 0, top: -12, display: "inline-flex", alignItems: "center", gap: 7, padding: "3px 10px", borderRadius: 999, background: c.ground, border: `1px solid ${c.line}`, fontSize: t.xs, color: c.muted, fontWeight: 600 }}>
            <svg width="12" height="12" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth={1.6} strokeLinecap="round" strokeLinejoin="round"><path d="M8 2v11M3.5 8.5 8 13l4.5-4.5" /></svg>
            Copies go down. Nothing reads up.
          </span>
        </div>

        {/* ── Contexts ── */}
        <section style={{ position: "relative", zIndex: 1, display: "grid", gap: 10 }}>
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
          {presentContexts.length === 0 && !showEmpty && (
            <div style={{ fontSize: t.sm, color: c.faint, lineHeight: 1.55, padding: "6px 0" }}>
              You are not known anywhere yet. Nothing below the line holds a copy of anything.
            </div>
          )}
          <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fill, minmax(300px, 1fr))", gap: 14 }}>
            {shownContexts.map((ctx) => {
              const standing = standingOf(ctx);
              return (
                <div
                  key={ctx.id}
                  onClick={() => select({ kind: "context", id: ctx.id })}
                  style={cardStyle(moodOf(flowOf(reach, "context", ctx.id), any), { padding: "12px 14px", gap: 10, minHeight: 120 })}
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
                  ) : standing === "absent" ? (
                    <span style={{ fontSize: t.sm, color: c.faint }}>Nobody yet. This context knows nothing about you.</span>
                  ) : (
                    <div style={{ display: "grid", gap: 6 }}>
                      {/* Two headings, because they are two different answers.
                          A persona that wears nothing is still a persona: the
                          context knows an identifier of the holder's and can
                          address it, while holding none of their attributes.
                          Calling that "known here as" overstates what left, and
                          folding it in with the contexts that hold nothing
                          hides an identifier the holder has out there. */}
                      <span style={{ fontSize: t.xs, color: c.faint, textTransform: "uppercase", letterSpacing: 0.4 }}>
                        {standing === "identified" ? "An identifier only" : "Known here as"}
                      </span>
                      {ctx.personas.map((p) => {
                        const key = personaKey(ctx.id, p.did);
                        const pFlow = flowOf(reach, "persona", key);
                        // Same hierarchy as the cards: reached is a wash, and
                        // only the selection wears a ring. This row is the one
                        // a person clicks most — it is what "who am I in this
                        // context" is asked of — so it is the one that most
                        // needs to look pressed.
                        const wash = pFlow === "self" ? c.accentSoft : pFlow ? FLOW_COLOUR[pFlow].wash : c.raised;
                        const edge = pFlow === "self" ? c.accent : c.line;
                        const ring = pFlow === "self" ? `0 0 0 2px ${c.ground}, 0 0 0 5px ${c.accent}` : undefined;
                        const linked = showLinks && p.faceId !== null && linkedFaces.has(p.faceId);
                        return (
                          <div
                            key={p.did}
                            ref={register(`persona:${key}`)}
                            onClick={(e) => {
                              e.stopPropagation();
                              select({ kind: "persona", contextId: ctx.id, did: p.did });
                            }}
                            style={{ display: "grid", gap: 3, padding: "6px 8px", borderRadius: "var(--w-r-sm)", background: wash, border: `${pFlow === "self" ? 2 : 1}px solid ${edge}`, ...(ring ? { boxShadow: ring } : {}), cursor: "pointer" }}
                          >
                            <div style={{ display: "flex", alignItems: "center", gap: 8, flexWrap: "wrap" }}>
                              <span style={{ fontSize: t.sm, fontWeight: 640 }}>{personaLabel(p.did)}</span>
                              {p.faceId ? (
                                <span style={{ fontSize: t.sm, color: c.muted }}>wears <strong style={{ color: c.text }}>{p.faceName ?? "a face"}</strong> · {p.claimCount} attribute{p.claimCount === 1 ? "" : "s"}</span>
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
                  {standing === "identified" && (
                    <span style={{ fontSize: t.sm, color: c.muted }}>
                      This context can address that identifier. It holds nothing else of yours.
                    </span>
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
                      onClick={(e) =>
                        setEditing({
                          kind: "bind",
                          contextId: ctx.id,
                          anchor: e.currentTarget,
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
                  onClick={(e) => setEditing({ kind: "bind", contextId: null, anchor: e.currentTarget })}
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
        <DetailStrip registry={registry}
          parties={parties}
          authority={authority}
          graph={graph}
          selection={selection}
          attributes={attributes}
          profiles={profiles}
          records={records}
          history={history}
          onReveal={onReveal}
          finding={selection.kind === "attribute" ? (valueLinked.get(selection.id) ?? null) : null}
          showing={showing}
          onShow={setShowing}
          onEdit={setEditing}
          onChanged={() => {
            setSelection(null);
            onChanged();
          }}
        />
      )}

      {/* ── Editors ──
          Every one of these opens as a popover against the control that
          summoned it. They used to render right here, at the end of the JSX,
          which put the first field of an "Add an attribute" form roughly 1700px
          down a 2450px scroller whose scrollTop never moved — so the commonest
          action on this screen appeared to do nothing at all. See
          `popover.tsx`. */}
      {editing?.kind === "attribute" && (
        <Popover
          anchor={{ current: editing.anchor }}
          onClose={() => setEditing(null)}
          title={editing.existing ? "Edit attribute" : "Add an attribute"}
        >
          <AttributeEditor registry={registry}
            key={editing.existing?.attributeId ?? "new"}
            parties={parties}
            authority={authority}
            {...(editing.existing ? { existing: editing.existing } : {})}
            onDone={done}
            onCancel={() => setEditing(null)}
          />
        </Popover>
      )}
      {editing?.kind === "face" && (
        <Popover
          anchor={{ current: editing.anchor }}
          onClose={() => setEditing(null)}
          title={editing.existing ? "Edit face" : "New face"}
          width={460}
        >
          <ProfileEditor
            key={editing.existing?.profileId ?? "new"}
            parties={parties}
            authority={authority}
            attributes={attributes}
            {...(editing.existing ? { existing: editing.existing } : {})}
            onDone={done}
            onCancel={() => setEditing(null)}
          />
        </Popover>
      )}
      {editing?.kind === "bind" && editing.contextId === null && (
        <Popover
          anchor={{ current: editing.anchor }}
          onClose={() => setEditing(null)}
          title="Where?"
        >
          <ChooseContext
            contexts={emptyContexts.length > 0 ? emptyContexts : graph.contexts}
            onChoose={(contextId) => setEditing({ kind: "bind", contextId, anchor: editing.anchor })}
            onCancel={() => setEditing(null)}
          />
        </Popover>
      )}
      {worldEditing && (
        <Popover
          anchor={{ current: worldEditing.anchor }}
          onClose={() => setWorldEditing(null)}
          title={worldEditing.existing ? "Edit world" : "A new part of your life"}
          width={470}
        >
          <WorldEditor
            key={worldEditing.existing?.facetId ?? "new"}
            parties={parties}
            authority={authority}
            {...(worldEditing.existing ? { existing: worldEditing.existing } : {})}
            faces={profiles}
            attributes={attributes}
            registry={registry}
            worlds={worlds}
            onDone={() => {
              setWorldEditing(null);
              onChanged();
            }}
            onCancel={() => setWorldEditing(null)}
          />
        </Popover>
      )}
      {editing?.kind === "bind" && editing.contextId !== null && (
        <Popover
          anchor={{ current: editing.anchor }}
          onClose={() => setEditing(null)}
          title="Be known here"
          width={460}
        >
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
        </Popover>
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
  registry,
  records,
  history,
  finding,
  showing,
  onReveal,
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
  /** The agent's claim-type table, or `null` while it loads. A caller must not
   *  substitute a compiled-in one — that is the copy this replaced. */
  registry: ClaimTypeRegistry | null;

  records: ContextRecord[];
  history: DisclosureRecord[] | null;
  /** The finding for the selected attribute, ranked against the holder's
   *  worlds — `crossing` is the second axis and is never read off `severity`. */
  finding: RankedFinding | null;
  showing: "claims" | null;
  onReveal: (target: RevealTarget) => Promise<unknown>;
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

  if (selection.kind === "attribute") {
    const attribute = graph.attributes.find((f) => f.id === selection.id);
    const raw = attributes.find((a) => a.attributeId === selection.id);
    if (!attribute || !raw) return null;
    const reach = attributeReach(graph, attribute.id);
    const linkedFaces = reach.faces.filter((f) => graph.links.some((l) => l.faceId === f.id));
    const prov = provenanceWords(attribute.provenance);
    return strip(
      <>
        <div style={{ display: "grid", gridTemplateColumns: "minmax(200px, 260px) minmax(0, 1fr) minmax(0, 1fr)", gap: 18 }}>
          <div style={{ display: "grid", gap: 3 }}>
            {/* The type names what the strip is about; the VALUE is not
                repeated here.
                The selected card expands in place and renders it, and two
                `AttributeValue`s for one attribute means two *Show* buttons,
                two reveal states and two things to keep in step — the second of
                which is always the one that stops being updated. The strip's
                job is what the card has no room for: what the mask means, what
                the holder decided, where it reaches, when it last left. */}
            <span style={{ fontFamily: font.mono, fontSize: t.md, fontWeight: 640 }}>{attribute.type}</span>
            <span style={{ fontSize: t.sm, color: c.faint }}>
              {attribute.label ? `${attribute.label} · ` : ""}{prov.text}
              {attribute.provenance.kind === "credentialBacked" ? " — provable, and the same signature to everyone who sees it" : attribute.provenance.kind === "selfAsserted" ? " — passed on, never proven" : ""}
            </span>
            {/* The one place with room to say what the mask is and is not —
                and the two cases are not the same sentence. A value the agent
                sent is being kept off the screen and nothing more. A value it
                withheld is not in this page at all, and *Show* is the request
                for it. Saying the first about the second is what the strip did
                before, and it was the one claim it must never make wrongly. */}
            {isSensitiveFor(registry, attribute.type, attribute.sensitivity) && (
              <span style={{ fontSize: t.sm, color: c.faint }}>
                {attribute.value === undefined
                  ? "Your agent has not sent this value to this page. Show asks it for this one."
                  : "Hidden until you press Show — that is about who can see your screen. Your agent has already sent this value here."}
              </span>
            )}
            {/* Whose answer this is. Absent means the registry's, and saying
                "you decided" over the registry's answer would be the console
                putting words in the holder's mouth about their own data. */}
            {(attribute.sensitivity || attribute.release) && (
              <span style={{ fontSize: t.sm, color: c.muted }}>
                You decided:{" "}
                {[
                  attribute.sensitivity === "high"
                    ? "kept back until you ask"
                    : attribute.sensitivity === "normal"
                      ? "shown"
                      : null,
                  attribute.release === "stepUp"
                    ? "approved again every time it leaves"
                    : attribute.release === "consent"
                      ? "approved once before it leaves"
                      : null,
                ]
                  .filter(Boolean)
                  .join(" · ")}
              </span>
            )}
            {attribute.stale && <span style={{ fontSize: t.sm, color: c.warn }}>Can no longer be proven ({attribute.staleReason ?? "stale"}).</span>}
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
              {finding && (
                <>
                  <span style={{ color: c.danger }}>{finding.finding.why}</span>
                  {/* The second axis, where the agent answered it. Silent on
                      `unknown`: the summary says that once rather than putting
                      a claim on every row. */}
                  {crossingWords(finding) && (
                    <span style={{ color: finding.crossing === "crosses" ? c.danger : c.muted }}>
                      {crossingWords(finding)}
                    </span>
                  )}
                </>
              )}
            </>
          ))}
          {col("Last left", lastLeft((d) => d.claimTypes.includes(attribute.type)))}
        </div>
        <div style={{ display: "flex", gap: 6, flexWrap: "wrap" }}>
          <Button kind="quiet" onClick={(e) => onEdit({ kind: "attribute", existing: raw, anchor: e.currentTarget })}>Edit</Button>
          <Destructive<PoolProfile[]>
            label="Delete"
            preview={async () => {
              // Asked again rather than read off the map, so the answer is
              // current at the moment of the decision.
              const current = await personaProfileList(managerSender, parties);
              return current.filter((p) => p.entries.some((e) => "ref" in e && e.ref === attribute.id));
            }}
            renderPreview={(faces) => (
              <>
                <strong>Deleting an attribute cannot be undone.</strong>
                <span style={{ fontFamily: font.mono, fontSize: t.xs }}>{attribute.type}</span>
                {faces.length === 0 ? (
                  <span>No face shows it, so nothing stops showing anything.</span>
                ) : (
                  <>
                    <span>{faces.length} face(s) show it and will stop: {faces.map((f) => f.name).join(", ")}</span>
                    <span>Every persona wearing one of those shows one attribute fewer from the next hand-over onwards. Nothing already shared is affected — that has left.</span>
                  </>
                )}
              </>
            )}
            needsForce={(faces) => faces.length > 0}
            forceLabel="Remove it from those faces too"
            commit={async (force) => {
              await personaAttributeDelete(managerSender, { ...parties, attributeId: attribute.id, cascade: force });
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
              shows {face.entries.length} attribute{face.entries.length === 1 ? "" : "s"}{face.preserved > 0 ? ` (${face.preserved} pinned, shown differently, or only here)` : ""}
            </span>
          </div>
          {col("Worn by", wearers.length === 0 ? (
            <span>Nobody yet. No context receives these attributes.</span>
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
          <Button kind="quiet" onClick={(e) => onEdit({ kind: "face", existing: raw, anchor: e.currentTarget })}>Edit</Button>
          <DeleteProfile parties={parties} profile={raw} onDone={onChanged} />
        </div>
        {showing === "claims" && (
          <ResolvedProfile registry={registry} parties={parties} profileId={face.id} name={face.name} pool={attributes} />
        )}
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
                a copy of <strong style={{ color: c.text }}>{p.faceName ?? "a face"}</strong>, worn by {personaLabel(p.did)} · {p.claimCount} attribute{p.claimCount === 1 ? "" : "s"}
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
            onClick={(e) => onEdit({ kind: "bind", contextId: ctx.id, anchor: e.currentTarget })}
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
            <span><strong style={{ color: c.text }}>{p.faceName ?? "a face"}</strong> · {p.claimCount} attribute{p.claimCount === 1 ? "" : "s"} copied into this context</span>
            {link && (
              <span style={{ color: c.danger }}>
                {link.wearers.filter((w) => !(w.did === p.did && w.contextId === p.contextId)).map((w) => `${personaLabel(w.did)} in ${labelOf(w.contextId)}`).join(", ")} wear{link.wearers.length === 2 ? "s" : ""} the same face — same person to anyone who sees both.
              </span>
            )}
          </>
        ) : (
          <span>Nothing. This persona is known here but shows no attributes.</span>
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
          onClick={(e) => onEdit({ kind: "bind", contextId: ctx.id, personaDid: p.did, anchor: e.currentTarget })}
        >
          {p.faceId ? "Change face" : "Put on a face"}
        </Button>
      </div>
      {showing === "claims" && p.faceId && (
        <PersonaClaims
          registry={registry}
          parties={parties}
          contextId={ctx.id}
          personaDid={p.did}
          profileName={p.faceName ?? "this face"}
          pool={attributes}
        />
      )}
    </>,
  );
}
