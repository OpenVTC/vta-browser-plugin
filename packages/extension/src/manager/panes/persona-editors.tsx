// The persona pane's editors and readers — shared by the guided setup and the
// identity map.
//
// Everything that writes to the agent, and the readers that resolve what a face
// shows, live here so the map (`persona-map.tsx`) and the first-run setup
// (`persona-setup.tsx`) compose the same forms rather than two drifting copies.
// The pane (`persona.tsx`) decides which of the two to show.
//
// Copy follows `design-docs/persona-vocabulary.md`: on screen it is a fact, a
// face, a context, and a persona that wears a face. The code keeps the spec's
// names (`attribute`, `profile`, `binding`) where they name wire records.

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  personaAttributePut,
  personaBindingSet,
  personaDisclosureHistory,
  personaProfileDelete,
  personaProfileGet,
  personaProfilePut,
  personasBlockingDelete,
  PROFILE_DELETE_BOUND,
  type AttributeProvenance,
  type AttributeValueType,
  type DisclosureRecord,
  type PoolAttribute,
  type PoolProfile,
  type PoolProfileEntry,
} from "@openvtc/pnm-core/admin";
import { getBinding, listBindings } from "@openvtc/pnm-core/persona";
import { webvhDidCreate, webvhDidList, webvhServerList } from "@openvtc/pnm-core/webvh";
import type { ContextRecord } from "@openvtc/pnm-core";
import { Button, Note, Panel, Pill } from "../../ui.js";
import { c, t, font } from "../../theme.js";
import { managerSender } from "../sender.js";
import { ConsentRequiredError, RelayTaskError } from "../carrier.js";
import { ConsentCeremony, runMutation } from "../destructive.js";
import { Loading, LoadError, Table, Truncated, type Column } from "../table.js";
import { useAsync } from "../use-async.js";
import { contextHeading, formatInstant } from "../format.js";
import { type Authority, type Parties } from "../use-vta.js";
import { holderGate } from "../holder-gate.js";
import { maskedFact } from "../claim-sensitivity.js";
import { composeEntries, lockedRefs, preservedEntries, tickedFrom } from "../profile-entries.js";
import { personaCandidates } from "../persona-candidates.js";

export const fieldStyle: React.CSSProperties = {
  boxSizing: "border-box",
  padding: "6px 9px",
  background: c.ground,
  color: c.text,
  border: `1px solid ${c.line}`,
  borderRadius: "var(--w-r-sm)",
  fontSize: t.sm,
};

export function Label({ children }: { children: React.ReactNode }) {
  return <span style={{ fontSize: t.xs, color: c.muted }}>{children}</span>;
}


// ── Reading what the agent sent, without adding to it ───────────────────────

/**
 * Render a value the schema places no type constraint on.
 *
 * `value` really is arbitrary JSON — a string attribute's value is a string —
 * so this must not assume an object, and must not print `[object Object]` for
 * the one case that is. `undefined` is the answer to a metadata-only listing
 * and says so, rather than rendering as an empty cell that reads like a fact
 * with no value.
 *
 * **Not exported, and that is the enforcement.** Every value this pane draws
 * goes through `FactValue` below, which is where a sensitive one is hidden. A
 * surface that could reach the raw rendering would be one mask away from
 * printing a passport number in full, and it would look like ordinary code.
 */
function formatValue(value: unknown): { text: string; withheld: boolean } {
  if (value === undefined) return { text: "not requested", withheld: true };
  if (value === null) return { text: "null", withheld: false };
  if (typeof value === "string") return { text: value, withheld: false };
  if (typeof value === "number" || typeof value === "boolean") {
    return { text: String(value), withheld: false };
  }
  return { text: JSON.stringify(value), withheld: false };
}

/**
 * A fact's value, hidden if its type says it should be, with a *Show* beside
 * it when it is.
 *
 * Every place this pane draws a value goes through here, because "wherever it
 * appears" is the whole property: a card that hides a passport number while the
 * strip below it prints the same number in full has hidden nothing, and the
 * second surface is always the one added later. Which types are hidden, and how
 * much of each survives the mask, is `claim-sensitivity.ts`'s answer — this
 * decides nothing, it only draws.
 *
 * **It hides a value from the screen, never from the page.** The agent already
 * answered; the string is in this tree either way. `claim-sensitivity.ts` opens
 * with the full version of that caveat and it is not repeated here, but do not
 * let a UI string in this component imply otherwise.
 *
 * **Reveal is per value and lives in this component.** Not lifted to the pane
 * keyed by fact id, which would be a store of "things the operator has
 * unhidden" — one that survives selection changes, outlives the card the person
 * was looking at, and is one refactor away from a *Show all*. Local state
 * cannot become that: it dies with the element, so leaving the pane, reloading
 * the console or navigating anywhere re-hides everything, and revealing the
 * same fact in two places is two deliberate acts rather than one.
 */
export function FactValue({
  type,
  value,
  style,
  textStyle,
}: {
  type: string;
  value: unknown;
  /** Typography for the row — applied to the wrapper, so the control inherits it. */
  style?: React.CSSProperties;
  /** Wrapping or truncation for the value itself, which differs per surface. */
  textStyle?: React.CSSProperties;
}) {
  const [shown, setShown] = useState(false);
  const { text, withheld } = formatValue(value);
  const { text: hidden, masked } = maskedFact(type, text);

  return (
    <span style={{ display: "inline-flex", alignItems: "baseline", gap: 7, minWidth: 0, ...style }}>
      <span
        style={{
          // A masked value is drawn at full strength; `c.faint` is this pane's
          // word for "the agent did not send one". Greying the mask too would
          // make a fact the holder has look exactly like a fact they do not,
          // and the difference is the one thing a hidden value must still say.
          color: withheld ? c.faint : c.text,
          ...(masked && !shown ? { fontFamily: font.mono, letterSpacing: 0.5 } : {}),
          ...textStyle,
        }}
      >
        {masked && !shown ? hidden : text}
      </span>
      {masked && (
        <button
          // The fact card underneath is itself a click target — it selects the
          // fact. Without this, revealing a value also moves the selection, and
          // the strip the operator was reading changes under them.
          onClick={(e) => {
            e.stopPropagation();
            setShown((s) => !s);
          }}
          title={
            shown
              ? "Hide it again."
              : "Hidden because this kind of fact is sensitive. Showing it changes what is on your " +
                "screen, not what this page holds — your agent has already sent the value here."
          }
          style={{
            flexShrink: 0,
            border: `1px solid ${c.line}`,
            background: "transparent",
            color: c.muted,
            borderRadius: 999,
            padding: "1px 8px",
            fontSize: t.xs,
            fontWeight: 600,
            fontFamily: "inherit",
            cursor: "pointer",
          }}
        >
          {shown ? "Hide" : "Show"}
        </button>
      )}
    </span>
  );
}


