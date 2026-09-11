// The pieces the New room form is built from.
//
// Split out of `rooms-create.tsx` so that file can be about the flow — which
// step decides what, in which order, and what is written — rather than about how
// a choice card draws. Nothing here talks to the agent.

import { useId, useState, type ReactNode } from "react";
import type { ServiceState } from "@openvtc/pnm-core/admin";
import type { WebvhServerRecord } from "@openvtc/pnm-core/webvh";
import type { ContextRecord } from "@openvtc/pnm-core";
import { Did, Note } from "../../ui.js";
import { c, t, font } from "../../theme.js";
import { contextHeading } from "../format.js";
import { didPath, pathProblem } from "../webvh-path.js";

export const fieldStyle: React.CSSProperties = {
  boxSizing: "border-box",
  padding: "6px 9px",
  background: c.ground,
  color: c.text,
  border: `1px solid ${c.line}`,
  borderRadius: "var(--w-r-sm)",
  fontSize: t.sm,
  maxWidth: "100%",
};

export const row: React.CSSProperties = { display: "flex", gap: 10, flexWrap: "wrap", alignItems: "flex-end" };

export const choices: React.CSSProperties = {
  display: "grid",
  gridTemplateColumns: "repeat(auto-fit, minmax(min(100%, 17rem), 1fr))",
  gap: 8,
};

/** A command to paste, drawn so its line breaks survive being copied. */
export const commandStyle: React.CSSProperties = {
  margin: 0,
  padding: "8px 11px",
  background: c.raised,
  border: `1px solid ${c.lineSoft}`,
  borderRadius: "var(--w-r-sm)",
  fontFamily: font.mono,
  fontSize: t.xs,
  lineHeight: 1.6,
  whiteSpace: "pre",
  overflowX: "auto",
};

export function Label({ children, hint }: { children: string; hint?: string | undefined }) {
  return (
    <span style={{ fontSize: t.xs, color: c.muted }}>
      {children}
      {hint ? <span style={{ color: c.faint }}> {hint}</span> : null}
    </span>
  );
}

export function Field({
  label,
  hint,
  grow,
  children,
}: {
  label: string;
  hint?: string | undefined;
  grow?: string | undefined;
  children: ReactNode;
}) {
  return (
    <label style={{ display: "grid", gap: 4, flex: grow ?? "0 1 auto", minWidth: 0 }}>
      <Label hint={hint}>{label}</Label>
      {children}
    </label>
  );
}

/**
 * One way through a step, with what it means written beside it.
 *
 * A bordered card rather than a bare radio because the description is the
 * point: "mint a host DID" next to a field is a label nobody reads, and the same
 * words as an option with a sentence under them are a decision.
 */
export function Choice({
  name,
  value,
  checked,
  onSelect,
  title,
  children,
}: {
  name: string;
  value: string;
  checked: boolean;
  onSelect: () => void;
  title: ReactNode;
  children?: ReactNode;
}) {
  return (
    <label
      style={{
        display: "flex",
        gap: 10,
        alignItems: "flex-start",
        padding: "9px 12px",
        border: `1px solid ${checked ? c.accent : c.line}`,
        background: checked ? c.accentSoft : c.ground,
        borderRadius: "var(--w-r-sm)",
        cursor: "pointer",
        minWidth: 0,
      }}
    >
      <input
        type="radio"
        name={name}
        value={value}
        checked={checked}
        onChange={onSelect}
        style={{ margin: "3px 0 0" }}
      />
      <span style={{ display: "grid", gap: 3, minWidth: 0 }}>
        <span style={{ fontSize: t.sm, fontWeight: 600, color: c.text }}>{title}</span>
        {children && (
          <span style={{ display: "grid", gap: 2, fontSize: t.xs, color: c.muted, lineHeight: 1.5 }}>
            {children}
          </span>
        )}
      </span>
    </label>
  );
}

