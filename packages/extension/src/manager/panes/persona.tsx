// Persona — the holder's own identity, and the one pane in this console that
// sits ABOVE every trust context.
//
// ## What this pane is for
//
// Everywhere else in the console, a context is the compartment: keys, DIDs,
// memory and app-state all live inside one. The attribute pool and the profiles
// over it do not. There is one person here, with one set of facts about
// themselves, and the contexts are the places they choose to present some of
// them.
//
// So the pane is a stack rather than a filtered list, and the order is the
// argument: **facts** (the pool), **projections over the facts** (profiles),
// **where a projection is presented** (bindings), and then the two readings
// that only make sense once all three exist — where the identities link, and
// what has actually left.
//
// ## The boundary runs through the middle of it
//
// Every task on this page is holder-scoped: the agent gates them on an
// *unscoped holder* credential — `Admin` AND unrestricted scope — and refuses a
// context-scoped administrator exactly as it refuses an application. That is
// why `isUnscopedHolder` and not `hasRole(authority, "admin")`; see its
// docstring for the emptiness trap that makes the two different tests.
//
// The one call that crosses the boundary is `personaBindingSet`, and it crosses
// **downwards**: the agent resolves the profile up here and pushes a
// materialised copy of the values into the context. The context receives
// claims, never a reference, so nothing inside it can address the pool
// afterwards. Nothing on this page reads upwards out of a context, and there is
// no task that would let it.
//
// ## Why the console, and not the wallet
//
// The wallet half of `persona/*` ships in `@openvtc/pnm-core/persona` and is
// deliberately the context-scoped half only. Until this pane existed, authoring
// a persona was `pnm`'s job alone, because `pnm` holds the credential that can.
// The console holds it too — it administers the agent rather than acting as one
// inside it — which is what makes this pane possible at all, and why the CI
// guard on those ten URIs now names `manager.js` as its single exception rather
// than banning them outright.

import { useCallback, useMemo, useState } from "react";
import {
  personaAttributeDelete,
  personaAttributeList,
  personaAttributePut,
  personaBindingSet,
  personaCorrelationAnalyze,
  personaDisclosureHistory,
  personaProfileDelete,
  personaProfileGet,
  personaProfileList,
  personaProfilePut,
  type AttributeProvenance,
  type AttributeValueType,
  type CorrelationFinding,
  type DisclosureRecord,
  type PoolAttribute,
  type PoolProfile,
  type PoolProfileEntry,
} from "@openvtc/pnm-core/admin";
import { getBinding, listBindings } from "@openvtc/pnm-core/persona";
import { webvhDidList } from "@openvtc/pnm-core/webvh";
import type { ContextRecord } from "@openvtc/pnm-core";
import { Button, Note, Panel, Pill } from "../../ui.js";
import { c, t, font } from "../../theme.js";
import { managerSender } from "../sender.js";
import { ConsentRequiredError } from "../carrier.js";
import { ConsentCeremony, Destructive, runMutation } from "../destructive.js";
import { Loading, LoadError, Table, Truncated, type Column } from "../table.js";
import { useAsync, type Async } from "../use-async.js";
import { contextHeading, formatInstant } from "../format.js";
import { isUnscopedHolder, type Authority, type Parties } from "../use-vta.js";
import { scanForProfile } from "../profile-bindings.js";
import {
  composeEntries,
  lockedRefs,
  preservedEntries,
  refOf,
  tickedFrom,
} from "../profile-entries.js";

const fieldStyle: React.CSSProperties = {
  boxSizing: "border-box",
  padding: "6px 9px",
  background: c.ground,
  color: c.text,
  border: `1px solid ${c.line}`,
  borderRadius: "var(--w-r-sm)",
  fontSize: t.sm,
};

function Label({ children }: { children: React.ReactNode }) {
  return <span style={{ fontSize: t.xs, color: c.muted }}>{children}</span>;
}

/** The refusal every task on this page shares, phrased as the agent phrases it.
 *  Null when the caller holds what it takes. */