// ## Why no `version` appears anywhere in this pane's tables
//
// The persona store keeps ONE MONOTONIC COUNTER FOR THE WHOLE STORE, and a
// record's `version` is the counter value its most recent write took. The
// schema says so outright: "a value of the store's monotonic write counter".
// It is an optimistic-concurrency token and a change-feed watermark at once —
// which per-record counters could not be, because two records' counters would
// not be comparable to each other.
//
// So it is **not an edit count**, and rendering it as `v2` beside a timestamp
// said that it was. Add a second attribute to an empty pool and it arrives as
// `v2` having never been edited: the console was reporting the pool's write
// history as the record's own. Same failure `format.ts` exists for — a value
// the console did not have, rendered as a confident wrong one — and worse here,
// because the number is plausible and nothing on screen distinguishes it from
// the revision count it looks like.
//
// The version is still read and still matters: every edit sends it back as
// `expectedVersion`, which is what an opaque concurrency token is for. It is a
// value to carry, not a value to show.


// ── The pool ────────────────────────────────────────────────────────────────

export const VALUE_TYPES: AttributeValueType[] = ["string", "number", "boolean", "date", "object"];



/**
 * Turn what was typed into the value the agent stores.
 *
 * Returns a message rather than throwing, because "that is not a number" is
 * something to say next to the field, not an exception to surface as a failed
 * task. The agent refuses a value that disagrees with its `valueType`, so
 * catching it here is the difference between a correction and a round trip.
 */
export function parseValue(
  raw: string,
  valueType: AttributeValueType,
): { ok: true; value: unknown } | { ok: false; why: string } {
  switch (valueType) {
    case "number": {
      const n = Number(raw.trim());
      if (raw.trim() === "" || Number.isNaN(n)) return { ok: false, why: "Not a number." };
      return { ok: true, value: n };
    }
    case "boolean":
      return { ok: true, value: raw === "true" };
    case "object":
      try {
        return { ok: true, value: JSON.parse(raw) as unknown };
      } catch (e) {
        return { ok: false, why: `Not valid JSON — ${e instanceof Error ? e.message : String(e)}` };
      }
    // `date` is a string on the wire; the agent compares it as one. Sending a
    // Date would serialise to whatever the browser's locale produces.
    case "date":
    case "string":
    default:
      return { ok: true, value: raw };
  }
}

/** The raw form of a stored value, for editing. The inverse of `parseValue`
 *  for every type it round-trips, and JSON for the one it does not. */
export function rawValue(value: unknown): string {
  if (value === undefined || value === null) return "";
  if (typeof value === "string") return value;
  if (typeof value === "number" || typeof value === "boolean") return String(value);
  return JSON.stringify(value, null, 2);
}


