// The first five minutes: an attribute, a face, a context.
//
// Shown while the holder has no face yet — the one state in which the identity
// map has nothing to draw and a stack of empty bands would answer "what do I
// do?" with silence. Three steps, in the order the model runs, each saying what
// it changes before it is done; and beside the second, the exact card someone
// would receive, updating as attributes are ticked, because that card is the whole
// point of a face and the thing a person cannot picture from a list of
// checkboxes.
//
// It composes the same editors the map uses (`persona-editors.tsx`). Nothing
// here writes to the agent on its own; it decides only what to show next.

import { useState } from "react";
import type { PoolAttribute, PoolProfile } from "@openvtc/pnm-core/admin";
import type { ContextRecord } from "@openvtc/pnm-core";
import type { ClaimTypeRegistry } from "@openvtc/pnm-core/persona";
import { Button, Note, Panel } from "../../ui.js";
import { c, t, font } from "../../theme.js";
import { contextHeading } from "../format.js";
import type { Authority, Parties } from "../use-vta.js";
import { AttributeEditor, BindingForm, AttributeValue, ProfileEditor } from "./persona-editors.js";
import { holderGate } from "../holder-gate.js";
import { reachableStep } from "../persona-flow.js";

type Step = 1 | 2 | 3;

function Stepper({ step, reachable, onGo }: { step: Step; reachable: (s: Step) => boolean; onGo: (s: Step) => void }) {
  const items: [Step, string][] = [
    [1, "Add an attribute or two"],
    [2, "Make a face"],
    [3, "Be known somewhere"],
  ];
  return (
    <div style={{ display: "flex", alignItems: "center", background: c.surface, border: `1px solid ${c.line}`, borderRadius: "var(--w-r-md)", padding: "12px 18px" }}>
      {items.map(([n, title], i) => {
        const state = n < step ? "done" : n === step ? "now" : "todo";
        // A step you could be on is a way to get there. The ticked circle is
        // the affordance a person reaches for first, and until it did anything
        // the only route back was a button labelled "Cancel".
        const go = reachable(n) && n !== step;
        return (
          <div key={n} style={{ display: "flex", alignItems: "center", flex: i < items.length - 1 ? 1 : "0 0 auto" }}>
            <div
              role={go ? "button" : undefined}
              tabIndex={go ? 0 : undefined}
              onClick={go ? () => onGo(n) : undefined}
              onKeyDown={go ? (e) => { if (e.key === "Enter" || e.key === " ") onGo(n); } : undefined}
              title={go ? `Back to “${title}”` : undefined}
              style={{ display: "flex", alignItems: "center", gap: 10, cursor: go ? "pointer" : "default", borderRadius: "var(--w-r-sm)", padding: "2px 6px", margin: "-2px -6px" }}
            >
              <span
                style={{
                  width: 22,
                  height: 22,
                  borderRadius: 999,
                  display: "inline-flex",
                  alignItems: "center",
                  justifyContent: "center",
                  fontSize: t.xs,
                  fontWeight: 700,
                  background: state === "done" ? c.ok : state === "now" ? c.accent : c.raised,
                  color: state === "todo" ? c.faint : c.accentInk,
                  border: `1px solid ${state === "todo" ? c.line : "transparent"}`,
                }}
              >
                {state === "done" ? (
                  <svg width="12" height="12" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth={2.2} strokeLinecap="round" strokeLinejoin="round"><path d="M3 8.5 6.5 12 13 4.5" /></svg>
                ) : (
                  n
                )}
              </span>
              <span style={{ fontSize: t.sm, fontWeight: 600, color: state === "todo" ? c.faint : c.text }}>{title}</span>
            </div>
            {i < items.length - 1 && <span style={{ flex: 1, height: 1, background: c.line, margin: "0 14px" }} />}
          </div>
        );
      })}
    </div>
  );
}

/** The card a stranger would receive from a face — the thing a tick list
 *  cannot convey. Rendered from the pool directly: at this step nothing has
 *  been pushed anywhere yet, so the pool is the only source. */
