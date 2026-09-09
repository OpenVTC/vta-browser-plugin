// Worlds — the parts of a life, and the faces that belong to them.
//
// A holder who uses this model for a while does not end up with three faces.
// They end up with twenty, and a flat list of twenty is a list nobody reads.
// A world is the arrangement over them: *Work*, *Home*, *Play*.
//
// ## What this screen must never imply
//
// **A world is an arrangement, not a container**, and the delete copy is where
// that is either said or quietly denied. Deleting *Work* deletes the word and
// the statement about what belonged to it; every face and attribute survives
// untouched. The intuitive reading is the other one — a grouping that looks
// like a folder is assumed to behave like one — so the confirm names what
// survives rather than only what goes, and `releasedFaces` from the agent's own
// answer is what it counts. There is no cascade to offer and none is offered.
//
// ## A face belongs to one world, and the refusal is actionable
//
// The agent refuses `persona/facet/put` when a face already belongs elsewhere,
// with `persona/facet/put:faceAlreadyPlaced` — and the details name the world
// already holding it. That is the whole reason the code exists: told only that
// the write failed, this pane could do nothing but send the holder off to find
// where the face is. Told which world, it offers to move it.
//
// ## Words
//
// **World**, and a face **belongs to** one. Never "facet", never "group", never
// "tag" or "assign" — see `design-docs/persona-vocabulary.md`. The wire keeps
// the specification's word; this screen does not.

import { useCallback, useMemo, useState } from "react";
import {
  personaFacetPut,
  personaFacetDelete,
  type PoolFacet,
  type PoolProfile,
  type PoolAttribute,
  type FacetColour,
} from "@openvtc/pnm-core/admin";
import { Button, Note, Panel } from "../../ui.js";
import { c, t, font } from "../../theme.js";
import { managerSender } from "../sender.js";
import { Destructive } from "../destructive.js";
import { holderGate } from "../holder-gate.js";
import type { Authority, Parties } from "../use-vta.js";
import { WORLD_COLOURS, worldHue, worldColourName } from "../world-colour.js";
import { placedElsewhere, worldOfFace, unplacedFaces, type Placement } from "../world-model.js";
import { groupRows } from "../attribute-list.js";
import type { ClaimTypeRegistry } from "@openvtc/pnm-core/persona";

function Swatch({
  colour,
  selected,
  onPick,
}: {
  colour: FacetColour;
  selected: boolean;
  onPick: () => void;
}) {
  return (
    <button
      type="button"
      onClick={onPick}
      aria-label={worldColourName(colour)}
      aria-pressed={selected}
      title={worldColourName(colour)}
      style={{
        width: 26,
        height: 26,
        borderRadius: 999,
        background: worldHue(colour),
        cursor: "pointer",
        // Selection is a ring in the neutral line colour, never a second hue:
        // the swatch's own colour is the only thing it is saying.
        border: selected ? `2px solid ${c.text}` : `1px solid ${c.line}`,
        boxShadow: selected ? `0 0 0 2px ${c.surface}` : "none",
        padding: 0,
      }}
    />
  );
}

/** The mark beside a world's name, wherever one is drawn. */
export function WorldChip({ facet }: { facet: PoolFacet }) {
  return (
    <span style={{ display: "inline-flex", alignItems: "center", gap: 7, minWidth: 0 }}>
      <span
        aria-hidden="true"
        style={{
          width: 10,
          height: 10,
          borderRadius: 999,
          background: worldHue(facet.colour as FacetColour),
          flex: "0 0 auto",
        }}
      />
      {facet.icon && <span aria-hidden="true">{facet.icon}</span>}
      <span style={{ fontSize: t.sm, fontWeight: 600, color: c.text, overflow: "hidden", textOverflow: "ellipsis" }}>
        {facet.name}
      </span>
    </span>
  );
}