export function AttributeEditor({
  parties,
  authority,
  existing,
  onDone,
  onCancel,
  cancelLabel = "Cancel",
}: {
  parties: Parties;
  authority: Authority | null;
  existing?: PoolAttribute;
  /** Omit where there is nothing to go back to — the guided setup's first step
   *  has no earlier state, and a "Cancel" that abandons the whole flow is not
   *  what a person reads it as. */
  onCancel?: (() => void) | undefined;
  /** "Cancel" unless the caller says otherwise. The guide says "Back", because
   *  that is where its button goes. */
  cancelLabel?: string | undefined;
  onDone: () => void;
}) {
  const [type, setType] = useState(existing?.type ?? "");
  const [label, setLabel] = useState(existing?.label ?? "");
  const [valueType, setValueType] = useState<AttributeValueType>(existing?.valueType ?? "string");
  const [raw, setRaw] = useState(rawValue(existing?.value));
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [pending, setPending] = useState<ConsentRequiredError | null>(null);
  const [correlation, setCorrelation] = useState<string | null>(null);

  const denied = holderGate(authority);

  // An existing attribute keeps the provenance it was created with, verbatim.
  //
  // This editor offers `selfAsserted` and nothing else, because the other two
  // forms are claims about an origin: `credentialBacked` names a credential and
  // a claim path the agent re-derives the value from, and `generated` names a
  // generator. Typing either by hand would be asserting a provenance nothing
  // checked. But *keeping* one is not asserting anything — so an edit here
  // sends back the object the agent gave us, and a credential-backed attribute
  // does not quietly become self-asserted because someone fixed its label.
  const provenance: AttributeProvenance = existing?.provenance ?? { kind: "selfAsserted" };
  const derived = provenance.kind === "credentialBacked";

  const save = useCallback(async () => {
    const parsed = parseValue(raw, valueType);
    if (!parsed.ok) {
      setError(parsed.why);
      return;
    }
    setBusy(true);
    setError(null);
    setPending(null);
    setCorrelation(null);
    // Held in a local, not read back off state. `setCorrelation` does not
    // change `correlation` for the rest of this closure — the render that
    // applies it has not happened yet — so branching on the state variable
    // here would close the editor the instant the warning was raised, which is
    // to say it would show the warning to nobody. The one place in this pane
    // where a write and the decision that depends on it are in the same
    // function.
    let linked: string | null = null;
    const ok = await runMutation(
      async () => {
        const res = await personaAttributePut(managerSender, {
          ...parties,
          type: type.trim(),
          valueType,
          value: parsed.value,
          provenance,
          ...(label.trim() ? { label: label.trim() } : {}),
          ...(existing ? { attributeId: existing.attributeId, expectedVersion: existing.version } : {}),
        });
        // Advisory, and it arrives with the write rather than before it: the
        // agent applies the change and then reports what it links, because
        // refusing on correlation grounds would be the agent deciding who the
        // holder is allowed to be. Shown, never acted on.
        const shared = res.correlation?.sharedWithProfileCount ?? 0;
        if (res.correlation?.severity === "high" || shared > 0) {
          linked =
            `Saved. ${shared} other fact(s) hold this exact value — anyone who sees both ` +
            `knows they are the same person, permanently.`;
          setCorrelation(linked);
        }
      },
      { onConsent: setPending, onError: setError },
    );
    setBusy(false);
    if (ok && linked === null) onDone();
  }, [parties, type, label, valueType, raw, provenance, existing, onDone]);

  return (
    <Panel
      title={existing ? `Edit ${existing.label ?? existing.type}` : "Add a fact"}
      description={
        existing
          ? "Editing writes a new version. A face that shows this fact live picks the change up " +
            "everywhere it is worn — which is the point of selecting rather than copying, and " +
            "worth remembering before changing a value rather than adding one."
          : "A fact about you, held once. Faces select it; a context receives a copy only when " +
            "a persona there wears one of them."
      }
    >
      <div style={{ display: "grid", gap: 10 }}>
        <label style={{ display: "grid", gap: 4 }}>
          <Label>TYPE</Label>
          <input
            style={{ ...fieldStyle, fontFamily: font.mono }}
            value={type}
            onChange={(e) => setType(e.target.value)}
            placeholder="phone.mobile"
            disabled={Boolean(existing)}
          />
          <span style={{ fontSize: t.xs, color: c.faint, lineHeight: 1.5 }}>
            The vocabulary token naming what this value <em>is</em>. Dotted, most general segment
            first — <code>name.legal</code>, <code>phone.mobile</code>, <code>address.postal</code>{" "}
            — so anything that has never heard of your token can still group it by its prefix.
            An <code>x:</code> prefix is an open extension namespace and behaves exactly like a
            known token.
          </span>
        </label>

        <label style={{ display: "grid", gap: 4 }}>
          <Label>LABEL</Label>
          <input
            style={fieldStyle}
            value={label}
            onChange={(e) => setLabel(e.target.value)}
            placeholder="work mobile"
          />
          <span style={{ fontSize: t.xs, color: c.faint }}>
            Your own name for it. Optional, and only ever shown to you.
          </span>
        </label>

        <label style={{ display: "grid", gap: 4 }}>
          <Label>VALUE TYPE</Label>
          <select
            style={fieldStyle}
            value={valueType}
            onChange={(e) => setValueType(e.target.value as AttributeValueType)}
          >
            {VALUE_TYPES.map((v) => (
              <option key={v} value={v}>
                {v}
              </option>
            ))}
          </select>
        </label>

        <label style={{ display: "grid", gap: 4 }}>
          <Label>VALUE</Label>
          {valueType === "boolean" ? (
            <select style={fieldStyle} value={raw} onChange={(e) => setRaw(e.target.value)}>
              <option value="true">true</option>
              <option value="false">false</option>
            </select>
          ) : valueType === "object" ? (
            <textarea
              style={{ ...fieldStyle, minHeight: 110, fontFamily: font.mono, resize: "vertical" }}
              value={raw}
              onChange={(e) => setRaw(e.target.value)}
              placeholder='{"street": "…"}'
            />
          ) : (
            <input
              style={fieldStyle}
              value={raw}
              onChange={(e) => setRaw(e.target.value)}
              placeholder={valueType === "date" ? "1978-04-02" : ""}
            />
          )}
          <span style={{ fontSize: t.xs, color: c.faint }}>
            It must agree with the value type — the agent refuses a document where it does not.
          </span>
        </label>

        {derived && (
          <Note tone="warn">
            This fact is backed by a <strong>credential</strong>, and that is kept as it stands —
            nothing here can turn a fact you can prove into one you merely said.
            The value is a display cache: the agent re-derives it from the credential and may
            overwrite what you type.
          </Note>
        )}

        {error && <Note tone="danger">{error}</Note>}
        {pending && <ConsentCeremony pending={pending} />}
        {correlation && (
          <Note tone="warn">
            <div style={{ display: "grid", gap: 8 }}>
              <span>{correlation}</span>
              <div>
                <Button kind="quiet" onClick={onDone}>
                  Understood
                </Button>
              </div>
            </div>
          </Note>
        )}

        <div style={{ display: "flex", gap: 8 }}>
          <Button
            kind="primary"
            disabled={busy || !type.trim() || Boolean(correlation)}
            {...(denied ? { title: denied } : {})}
            onClick={() => void save()}
          >
            {busy ? "Saving…" : existing ? "Save" : "Add fact"}
          </Button>
          {onCancel && (
            <Button kind="quiet" disabled={busy} onClick={onCancel}>
              {cancelLabel}
            </Button>
          )}
        </div>
        {denied && <span style={{ fontSize: t.sm, color: c.muted }}>{denied}</span>}
      </div>
    </Panel>
  );
}