/**
 * A numbered step: what it decides, why, then the controls.
 *
 * The tick says the step has what it needs — not that anything was written.
 * `locked` holds a step closed behind an earlier one, saying which: its title
 * and reason still show, so the shape of the whole flow is visible from the
 * start, but its controls do not until they can mean something.
 */
export function Step({
  n,
  title,
  why,
  done,
  locked,
  last = false,
  children,
}: {
  n: number;
  title: string;
  why: ReactNode;
  done: boolean;
  locked?: string | null | undefined;
  last?: boolean;
  children: ReactNode;
}) {
  return (
    <section style={{ display: "grid", gridTemplateColumns: "22px minmax(0, 1fr)", columnGap: 14 }}>
      <div style={{ display: "grid", gridTemplateRows: "22px 1fr", justifyItems: "center" }}>
        <span
          role="img"
          aria-label={done ? `Step ${n}, ready` : locked ? `Step ${n}, waiting` : `Step ${n}`}
          style={{
            width: 22,
            height: 22,
            borderRadius: 999,
            display: "inline-flex",
            alignItems: "center",
            justifyContent: "center",
            fontSize: t.xs,
            fontWeight: 700,
            background: done ? c.ok : locked ? c.raised : c.accent,
            color: locked && !done ? c.faint : c.accentInk,
            border: `1px solid ${locked && !done ? c.line : "transparent"}`,
          }}
        >
          {done ? (
            <svg width="12" height="12" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth={2.2} strokeLinecap="round" strokeLinejoin="round"><path d="M3 8.5 6.5 12 13 4.5" /></svg>
          ) : (
            n
          )}
        </span>
        {!last && <span style={{ width: 1, background: c.line, marginTop: 6 }} />}
      </div>
      <div style={{ display: "grid", gap: 10, paddingBottom: last ? 4 : 24, minWidth: 0 }}>
        <div style={{ display: "grid", gap: 3 }}>
          <h3
            style={{
              margin: 0,
              fontSize: t.base,
              fontWeight: 640,
              lineHeight: "22px",
              color: locked && !done ? c.muted : c.text,
            }}
          >
            {title}
          </h3>
          <p style={{ margin: 0, fontSize: t.sm, color: c.muted, lineHeight: 1.55, maxWidth: "82ch" }}>
            {why}
          </p>
        </div>
        {locked && !done ? (
          <p style={{ margin: 0, fontSize: t.sm, color: c.faint, fontStyle: "italic" }}>{locked}</p>
        ) : (
          children
        )}
      </div>
    </section>
  );
}

export function ContextSelect({
  name,
  options,
  value,
  onChange,
}: {
  name: string;
  options: ContextRecord[];
  value: string;
  onChange: (id: string) => void;
}) {
  return (
    <select aria-label={name} style={fieldStyle} value={value} onChange={(e) => onChange(e.target.value)}>
      <option value="">Choose…</option>
      {options.map((ctx) => (
        <option key={ctx.id} value={ctx.id}>
          {contextHeading(ctx, ctx.id)}
        </option>
      ))}
    </select>
  );
}

export function ServerSelect({
  name,
  servers,
  value,
  onChange,
}: {
  name: string;
  servers: WebvhServerRecord[] | null;
  value: string;
  onChange: (id: string) => void;
}) {
  return (
    <select
      aria-label={name}
      style={fieldStyle}
      value={value}
      onChange={(e) => onChange(e.target.value)}
      disabled={servers === null}
    >
      <option value="">{servers === null ? "Reading…" : "Choose…"}</option>
      {(servers ?? []).map((s) => (
        <option key={s.id} value={s.id}>
          {s.label ? `${s.label} (${s.id})` : s.id}
        </option>
      ))}
    </select>
  );
}

const KIND_LABEL: Record<ServiceState["kind"], string> = {
  didcomm: "DIDComm",
  tsp: "TSP",
  rest: "REST",
  webauthn: "WebAuthn",
};

