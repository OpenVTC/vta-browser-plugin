// Shared presentational components, built on the tokens in `theme.ts`.
//
// Deliberately small and unopinionated about data — these exist so popup,
// options and confirm stop each inventing their own pill, button and DID
// rendering, which is how the extension ended up with two visual identities
// and ~20 ad-hoc hex literals.

import type { CSSProperties, ReactNode } from "react";
import { splitDid, didHost, type DidPart } from "./did-display.js";
import { displayAgentName, type AgentName } from "./agent-name.js";
import { c, t, font, button, pill, type ButtonKind, type PillTone } from "./theme.js";

const ROLE_STYLE: Record<DidPart["role"], CSSProperties> = {
  // The method prefix is identical on every DID the user will ever see, so it
  // carries no information and recedes furthest.
  method: { color: c.faint },
  opaque: { color: c.muted },
  // The host is what a human verifies — the only part that should read loudly.
  host: { color: c.text, fontWeight: 620 },
  path: { color: c.faint },
};

/**
 * Render a DID with its host emphasised.
 *
 * `verified` tints the host with the semantic "verified" colour, for use only
 * where resolution actually succeeded — it is a claim about cryptographic
 * state, not decoration.
 */
export function Did({
  value,
  verified = false,
  size = t.sm,
}: {
  value: string;
  verified?: boolean;
  size?: string;
}) {
  const parts = splitDid(value);
  const host = didHost(value);
  return (
    <span
      style={{ fontFamily: font.mono, fontSize: size, wordBreak: "break-all", lineHeight: 1.45 }}
      // Screen readers get the same emphasis the visual treatment gives:
      // lead with the host rather than reading fifty opaque characters first.
      aria-label={host ? `DID at ${host}: ${value}` : value}
    >
      {parts.map((p, i) => (
        <span
          key={i}
          style={
            p.role === "host" && verified
              ? { ...ROLE_STYLE.host, color: c.ok }
              : ROLE_STYLE[p.role]
          }
        >
          {p.text}
        </span>
      ))}
    </span>
  );
}

/**
 * A DID shown by name, with the identifier beneath it.
 *
 * `agentName` must come from the resolved document's `alsoKnownAs` — it is
 * never derived here. A name is not a segment of the DID: the name → DID link
 * is a web redirect, so a name inferred from DID structure would be an
 * unverified guess wearing an authoritative-looking label, which is the exact
 * spoofing the `alsoKnownAs` check exists to prevent.
 *
 * With no verified name, this falls back to the host — a fact about the DID
 * itself, presented as such and never as a handle.
 */
export function DidNamed({
  value,
  agentName,
  verified = false,
  suffix,
}: {
  value: string;
  /** A name the document claims, already verified by the caller. */
  agentName?: AgentName;
  verified?: boolean;
  /** Appended to the name, e.g. a Pill. */
  suffix?: ReactNode;
}) {
  const handle = agentName ? displayAgentName(agentName) : undefined;
  const host = didHost(value);
  if (!handle && !host) return <Did value={value} verified={verified} />;
  return (
    <div style={{ display: "grid", gap: 3, minWidth: 0 }}>
      <div style={{ display: "flex", alignItems: "center", gap: 8, flexWrap: "wrap" }}>
        <span
          style={{
            fontSize: t.base,
            fontWeight: 640,
            color: verified ? c.ok : c.text,
            wordBreak: "break-word",
          }}
        >
          {handle ?? host}
        </span>
        {suffix}
      </div>
      <Did value={value} size={t.xs} />
    </div>
  );
}

export function Pill({ tone, children }: { tone: PillTone; children: ReactNode }) {
  return <span style={pill(tone)}>{children}</span>;
}

export function Button({
  kind = "default",
  onClick,
  disabled,
  title,
  children,
  style,
}: {
  kind?: ButtonKind;
  onClick?: () => void;
  disabled?: boolean;
  title?: string;
  children: ReactNode;
  style?: CSSProperties;
}) {
  return (
    <button
      onClick={onClick}
      disabled={disabled}
      title={title}
      style={{ ...button(kind), ...(disabled ? { opacity: 0.5, cursor: "default" } : {}), ...style }}
    >
      {children}
    </button>
  );
}

/** A bordered panel with an optional heading and explanatory line. The
 *  description slot is not optional decoration — every setting in this wallet
 *  has a consequence, and the panel makes room for saying what it is. */
export function Panel({
  title,
  description,
  children,
}: {
  title?: string;
  description?: ReactNode;
  children?: ReactNode;
}) {
  return (
    <section
      style={{
        background: c.surface,
        border: `1px solid ${c.line}`,
        borderRadius: "var(--w-r-md)",
        padding: "16px 18px",
        display: "grid",
        gap: 10,
      }}
    >
      {title && <h2 style={{ margin: 0, fontSize: t.md, fontWeight: 640 }}>{title}</h2>}
      {description && (
        <p style={{ margin: 0, fontSize: t.sm, color: c.muted, lineHeight: 1.55, maxWidth: "82ch" }}>
          {description}
        </p>
      )}
      {children}
    </section>
  );
}

export type NoteTone = "warn" | "danger" | "accent";

/** A consequence the user should read before acting. Left-rule rather than a
 *  full tinted box so several can sit in a column without the page turning
 *  into a warning wall. */
export function Note({ tone = "warn", children }: { tone?: NoteTone; children: ReactNode }) {
  const map: Record<NoteTone, { edge: string; bg: string }> = {
    warn: { edge: c.warn, bg: c.warnSoft },
    danger: { edge: c.danger, bg: c.dangerSoft },
    accent: { edge: c.accent, bg: c.accentSoft },
  };
  const { edge, bg } = map[tone];
  return (
    <div
      style={{
        borderLeft: `2px solid ${edge}`,
        background: bg,
        padding: "9px 13px",
        borderRadius: "0 var(--w-r-sm) var(--w-r-sm) 0",
        fontSize: t.sm,
        lineHeight: 1.55,
        color: c.text,
      }}
    >
      {children}
    </div>
  );
}

/** Placeholder for a list with nothing in it. Says what would appear here,
 *  rather than just "None" — an empty state is a chance to explain. */
export function Empty({ children }: { children: ReactNode }) {
  return (
    <div style={{ fontSize: t.sm, color: c.faint, padding: "10px 0" }}>{children}</div>
  );
}