export function ProfileEditor({
  parties,
  authority,
  attributes,
  existing,
  onPreview,
  onDone,
  onCancel,
  cancelLabel = "Cancel",
}: {
  parties: Parties;
  authority: Authority | null;
  attributes: PoolAttribute[];
  existing?: PoolProfile;
  /**
   * The current name and ticks, reported as they change, so a caller can show
   * what this face would hand over. The guided setup renders its card from it.
   *
   * An explicit prop rather than a caller reading the DOM: the first version of
   * the setup wrapped this editor in a div and scraped its checkboxes from a
   * `ref` callback, which React re-invokes on every commit — so the scrape set
   * state, the state re-rendered, and the re-render scraped again. React error
   * #185, a blank screen, and no clue in it that a preview was the cause.
   */
  onPreview?: ((selection: { ids: string[]; name: string }) => void) | undefined;
  onDone: () => void;
  onCancel: () => void;
  cancelLabel?: string | undefined;
}) {
  const [name, setName] = useState(existing?.name ?? "");
  const [selected, setSelected] = useState<Set<string>>(
    () => new Set(tickedFrom(existing?.entries ?? [])),
  );
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [pending, setPending] = useState<ConsentRequiredError | null>(null);

  const denied = holderGate(authority);

  // Which entries the editor cannot express, and which attributes they already
  // project. Both — and the composition on save — live in `profile-entries.ts`,
  // because what a profile presents is a security property and a component's
  // reasoning is not testable. See that file's header for the two ways this
  // goes wrong.
  const preserved = useMemo(() => preservedEntries(existing?.entries ?? []), [existing]);
  const preservedRefs = useMemo(() => lockedRefs(existing?.entries ?? []), [existing]);

  const save = useCallback(async () => {
    setBusy(true);
    setError(null);
    setPending(null);
    const entries = composeEntries(existing?.entries ?? [], selected);
    const ok = await runMutation(
      async () => {
        await personaProfilePut(managerSender, {
          ...parties,
          name: name.trim(),
          entries,
          ...(existing
            ? {
                profileId: existing.profileId,
                expectedVersion: existing.version,
                ...(existing.credentialRefs !== undefined
                  ? { credentialRefs: existing.credentialRefs }
                  : {}),
              }
            : {}),
        });
      },
      { onConsent: setPending, onError: setError },
    );
    setBusy(false);
    if (ok) onDone();
  }, [parties, name, selected, existing, onDone]);

  // Reported from a ref, not from the dependency list. `onPreview` is nearly
  // always an inline arrow, so keying the effect on it would fire on every
  // render — and every fire sets the caller's state, which renders again. The
  // effect fires only when the selection itself moves; `selected`'s identity
  // changes in `toggle` and nowhere else, which is what makes that true.
  const previewRef = useRef(onPreview);
  previewRef.current = onPreview;
  useEffect(() => {
    previewRef.current?.({ ids: [...selected], name });
  }, [selected, name]);

  const toggle = (id: string) =>
    setSelected((s) => {
      const next = new Set(s);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });

  return (
    <Panel
      title={existing ? `Edit ${existing.name}` : "New face"}
      description="A face is the set of facts you show together. What you leave unticked stays
        out — including facts you add later, which is the whole reason it works that way round."
    >
      <div style={{ display: "grid", gap: 12 }}>
        <label style={{ display: "grid", gap: 4 }}>
          <Label>NAME</Label>
          <input
            style={fieldStyle}
            value={name}
            onChange={(e) => setName(e.target.value)}
            placeholder="work"
          />
          <span style={{ fontSize: t.xs, color: c.faint }}>
            Contexts see this name too. Pick one that says who you are there, not where you use it.
          </span>
        </label>

        <div style={{ display: "grid", gap: 6 }}>
          <Label>SHOWS</Label>
          {attributes.length === 0 ? (
            <span style={{ fontSize: t.sm, color: c.faint }}>
              No facts to show yet. Add one first.
            </span>
          ) : (
            <div style={{ display: "grid", gap: 6 }}>
              {attributes.map((a) => {
                const locked = preservedRefs.has(a.attributeId);
                return (
                  <label
                    key={a.attributeId}
                    style={{ display: "flex", gap: 8, alignItems: "flex-start", fontSize: t.sm }}
                    {...(locked
                      ? { title: "Projected by an entry this editor cannot express — see below." }
                      : {})}
                  >
                    <input
                      type="checkbox"
                      checked={locked || selected.has(a.attributeId)}
                      disabled={locked}
                      onChange={() => toggle(a.attributeId)}
                      style={{ marginTop: 3 }}
                    />
                    <span style={locked ? { color: c.muted } : {}}>
                      <span style={{ fontFamily: font.mono, fontSize: t.xs }}>{a.type}</span>
                      {a.label && <span style={{ color: c.muted }}> · {a.label}</span>}
                      {a.stale && <span style={{ color: c.warn }}> · stale</span>}
                      {locked && <span style={{ color: c.accent }}> · pinned or overridden</span>}
                    </span>
                  </label>
                );
              })}
            </div>
          )}
          <span style={{ fontSize: t.xs, color: c.faint, lineHeight: 1.5 }}>
            Ticked facts are <em>live</em>: change a phone number once and every face that shows
            it changes with it.
          </span>
        </div>

        {preserved.length > 0 && (
          <Note tone="accent">
            <div style={{ display: "grid", gap: 6 }}>
              <strong>
                {preserved.length} entr{preserved.length === 1 ? "y" : "ies"} in this face
                cannot be edited here, and are kept as they are.
              </strong>
              <span>
                A pinned, overridden or face-only entry says something the tick list above
                cannot: which version is shown, a value used only here, or a value that lives
                nowhere else. Rebuilding the face from the ticks alone would drop them
                silently. Use <code>pnm persona</code> to change them.
              </span>
            </div>
          </Note>
        )}

        {error && <Note tone="danger">{error}</Note>}
        {pending && <ConsentCeremony pending={pending} />}

        <div style={{ display: "flex", gap: 8 }}>
          <Button
            kind="primary"
            disabled={busy || !name.trim()}
            {...(denied ? { title: denied } : {})}
            onClick={() => void save()}
          >
            {busy ? "Saving…" : existing ? "Save" : "Create face"}
          </Button>
          <Button kind="quiet" disabled={busy} onClick={onCancel}>
            {cancelLabel}
          </Button>
        </div>
        {denied && <span style={{ fontSize: t.sm, color: c.muted }}>{denied}</span>}
      </div>
    </Panel>
  );
}

/**
 * Deleting a profile: the agent's refusal is the preview.
 *
 * Everything else irreversible in this console previews by asking the agent
 * what the change would cost. There is no read that answers it here — "which
 * personas present this profile" spans every context, and the only code that
 * computes it agent-side lives inside `persona/profile/delete` itself, where it
 * runs in order to *refuse*.
 *
 * So the refusal is the preview, and it is a better one than a question would
 * have been: it is computed at the moment of the delete rather than a moment
 * before it, so nothing can bind in between.
 *
 * **This shape needs the refusal's code and details to survive the bridge**,
 * which they did not until the relay was widened. Before that the console had
 * only prose, matching on which R3.7 forbids, so the unbind was offered up
 * front as a checkbox the operator had to reason about with no idea whether it
 * applied. Now the first attempt is the question and the answer names the
 * personas.
 *
 * `Destructive`'s force tick is still the wrong shape for this: it disables the
 * confirm until ticked, which would make every operator authorise an unbind for
 * the ordinary case where nothing is bound.
 */