/** A mediator the agent's own transports route through. */
export interface AgentMediator {
  did: string;
  kinds: string[];
  /** Whether any transport using it is currently advertised. */
  enabled: boolean;
}

/**
 * The distinct mediators in a services listing, advertised ones first.
 *
 * DIDComm and TSP usually share one mediator, and offering it twice would read
 * as a choice between two things that are the same.
 */
export function agentMediators(services: ServiceState[]): AgentMediator[] {
  const byDid = new Map<string, AgentMediator>();
  for (const s of services) {
    if (!s.mediatorDid) continue;
    const m = byDid.get(s.mediatorDid) ?? { did: s.mediatorDid, kinds: [], enabled: false };
    m.kinds.push(KIND_LABEL[s.kind] ?? s.kind);
    m.enabled ||= s.enabled;
    byDid.set(s.mediatorDid, m);
  }
  return [...byDid.values()].sort((a, b) => Number(b.enabled) - Number(a.enabled));
}

/**
 * The agent's own mediator as a choice, or a different one typed.
 *
 * `typing` is its own state rather than read off `value`, because "a different
 * mediator, not typed yet" and "nothing chosen" are both the empty string, and
 * only one of them should show the field.
 */
export function MediatorPicker({
  name,
  value,
  onChange,
  known,
  knownError,
}: {
  name: string;
  value: string;
  onChange: (did: string) => void;
  known: AgentMediator[] | null;
  knownError: string | null;
}) {
  const group = useId();
  const [typing, setTyping] = useState(false);
  const list = known ?? [];
  const other = typing || (value !== "" && !list.some((m) => m.did === value));

  const input = (
    <input
      aria-label={name}
      style={{ ...fieldStyle, width: "100%" }}
      value={value}
      placeholder="did:…"
      onChange={(e) => onChange(e.target.value)}
    />
  );

  if (knownError) {
    return (
      <div style={{ display: "grid", gap: 6 }}>
        <Note tone="warn">
          Your agent&apos;s transports could not be read ({knownError}), so its mediator cannot be
          offered here. That is a failure to ask, not an agent without one — enter the mediator&apos;s
          DID instead. The Transports pane shows it, if you can read that pane.
        </Note>
        {input}
      </div>
    );
  }
  if (known === null) {
    return <span style={{ fontSize: t.sm, color: c.faint }}>Asking your agent which mediator it uses…</span>;
  }
  if (list.length === 0) {
    return (
      <div style={{ display: "grid", gap: 6 }}>
        <span style={{ fontSize: t.xs, color: c.muted }}>
          Your agent routes nothing through a mediator — it is reached over REST alone — so there is
          none to offer. Enter the DID of the mediator to use.
        </span>
        {input}
      </div>
    );
  }

  return (
    <div style={{ display: "grid", gap: 8 }}>
      <div style={choices}>
        {list.map((m) => (
          <Choice
            key={m.did}
            name={group}
            value={m.did}
            checked={!other && value === m.did}
            onSelect={() => {
              setTyping(false);
              onChange(m.did);
            }}
            title={list.length > 1 ? `Your agent's ${m.kinds.join(" / ")} mediator` : "Your agent's mediator"}
          >
            <Did value={m.did} size={t.xs} />
            <span>
              {m.enabled
                ? `Your agent routes ${m.kinds.join(" and ")} through it — the usual choice.`
                : `Your agent has ${m.kinds.join(" and ")} switched off, so it is not advertising this one right now.`}
            </span>
          </Choice>
        ))}
        <Choice
          name={group}
          value="other"
          checked={other}
          onSelect={() => {
            setTyping(true);
            if (list.some((m) => m.did === value)) onChange("");
          }}
          title="A different mediator"
        >
          Name any mediator by its DID.
        </Choice>
      </div>
      {other && input}
    </div>
  );
}

/**
 * Whether a DID's path is the hosting server's choice or the operator's.
 *
 * `path` survives switching back to the server's choice, so flipping between
 * the two does not throw away what was typed — but only `named` decides what is
 * sent.
 */
