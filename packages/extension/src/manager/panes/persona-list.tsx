// The list view: the same attributes as the map, in the shape you tidy in.
//
// ## Why this exists beside the map
//
// The map's subject is reach — what one selection touches — so it draws one
// selection at a time and answers a question about it. That is the right
// picture and the wrong tool for the job a holder actually arrives with once
// the pool is large: *delete these four stale numbers, put these six into a new
// face*. Doing that on the map is opening, reading and confirming one card at a
// time, and no amount of layout fixes it, because one-at-a-time is what the map
// is for.
//
// So this is a second view over the same graph — same `AttributeNode`s, same
// families, same words (`attribute-words.ts`), no new wire records — with a
// selection that is a *set*. Everything interesting about it is in
// `attribute-list.ts` and tested there; this file draws.
//
// ## What it will not do
//
// There is no bulk visibility action, and its absence is deliberate enough to
// be printed on the screen. `persona/attribute/put` is a replace, and this pane
// lists without `includeSensitive` on purpose, so an attribute resolving to
// `sensitivity: high` is in hand with `value: undefined`. Writing a bulk
// visibility change through `put` would send an empty value for every sensitive
// row and blank it — silently, with no `attribute/get` and no version history
// to restore from. `whyNoBulkVisibility()` says so where someone would
// otherwise wonder why the button is missing.
//
// ## Delete asks the second question first
//
// The agent refuses to delete an attribute a face still references unless
// `cascade` is set. Sending twelve and discovering five of them are in use is
// five refusals after seven irreversible successes, so the preview counts them
// before anything is sent and `cascade` rides on `Destructive`'s `force` tick —
// which is exactly what that tick is for: overriding a refusal the agent makes
// on purpose is its own decision.

import { useCallback, useMemo, useState } from "react";
import { personaAttributeDelete, personaProfilePut } from "@openvtc/pnm-core/admin";
import type { ClaimTypeRegistry } from "@openvtc/pnm-core/persona";
import { Button, Note, Pill } from "../../ui.js";
import { c, t, font } from "../../theme.js";
import { managerSender } from "../sender.js";
import { Destructive } from "../destructive.js";
import type { Parties } from "../use-vta.js";
import type { AttributeNode, FaceNode } from "../identity-graph.js";
import { provenanceWords, labelSaysSomethingElse, staleWords } from "../attribute-words.js";
import {
  groupRows,
  flatOrder,
  toggle,
  selectRange,
  groupState,
  toggleGroup,
  pruneSelection,
  selectedRows,
  previewDelete,
  whyNoBulkVisibility,
  type ListGroup,
  type DeletePreview,
} from "../attribute-list.js";
import { AttributeValue } from "./persona-editors.js";
import type { RevealTarget } from "../reveal-value.js";

/**
 * A checkbox with a third state.
 *
 * `indeterminate` is a DOM property and not an attribute, so React cannot set
 * it from JSX — it has to go through a ref callback. Without it a partly
 * selected family draws an empty box, which says "none of these are selected"
 * over four rows that are.
 */
function TriCheck({
  state,
  onChange,
  title,
}: {
  state: "none" | "some" | "all";
  onChange: () => void;
  title: string;
}) {
  return (
    <input
      type="checkbox"
      checked={state === "all"}
      title={title}
      aria-label={title}
      ref={(el) => {
        if (el) el.indeterminate = state === "some";
      }}
      onChange={onChange}
      style={{ cursor: "pointer", accentColor: c.accent, width: 15, height: 15, flex: "0 0 auto" }}
    />
  );
}