export function DeleteProfile({
  parties,
  profile,
  onDone,
}: {
  parties: Parties;
  profile: PoolProfile;
  onDone: () => void;
}) {
  type Phase =
    | { kind: "idle" }
    | { kind: "confirm" }
    | { kind: "working" }
    /** The agent refused and named what is in the way. `personas` is null when
     *  it refused without saying — see `personasBlockingDelete`. */
    | { kind: "blocked"; personas: string[] | null; message: string }
    | { kind: "consent"; pending: ConsentRequiredError }
    | { kind: "error"; message: string };

  const [phase, setPhase] = useState<Phase>({ kind: "idle" });

  const run = useCallback(
    async (unbind: boolean) => {
      setPhase({ kind: "working" });
      try {
        await personaProfileDelete(managerSender, {
          ...parties,
          profileId: profile.profileId,
          unbind,
        });
        setPhase({ kind: "idle" });
        onDone();
      } catch (e) {
        if (e instanceof ConsentRequiredError) {
          setPhase({ kind: "consent", pending: e });
          return;
        }
        // The one refusal this flow is built around. Matched on the code the
        // agent sent, never on its prose.
        if (e instanceof RelayTaskError && e.code === PROFILE_DELETE_BOUND) {
          setPhase({
            kind: "blocked",
            personas: personasBlockingDelete(e.details),
            message: e.message,
          });
          return;
        }
        setPhase({ kind: "error", message: e instanceof Error ? e.message : String(e) });
      }
    },
    [parties, profile.profileId, onDone],
  );

  if (phase.kind === "idle") {
    return (
      <Button
        kind="danger"
        onClick={() => setPhase({ kind: "confirm" })}
      >
        Delete
      </Button>
    );
  }

  if (phase.kind === "consent") {
    return (
      <div style={{ display: "grid", gap: 10, maxWidth: 460 }}>
        <ConsentCeremony pending={phase.pending} />
        <div>
          <Button kind="quiet" onClick={() => setPhase({ kind: "idle" })}>
            Close
          </Button>
        </div>
      </div>
    );
  }

  if (phase.kind === "error") {
    return (
      <div style={{ display: "grid", gap: 10, maxWidth: 480 }}>
        <Note tone="danger">{phase.message}</Note>
        <div>
          <Button kind="quiet" onClick={() => setPhase({ kind: "idle" })}>
            Back
          </Button>
        </div>
      </div>
    );
  }

  if (phase.kind === "blocked") {
    return (
      <div style={{ display: "grid", gap: 12, maxWidth: 480 }}>
        <Note tone="danger">
          <div style={{ display: "grid", gap: 8 }}>
            <strong>Your agent refused: personas are still wearing this face.</strong>
            {phase.personas === null ? (
              // It refused without naming them, so say that rather than render
              // an empty list — "no personas" over a refusal caused by personas
              // is the one reading that must not be possible here.
              <span>
                It did not say which. Deleting anyway will leave them showing nothing, and
                this console cannot tell you how many that is — {phase.message}
              </span>
            ) : (
              <>
                <span>
                  {phase.personas.length} persona(s) wear it and would be left showing
                  nothing:
                </span>
                {phase.personas.map((did) => (
                  <span key={did} style={{ fontFamily: font.mono, fontSize: t.xs, wordBreak: "break-all" }}>
                    {did}
                  </span>
                ))}
              </>
            )}
            <span>
              That is a legal state, and one you will not be warned about again. Nothing already
              shared is affected — that has left.
            </span>
          </div>
        </Note>
        <div style={{ display: "flex", gap: 8, flexWrap: "wrap" }}>
          <Button kind="danger" onClick={() => void run(true)}>
            Take it off {phase.personas === null ? "them" : `${phase.personas.length}`} and delete
          </Button>
          <Button kind="quiet" onClick={() => setPhase({ kind: "idle" })}>
            Cancel
          </Button>
        </div>
      </div>
    );
  }

  const busy = phase.kind === "working";
  return (
    <div style={{ display: "grid", gap: 12, maxWidth: 460 }}>
      <Note tone="danger">
        <div style={{ display: "grid", gap: 8 }}>
          <strong>Deleting “{profile.name}” cannot be undone.</strong>
          <span>
            It shows {profile.entries.length} fact(s). The facts themselves are untouched — a
            face is a selection over them, not a copy.
          </span>
          <span>
            If any persona is still wearing it, your agent will refuse and name them, and you can
            decide then.
          </span>
        </div>
      </Note>
      <div style={{ display: "flex", gap: 8 }}>
        <Button kind="danger" disabled={busy} onClick={() => void run(false)}>
          {busy ? "Working…" : "Delete face"}
        </Button>
        <Button kind="quiet" disabled={busy} onClick={() => setPhase({ kind: "idle" })}>
          Cancel
        </Button>
      </div>
    </div>
  );
}

/**
 * What a profile would actually present, asked of the agent.
 *
 * The table above describes a profile's *entries* — which is all the console
 * can say for itself, because three of the four entry forms hold a value the
 * pool does not: a pinned version, an override, a profile-local inline value.
 * `resolve` is the only way to see what comes out the other end, and it is
 * opt-in at the agent for the reason that makes it worth having: it decrypts
 * pool values and re-derives credential-backed ones, so asking is itself a read
 * of the holder's identity. Hence a button per profile rather than a column.
 *
 * A resolved claim is not a pool attribute. An inline one has no `attributeId`,
 * no `version` and no `updatedAt`, and the absence of all three is precisely
 * what says the value lives only in this profile — so it is rendered as a
 * statement rather than as three empty cells.
 */

export function ResolvedProfile({
  parties,
  profileId,
  name,
}: {
  parties: Parties;
  profileId: string;
  /** How to name it while loading and when it holds nothing. */
  name: string;
}) {
  const resolved = useAsync(
    async () => personaProfileGet(managerSender, { ...parties, profileId, resolve: true }),
    [parties.holder.did, parties.service.did, profileId],
  );

  if (resolved.error) return <LoadError what={`what ${name} shows`} error={resolved.error} />;
  if (!resolved.data) return <Loading what={`what ${name} shows`} />;

  const claims = resolved.data.resolved ?? [];
  if (claims.length === 0) {
    return (
      <div style={{ fontSize: t.sm, color: c.faint, padding: "6px 0" }}>
        This face shows nothing. A persona wearing it hands over no facts.
      </div>
    );
  }

  return (
    <div style={{ display: "grid", gap: 6, padding: "4px 0 6px" }}>
      <span style={{ fontSize: t.xs, color: c.faint, textTransform: "uppercase", letterSpacing: 0.4 }}>
        What someone would receive
      </span>
      {claims.map((claim, i) => {
        // Absent on all three counts is the inline case, and it is worth
        // naming: the value is not in the pool, so nothing else references it
        // and editing the pool will never change it.
        const inline = claim.attributeId === undefined;
        return (
          <div
            key={`${profileId}-claim-${i}`}
            style={{ display: "flex", gap: 10, flexWrap: "wrap", alignItems: "baseline" }}
          >
            <span style={{ fontFamily: font.mono, fontSize: t.xs, minWidth: 150 }}>{claim.type}</span>
            <FactValue type={claim.type} value={claim.value} textStyle={{ wordBreak: "break-word" }} />
            {inline && <Pill tone="accent">only in this face</Pill>}
            {claim.stale && <Pill tone="warn">stale</Pill>}
          </div>
        );
      })}
    </div>
  );
}