function WorldEditor({
  parties,
  authority,
  existing,
  faces,
  attributes,
  registry,
  worlds,
  onDone,
  onCancel,
}: {
  parties: Parties;
  authority: Authority | null;
  existing?: PoolFacet;
  faces: readonly PoolProfile[];
  attributes: readonly PoolAttribute[];
  registry: ClaimTypeRegistry | null;
  worlds: readonly PoolFacet[];
  onDone: () => void;
  onCancel: () => void;
}) {
  const [name, setName] = useState(existing?.name ?? "");
  const [colour, setColour] = useState<FacetColour>((existing?.colour as FacetColour) ?? "slate");
  const [icon, setIcon] = useState(existing?.icon ?? "");
  // Seeded from what was loaded. A put REPLACES both lists, so an editor that
  // opened with an empty selection and saved would silently empty the world's
  // membership on an edit that meant to rename it.
  const [chosen, setChosen] = useState<Set<string>>(new Set(existing?.faceIds ?? []));
  // Same seeding rule, same reason: a put replaces this list too.
  const [chosenAttrs, setChosenAttrs] = useState<Set<string>>(
    new Set(existing?.attributeIds ?? []),
  );
  const [busy, setBusy] = useState(false);
  const [conflict, setConflict] = useState<Placement[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const denied = holderGate(authority);

  const save = useCallback(async () => {
    setBusy(true);
    setError(null);
    setConflict(null);
    try {
      await personaFacetPut(managerSender, {
        ...parties,
        ...(existing ? { facetId: existing.facetId, expectedVersion: existing.version } : {}),
        name: name.trim(),
        colour,
        ...(icon.trim() ? { icon: icon.trim() } : {}),
        faceIds: [...chosen],
        attributeIds: [...chosenAttrs],
      });
      onDone();
    } catch (e) {
      // The refusal that has somewhere to go. `faceAlreadyPlaced` carries the
      // world already holding each face, so this offers to move rather than
      // printing a failure and leaving the holder to search.
      const placed = placedElsewhere(e);
      if (placed) setConflict(placed);
      else setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  }, [parties, existing, name, colour, icon, chosen, chosenAttrs, onDone]);

  const toggle = (id: string) =>
    setChosen((current) => {
      const next = new Set(current);
      if (!next.delete(id)) next.add(id);
      return next;
    });

  const toggleAttr = (id: string) =>
    setChosenAttrs((current) => {
      const next = new Set(current);
      if (!next.delete(id)) next.add(id);
      return next;
    });

  // Grouped by the families the map and the list already use, rather than a
  // flat column of thirty. Same grouping, one definition — two arrangements of
  // one pool that disagree is the defect where a person counts six in one place
  // and five in another.
  const attributeGroups = groupRows(
    attributes.map((a) => ({
      id: a.attributeId,
      type: a.type,
      label: a.label,
      value: a.value,
      provenance: a.provenance,
      stale: Boolean(a.stale),
      version: a.version,
    })) as never,
    registry,
  );

  return (
    <Panel title={existing ? `Edit ${existing.name}` : "A new part of your life"}>
      {denied && <Note tone="warn">{denied}</Note>}
      <div style={{ display: "grid", gap: 12 }}>
        <label style={{ display: "grid", gap: 4 }}>
          <span style={{ fontSize: t.sm, color: c.text }}>What do you call it?</span>
          <input
            value={name}
            aria-label="What do you call it?"
            placeholder="Work"
            onChange={(e) => setName(e.target.value)}
            style={{
              background: c.surface,
              color: c.text,
              border: `1px solid ${c.line}`,
              borderRadius: "var(--w-r-sm)",
              padding: "7px 9px",
              fontSize: t.sm,
              fontFamily: font.sans,
            }}
          />
        </label>

        <div style={{ display: "grid", gap: 6 }}>
          <span style={{ fontSize: t.sm, color: c.text }}>Colour</span>
          <div style={{ display: "flex", gap: 8, flexWrap: "wrap" }}>
            {WORLD_COLOURS.map((w) => (
              <Swatch key={w} colour={w} selected={w === colour} onPick={() => setColour(w)} />
            ))}
          </div>
        </div>

        <label style={{ display: "grid", gap: 4, maxWidth: 160 }}>
          <span style={{ fontSize: t.sm, color: c.text }}>A mark (optional)</span>
          <input
            value={icon}
            aria-label="A mark (optional)"
            placeholder="💼"
            maxLength={4}
            onChange={(e) => setIcon(e.target.value)}
            style={{
              background: c.surface,
              color: c.text,
              border: `1px solid ${c.line}`,
              borderRadius: "var(--w-r-sm)",
              padding: "7px 9px",
              fontSize: t.sm,
            }}
          />
        </label>

        <div style={{ display: "grid", gap: 6 }}>
          <span style={{ fontSize: t.sm, color: c.text }}>Which faces belong to it?</span>
          {faces.length === 0 ? (
            <span style={{ fontSize: t.sm, color: c.faint }}>
              You have no faces yet. A world can wait until you do.
            </span>
          ) : (
            faces.map((f) => {
              const elsewhere = worldOfFace(worlds, f.profileId, existing?.facetId);
              return (
                <label
                  key={f.profileId}
                  style={{ display: "flex", alignItems: "center", gap: 9, fontSize: t.sm }}
                >
                  <input
                    type="checkbox"
                    checked={chosen.has(f.profileId)}
                    disabled={Boolean(elsewhere)}
                    aria-label={f.name}
                    onChange={() => toggle(f.profileId)}
                    style={{ accentColor: c.accent, width: 15, height: 15 }}
                  />
                  <span style={{ color: elsewhere ? c.faint : c.text }}>{f.name}</span>
                  {elsewhere && (
                    // Said before the save rather than after. A checkbox that
                    // looked available and then failed is a refusal the holder
                    // had no way to anticipate.
                    <span style={{ fontSize: t.xs, color: c.faint }}>
                      already belongs to {elsewhere.name}
                    </span>
                  )}
                </label>
              );
            })
          )}
        </div>

        <div style={{ display: "grid", gap: 8 }}>
          <span style={{ fontSize: t.sm, color: c.text }}>Which attributes belong to it?</span>
          {/* No exclusivity here, and none is implied: an attribute may belong
              to several worlds, because a mobile number is genuinely part of a
              working life and a home one at once. */}
          <span style={{ fontSize: t.xs, color: c.faint }}>
            An attribute can belong to more than one — your mobile is probably in both.
          </span>
          {attributeGroups.length === 0 ? (
            <span style={{ fontSize: t.sm, color: c.faint }}>You have no attributes yet.</span>
          ) : (
            attributeGroups.map((g) => (
              <div key={g.family} style={{ display: "grid", gap: 4 }}>
                <span style={{ fontSize: t.xs, color: c.faint, display: "flex", alignItems: "center", gap: 6 }}>
                  <span
                    aria-hidden="true"
                    style={{ width: 3, height: 11, background: g.style.hue, borderRadius: 2 }}
                  />
                  {g.style.label}
                </span>
                {g.rows.map((row) => (
                  <label
                    key={row.id}
                    style={{ display: "flex", alignItems: "center", gap: 9, fontSize: t.sm, paddingLeft: 9 }}
                  >
                    <input
                      type="checkbox"
                      checked={chosenAttrs.has(row.id)}
                      aria-label={row.label ?? row.type}
                      onChange={() => toggleAttr(row.id)}
                      style={{ accentColor: c.accent, width: 15, height: 15 }}
                    />
                    <code style={{ fontFamily: font.mono, fontSize: t.xs, color: c.muted }}>
                      {row.type}
                    </code>
                    {row.label && <span style={{ color: c.faint, fontSize: t.xs }}>{row.label}</span>}
                  </label>
                ))}
              </div>
            ))
          )}
        </div>

        {conflict && (
          <Note tone="warn">
            {conflict.length === 1
              ? "That face already belongs to another world."
              : `${conflict.length} of those faces already belong to another world.`}{" "}
            A face belongs to one world at a time — untick it here, or take it out of the other
            world first.
          </Note>
        )}
        {error && <Note tone="danger">{error}</Note>}

        <div style={{ display: "flex", gap: 10 }}>
          <Button
            kind="primary"
            disabled={name.trim() === "" || busy || Boolean(denied)}
            onClick={() => void save()}
          >
            {busy ? "Saving…" : existing ? "Save" : "Create"}
          </Button>
          <Button kind="quiet" onClick={onCancel}>
            Cancel
          </Button>
        </div>
      </div>
    </Panel>
  );
}

export function WorldsPane({
  parties,
  authority,
  worlds,
  faces,
  attributes,
  registry,
  onChanged,
}: {
  parties: Parties;
  authority: Authority | null;
  worlds: readonly PoolFacet[];
  faces: readonly PoolProfile[];
  attributes: readonly PoolAttribute[];
  registry: ClaimTypeRegistry | null;
  onChanged: () => void;
}) {
  const [editing, setEditing] = useState<string | null>(null);
  const [creating, setCreating] = useState(false);
  const denied = holderGate(authority);
  const loose = useMemo(() => unplacedFaces(worlds, faces), [worlds, faces]);

  const target = worlds.find((w) => w.facetId === editing);

  if (creating || target) {
    return (
      <WorldEditor
        // Keyed on the record: the editor seeds state from its props, which run
        // on mount and never again, so an unkeyed second open shows the first
        // world's name and colour — and a put replaces.
        key={target?.facetId ?? "new"}
        parties={parties}
        authority={authority}
        {...(target ? { existing: target } : {})}
        faces={faces}
        attributes={attributes}
        registry={registry}
        worlds={worlds}
        onDone={() => {
          setEditing(null);
          setCreating(false);
          onChanged();
        }}
        onCancel={() => {
          setEditing(null);
          setCreating(false);
        }}
      />
    );
  }

  return (
    <div style={{ display: "grid", gap: 14, alignContent: "start" }}>
      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", gap: 12 }}>
        <div style={{ display: "grid", gap: 3 }}>
          <span style={{ fontSize: t.md, fontWeight: 640, color: c.text }}>Your worlds</span>
          <span style={{ fontSize: t.sm, color: c.muted }}>
            A part of your life, and the faces that belong to it. Keep your worlds apart.
          </span>
        </div>
        <Button
          kind="primary"
          disabled={Boolean(denied)}
          {...(denied ? { title: denied } : {})}
          onClick={() => setCreating(true)}
        >
          New world
        </Button>
      </div>

      {worlds.length === 0 ? (
        <Note tone="accent">
          You have no worlds yet. Most people start with two — the part of life they work in, and
          the part they do not.
        </Note>
      ) : (
        worlds.map((w) => {
          const members = faces.filter((f) => w.faceIds?.includes(f.profileId));
          return (
            <div
              key={w.facetId}
              style={{
                border: `1px solid ${c.line}`,
                borderRadius: "var(--w-r-md)",
                padding: "12px 14px",
                display: "grid",
                gap: 8,
              }}
            >
              <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", gap: 12 }}>
                <WorldChip facet={w} />
                <div style={{ display: "flex", gap: 8 }}>
                  <Button kind="quiet" onClick={() => setEditing(w.facetId)}>
                    Edit
                  </Button>
                  <Destructive<{ released: number; names: string[] }>
                    label="Delete"
                    disabledReason={denied}
                    preview={async () => ({
                      released: members.length,
                      names: members.map((f) => f.name),
                    })}
                    renderPreview={(p) => (
                      <div style={{ fontSize: t.sm, color: c.text, display: "grid", gap: 6 }}>
                        <div>
                          <strong>{w.name}</strong> stops being a part of your life on this screen.
                        </div>
                        {/* The sentence that decides whether this reads as a
                            folder. Said first, and said even when nothing
                            belongs to it. */}
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
                        facetId: w.facetId,
                        expectedVersion: w.version,
                      });
                    }}
                    onDone={onChanged}
                  />
                </div>
              </div>
              <div style={{ fontSize: t.sm, color: c.muted }}>
                {members.length === 0
                  ? "No faces belong to it yet."
                  : members.map((f) => f.name).join(" · ")}
              </div>
              {(w.attributeIds?.length ?? 0) > 0 && (
                <div style={{ fontSize: t.xs, color: c.faint }}>
                  {w.attributeIds!.length} attribute
                  {w.attributeIds!.length === 1 ? "" : "s"} belong
                  {w.attributeIds!.length === 1 ? "s" : ""} to it
                </div>
              )}
            </div>
          );
        })
      )}

      {worlds.length > 0 && loose.length > 0 && (
        <Note tone="accent">
          {loose.length === 1 ? "One face belongs" : `${loose.length} faces belong`} to no world:{" "}
          {loose.map((f) => f.name).join(", ")}. That is a fine place for{" "}
          {loose.length === 1 ? "it" : "them"} to stay.
        </Note>
      )}
    </div>
  );
}
