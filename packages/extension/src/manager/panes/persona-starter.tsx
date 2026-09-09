// "What should I put in?" — answered on the first screen, in one form.
//
// The guided setup's first step used to open a free-text claim type and an
// empty value. That is the right editor and the wrong first question: a person
// who has never seen this model does not know `name.given` is a thing they may
// write, and the vocabulary that would tell them is not on the screen. So they
// add one attribute or none, and the face they build in step two has nothing to
// choose from.
//
// This offers the answer instead — the ordinary things, in the holder's words,
// each marked against what their own agent declares (`starter-set.ts`). It is a
// shortcut into the same `persona/attribute/put` the editor beneath it uses,
// not a different way of holding anything.
//
// ## Two properties the form must keep
//
// **A row nobody typed into is not written.** `entriesToWrite` drops blanks, so
// tabbing through the form adds nothing. Writing `""` would put an attribute in
// someone's list asserting their first name is empty, and `put` is a replace,
// so the correction is a round trip rather than a no-op.
//
// **A partial failure says which half happened.** The writes are sequential and
// independent — there is no batch put — so the fifth can fail with four already
// stored. Reporting only the error would leave someone believing none of it
// landed, and a retry would then create duplicates of the four that did.

import { useCallback, useMemo, useState } from "react";
import { personaAttributePut } from "@openvtc/pnm-core/admin";
import type { ClaimTypeRegistry } from "@openvtc/pnm-core/persona";
import { Button, Note, Panel } from "../../ui.js";
import { c, t, font } from "../../theme.js";
import { managerSender } from "../sender.js";
import { holderGate } from "../holder-gate.js";
import type { Authority, Parties } from "../use-vta.js";
import {
  starterFor,
  entriesToWrite,
  whyNoIdentityDocuments,
  type OfferedSuggestion,
} from "../starter-set.js";

function Field({
  suggestion,
  value,
  onChange,
}: {
  suggestion: OfferedSuggestion;
  value: string;
  onChange: (v: string) => void;
}) {
  return (
    <label style={{ display: "grid", gap: 4 }}>
      <span style={{ display: "flex", alignItems: "baseline", gap: 8 }}>
        <span style={{ fontSize: t.sm, color: c.text }}>{suggestion.label}</span>
        <code style={{ fontFamily: font.mono, fontSize: t.xs, color: c.faint }}>
          {suggestion.type}
        </code>
      </span>
      <input
        value={value}
        aria-label={suggestion.label}
        placeholder={suggestion.hint ?? ""}
        onChange={(e) => onChange(e.target.value)}
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
      {!suggestion.declared && (
        // Said before they type, not after. An undeclared leaf resolves to the
        // most protective treatment the agent has, so the value comes back
        // masked — which is a surprise worth spending a line to avoid.
        <span style={{ fontSize: t.xs, color: c.faint }}>
          Your agent has not said what kind of value this is, so it will keep it back until you ask
          for it.
        </span>
      )}
    </label>
  );
}

export function StarterForm({
  parties,
  authority,
  registry,
  onDone,
  onManual,
}: {
  parties: Parties;
  authority: Authority | null;
  registry: ClaimTypeRegistry | null;
  /** Something was written — the pane refetches. */
  onDone: (added: number) => void;
  /** "I'd rather type my own" — hands over to the free-form editor. */
  onManual: () => void;
}) {
  const offered = useMemo(() => starterFor(registry), [registry]);
  const [values, setValues] = useState<Record<string, string>>({});
  const [more, setMore] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const denied = holderGate(authority);

  const set = useCallback((type: string, v: string) => {
    setValues((current) => ({ ...current, [type]: v }));
  }, []);

  const basics = offered.filter((o) => o.tier === "basics");
  const often = offered.filter((o) => o.tier === "often");
  const pending = entriesToWrite(offered, values);

  const save = useCallback(async () => {
    setBusy(true);
    setError(null);
    let written = 0;
    try {
      for (const entry of pending) {
        await personaAttributePut(managerSender, {
          ...parties,
          type: entry.type,
          valueType: entry.valueType,
          value: entry.value,
          label: entry.label,
          provenance: { kind: "selfAsserted" },
          // Create only. Without it a retry after a partial failure replaces
          // by last-writer-wins on a fresh id each time, which is how someone
          // ends up with two of their own first name.
          expectedVersion: 0,
        });
        written += 1;
      }
      onDone(written);
    } catch (e) {
      // Which half happened, not just what went wrong. `written` is the count
      // that is already stored; a retry must not be read as starting over.
      const message = e instanceof Error ? e.message : String(e);
      setError(
        written === 0
          ? message
          : `${written} of ${pending.length} were added before this stopped: ${message}. ` +
            `The ones already added are in your list — clear those rows before trying again.`,
      );
      if (written > 0) onDone(written);
    } finally {
      setBusy(false);
    }
  }, [pending, parties, onDone]);

  return (
    <div style={{ display: "grid", gap: 12, alignContent: "start" }}>
      <Panel title="Start with the ordinary things">
        <p style={{ margin: 0, fontSize: t.sm, color: c.muted, lineHeight: 1.6 }}>
          Fill in whatever you like and leave the rest blank — nothing here is visible anywhere yet,
          and you can add more at any time.
        </p>
        {denied && <Note tone="warn">{denied}</Note>}
        <div style={{ display: "grid", gap: 12 }}>
          {basics.map((s) => (
            <Field key={s.type} suggestion={s} value={values[s.type] ?? ""} onChange={(v) => set(s.type, v)} />
          ))}
        </div>

        {!more && (
          <div>
            <Button kind="quiet" onClick={() => setMore(true)}>
              More things sites often ask for
            </Button>
          </div>
        )}
        {more && (
          <div style={{ display: "grid", gap: 12 }}>
            <div style={{ height: 1, background: c.lineSoft }} />
            <span style={{ fontSize: t.sm, color: c.muted }}>
              Your agent keeps most of these back until you ask to see them.
            </span>
            {often.map((s) => (
              <Field key={s.type} suggestion={s} value={values[s.type] ?? ""} onChange={(v) => set(s.type, v)} />
            ))}
          </div>
        )}

        <Note tone="accent">{whyNoIdentityDocuments()}</Note>
        {error && <Note tone="danger">{error}</Note>}

        <div style={{ display: "flex", gap: 10, alignItems: "center" }}>
          <Button
            kind="primary"
            disabled={pending.length === 0 || busy || Boolean(denied)}
            onClick={() => void save()}
          >
            {busy
              ? "Adding…"
              : pending.length === 0
                ? "Add these"
                : `Add ${pending.length} attribute${pending.length === 1 ? "" : "s"}`}
          </Button>
          <Button kind="quiet" onClick={onManual}>
            I'd rather type my own
          </Button>
        </div>
      </Panel>
    </div>
  );
}