/**
 * Which personas present a profile, and where.
 *
 * The question a holder actually asks of a profile — "who knows me by this?" —
 * and the console has to assemble it, because no single task answers it. The
 * assembly, and the soundness argument that makes it exact, live in
 * `profile-bindings.ts`; this renders the result.
 *
 * **A click, not a column.** Even bounded, it is a fan-out across every
 * context, and the answer is the holder's linkage map — the artifact this
 * family exists to keep from being assembled casually. A column would run it on
 * every page load for every profile and leave the map on screen whether or not
 * anyone asked.
 */
/**
 * Which personas present a profile, and where.
 *
 * The question a holder actually asks of a profile — "who knows me by this?" —
 * and the console has to assemble it, because no single task answers it. The
 * assembly, and the soundness argument that makes it exact, live in
 * `profile-bindings.ts`; this renders the result.
 *
 * **A click, not a column.** Even bounded, it is a fan-out across every
 * context, and the answer is the holder's linkage map — the artifact this
 * family exists to keep from being assembled casually. A column would run it on
 * every page load for every profile and leave the map on screen whether or not
 * anyone asked.
 */

export function PersonaClaims({
  parties,
  contextId,
  personaDid,
  profileName,
}: {
  parties: Parties;
  contextId: string;
  personaDid: string;
  profileName: string;
}) {
  const bound = useAsync(
    async () => getBinding(managerSender, { ...parties, contextId, personaDid }),
    [parties.holder.did, parties.service.did, contextId, personaDid],
  );

  if (bound.error) return <LoadError what={`what ${profileName} presents`} error={bound.error} />;
  if (!bound.data) return <Loading what={`what ${profileName} presents`} />;
  if (!bound.data.profileId) {
    // `bound` was true a moment ago and the profile is gone now, or the agent
    // withheld the id. Either way, say that rather than render an empty list
    // that reads as "presents nothing".
    return (
      <div style={{ fontSize: t.sm, color: c.faint, padding: "6px 0" }}>
        Your agent did not name the face behind this persona, so there is nothing to resolve.
      </div>
    );
  }

  return (
    <ResolvedProfile
      parties={parties}
      profileId={bound.data.profileId}
      name={bound.data.profileName ?? profileName}
    />
  );
}


export function DisclosureHistoryPanel({
  parties,
  authority,
  records,
}: {
  parties: Parties;
  authority: Authority | null;
  records: ContextRecord[];
}) {
  const [contextId, setContextId] = useState("");
  const [verifierDid, setVerifierDid] = useState("");
  const denied = holderGate(authority);

  // Applied on submit rather than on every keystroke: this is a query the agent
  // runs across every context, not a filter over rows already on screen.
  const [query, setQuery] = useState<{ contextId: string; verifierDid: string }>({
    contextId: "",
    verifierDid: "",
  });

  const history = useAsync(
    async () =>
      personaDisclosureHistory(managerSender, {
        ...parties,
        ...(query.contextId ? { contextId: query.contextId } : {}),
        ...(query.verifierDid.trim() ? { verifierDid: query.verifierDid.trim() } : {}),
      }),
    [parties.holder.did, parties.service.did, query.contextId, query.verifierDid],
  );

  const columns: Column<DisclosureRecord>[] = [
    {
      key: "when",
      header: "When",
      width: "170px",
      render: (d) => <span style={{ color: c.muted }}>{formatInstant(d.disclosedAt)}</span>,
    },
    {
      key: "verifier",
      header: "To",
      render: (d) => (
        <div style={{ display: "grid", gap: 3 }}>
          <span style={{ fontFamily: font.mono, fontSize: t.xs, wordBreak: "break-all" }}>
            {d.verifierDid}
          </span>
          <span style={{ color: c.faint, fontSize: t.xs }}>in {d.contextId}</span>
        </div>
      ),
    },
    {
      key: "as",
      header: "As",
      render: (d) => (
        <span style={{ fontFamily: font.mono, fontSize: t.xs, wordBreak: "break-all" }}>
          {d.personaDid}
        </span>
      ),
    },
    {
      key: "claims",
      header: "What left",
      render: (d) => (
        <div style={{ display: "grid", gap: 3 }}>
          <span>{d.claimTypes.join(", ")}</span>
          {d.rungs && d.rungs.length > 0 && (
            <span style={{ color: c.muted, fontSize: t.xs }}>as {d.rungs.join(", ")}</span>
          )}
          {d.purpose && (
            <span style={{ color: c.faint, fontSize: t.xs }}>“{d.purpose}”</span>
          )}
        </div>
      ),
    },
  ];

  return (
    <Panel
      title="What has left, and to whom"
      description="Everything your agent has handed over on your behalf, across every context.
        The one view here that spans them all — which is exactly why it is yours alone."
    >
      <div style={{ display: "grid", gap: 12 }}>
        <div style={{ display: "flex", gap: 10, flexWrap: "wrap", alignItems: "flex-end" }}>
          <label style={{ display: "grid", gap: 4, flex: "0 1 260px" }}>
            <Label>CONTEXT</Label>
            <select
              style={fieldStyle}
              value={contextId}
              onChange={(e) => setContextId(e.target.value)}
            >
              <option value="">every context</option>
              {records.map((r) => (
                <option key={r.id} value={r.id}>
                  {contextHeading(r, r.id)}
                </option>
              ))}
            </select>
          </label>
          <label style={{ display: "grid", gap: 4, flex: "1 1 300px" }}>
            <Label>RECEIVED BY (DID)</Label>
            <input
              style={{ ...fieldStyle, fontFamily: font.mono }}
              value={verifierDid}
              onChange={(e) => setVerifierDid(e.target.value)}
              placeholder="any"
            />
          </label>
          <Button onClick={() => setQuery({ contextId, verifierDid })}>Apply</Button>
        </div>

        {history.error && <LoadError what="what has left" error={history.error} />}
        {history.loading && !history.data && <Loading what="what has left" />}
        {history.data && (
          <>
            <Table
              columns={columns}
              rows={history.data.disclosures}
              rowKey={(d) => d.disclosureId}
              empty={
                query.contextId || query.verifierDid
                  ? "Nothing matches that. Widen the filters to see the rest."
                  : "Nothing has left yet."
              }
            />
            {history.data.nextCursor && <Truncated what="what has left" />}
          </>
        )}
        {denied && <span style={{ fontSize: t.sm, color: c.muted }}>{denied}</span>}
      </div>
    </Panel>
  );
}