function StrangerCard({
  attributes,
  faceName,
  registry,
}: {
  attributes: PoolAttribute[];
  faceName: string;
  registry: ClaimTypeRegistry | null;
}) {
  const name = attributes.find((f) => f.type === "name" || f.type.startsWith("name."));
  const rest = attributes.filter((f) => f !== name);
  const provable = attributes.some((f) => f.provenance.kind === "credentialBacked" && !f.stale);
  return (
    <div style={{ background: c.ground, border: `1px dashed ${c.line}`, borderRadius: "var(--w-r-md)", padding: "16px 18px", display: "grid", gap: 12, alignContent: "start" }}>
      <div style={{ display: "grid", gap: 3 }}>
        <span style={{ fontSize: t.xs, textTransform: "uppercase", letterSpacing: 0.4, color: c.faint }}>What a stranger would receive</span>
        <span style={{ fontSize: t.sm, color: c.muted }}>Exactly this, and nothing else. It changes as you tick.</span>
      </div>
      <div style={{ background: c.surface, border: `1px solid ${c.line}`, borderRadius: "var(--w-r-lg)", padding: "18px 20px", display: "grid", gap: 10, boxShadow: "0 1px 2px rgba(19,23,34,0.06), 0 8px 24px rgba(19,23,34,0.06)" }}>
        {attributes.length === 0 ? (
          <span style={{ fontSize: t.sm, color: c.faint }}>Nothing ticked. A stranger would receive an empty card.</span>
        ) : (
          <>
            <div style={{ display: "grid" }}>
              {name ? (
                <AttributeValue registry={registry} type={name.type} value={name.value} style={{ fontSize: t.md, fontWeight: 640 }} />
              ) : (
                <span style={{ fontSize: t.md, fontWeight: 640 }}>—</span>
              )}
              <span style={{ fontSize: t.xs, color: c.faint }}>{faceName || "unnamed face"}</span>
            </div>
            {rest.length > 0 && <div style={{ height: 1, background: c.lineSoft }} />}
            <div style={{ display: "grid", gridTemplateColumns: "minmax(90px, auto) minmax(0, 1fr)", gap: "6px 12px", fontSize: t.sm }}>
              {rest.map((f) => (
                <span key={f.attributeId} style={{ display: "contents" }}>
                  <span style={{ color: c.faint, fontFamily: font.mono, fontSize: t.xs }}>{f.label ?? f.type}</span>
                  <AttributeValue registry={registry} type={f.type} value={f.value} />
                </span>
              ))}
            </div>
          </>
        )}
      </div>
      <div style={{ display: "grid", gap: 6, fontSize: t.sm, color: c.muted, lineHeight: 1.5 }}>
        {attributes.length > 0 && !provable && (
          <span>
            <strong style={{ color: c.text }}>Nothing here is proven.</strong> These are things you said. A context can pass them on, but cannot show anyone they are true.
          </span>
        )}
        {provable && (
          <span>
            <strong style={{ color: c.text }}>Part of this is provable</strong> — and a credential carries the same signature to everyone who sees it, so it links you wherever it goes.
          </span>
        )}
      </div>
    </div>
  );
}