function holderGate(authority: Authority | null): string | null {
  if (!authority) return null;
  if (isUnscopedHolder(authority)) return null;
  return (
    "Your identity sits above every trust context, so this needs an unscoped holder " +
    "credential — Admin at this agent with no context restriction. An administrator scoped " +
    "to one context is refused here exactly as an application would be."
  );
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
 * How an entry is described in a list.
 *
 * The four forms are not decoration — pinned, overridden and inline each say
 * something different about where the value on the wire will come from, and a
 * profile editor that rendered them all as "the attribute" would hide the one
 * thing that distinguishes them.
 */
function describeEntry(entry: PoolProfileEntry, byId: Map<string, PoolAttribute>): string {
  if ("inline" in entry) {
    return `${entry.inline.type} — a value held only by this profile`;
  }
  const attr = byId.get(entry.ref);
  const name = attr ? (attr.label ?? attr.type) : entry.ref;
  if ("pinVersion" in entry) return `${name} — pinned at version ${entry.pinVersion}`;
  if ("override" in entry) return `${name} — overridden for this profile`;
  return name;
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

function severityTone(severity: string): "danger" | "warn" | "off" {
  if (severity === "high") return "danger";
  if (severity === "low") return "warn";
  return "off";
}

// ── The pool ────────────────────────────────────────────────────────────────

const VALUE_TYPES: AttributeValueType[] = ["string", "number", "boolean", "date", "object"];

/**
 * Row actions, side by side rather than stacked.
 *
 * Stacking them made every row as tall as its tallest column plus a second
 * button — two lines of chrome for one line of content, so a pool of four
 * attributes filled the viewport. The pool is a list a holder scans, and a list
 * you cannot see at once is a worse answer to "what do I hold about myself".
 *
 * `flexWrap` is what makes the row form safe rather than merely shorter:
 * `Destructive` replaces its button with a preview panel in place, and without
 * wrapping that panel would sit beside "Edit" and squeeze it. Wrapped, the
 * panel drops to its own line under the buttons and the row grows only while
 * the confirmation is open.
 */
const ROW_ACTIONS: React.CSSProperties = {
  display: "flex",
  gap: 8,
  flexWrap: "wrap",
  alignItems: "flex-start",
};

/** One datalist, one id. Only one binding form exists on the page. */
const DID_SUGGESTIONS = "persona-did-suggestions";

/**
 * Turn what was typed into the value the agent stores.
 *
 * Returns a message rather than throwing, because "that is not a number" is
 * something to say next to the field, not an exception to surface as a failed
 * task. The agent refuses a value that disagrees with its `valueType`, so
 * catching it here is the difference between a correction and a round trip.
 */
function parseValue(
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
function rawValue(value: unknown): string {
  if (value === undefined || value === null) return "";
  if (typeof value === "string") return value;
  if (typeof value === "number" || typeof value === "boolean") return String(value);
  return JSON.stringify(value, null, 2);
}

function AttributeEditor({
  parties,
  authority,
  existing,
  onDone,
  onCancel,
}: {
  parties: Parties;
  authority: Authority | null;
  existing?: PoolAttribute;
  onDone: () => void;
  onCancel: () => void;
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
            `Saved. This value is already held by ${shared} other attribute(s) — anyone who ` +
            `sees both presentations can link the personas carrying them, permanently.`;
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
      title={existing ? `Edit ${existing.label ?? existing.type}` : "New attribute"}
      description={
        existing
          ? "Editing writes a new version. A profile that references this attribute live picks " +
            "the change up everywhere it is presented — which is the point of referencing rather " +
            "than copying, and worth remembering before changing a value rather than adding one."
          : "A fact about you, held once. Profiles reference it; contexts receive a copy only " +
            "when you bind one."
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
            This attribute is <strong>credential-backed</strong>, and its provenance is kept as
            it stands — nothing here can turn a credential-backed fact into a self-asserted one.
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
            disabled={busy || !type.trim() || Boolean(denied) || Boolean(correlation)}
            {...(denied ? { title: denied } : {})}
            onClick={() => void save()}
          >
            {busy ? "Saving…" : existing ? "Save" : "Add attribute"}
          </Button>
          <Button kind="quiet" disabled={busy} onClick={onCancel}>
            Cancel
          </Button>
        </div>
        {denied && <span style={{ fontSize: t.sm, color: c.muted }}>{denied}</span>}
      </div>
    </Panel>
  );
}

function AttributesPanel({
  parties,
  authority,
  attributes,
  profiles,
  onChanged,
}: {
  parties: Parties;
  authority: Authority | null;
  attributes: Async<PoolAttribute[]>;
  profiles: Async<PoolProfile[]>;
  onChanged: () => void;
}) {
  const [editing, setEditing] = useState<PoolAttribute | null>(null);
  const [creating, setCreating] = useState(false);
  const denied = holderGate(authority);

  const rows = attributes.data ?? [];

  if (editing) {
    return (
      <AttributeEditor
        key={editing.attributeId}
        parties={parties}
        authority={authority}
        existing={editing}
        onDone={() => {
          setEditing(null);
          onChanged();
        }}
        onCancel={() => setEditing(null)}
      />
    );
  }

  const columns: Column<PoolAttribute>[] = [
    {
      key: "type",
      header: "Type",
      width: "200px",
      render: (a) => (
        <div style={{ display: "grid", gap: 2 }}>
          <span style={{ fontFamily: font.mono, fontSize: t.xs, wordBreak: "break-word" }}>
            {a.type}
          </span>
          {a.label && <span style={{ color: c.muted }}>{a.label}</span>}
        </div>
      ),
    },
    {
      key: "value",
      header: "Value",
      render: (a) => {
        const { text, withheld } = formatValue(a.value);
        return (
          <span
            style={{
              color: withheld ? c.faint : c.text,
              fontStyle: withheld ? "italic" : "normal",
              wordBreak: "break-word",
            }}
          >
            {text}
          </span>
        );
      },
    },
    {
      key: "provenance",
      header: "Provenance",
      width: "150px",
      render: (a) => (
        <div style={{ display: "grid", gap: 4 }}>
          <Pill tone={a.provenance.kind === "selfAsserted" ? "off" : "accent"}>
            {a.provenance.kind === "credentialBacked"
              ? "credential"
              : a.provenance.kind === "generated"
                ? "generated"
                : "self-asserted"}
          </Pill>
          {/* A stale attribute is shown, never hidden: a holder deciding what to
              present needs to see that a credential can no longer be
              re-derived, not to have the row quietly disappear. */}
          {a.stale && <Pill tone="warn">stale{a.staleReason ? ` · ${a.staleReason}` : ""}</Pill>}
        </div>
      ),
    },
    {
      key: "updated",
      header: "Updated",
      width: "160px",
      // The timestamp alone: `version` is deliberately not shown. See the
      // block above `severityTone`.
      render: (a) => <span style={{ color: c.muted }}>{formatInstant(a.updatedAt)}</span>,
    },
    {
      key: "actions",
      header: "",
      render: (a) => (
        <div style={ROW_ACTIONS}>
          <Button kind="quiet" onClick={() => setEditing(a)}>
            Edit
          </Button>
          <Destructive<PoolProfile[]>
            label="Delete"
            disabledReason={denied}
            // The cost of this delete is "which profiles stop projecting it",
            // and the console can answer that exactly: a profile's entries
            // carry the attribute id. Asked again here rather than read off
            // the table above, so the answer is current at the moment of the
            // decision rather than whenever the page last loaded.
            preview={async () => {
              const current = await personaProfileList(managerSender, parties);
              return current.filter((p) => p.entries.some((e) => refOf(e) === a.attributeId));
            }}
            renderPreview={(referring) => (
              <>
                <strong>Deleting an attribute cannot be undone.</strong>
                <span style={{ fontFamily: font.mono, fontSize: t.xs }}>{a.type}</span>
                {referring.length === 0 ? (
                  <span>No profile references it, so nothing stops presenting anything.</span>
                ) : (
                  <>
                    <span>
                      {referring.length} profile(s) reference it and will stop projecting it:
                    </span>
                    <span style={{ color: c.muted }}>
                      {referring.map((p) => p.name).join(", ")}
                    </span>
                    <span>
                      Every persona bound to one of those profiles presents one claim fewer from
                      the next disclosure onwards. Nothing already disclosed is affected — that
                      has left.
                    </span>
                  </>
                )}
              </>
            )}
            needsForce={(referring) => referring.length > 0}
            forceLabel="Remove it from those profiles too"
            commit={async (force) => {
              await personaAttributeDelete(managerSender, {
                ...parties,
                attributeId: a.attributeId,
                cascade: force,
              });
            }}
            onDone={onChanged}
          />
        </div>
      ),
    },
  ];

  return (
    <div style={{ display: "grid", gap: 16 }}>
      <Panel
        title="Attributes"
        description="The facts you hold about yourself, each stored once. Nothing here is inside a
          trust context — a context receives a copy only when you bind a profile to a persona in
          it."
      >
        {attributes.error && <LoadError what="your attributes" error={attributes.error} />}
        {attributes.loading && !attributes.data && <Loading what="your attributes" />}
        {attributes.data && (
          <Table
            columns={columns}
            rows={rows}
            rowKey={(a) => a.attributeId}
            empty="Nothing yet. An attribute is a single fact — a name, a phone number, a date of
              birth — that profiles then project."
          />
        )}
        {profiles.error && (
          <Note tone="warn">
            Deleting an attribute will still say what it would cost, but the profile list this
            page loaded is stale — {profiles.error}
          </Note>
        )}
        {!creating && (
          <div>
            <Button
              disabled={Boolean(denied)}
              {...(denied ? { title: denied } : {})}
              onClick={() => setCreating(true)}
            >
              New attribute
            </Button>
          </div>
        )}
      </Panel>

      {creating && (
        <AttributeEditor
          key="new"
          parties={parties}
          authority={authority}
          onDone={() => {
            setCreating(false);
            onChanged();
          }}
          onCancel={() => setCreating(false)}
        />
      )}
    </div>
  );
}

// ── Profiles ────────────────────────────────────────────────────────────────

function ProfileEditor({
  parties,
  authority,
  attributes,
  existing,
  onDone,
  onCancel,
}: {
  parties: Parties;
  authority: Authority | null;
  attributes: PoolAttribute[];
  existing?: PoolProfile;
  onDone: () => void;
  onCancel: () => void;
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

  const toggle = (id: string) =>
    setSelected((s) => {
      const next = new Set(s);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });

  return (
    <Panel
      title={existing ? `Edit ${existing.name}` : "New profile"}
      description="A profile is a whitelist over your attributes. What you leave unticked is
        excluded — including anything you add to the pool later, which is the whole reason it is
        a whitelist and not a list of exclusions."
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
            Yours, and shown to you. A context sees the name of the profile a persona presents.
          </span>
        </label>

        <div style={{ display: "grid", gap: 6 }}>
          <Label>PROJECTS</Label>
          {attributes.length === 0 ? (
            <span style={{ fontSize: t.sm, color: c.faint }}>
              There are no attributes to project yet. Add one above first.
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
            Ticked attributes are referenced <em>live</em>: change a phone number once and every
            profile referencing it changes with it.
          </span>
        </div>

        {preserved.length > 0 && (
          <Note tone="accent">
            <div style={{ display: "grid", gap: 6 }}>
              <strong>
                {preserved.length} entr{preserved.length === 1 ? "y" : "ies"} in this profile
                cannot be edited here, and are kept as they are.
              </strong>
              <span>
                A pinned, overridden or profile-local entry says something the tick list above
                cannot: which version is presented, a value used only here, or a value that lives
                nowhere else. Rebuilding the profile from the ticks alone would drop them
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
            disabled={busy || !name.trim() || Boolean(denied)}
            {...(denied ? { title: denied } : {})}
            onClick={() => void save()}
          >
            {busy ? "Saving…" : existing ? "Save" : "Create profile"}
          </Button>
          <Button kind="quiet" disabled={busy} onClick={onCancel}>
            Cancel
          </Button>
        </div>
        {denied && <span style={{ fontSize: t.sm, color: c.muted }}>{denied}</span>}
      </div>
    </Panel>
  );
}

/**
 * Deleting a profile, which is deliberately **not** a `Destructive`.
 *
 * Everything else irreversible in this console previews by asking the agent
 * what the change would cost. There is no read that answers it here: "which
 * personas present this profile" spans every context, and the only code that
 * computes it is inside `persona/profile/delete` itself. The agent's design is
 * to refuse the delete while anything is bound and name what it found, so the
 * cost arrives *with the refusal* rather than before it.
 *
 * `Destructive`'s force tick is the wrong shape for that: it disables the
 * confirm button until ticked, which would make every operator authorise an
 * unbind for the ordinary case where nothing is bound. So the choice is
 * offered as an ordinary option, defaulted off, and the agent's refusal is what
 * tells the operator to turn it on — with its own count, which is the number
 * that matters.
 */
function DeleteProfile({
  parties,
  profile,
  disabledReason,
  onDone,
}: {
  parties: Parties;
  profile: PoolProfile;
  disabledReason: string | null;
  onDone: () => void;
}) {
  const [open, setOpen] = useState(false);
  const [unbind, setUnbind] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [pending, setPending] = useState<ConsentRequiredError | null>(null);

  const run = useCallback(async () => {
    setBusy(true);
    setError(null);
    setPending(null);
    const ok = await runMutation(
      async () => {
        await personaProfileDelete(managerSender, {
          ...parties,
          profileId: profile.profileId,
          unbind,
        });
      },
      { onConsent: setPending, onError: setError },
    );
    setBusy(false);
    if (ok) {
      setOpen(false);
      setUnbind(false);
      onDone();
    }
  }, [parties, profile.profileId, unbind, onDone]);

  if (!open) {
    return (
      <Button
        kind="danger"
        disabled={Boolean(disabledReason)}
        {...(disabledReason ? { title: disabledReason } : {})}
        onClick={() => setOpen(true)}
      >
        Delete
      </Button>
    );
  }

  return (
    <div style={{ display: "grid", gap: 12, maxWidth: 460 }}>
      <Note tone="danger">
        <div style={{ display: "grid", gap: 8 }}>
          <strong>Deleting “{profile.name}” cannot be undone.</strong>
          <span>
            It projects {profile.entries.length} attribute(s). The attributes themselves are
            untouched — a profile is a view over them, not a copy.
          </span>
          <span>
            Your agent refuses this while any persona is still presenting the profile, and says
            how many. Nothing already disclosed is affected.
          </span>
        </div>
      </Note>

      <label style={{ display: "flex", gap: 8, alignItems: "flex-start", fontSize: t.sm }}>
        <input
          type="checkbox"
          checked={unbind}
          onChange={(e) => setUnbind(e.target.checked)}
          style={{ marginTop: 2 }}
        />
        <span>
          Unbind any persona presenting it first, in every context. Those personas are left
          presenting <em>nothing</em> — a legal state, and one you will not be told about again.
        </span>
      </label>

      {error && <Note tone="danger">{error}</Note>}
      {pending && <ConsentCeremony pending={pending} />}

      <div style={{ display: "flex", gap: 8 }}>
        <Button kind="danger" disabled={busy} onClick={() => void run()}>
          {busy ? "Working…" : unbind ? "Unbind and delete" : "Delete profile"}
        </Button>
        <Button
          kind="quiet"
          disabled={busy}
          onClick={() => {
            setOpen(false);
            setUnbind(false);
            setError(null);
          }}
        >
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
function ResolvedProfile({
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

  if (resolved.error) return <LoadError what={`what ${name} presents`} error={resolved.error} />;
  if (!resolved.data) return <Loading what={`what ${name} presents`} />;

  const claims = resolved.data.resolved ?? [];
  if (claims.length === 0) {
    return (
      <div style={{ fontSize: t.sm, color: c.faint, padding: "6px 0" }}>
        This profile presents nothing. A persona bound to it discloses no claims.
      </div>
    );
  }

  return (
    <div style={{ display: "grid", gap: 6, padding: "4px 0 6px" }}>
      <span style={{ fontSize: t.xs, color: c.faint, textTransform: "uppercase", letterSpacing: 0.4 }}>
        What a verifier would receive
      </span>
      {claims.map((claim, i) => {
        const { text, withheld } = formatValue(claim.value);
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
            <span style={{ color: withheld ? c.faint : c.text, wordBreak: "break-word" }}>{text}</span>
            {inline && <Pill tone="accent">held only here</Pill>}
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
function ProfileBindings({
  parties,
  profile,
  records,
}: {
  parties: Parties;
  profile: PoolProfile;
  records: ContextRecord[];
}) {
  const found = useAsync(
    async () =>
      scanForProfile(
        records.map((r) => r.id),
        { profileId: profile.profileId, name: profile.name },
        {
          list: (contextId) => listBindings(managerSender, { ...parties, contextId }),
          get: (contextId, personaDid) =>
            getBinding(managerSender, { ...parties, contextId, personaDid }),
        },
      ),
    [parties.holder.did, parties.service.did, profile.profileId, profile.name, records.length],
  );

  if (found.error) return <LoadError what={`who presents ${profile.name}`} error={found.error} />;
  if (!found.data) return <Loading what={`who presents ${profile.name}`} />;

  const { rows, unreadable } = found.data;

  return (
    <div style={{ display: "grid", gap: 6, padding: "4px 0 6px" }}>
      <span style={{ fontSize: t.xs, color: c.faint, textTransform: "uppercase", letterSpacing: 0.4 }}>
        Presented by
      </span>
      {rows.length === 0 ? (
        <span style={{ fontSize: t.sm, color: c.faint }}>
          No persona presents this profile. Nothing discloses it, in any context.
        </span>
      ) : (
        rows.map((row) => (
          <div
            key={`${row.contextId}-${row.personaDid}`}
            style={{ display: "flex", gap: 10, flexWrap: "wrap", alignItems: "baseline" }}
          >
            <span style={{ fontFamily: font.mono, fontSize: t.xs, wordBreak: "break-all" }}>
              {row.personaDid}
            </span>
            <span style={{ color: c.muted, fontSize: t.sm }}>
              in {contextHeading(records.find((r) => r.id === row.contextId), row.contextId)} ·{" "}
              {row.claimCount} claim(s)
            </span>
          </div>
        ))
      )}
      {rows.length > 1 && (
        // The whole reason a holder asks. Two personas presenting one profile
        // present identical values, so anyone who sees both knows they are the
        // same person — and no later narrowing undoes it for someone who
        // already saw them.
        <Note tone="warn">
          {rows.length} personas present this profile. They disclose the same values, so anyone
          who sees two of them knows they are the same person — permanently.
        </Note>
      )}
      {unreadable.length > 0 && (
        <Note tone="warn">
          This answer is incomplete: your agent would not answer for {unreadable.join(", ")}. A
          persona there could be presenting this profile without appearing above.
        </Note>
      )}
    </div>
  );
}

function ProfilesPanel({
  parties,
  authority,
  attributes,
  profiles,
  records,
  onChanged,
}: {
  parties: Parties;
  authority: Authority | null;
  attributes: PoolAttribute[];
  profiles: Async<PoolProfile[]>;
  /** The contexts to look in when asked who presents a profile. */
  records: ContextRecord[];
  onChanged: () => void;
}) {
  const [editing, setEditing] = useState<PoolProfile | null>(null);
  const [creating, setCreating] = useState(false);
  /** Which row is expanded, and which of its two questions it is answering.
   *  One state rather than two, so opening either closes the other — a row
   *  showing both at once reads as one list. */
  const [open, setOpen] = useState<{ profileId: string; view: "claims" | "where" } | null>(null);
  const denied = holderGate(authority);

  const byId = useMemo(
    () => new Map(attributes.map((a) => [a.attributeId, a])),
    [attributes],
  );

  const toggle = (profileId: string, view: "claims" | "where") =>
    setOpen((current) =>
      current?.profileId === profileId && current.view === view ? null : { profileId, view },
    );

  if (editing) {
    return (
      <ProfileEditor
        key={editing.profileId}
        parties={parties}
        authority={authority}
        attributes={attributes}
        existing={editing}
        onDone={() => {
          setEditing(null);
          onChanged();
        }}
        onCancel={() => setEditing(null)}
      />
    );
  }

  const columns: Column<PoolProfile>[] = [
    {
      key: "name",
      header: "Profile",
      width: "180px",
      render: (p) => <span style={{ fontWeight: 600 }}>{p.name}</span>,
    },
    {
      key: "entries",
      header: "Projects",
      render: (p) =>
        p.entries.length === 0 ? (
          <span style={{ color: c.faint }}>nothing — a persona bound to this presents no claims</span>
        ) : (
          <div style={{ display: "grid", gap: 3 }}>
            {p.entries.map((e, i) => (
              <span key={`${p.profileId}-${i}`} style={{ color: c.muted }}>
                {describeEntry(e, byId)}
              </span>
            ))}
          </div>
        ),
    },
    {
      key: "updated",
      header: "Updated",
      width: "160px",
      render: (p) => <span style={{ color: c.muted }}>{formatInstant(p.updatedAt)}</span>,
    },
    {
      key: "actions",
      header: "",
      render: (p) => (
        <div style={ROW_ACTIONS}>
          <Button
            kind="quiet"
            disabled={Boolean(denied)}
            {...(denied ? { title: denied } : {})}
            onClick={() => toggle(p.profileId, "claims")}
          >
            {open?.profileId === p.profileId && open.view === "claims" ? "Hide" : "What it presents"}
          </Button>
          <Button
            kind="quiet"
            disabled={Boolean(denied)}
            {...(denied ? { title: denied } : {})}
            onClick={() => toggle(p.profileId, "where")}
          >
            {open?.profileId === p.profileId && open.view === "where" ? "Hide" : "Who presents it"}
          </Button>
          <Button kind="quiet" onClick={() => setEditing(p)}>
            Edit
          </Button>
          <DeleteProfile
            parties={parties}
            profile={p}
            disabledReason={denied}
            onDone={onChanged}
          />
        </div>
      ),
    },
  ];

  return (
    <div style={{ display: "grid", gap: 16 }}>
      <Panel
        title="Profiles"
        description="Which of your attributes travel together. A profile references the pool
          rather than copying it, so a value changed once changes everywhere it is presented."
      >
        {profiles.error && <LoadError what="your profiles" error={profiles.error} />}
        {profiles.loading && !profiles.data && <Loading what="your profiles" />}
        {profiles.data && (
          <Table
            columns={columns}
            rows={profiles.data}
            rowKey={(p) => p.profileId}
            expanded={(p) => {
              if (open?.profileId !== p.profileId) return null;
              return open.view === "claims" ? (
                <ResolvedProfile parties={parties} profileId={p.profileId} name={p.name} />
              ) : (
                <ProfileBindings parties={parties} profile={p} records={records} />
              );
            }}
            empty="No profiles yet. Until there is one, no persona has anything to present."
          />
        )}
        {!creating && (
          <div>
            <Button
              disabled={Boolean(denied)}
              {...(denied ? { title: denied } : {})}
              onClick={() => setCreating(true)}
            >
              New profile
            </Button>
          </div>
        )}
      </Panel>

      {creating && (
        <ProfileEditor
          key="new"
          parties={parties}
          authority={authority}
          attributes={attributes}
          onDone={() => {
            setCreating(false);
            onChanged();
          }}
          onCancel={() => setCreating(false)}
        />
      )}
    </div>
  );
}

// ── Bindings ────────────────────────────────────────────────────────────────

/** One row of `persona/binding/list` — thin by construction at the agent:
 *  whether bound, the profile's label, a claim count. Never the contents. */
type BindingRow = Awaited<ReturnType<typeof listBindings>>["personas"][number];

/**
 * What one persona actually presents in one context.
 *
 * Two calls, and the first is not avoidable: `binding/list` gives a profile
 * *name* and a count, never a `profileId` and never contents — thin by
 * construction, because a binding read that returned values would make the
 * disclosure gate decorative. So `binding/get` resolves the id, and
 * `profile/get?resolve=true` resolves what it projects.
 *
 * **This is a truthful answer only because a pool edit now pushes.** The
 * resolved profile is what the agent last materialised into the context; until
 * VTI#1281 nothing called `rematerialise`, so the two could disagree and this
 * view would have shown a holder values their verifiers were never given.
 * Reading the profile is the right source *because* the push exists — not a
 * convenient stand-in for the copy.
 */
function PersonaClaims({
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
        Your agent did not name the profile behind this binding, so there is nothing to resolve.
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

function BindingsPanel({
  parties,
  authority,
  profiles,
  records,
}: {
  parties: Parties;
  authority: Authority | null;
  profiles: PoolProfile[];
  records: ContextRecord[];
}) {
  const [contextId, setContextId] = useState<string>("");
  const [showing, setShowing] = useState<string | null>(null);
  const [personaDid, setPersonaDid] = useState("");
  const [profileId, setProfileId] = useState<string>("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [pending, setPending] = useState<ConsentRequiredError | null>(null);
  const [outcome, setOutcome] = useState<string | null>(null);

  const denied = holderGate(authority);

  const bindings = useAsync(
    async () =>
      contextId ? listBindings(managerSender, { ...parties, contextId }) : null,
    [parties.holder.did, parties.service.did, contextId],
  );

  // The identifiers this context publishes — the same read the DIDs pane makes.
  // Loaded separately from the bindings, and allowed to fail on its own: this
  // is a convenience, and a picker that could not load must not take the field
  // down with it.
  const published = useAsync(
    async () => (contextId ? webvhDidList(managerSender, { ...parties, contextId }) : null),
    [parties.holder.did, parties.service.did, contextId],
  );

  /**
   * What to offer in the picker, and why it is a `datalist` rather than a
   * `<select>`.
   *
   * **A persona DID is not necessarily one of the context's published
   * `did:webvh` identifiers.** A v4 holder is a `did:key` the VTA mints, peers
   * are reached at `did:peer`, and a binding names whichever identifier this
   * context knows the holder by. A select would refuse every one of those —
   * turning a convenience into a constraint, and a wrong one.
   *
   * So the two sources are suggestions over a field that still takes anything:
   * the DIDs this context publishes, and the personas already bound here (which
   * the first list does not contain when the persona is not a webvh DID —
   * exactly the case a picker built only from published DIDs would hide).
   */
  const suggestions = useMemo(() => {
    const out = new Map<string, string>();
    for (const d of published.data?.dids ?? []) {
      out.set(d.did, `published in ${d.contextId}`);
    }
    for (const b of bindings.data?.personas ?? []) {
      // Already-bound wins the label: "presents work" says more than "published
      // here", and it is the line an operator is looking for when they came to
      // change a binding.
      out.set(
        b.personaDid,
        b.bound ? `already presents ${b.profileName ?? "a profile"}` : "bound here, presenting nothing",
      );
    }
    return [...out].map(([did, note]) => ({ did, note }));
  }, [published.data, bindings.data]);

  const bind = useCallback(async () => {
    setBusy(true);
    setError(null);
    setPending(null);
    setOutcome(null);
    const ok = await runMutation(
      async () => {
        const res = await personaBindingSet(managerSender, {
          ...parties,
          contextId,
          personaDid: personaDid.trim(),
          // An empty selection is an explicit unbind, not an omission. The
          // agent distinguishes the two: `null` clears the binding, an absent
          // member leaves it as it stands.
          profileId: profileId === "" ? null : profileId,
        });
        const also = res.correlation?.alsoBoundPersonaCount ?? 0;
        setOutcome(
          profileId === ""
            ? "Unbound. That persona now presents nothing in this context."
            : `Bound. ${res.materialisedClaimCount ?? 0} claim(s) were copied into the context.` +
              (also > 0
                ? ` ${also} other persona(s) already present this profile — anyone who sees both ` +
                  `knows they are the same person, and no later change undoes that.`
                : ""),
        );
      },
      { onConsent: setPending, onError: setError },
    );
    setBusy(false);
    if (ok) bindings.reload();
  }, [parties, contextId, personaDid, profileId, bindings]);

  /**
   * Load what a persona currently presents, and preselect it.
   *
   * Without this, "Change…" filled in the DID and left PRESENTS on its first
   * option — which is *unbind*. The button relabels itself to "Unbind", so
   * nothing was silently destructive, but an affordance called "Change…" that
   * arms a removal is a trap laid for the one operator who does not read the
   * button. It costs one call: `binding/list` returns `profileName` and not
   * `profileId`, so the row on screen cannot answer this and `binding/get` has
   * to be asked.
   */
  const loadCurrent = useCallback(
    async (did: string) => {
      setPersonaDid(did);
      setOutcome(null);
      setError(null);
      if (!contextId) return;
      try {
        const current = await getBinding(managerSender, { ...parties, contextId, personaDid: did });
        setProfileId(current.profileId ?? "");
      } catch (e) {
        // Leave the selection alone rather than defaulting it. Falling back to
        // "" would put the form on "unbind" precisely when we failed to find
        // out what it was — the one case where guessing is worst.
        setError(
          `Loaded the persona, but your agent would not say what it presents — ` +
            `${e instanceof Error ? e.message : String(e)}. Check the row above before saving.`,
        );
      }
    },
    [parties, contextId],
  );

  /**
   * Why the submit is unavailable, or null when it is.
   *
   * The second clause is the interesting one. `profileId === ""` means unbind,
   * and unbinding a persona that presents nothing is a call that changes
   * nothing — so a fresh form, whose profile select starts on its first option,
   * offered a button labelled "Unbind" as the default action for a persona that
   * had never been bound. Harmless to press and confusing to read: the operator
   * came to bind, and the console named the opposite.
   *
   * Only applied when the bindings actually loaded. Not knowing whether a
   * persona is bound is not the same as knowing it is not, and disabling on a
   * failed read would refuse a legitimate unbind because a *different* call
   * failed.
   */
  const known = bindings.data?.personas.find((b) => b.personaDid === personaDid.trim());
  const submitRefusal =
    denied ??
    (bindings.data && profileId === "" && !known?.bound
      ? "This persona presents nothing already — choose a profile to bind it to."
      : null);

  const columns: Column<BindingRow>[] = [
    {
      key: "persona",
      header: "Persona",
      render: (b) => (
        <span style={{ fontFamily: font.mono, fontSize: t.xs, wordBreak: "break-all" }}>
          {b.personaDid}
        </span>
      ),
    },
    {
      key: "presents",
      header: "Presents",
      width: "220px",
      // The profile name and a count are all `binding/list` returns — thin by
      // construction at the agent, which never sends claim contents on this
      // path. So the count is a link rather than an answer: it says how much
      // there is, and clicking asks what it is.
      render: (b) =>
        b.bound ? (
          <Button
            kind="quiet"
            onClick={() => setShowing((did) => (did === b.personaDid ? null : b.personaDid))}
          >
            {b.profileName ?? "a profile"} · {b.claimCount ?? 0} claim(s)
          </Button>
        ) : (
          <Pill tone="off">nothing</Pill>
        ),
    },
    {
      key: "actions",
      header: "",
      width: "120px",
      render: (b) => (
        <Button kind="quiet" onClick={() => void loadCurrent(b.personaDid)}>
          Change…
        </Button>
      ),
    },
  ];

  return (
    <Panel
      title="What each persona presents"
      description="A binding is where your identity crosses into a context, and it only ever
        crosses downwards: your agent resolves the profile up here and pushes a copy of the values
        into the context. The context receives claims, never a reference back to the pool."
    >
      <div style={{ display: "grid", gap: 12 }}>
        <label style={{ display: "grid", gap: 4, maxWidth: 420 }}>
          <Label>CONTEXT</Label>
          <select
            style={fieldStyle}
            value={contextId}
            onChange={(e) => {
              setContextId(e.target.value);
              setOutcome(null);
            }}
          >
            <option value="">Select a context…</option>
            {records.map((r) => (
              <option key={r.id} value={r.id}>
                {contextHeading(r, r.id)}
              </option>
            ))}
          </select>
        </label>

        {!contextId ? (
          <Note tone="accent">
            <strong>Pick a context.</strong> A binding lives in one, and the same persona DID in
            two contexts is two unrelated bindings — which is the property that keeps the two
            sides of your life apart.
          </Note>
        ) : (
          <>
            {bindings.error && <LoadError what="the bindings in this context" error={bindings.error} />}
            {bindings.loading && !bindings.data && <Loading what="the bindings in this context" />}
            {bindings.data && (
              <>
                <Table
                  columns={columns}
                  rows={bindings.data.personas}
                  rowKey={(b) => b.personaDid}
                  expanded={(b) =>
                    showing === b.personaDid && b.bound ? (
                      <PersonaClaims
                        parties={parties}
                        contextId={contextId}
                        personaDid={b.personaDid}
                        profileName={b.profileName ?? "this profile"}
                      />
                    ) : null
                  }
                  empty="No persona has ever been bound in this context. Name one below to start."
                />
                {bindings.data.nextCursor && <Truncated what="the personas in this context" />}
              </>
            )}

            <div style={{ display: "grid", gap: 10, maxWidth: 560 }}>
              <label style={{ display: "grid", gap: 4 }}>
                <Label>PERSONA DID</Label>
                <input
                  style={{ ...fieldStyle, fontFamily: font.mono }}
                  value={personaDid}
                  onChange={(e) => setPersonaDid(e.target.value)}
                  placeholder="did:webvh:…"
                  list={DID_SUGGESTIONS}
                />
                <datalist id={DID_SUGGESTIONS}>
                  {suggestions.map((option) => (
                    <option key={option.did} value={option.did} label={option.note} />
                  ))}
                </datalist>
                <span style={{ fontSize: t.xs, color: c.faint, lineHeight: 1.5 }}>
                  The identifier this context knows you by.{" "}
                  {published.loading
                    ? "Loading the DIDs this context publishes…"
                    : suggestions.length > 0
                      ? `${suggestions.length} to choose from — or type any DID, since a persona ` +
                        "need not be one this context published."
                      : "Type any DID. Create one in the DIDs pane if this context has none yet."}
                </span>
                {published.error && (
                  // Not a `LoadError`: nothing here failed that stops the
                  // operator binding. Saying "your agent would not return the
                  // DIDs" beside a working field reads as a broken form.
                  <span style={{ fontSize: t.xs, color: c.warn }}>
                    Suggestions unavailable — {published.error}. Typing a DID still works.
                  </span>
                )}
              </label>

              <label style={{ display: "grid", gap: 4 }}>
                <Label>PRESENTS</Label>
                <select
                  style={fieldStyle}
                  value={profileId}
                  onChange={(e) => setProfileId(e.target.value)}
                >
                  <option value="">— nothing (unbind) —</option>
                  {profiles.map((p) => (
                    <option key={p.profileId} value={p.profileId}>
                      {p.name} ({p.entries.length} attribute(s))
                    </option>
                  ))}
                </select>
              </label>

              {error && <Note tone="danger">{error}</Note>}
              {pending && <ConsentCeremony pending={pending} />}
              {outcome && <Note tone="accent">{outcome}</Note>}

              <div>
                <Button
                  kind="primary"
                  disabled={busy || !personaDid.trim() || Boolean(submitRefusal)}
                  {...(submitRefusal ? { title: submitRefusal } : {})}
                  onClick={() => void bind()}
                >
                  {busy ? "Working…" : profileId === "" ? "Unbind" : "Bind"}
                </Button>
              </div>
              {submitRefusal && personaDid.trim() && (
                <span style={{ fontSize: t.sm, color: c.muted }}>{submitRefusal}</span>
              )}
            </div>
          </>
        )}
      </div>
    </Panel>
  );
}

// ── Where the identities link ───────────────────────────────────────────────

function CorrelationPanel({
  parties,
  authority,
}: {
  parties: Parties;
  authority: Authority | null;
}) {
  const [findings, setFindings] = useState<CorrelationFinding[] | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const denied = holderGate(authority);

  const run = useCallback(async () => {
    setBusy(true);
    setError(null);
    try {
      setFindings(await personaCorrelationAnalyze(managerSender, parties));
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  }, [parties]);

  return (
    <Panel
      title="Where your identities link"
      description="Two personas that present the same value are the same person to anyone who
        sees both, and no later narrowing undoes it. This asks your agent where that already
        holds."
    >
      <div style={{ display: "grid", gap: 12 }}>
        <Note tone="accent">
          Run on demand, and only ever here. The answer is the map of how your identities join
          up — the one thing this whole family exists to keep anyone else from assembling — so
          it is not something the console leaves lying on screen.
        </Note>

        {error && <Note tone="danger">Your agent would not analyse this — {error}</Note>}

        {findings && findings.length === 0 && (
          <Note tone="accent">
            Nothing in your pool correlates. That is an answer, not an empty result.
          </Note>
        )}

        {findings && findings.length > 0 && (
          <div style={{ display: "grid", gap: 10 }}>
            {findings.map((f, i) => (
              <div
                key={`${f.attributeId ?? "candidate"}-${i}`}
                style={{
                  border: `1px solid ${c.line}`,
                  borderRadius: "var(--w-r-sm)",
                  padding: "10px 12px",
                  display: "grid",
                  gap: 6,
                }}
              >
                <div style={{ display: "flex", gap: 10, alignItems: "center", flexWrap: "wrap" }}>
                  <Pill tone={severityTone(f.severity)}>{f.severity}</Pill>
                  {f.attributeId && (
                    <span style={{ fontFamily: font.mono, fontSize: t.xs, color: c.muted }}>
                      {f.attributeId}
                    </span>
                  )}
                </div>
                <span style={{ lineHeight: 1.55 }}>{f.why}</span>
                {f.remedies.length > 0 && (
                  <span style={{ fontSize: t.sm, color: c.muted }}>
                    What you can do: {f.remedies.join(", ")}
                  </span>
                )}
              </div>
            ))}
            {/* Severity here is a function of the value AND how it is proved,
                never of provenance alone, and it reads backwards until that is
                said: a credential presented whole carries an identical issuer
                signature to every verifier that sees it, so it correlates more
                than a value you asserted yourself. */}
            <Note tone="warn">
              A credential presented <em>whole</em> correlates more than a value you asserted
              yourself — it carries the same issuer signature to everyone who sees it. A derived
              or predicate proof correlates less. Severity follows that, not "how official the
              fact is".
            </Note>
          </div>
        )}

        <div>
          <Button
            disabled={busy || Boolean(denied)}
            {...(denied ? { title: denied } : {})}
            onClick={() => void run()}
          >
            {busy ? "Asking your agent…" : findings ? "Check again" : "Check for linkage"}
          </Button>
        </div>
        {denied && <span style={{ fontSize: t.sm, color: c.muted }}>{denied}</span>}
      </div>
    </Panel>
  );
}

// ── What has left ───────────────────────────────────────────────────────────

function DisclosureHistoryPanel({
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
      description="Every disclosure your agent has made on your behalf, across every context.
        This is the only reading in the console that spans them — which is exactly why it is
        holder-only."
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
            <Label>VERIFIER DID</Label>
            <input
              style={{ ...fieldStyle, fontFamily: font.mono }}
              value={verifierDid}
              onChange={(e) => setVerifierDid(e.target.value)}
              placeholder="any"
            />
          </label>
          <Button onClick={() => setQuery({ contextId, verifierDid })}>Apply</Button>
        </div>

        {history.error && <LoadError what="your disclosure history" error={history.error} />}
        {history.loading && !history.data && <Loading what="your disclosure history" />}
        {history.data && (
          <>
            <Table
              columns={columns}
              rows={history.data.disclosures}
              rowKey={(d) => d.disclosureId}
              empty={
                query.contextId || query.verifierDid
                  ? "Nothing matches that. Widen the filters to see the rest."
                  : "Nothing has been disclosed from this agent yet."
              }
            />
            {history.data.nextCursor && <Truncated what="your disclosure history" />}
          </>
        )}
        {denied && <span style={{ fontSize: t.sm, color: c.muted }}>{denied}</span>}
      </div>
    </Panel>
  );
}

// ── The pane ────────────────────────────────────────────────────────────────

export function PersonaPane({
  parties,
  authority,
  records,
}: {
  parties: Parties;
  authority: Authority | null;
  /** The contexts the shell already loaded. Shared rather than refetched, so a
   *  binding names a context by the same label the tree does. */
  records: ContextRecord[];
}) {
  // Attributes and profiles are fetched once, here, and handed to both panels
  // that need them. A profile's entries reference attribute ids, and an
  // attribute's delete cost is "which profiles project it": two fetches would
  // let the two halves of one screen describe different states of the store.
  const attributes = useAsync(
    // Values are asked for deliberately. This pane is the holder looking at
    // their own pool from a surface holding an unscoped holder credential —
    // the one place where showing them is the job — and a table of types with
    // no values cannot answer "is this the right phone number".
    async () => personaAttributeList(managerSender, { ...parties, includeValues: true }),
    [parties.holder.did, parties.service.did],
  );
  const profiles = useAsync(
    async () => personaProfileList(managerSender, parties),
    [parties.holder.did, parties.service.did],
  );

  const reloadAll = useCallback(() => {
    attributes.reload();
    profiles.reload();
  }, [attributes, profiles]);

  const denied = holderGate(authority);

  return (
    <div style={{ display: "grid", gap: 16, alignContent: "start" }}>
      <Panel
        title="Your identity, above every context"
        description="The facts you hold about yourself, the profiles that select among them, and
          the personas that present a profile inside one trust context."
      >
        <div style={{ fontSize: t.sm, color: c.muted, lineHeight: 1.55 }}>
          Nothing on this page belongs to a context, which is why the tree beside the other panes
          is absent here. The boundary runs one way: you push a copy down into a context when you
          bind a profile, and a context can never read back up.
        </div>
        {denied && <Note tone="warn">{denied}</Note>}
      </Panel>

      <AttributesPanel
        parties={parties}
        authority={authority}
        attributes={attributes}
        profiles={profiles}
        onChanged={reloadAll}
      />

      <ProfilesPanel
        parties={parties}
        authority={authority}
        attributes={attributes.data ?? []}
        profiles={profiles}
        records={records}
        onChanged={reloadAll}
      />

      <BindingsPanel
        parties={parties}
        authority={authority}
        profiles={profiles.data ?? []}
        records={records}
      />

      <CorrelationPanel parties={parties} authority={authority} />

      <DisclosureHistoryPanel parties={parties} authority={authority} records={records} />
    </div>
  );
}