// ── The pane ────────────────────────────────────────────────────────────────



// ── Wearing a face ──────────────────────────────────────────────────────────

/**
 * What to offer in the persona picker, and why it is a `datalist` rather than
 * a `<select>`.
 *
 * **A persona DID is not necessarily one of the context's published `did:webvh`
 * identifiers.** A v4 holder is a `did:key` the VTA mints, peers are reached at
 * `did:peer`, and a binding names whichever identifier this context knows the
 * holder by. A select would refuse every one of those — turning a convenience
 * into a constraint, and a wrong one.
 *
 * So the two sources are suggestions over a field that still takes anything:
 * the DIDs this context publishes, and the personas already known here (which
 * the first list does not contain when the persona is not a webvh DID — exactly
 * the case a picker built only from published DIDs would hide).
 */
function useDidSuggestions(parties: Parties, contextId: string) {
  const published = useAsync(
    async () => (contextId ? webvhDidList(managerSender, { ...parties, contextId }) : null),
    [parties.holder.did, parties.service.did, contextId],
  );
  const known = useAsync(
    async () => (contextId ? listBindings(managerSender, { ...parties, contextId }) : null),
    [parties.holder.did, parties.service.did, contextId],
  );
  // Filtered again here, not because the agent does not filter — it does — but
  // because "the agent promises" and "this list cannot contain one" are
  // different claims, and only the second has a test. See
  // `persona-candidates.ts`.
  const suggestions = useMemo(
    () => personaCandidates(contextId, published.data?.dids ?? [], known.data?.personas ?? []),
    [contextId, published.data, known.data],
  );
  const reload = useCallback(() => {
    published.reload();
    known.reload();
  }, [published, known]);
  return { suggestions, loading: published.loading, error: published.error, known: known.data, reload };
}

/**
 * Choosing which persona this context knows you by.
 *
 * **A dropdown, with a way out.** #165 made this a free-text field with a
 * `datalist`, on the reasoning that a persona DID need not be one of the
 * context's published `did:webvh` identifiers — a v4 holder is a `did:key` the
 * VTA mints, peers are `did:peer` — and a `<select>` would refuse all of those.
 * That reasoning still holds, and it was still the wrong control: in a context
 * publishing nothing the field is an empty box asking a first-time holder to
 * type a DID they do not have, which is where the guided setup dead-ended.
 *
 * So the list leads and the free-text field is one option inside it. The
 * unusual identifiers stay reachable; they stop being the default question.
 *
 * **And when a context has none, the answer is to make one**, not to send the
 * holder to another pane mid-flow. `serverId` is what that needs: omitting it
 * means *serverless* — the caller serves the log itself at a `url` — so this
 * asks the agent which hosting servers it can publish through and uses the one
 * when there is one. No server registered is the one case that really does
 * belong in the DIDs pane, and it says so.
 */
function PersonaPicker({
  parties,
  authority,
  contextId,
  contextLabel,
  suggestions,
  loading,
  error,
  value,
  onChange,
  onCreated,
}: {
  parties: Parties;
  authority: Authority | null;
  contextId: string;
  contextLabel: string;
  suggestions: { did: string; note: string }[];
  loading: boolean;
  error: string | null;
  value: string;
  onChange: (did: string) => void;
  onCreated: () => void;
}) {
  const OTHER = "\u0000other";
  const [typing, setTyping] = useState(false);
  const [creating, setCreating] = useState(false);
  const [createError, setCreateError] = useState<string | null>(null);
  const denied = holderGate(authority);

  const servers = useAsync(
    async () => webvhServerList(managerSender, parties),
    [parties.holder.did, parties.service.did],
  );
  const server = servers.data?.servers?.[0];

  const create = useCallback(async () => {
    if (!server) return;
    setCreating(true);
    setCreateError(null);
    try {
      const made = await webvhDidCreate(managerSender, { ...parties, contextId, serverId: server.id });
      onChange(made.did);
      setTyping(false);
      onCreated();
    } catch (e) {
      setCreateError(e instanceof Error ? e.message : String(e));
    } finally {
      setCreating(false);
    }
  }, [parties, contextId, server, onChange, onCreated]);

  return (
    <div style={{ display: "grid", gap: 4 }}>
      <Label>PERSONA</Label>
      {suggestions.length > 0 && !typing ? (
        <select
          style={fieldStyle}
          value={suggestions.some((s) => s.did === value) ? value : ""}
          onChange={(e) => {
            if (e.target.value === OTHER) {
              setTyping(true);
              onChange("");
            } else {
              onChange(e.target.value);
            }
          }}
        >
          <option value="">Choose one…</option>
          {suggestions.map((option) => (
            <option key={option.did} value={option.did}>
              {personaOptionLabel(option)}
            </option>
          ))}
          <option value={OTHER}>— another DID, typed —</option>
        </select>
      ) : (
        <input
          style={{ ...fieldStyle, fontFamily: font.mono }}
          value={value}
          onChange={(e) => onChange(e.target.value)}
          placeholder="did:webvh:…"
        />
      )}

      <span style={{ fontSize: t.xs, color: c.faint, lineHeight: 1.5 }}>
        The identifier {contextLabel} knows you by.{" "}
        {loading
          ? "Looking for identifiers this context publishes…"
          : suggestions.length > 0
            ? typing
              ? "Any DID works — a persona need not be one this context published."
              : `${suggestions.length} to choose from.`
            : "This context publishes none yet."}
      </span>

      {suggestions.length > 0 && typing && (
        <div>
          <Button kind="quiet" onClick={() => { setTyping(false); onChange(""); }}>
            Back to the list
          </Button>
        </div>
      )}

      {/* No identifier to pick is the case that dead-ended the guide. */}
      {!loading && suggestions.length === 0 && !typing && (
        <div style={{ display: "flex", gap: 8, alignItems: "center", flexWrap: "wrap", paddingTop: 2 }}>
          {server ? (
            <>
              <Button
                kind="primary"
                disabled={creating || Boolean(denied)}
                {...(denied ? { title: denied } : {})}
                onClick={() => void create()}
              >
                {creating ? "Creating…" : "Create one here"}
              </Button>
              <span style={{ fontSize: t.xs, color: c.faint }}>
                Published through {server.label ?? server.id}, and not portable — it lives where it is
                published. The DIDs pane is where to choose otherwise.
              </span>
            </>
          ) : servers.loading ? (
            <span style={{ fontSize: t.xs, color: c.faint }}>Checking where your agent can publish…</span>
          ) : (
            <Note tone="warn">
              Your agent has no hosting server registered, so it cannot mint an identifier here.
              Register one in the DIDs pane, then come back — or type a DID you already hold.
            </Note>
          )}
          <Button kind="quiet" onClick={() => setTyping(true)}>Type one instead</Button>
        </div>
      )}

      {createError && <Note tone="danger">Your agent would not create one — {createError}</Note>}
      {error && (
        <span style={{ fontSize: t.xs, color: c.warn }}>
          The list is unavailable — {error}. Typing a DID still works.
        </span>
      )}
    </div>
  );
}

