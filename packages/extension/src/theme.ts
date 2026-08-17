// Typed accessors for the tokens in `theme.css`.
//
// This codebase styles with inline `CSSProperties` objects rather than
// classes, so tokens have to be reachable from TypeScript. Each value is a
// `var(--w-*)` reference, not a literal, so a component written once resolves
// correctly in both themes and there is no second palette to keep in sync.
//
// Import `./theme.css` once per entry point (popup, options, confirm); these
// constants are inert without it.

import type { CSSProperties } from "react";

/** Colour tokens. Every one resolves through CSS custom properties, so
 *  light/dark is handled by the stylesheet and never by branching here. */
export const c = {
  ground: "var(--w-ground)",
  surface: "var(--w-surface)",
  raised: "var(--w-raised)",
  line: "var(--w-line)",
  lineSoft: "var(--w-line-soft)",
  text: "var(--w-text)",
  muted: "var(--w-muted)",
  faint: "var(--w-faint)",

  accent: "var(--w-accent)",
  accentSoft: "var(--w-accent-soft)",
  accentInk: "var(--w-accent-ink)",

  ok: "var(--w-ok)",
  okSoft: "var(--w-ok-soft)",
  warn: "var(--w-warn)",
  warnSoft: "var(--w-warn-soft)",
  danger: "var(--w-danger)",
  dangerSoft: "var(--w-danger-soft)",
} as const;

/** Type scale. Sizes are the whole scale — anything not here is off-scale. */
export const t = {
  xs: "var(--w-t-xs)",
  sm: "var(--w-t-sm)",
  base: "var(--w-t-base)",
  md: "var(--w-t-md)",
  lg: "var(--w-t-lg)",
  xl: "var(--w-t-xl)",
} as const;

export const radius = {
  sm: "var(--w-r-sm)",
  md: "var(--w-r-md)",
  lg: "var(--w-r-lg)",
} as const;

export const font = {
  sans: "var(--w-sans)",
  mono: "var(--w-mono)",
} as const;

/** Monospace run of cryptographic material. Used wherever a DID, digest or
 *  key appears outside the structured `Did` component. */
export const mono: CSSProperties = {
  fontFamily: font.mono,
  fontSize: t.sm,
  wordBreak: "break-all",
};

/** Uppercase micro-label. The tracking is what stops it reading as shouting. */
export const microLabel: CSSProperties = {
  fontSize: t.xs,
  textTransform: "uppercase",
  letterSpacing: "0.1em",
  fontWeight: 650,
  color: c.faint,
};

export const card: CSSProperties = {
  background: c.surface,
  border: `1px solid ${c.line}`,
  borderRadius: radius.md,
  padding: "16px 18px",
};

export type ButtonKind = "default" | "primary" | "quiet" | "danger";

/** Button styling by role. `primary` is reserved for the one action a screen
 *  exists to perform; more than one per view means none of them is primary. */
export function button(kind: ButtonKind = "default"): CSSProperties {
  const base: CSSProperties = {
    fontFamily: font.sans,
    fontSize: t.sm,
    fontWeight: 600,
    padding: "7px 14px",
    borderRadius: radius.sm,
    border: `1px solid ${c.line}`,
    background: c.raised,
    color: c.text,
    cursor: "pointer",
    whiteSpace: "nowrap",
  };
  switch (kind) {
    case "primary":
      return { ...base, background: c.accent, borderColor: c.accent, color: c.accentInk };
    case "quiet":
      return { ...base, background: "transparent", borderColor: "transparent", color: c.muted, padding: "7px 8px" };
    case "danger":
      return { ...base, background: "transparent", borderColor: "transparent", color: c.danger, padding: "7px 8px" };
    default:
      return base;
  }
}

export type PillTone = "ok" | "warn" | "danger" | "accent" | "off";

/** Status pill. State is encoded in form as well as colour (the label carries
 *  the meaning), so it survives being read by someone who can't separate the
 *  hues. */
export function pill(tone: PillTone): CSSProperties {
  const base: CSSProperties = {
    fontSize: "10.5px",
    fontWeight: 650,
    letterSpacing: "0.045em",
    textTransform: "uppercase",
    padding: "2.5px 8px",
    borderRadius: 999,
    whiteSpace: "nowrap",
    display: "inline-block",
  };
  const tones: Record<PillTone, CSSProperties> = {
    ok: { background: c.okSoft, color: c.ok },
    warn: { background: c.warnSoft, color: c.warn },
    danger: { background: c.dangerSoft, color: c.danger },
    accent: { background: c.accentSoft, color: c.accent },
    off: { background: c.raised, color: c.faint },
  };
  return { ...base, ...tones[tone] };
}