export interface PathChoice {
  named: boolean;
  path: string;
}

export const SERVER_CHOOSES: PathChoice = { named: false, path: "" };

/** `pathMode` for a mint: absent is the server's choice (`autoAssign`). */
export const pathMode = (choice: PathChoice) =>
  choice.named ? { pathMode: { mode: "explicit" as const, path: choice.path } } : {};

/**
 * The path a DID is published under: the hosting server's choice, or a name.
 *
 * The preview is the reason to show the name at all — `rooms/northwind` typed
 * into a field is a path, and the operator is picking a DID. Showing where it
 * lands inside one is what makes the choice legible.
 */
export function PathPicker({
  name,
  example,
  value,
  onChange,
}: {
  name: string;
  example: string;
  value: PathChoice;
  onChange: (next: PathChoice) => void;
}) {
  const group = useId();
  const problem = value.named && value.path ? pathProblem(value.path) : null;

  return (
    <div style={{ display: "grid", gap: 6 }}>
      <Label hint="— the part of the DID after the domain">DID PATH</Label>
      <div style={choices}>
        <Choice
          name={group}
          value="path-auto"
          checked={!value.named}
          onSelect={() => onChange({ ...value, named: false })}
          title="Let the hosting server choose"
        >
          It allocates a fresh name that is free on that server.
        </Choice>
        <Choice
          name={group}
          value="path-named"
          checked={value.named}
          onSelect={() => onChange({ ...value, named: true })}
          title="Choose a name"
        >
          <span>
            A name you pick, such as <code>{example}</code>. It becomes part of the DID.
          </span>
        </Choice>
      </div>
      {value.named && (
        <>
          <input
            aria-label={name}
            style={{ ...fieldStyle, width: "100%", fontFamily: font.mono }}
            value={value.path}
            placeholder={example}
            spellCheck={false}
            autoCapitalize="none"
            autoComplete="off"
            onChange={(e) => onChange({ ...value, path: e.target.value })}
          />
          {problem ? (
            <span style={{ fontSize: t.xs, color: c.danger }}>{problem}</span>
          ) : value.path ? (
            <span style={{ fontSize: t.xs, color: c.muted, fontFamily: font.mono, wordBreak: "break-all" }}>
              <span style={{ color: c.faint }}>did:webvh:&lt;scid&gt;:&lt;domain&gt;:</span>
              <strong style={{ color: c.text }}>{didPath(value.path)}</strong>
            </span>
          ) : (
            <span style={{ fontSize: t.xs, color: c.muted }}>
              Lowercase letters, digits and hyphens, with “/” between segments.
            </span>
          )}
        </>
      )}
    </div>
  );
}

/**
 * Whether a minted DID also advertises TSP at its mediator.
 *
 * A checkbox rather than a pair of cards because it adds to the mediator above
 * it rather than choosing between two things. Off by default, the agent's own
 * posture: a DID advertising a transport nothing behind it decodes is one
 * clients will choose and cannot use, so ticking it is a claim about whoever
 * holds the DID — and the words beside it say who that is.
 */
export function TspChoice({
  name,
  checked,
  onChange,
  children,
}: {
  name: string;
  checked: boolean;
  onChange: (next: boolean) => void;
  children: ReactNode;
}) {
  return (
    <label style={{ display: "flex", gap: 10, alignItems: "flex-start", fontSize: t.sm, cursor: "pointer" }}>
      <input
        type="checkbox"
        aria-label={name}
        checked={checked}
        onChange={(e) => onChange(e.target.checked)}
        style={{ margin: "3px 0 0" }}
      />
      <span style={{ display: "grid", gap: 2, minWidth: 0 }}>
        <span style={{ fontWeight: 600, color: c.text }}>Also advertise TSP at this mediator</span>
        <span style={{ fontSize: t.xs, color: c.muted, lineHeight: 1.5 }}>{children}</span>
      </span>
    </label>
  );
}