/** A persona reads as its own last path segment, with what it wears beside it.
 *  The full DID is the value; this is only how the option reads. */
function personaOptionLabel(option: { did: string; note: string }): string {
  const segments = option.did.split(":");
  const tail = segments[segments.length - 1] ?? option.did;
  return `${tail} — ${option.note}`;
}

/**
 * Put a face on a persona in one context — or take it off.
 *
 * Composable: the map opens it for a context with the persona and face
 * prefilled, the guided setup opens it with the face just made. It loads what
 * the persona currently wears when given one, so "Change face" never arms an
 * unbind — see `loadCurrent`.
 */
export function BindingForm({
  parties,
  authority,
  contextId,
  contextLabel,
  profiles,
  personaDid: initialDid,
  onDone,
  onCancel,
  cancelLabel = "Cancel",
}: {
  parties: Parties;
  authority: Authority | null;
  contextId: string;
  contextLabel: string;
  profiles: PoolProfile[];
  /** A persona already known here, to change. Omit for a new one. */
  personaDid?: string | undefined;
  onDone: (outcome: string) => void;
  onCancel?: (() => void) | undefined;
  cancelLabel?: string | undefined;
}) {
  const [personaDid, setPersonaDid] = useState(initialDid ?? "");
  const [profileId, setProfileId] = useState<string>(profiles[0]?.profileId ?? "");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [pending, setPending] = useState<ConsentRequiredError | null>(null);
  const denied = holderGate(authority);
  const { suggestions, loading, error: suggestError, known, reload: reloadSuggestions } = useDidSuggestions(parties, contextId);

  // Prefill what the persona wears now, so opening the form to change a face
  // never lands on "take it off". `binding/list` returns a name, not an id, so
  // this is one `binding/get`; a failed read leaves the selection alone rather
  // than defaulting it — "nothing" is the worst guess at the moment we do not
  // know.
  const current = useAsync(
    async () =>
      initialDid ? getBinding(managerSender, { ...parties, contextId, personaDid: initialDid }) : null,
    [parties.holder.did, parties.service.did, contextId, initialDid],
  );
  useEffect(() => {
    if (current.data) setProfileId(current.data.profileId ?? "");
  }, [current.data]);

  const isKnown = known?.personas.find((b) => b.personaDid === personaDid.trim());
  const wouldNoOp = known !== null && known !== undefined && profileId === "" && !isKnown?.bound;
  const refusal = denied ?? (wouldNoOp ? "This persona wears nothing already — choose a face to put on." : null);

  const submit = useCallback(async () => {
    setBusy(true);
    setError(null);
    setPending(null);
    let outcome = "";
    const ok = await runMutation(
      async () => {
        const res = await personaBindingSet(managerSender, {
          ...parties,
          contextId,
          personaDid: personaDid.trim(),
          // An empty selection is an explicit take-off, not an omission: `null`
          // clears the binding, an absent member leaves it as it stands.
          profileId: profileId === "" ? null : profileId,
        });
        const also = res.correlation?.alsoBoundPersonaCount ?? 0;
        outcome =
          profileId === ""
            ? "Taken off. That persona now shows nothing here."
            : `Done. ${res.materialisedClaimCount ?? 0} fact(s) were copied into ${contextLabel}.` +
              (also > 0
                ? ` ${also} other persona(s) already wear this face — anyone who sees two of them knows they are the same person, and no later change undoes that.`
                : "");
      },
      { onConsent: setPending, onError: setError },
    );
    setBusy(false);
    if (ok) onDone(outcome);
  }, [parties, contextId, contextLabel, personaDid, profileId, onDone]);

  return (
    <Panel
      title={initialDid ? `Change face in ${contextLabel}` : `Be known in ${contextLabel} as…`}
      description="A persona wears a face inside one context. Your agent copies the face's facts down into
        the context; the context never reaches back up."
    >
      <div style={{ display: "grid", gap: 10, maxWidth: 560 }}>
        {initialDid ? (
          <div style={{ display: "grid", gap: 4 }}>
            <Label>PERSONA</Label>
            <span style={{ fontFamily: font.mono, fontSize: t.xs, wordBreak: "break-all", padding: "6px 0" }}>
              {initialDid}
            </span>
          </div>
        ) : (
          <PersonaPicker
            parties={parties}
            authority={authority}
            contextId={contextId}
            contextLabel={contextLabel}
            suggestions={suggestions}
            loading={loading}
            error={suggestError}
            value={personaDid}
            onChange={setPersonaDid}
            onCreated={reloadSuggestions}
          />
        )}

        <label style={{ display: "grid", gap: 4 }}>
          <Label>WEARS</Label>
          <select style={fieldStyle} value={profileId} onChange={(e) => setProfileId(e.target.value)}>
            <option value="">— nothing (take it off) —</option>
            {profiles.map((p) => (
              <option key={p.profileId} value={p.profileId}>
                {p.name} ({p.entries.length} fact(s))
              </option>
            ))}
          </select>
        </label>

        {error && <Note tone="danger">{error}</Note>}
        {pending && <ConsentCeremony pending={pending} />}

        <div style={{ display: "flex", gap: 8 }}>
          <Button
            kind="primary"
            disabled={busy || !personaDid.trim() || Boolean(refusal)}
            {...(refusal ? { title: refusal } : {})}
            onClick={() => void submit()}
          >
            {busy ? "Working…" : profileId === "" ? "Take it off" : initialDid ? "Change face" : "Put it on"}
          </Button>
          {onCancel && (
            <Button kind="quiet" disabled={busy} onClick={onCancel}>
              {cancelLabel}
            </Button>
          )}
        </div>
        {refusal && personaDid.trim() && <span style={{ fontSize: t.sm, color: c.muted }}>{refusal}</span>}
      </div>
    </Panel>
  );
}