export function GuidedSetup({
  parties,
  authority,
  records,
  attributes,
  profiles,
  onChanged,
  onFinished,
  onSkip,
  registry,
}: {
  parties: Parties;
  authority: Authority | null;
  records: ContextRecord[];
  attributes: PoolAttribute[];
  profiles: PoolProfile[];
  onChanged: () => void;
  /** The third step succeeded; the map takes over with the outcome as its banner. */
  onFinished: (outcome: string) => void;
  onSkip: () => void;
  registry: ClaimTypeRegistry | null;
}) {
  const [step, setStep] = useState<Step>(attributes.length === 0 ? 1 : 2);
  const [contextId, setContextId] = useState(records[0]?.id ?? "");
  const [ticked, setTicked] = useState<Set<string>>(new Set());
  const [faceName, setFaceName] = useState("");
  const denied = holderGate(authority);
  const face = profiles[0];

  const preview = attributes.filter((a) => ticked.has(a.attributeId));

  return (
    <div style={{ display: "grid", gap: 16, alignContent: "start" }}>
      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "flex-start", gap: 16 }}>
        <div style={{ display: "grid", gap: 3 }}>
          <h1 style={{ margin: 0, fontSize: t.lg, fontWeight: 640 }}>Set up your identity</h1>
          <span style={{ fontSize: t.sm, color: c.muted }}>Three steps. Each says what it changes before you do it.</span>
        </div>
        <Button kind="quiet" onClick={onSkip}>Skip — I'll build it myself</Button>
      </div>
      {denied && <Note tone="warn">{denied}</Note>}
      <Stepper
        step={step}
        reachable={(s) => reachableStep(s, { attributes: attributes.length, faces: profiles.length })}
        onGo={setStep}
      />

      {step === 1 && (
        <div style={{ display: "grid", gridTemplateColumns: "minmax(0, 1.2fr) minmax(0, 1fr)", gap: 16 }}>
          <div style={{ display: "grid", gap: 12, alignContent: "start" }}>
            <AttributeEditor registry={registry}
              key={`new-${attributes.length}`}
              parties={parties}
              authority={authority}
              onDone={onChanged}
            />
            {attributes.length > 0 && (
              <Panel title={`${attributes.length} attribute${attributes.length === 1 ? "" : "s"} so far`}>
                <div style={{ display: "grid", gap: 6 }}>
                  {attributes.map((a) => (
                    <div key={a.attributeId} style={{ display: "flex", gap: 10, alignItems: "baseline", fontSize: t.sm }}>
                      <span style={{ fontFamily: font.mono, fontSize: t.xs, color: c.muted, minWidth: 120 }}>{a.type}</span>
                      <AttributeValue registry={registry} type={a.type} value={a.value} />
                    </div>
                  ))}
                </div>
                <div>
                  <Button kind="primary" onClick={() => setStep(2)}>That's enough for now — make a face</Button>
                </div>
              </Panel>
            )}
          </div>
          <Panel title="Why start here">
            <p style={{ margin: 0, fontSize: t.sm, color: c.muted, lineHeight: 1.6 }}>
              An attribute is one thing about you, held once — a name, a phone number, a handle. Nothing you add here
              is visible anywhere yet. Faces choose among attributes; a context receives a copy only when a persona
              there wears one.
            </p>
            <p style={{ margin: 0, fontSize: t.sm, color: c.muted, lineHeight: 1.6 }}>
              Two or three are plenty to start. You can always add more, and a face only ever shows what you
              ticked — attributes you add later stay out until you say otherwise.
            </p>
          </Panel>
        </div>
      )}

      {step === 2 && (
        <div style={{ display: "grid", gridTemplateColumns: "minmax(0, 1.2fr) minmax(0, 1fr)", gap: 16 }}>
          <ProfileEditor
            key={face?.profileId ?? "new"}
            parties={parties}
            authority={authority}
            attributes={attributes}
            {...(face ? { existing: face } : {})}
            onPreview={(selection) => {
              setTicked(new Set(selection.ids));
              setFaceName(selection.name);
            }}
            onDone={() => {
              onChanged();
              setStep(3);
            }}
            onCancel={() => setStep(1)}
            cancelLabel="Back — add more attributes"
          />
          <StrangerCard registry={registry} attributes={preview} faceName={faceName} />
        </div>
      )}

      {step === 3 && (
        <div style={{ display: "grid", gridTemplateColumns: "minmax(0, 1.2fr) minmax(0, 1fr)", gap: 16 }}>
          <div style={{ display: "grid", gap: 12, alignContent: "start" }}>
            <label style={{ display: "grid", gap: 4, maxWidth: 420 }}>
              <span style={{ fontSize: t.xs, color: c.muted }}>WHERE</span>
              <select
                value={contextId}
                onChange={(e) => setContextId(e.target.value)}
                style={{ boxSizing: "border-box", padding: "6px 9px", background: c.ground, color: c.text, border: `1px solid ${c.line}`, borderRadius: "var(--w-r-sm)", fontSize: t.sm }}
              >
                {records.map((r) => (
                  <option key={r.id} value={r.id}>{contextHeading(r, r.id)}</option>
                ))}
              </select>
            </label>
            {contextId && face ? (
              <BindingForm
                key={contextId}
                parties={parties}
                authority={authority}
                contextId={contextId}
                contextLabel={contextHeading(records.find((r) => r.id === contextId), contextId)}
                profiles={profiles}
                onDone={onFinished}
                onCancel={() => setStep(2)}
                cancelLabel="Back — change the face"
              />
            ) : (
              <Note tone="warn">
                {face ? "Pick a context." : "The face has not appeared yet — a moment."}
              </Note>
            )}
          </div>
          <Panel title="What this does">
            <p style={{ margin: 0, fontSize: t.sm, color: c.muted, lineHeight: 1.6 }}>
              A persona is the identifier a context knows you by. Putting a face on it copies the face's attributes
              down into that context — and only that context. Nothing reads back up.
            </p>
            <p style={{ margin: 0, fontSize: t.sm, color: c.muted, lineHeight: 1.6 }}>
              Edit an attribute later and every copy updates. Wear the same face in two contexts and anyone who sees
              you in both knows you are one person — the map will show that link the moment it exists.
            </p>
          </Panel>
        </div>
      )}
    </div>
  );
}