function Row({
  attribute,
  selected,
  registry,
  reveal,
  onToggle,
  onEdit,
}: {
  attribute: AttributeNode;
  selected: boolean;
  registry: ClaimTypeRegistry | null;
  reveal: (target: RevealTarget) => Promise<unknown>;
  onToggle: (id: string, shift: boolean) => void;
  onEdit: (attribute: AttributeNode) => void;
}) {
  const prov = provenanceWords(attribute.provenance);
  const showLabel = labelSaysSomethingElse(attribute.label, attribute.value);
  return (
    <div
      style={{
        display: "flex",
        alignItems: "center",
        gap: 12,
        padding: "7px 12px",
        borderTop: `1px solid ${c.lineSoft}`,
        background: selected ? c.accentSoft : "transparent",
      }}
    >
      <input
        type="checkbox"
        checked={selected}
        aria-label={attribute.label ?? attribute.type}
        // The shift key is read off the click rather than tracked on the
        // window: a modifier held between renders is a piece of state that
        // goes stale the moment focus leaves the pane.
        onClick={(e) => onToggle(attribute.id, e.shiftKey)}
        onChange={() => {}}
        style={{ cursor: "pointer", accentColor: c.accent, width: 15, height: 15, flex: "0 0 auto" }}
      />
      <code style={{ fontFamily: font.mono, fontSize: t.xs, color: c.muted, flex: "0 0 168px" }}>
        {attribute.type}
      </code>
      <div style={{ flex: 1, minWidth: 0, display: "flex", alignItems: "baseline", gap: 8 }}>
        {/* Never formatted here. A value masked on the card and printed in a
            list is masked nowhere. */}
        <AttributeValue
          type={attribute.type}
          value={attribute.value}
          sensitivity={attribute.sensitivity}
          registry={registry}
          reveal={() => reveal({ attributeId: attribute.id, type: attribute.type })}
          textStyle={{ overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}
        />
        {showLabel && (
          <span style={{ fontSize: t.xs, color: c.faint, whiteSpace: "nowrap" }}>
            {attribute.label}
          </span>
        )}
      </div>
      <span style={{ fontSize: t.xs, color: prov.tone === "off" ? c.faint : c.muted, whiteSpace: "nowrap" }}>
        {prov.text}
      </span>
      {attribute.stale && <Pill tone="warn">{staleWords(attribute.staleReason)}</Pill>}
      <Button kind="quiet" onClick={() => onEdit(attribute)}>
        Edit
      </Button>
    </div>
  );
}

function Group({
  group,
  selection,
  registry,
  reveal,
  onToggleRow,
  onToggleGroup,
  onEdit,
}: {
  group: ListGroup;
  selection: ReadonlySet<string>;
  registry: ClaimTypeRegistry | null;
  reveal: (target: RevealTarget) => Promise<unknown>;
  onToggleRow: (id: string, shift: boolean) => void;
  onToggleGroup: (group: ListGroup) => void;
  onEdit: (attribute: AttributeNode) => void;
}) {
  const state = groupState(selection, group);
  return (
    <div style={{ border: `1px solid ${c.line}`, borderRadius: "var(--w-r-md)", marginBottom: 14, overflow: "hidden" }}>
      <div
        style={{
          display: "flex",
          alignItems: "center",
          gap: 12,
          padding: "9px 12px",
          background: c.raised,
        }}
      >
        <TriCheck
          state={state}
          onChange={() => onToggleGroup(group)}
          title={`Select everything under ${group.style.label}`}
        />
        {/* The family hue is a 3px stripe and nothing else — never a border
            (selection owns that) and never a pill (status owns that). */}
        <span style={{ width: 3, alignSelf: "stretch", background: group.style.hue, borderRadius: 2 }} />
        <div style={{ flex: 1, minWidth: 0 }}>
          <div style={{ fontSize: t.sm, fontWeight: 650, color: c.text }}>{group.style.label}</div>
          <div style={{ fontSize: t.xs, color: c.faint }}>{group.style.note}</div>
        </div>
        <span style={{ fontSize: t.xs, color: c.faint }}>{group.rows.length}</span>
      </div>
      {group.rows.map((row) => (
        <Row
          key={row.id}
          attribute={row}
          selected={selection.has(row.id)}
          registry={registry}
          reveal={reveal}
          onToggle={onToggleRow}
          onEdit={onEdit}
        />
      ))}
    </div>
  );
}

/** Add every selected attribute to an existing face, as a live reference. */
function AddToFace({
  faces,
  rows,
  parties,
  onDone,
}: {
  faces: readonly FaceNode[];
  rows: readonly AttributeNode[];
  parties: Parties;
  onDone: () => void;
}) {
  const [faceId, setFaceId] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const face = faces.find((f) => f.id === faceId);

  const run = useCallback(async () => {
    if (!face) return;
    setBusy(true);
    setError(null);
    try {
      // A face is a whitelist and `profile/put` is a replace, so the existing
      // entries are sent back with the additions appended. Dropping them would
      // silently empty the face — the same replace hazard the attribute editor
      // guards, one record up.
      const have = new Set(
        face.entries.flatMap((e) =>
          typeof e === "object" && e !== null && "ref" in e ? [(e as { ref: string }).ref] : [],
        ),
      );
      const additions = rows.filter((r) => !have.has(r.id)).map((r) => ({ ref: r.id }));
      if (additions.length === 0) {
        setError("Every one of those is already in that face.");
        return;
      }
      await personaProfilePut(managerSender, {
        ...parties,
        profileId: face.id,
        name: face.name,
        entries: [...face.entries, ...additions],
        expectedVersion: face.version,
      });
      setFaceId("");
      onDone();
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  }, [face, rows, parties, onDone]);

  return (
    <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
      <select
        value={faceId}
        onChange={(e) => setFaceId(e.target.value)}
        aria-label="Add to a face"
        style={{
          background: c.surface,
          color: c.text,
          border: `1px solid ${c.line}`,
          borderRadius: "var(--w-r-sm)",
          padding: "5px 8px",
          fontSize: t.sm,
        }}
      >
        <option value="">Add to a face…</option>
        {faces.map((f) => (
          <option key={f.id} value={f.id}>
            {f.name}
          </option>
        ))}
      </select>
      <Button kind="quiet" disabled={!face || busy} onClick={() => void run()}>
        {busy ? "Adding…" : "Add"}
      </Button>
      {error && <span style={{ fontSize: t.xs, color: c.warn }}>{error}</span>}
    </div>
  );
}

export function AttributeList({
  attributes,
  faces,
  registry,
  parties,
  reveal,
  onChanged,
  onEdit,
}: {
  attributes: readonly AttributeNode[];
  faces: readonly FaceNode[];
  registry: ClaimTypeRegistry | null;
  parties: Parties;
  reveal: (target: RevealTarget) => Promise<unknown>;
  /** Refetch — a delete or a face edit changes what every other view draws. */
  onChanged: () => void;
  onEdit: (attribute: AttributeNode) => void;
}) {
  const [selection, setSelection] = useState<ReadonlySet<string>>(new Set());
  const [anchor, setAnchor] = useState<string | null>(null);

  const groups = useMemo(() => groupRows(attributes, registry), [attributes, registry]);
  const order = useMemo(() => flatOrder(groups), [groups]);

  // A delete removes rows from under the selection. Without this the bulk bar
  // keeps counting attributes that are gone and the next action sends their ids
  // to be refused one at a time.
  const live = useMemo(() => pruneSelection(selection, attributes), [selection, attributes]);
  const rows = useMemo(() => selectedRows(live, groups), [live, groups]);

  const onToggleRow = useCallback(
    (id: string, shift: boolean) => {
      setSelection((current) =>
        shift ? selectRange(current, order, anchor, id) : toggle(current, id),
      );
      setAnchor(id);
    },
    [order, anchor],
  );

  const onToggleGroup = useCallback((group: ListGroup) => {
    setSelection((current) => toggleGroup(current, group));
    setAnchor(null);
  }, []);

  const clear = useCallback(() => {
    setSelection(new Set());
    setAnchor(null);
  }, []);

  const afterWrite = useCallback(() => {
    clear();
    onChanged();
  }, [clear, onChanged]);

  const commitDelete = useCallback(
    async (cascade: boolean) => {
      // Sequential, and it stops at the first refusal rather than pressing on.
      // Deleting is irreversible: a loop that swallowed one error and carried
      // on would leave the holder with a partial result and one message
      // describing neither what went nor what stayed.
      for (const row of rows) {
        await personaAttributeDelete(managerSender, {
          ...parties,
          attributeId: row.id,
          ...(cascade ? { cascade: true } : {}),
        });
      }
    },
    [rows, parties],
  );

  if (attributes.length === 0) return null;

  return (
    <div>
      <div style={{ display: "flex", alignItems: "center", gap: 12, marginBottom: 12, minHeight: 32 }}>
        <span style={{ fontSize: t.sm, color: c.muted }}>
          {live.size > 0 ? `${live.size} selected` : `${attributes.length} attributes`}
        </span>
        {live.size > 0 && (
          <>
            <Button kind="quiet" onClick={clear}>
              Clear
            </Button>
            <AddToFace faces={faces} rows={rows} parties={parties} onDone={afterWrite} />
            <Destructive<DeletePreview>
              label={`Delete ${live.size}`}
              preview={async () => previewDelete(live, groups, attributes, faces)}
              needsForce={(p) => p.usedInFaces > 0}
              forceLabel="Also remove them from the faces listed above"
              renderPreview={(p) => (
                <div style={{ fontSize: t.sm, color: c.text, display: "grid", gap: 6 }}>
                  <div>
                    {p.count} attribute{p.count === 1 ? "" : "s"} across {p.types.length} type
                    {p.types.length === 1 ? "" : "s"}.
                  </div>
                  {p.lastOfType > 0 && (
                    <div style={{ color: c.warn }}>
                      {p.lastOfType} would be the last of {p.lastOfType === 1 ? "its" : "their"} kind
                      you hold — any face showing {p.lastOfType === 1 ? "it" : "them"} stops
                      presenting {p.lastOfType === 1 ? "it" : "them"}.
                    </div>
                  )}
                  {p.credentialBacked > 0 && (
                    <div style={{ color: c.warn }}>
                      {p.credentialBacked} {p.credentialBacked === 1 ? "is" : "are"} backed by a
                      credential — deleting {p.credentialBacked === 1 ? "it" : "them"} here does not
                      touch the credential, but the link to it is gone.
                    </div>
                  )}
                  {p.usedInFaces > 0 && (
                    <div style={{ color: c.warn }}>
                      {p.usedInFaces} {p.usedInFaces === 1 ? "is" : "are"} still shown by{" "}
                      {p.facesAffected.join(", ")}. Your agent refuses to delete{" "}
                      {p.usedInFaces === 1 ? "it" : "them"} while that is true.
                    </div>
                  )}
                  <div style={{ color: c.faint, fontSize: t.xs }}>
                    Nothing already shared is affected — that has left.
                  </div>
                </div>
              )}
              commit={commitDelete}
              onDone={afterWrite}
            />
          </>
        )}
      </div>

      {live.size > 0 && (
        <div style={{ marginBottom: 12 }}>
          <Note tone="accent">{whyNoBulkVisibility()}</Note>
        </div>
      )}

      {groups.map((group) => (
        <Group
          key={group.family}
          group={group}
          selection={live}
          registry={registry}
          reveal={reveal}
          onToggleRow={onToggleRow}
          onToggleGroup={onToggleGroup}
          onEdit={onEdit}
        />
      ))}
    </div>
  );
}
