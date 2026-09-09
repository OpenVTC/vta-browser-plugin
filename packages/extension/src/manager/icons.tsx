// The console's icon set.
//
// One 24×24 grid, 1.6 stroke, round caps and joins, `currentColor` throughout,
// so an icon inherits whatever colour the thing it sits in already resolved —
// an act's hue on the rail, a family's hue on a group header, a standing's hue
// on a context card. Nothing here hardcodes a colour, for the same reason
// `theme.ts` hardcodes none: a literal would be right in exactly one theme.
//
// ## Why these glyphs and not a generic set
//
// The four sections under "Authority & graph" are the reason this file is
// hand-drawn. Access, Approvals, Policy and Sessions are all *security*, so any
// four shield-and-padlock variants collapse into each other at 18px — which is
// the size they are actually rendered at. They are drawn instead as four
// different **kinds of thing**, sharing no motif:
//
//   Access     a person beside a list — an ACL is literally who may act
//   Approvals  a check in a circle — a decision
//   Policy     a fork — rules that route
//   Sessions   a clock — live, and expiring
//
// Two more worth recording, because the obvious drawing was wrong:
//
//   Rooms      a vault, not a door. A door outline is an empty rectangle at
//              18px, indistinguishable from `app-state`'s panel — and a room
//              is shared storage whose host holds ciphertext it cannot read,
//              which a vault says and a door does not.
//   DIDs       a tag. An identifier that resolves, rather than a document.
//
// ## Standing is a shape, not only a colour
//
// `st-known` / `st-identified` / `st-absent` differ in **form** — filled,
// dashed, struck through — before they differ in hue. A context's standing is
// the one thing on the identity map a reader must not get wrong, and
// `identified` in particular is a real state that used to have no words on
// screen at all (see CLAUDE.md). A reader who cannot separate green from amber
// still reads three different shapes.

import type { CSSProperties } from "react";

/** Every glyph this console draws. A section id maps to the icon of the same
 *  name, which is what keeps `shell.tsx` from carrying a second lookup table. */
export type IconName =
  // Sections, one per `SectionId`.
  | "contexts" | "keys" | "dids"
  | "credentials" | "persona" | "memory" | "app-state" | "rooms"
  | "services" | "maintenance" | "audit"
  | "access" | "approvals" | "policy" | "sessions"
  // Attribute families, one per `AttributeFamily`.
  | "fam-identity" | "fam-contact" | "fam-public" | "fam-gated" | "fam-unregistered"
  // Context standing, one per `Standing` that can be drawn.
  | "st-known" | "st-identified" | "st-absent" | "st-unreadable"
  // Furniture.
  | "chevron" | "close" | "plus" | "eye" | "eye-off" | "search" | "drag" | "info" | "released";

/** The path data for each glyph. Kept as a plain record rather than a
 *  component per icon: they are data, and a 30-component file is 30 places to
 *  drift from the grid. */
const PATHS: Record<IconName, string> = {
  contexts:
    "M3.4 4.6h17.2v14.8H3.4zM12 4.6v14.8M3.4 12h17.2",
  keys:
    "M11.2 12h9.4M18 12v3.2M15.1 12v2.4",
  dids:
    "M3.9 10.9 10.9 3.9h6.6a2.6 2.6 0 0 1 2.6 2.6v6.6l-7 7a2.1 2.1 0 0 1-3 0l-6.2-6.2a2.1 2.1 0 0 1 0-3z",
  credentials:
    "M6.9 8.2h7.2M6.9 11.6h4.6M14.9 19.7 14.3 23l2.3-1.4 2.3 1.4-.6-3.3",
  persona:
    "M4.9 20.4a7.1 7.1 0 0 1 14.2 0",
  memory:
    "M6.6 3.4h6.6l5.8 5.8v10.9a1.6 1.6 0 0 1-1.6 1.6H6.6A1.6 1.6 0 0 1 5 20.1V5A1.6 1.6 0 0 1 6.6 3.4zM13.2 3.4v5.8H19M8.4 13.9h7.2M8.4 17.1h4.6",
  "app-state":
    "M3.4 9.1h17.2M7 13.2h6.4M7 16.1h4",
  rooms:
    "M12 8.5V6.9M12 17.1v-1.6M8.5 12H6.9M17.1 12h-1.6",
  services:
    "M7.9 6.4h5.9a2.9 2.9 0 0 1 0 5.8h-3.6a2.9 2.9 0 0 0 0 5.8h5.9",
  maintenance:
    "M20 5.2 16.9 8.3a1.4 1.4 0 0 1-2 0l-.7-.7a1.4 1.4 0 0 1 0-2L17.3 2.5a5.4 5.4 0 0 0-6.6 7.3l-7.1 7.1a2 2 0 0 0 2.8 2.8l7.1-7.1A5.4 5.4 0 0 0 20 5.2z",
  audit:
    "M7 4.4v15.2M11.6 7.5h8.4M11.6 12h6.2M11.6 16.5h7.3",
  access:
    "M2.9 18.7a4.9 4.9 0 0 1 9 0M14.6 8.3h6.5M14.6 12.4h6.5M14.6 16.5h4.2",
  approvals:
    "M8.1 12.3 10.9 15.1 16 9.5",
  policy:
    "M7.5 12h3.1a2.2 2.2 0 0 0 1.9-1.1l1.3-2.2a2.2 2.2 0 0 1 1.9-1.1h.8M7.5 12h3.1a2.2 2.2 0 0 1 1.9 1.1l1.3 2.2a2.2 2.2 0 0 0 1.9 1.1h.8",
  sessions:
    "M12 7.1V12l3.3 2",

  "fam-identity": "M5.2 20.2a6.8 6.8 0 0 1 13.6 0",
  "fam-contact": "M12 21s6.8-6.1 6.8-11a6.8 6.8 0 1 0-13.6 0C5.2 14.9 12 21 12 21z",
  "fam-public": "M3.7 12h16.6M12 3.7a13 13 0 0 1 0 16.6 13 13 0 0 1 0-16.6z",
  "fam-gated": "M8.3 10.6V7.9a3.7 3.7 0 0 1 7.4 0v2.7",
  "fam-unregistered": "M9.6 9.5a2.5 2.5 0 0 1 4.8.8c0 1.7-2.4 2.1-2.4 3.7",

  "st-known": "M5.2 20.2a6.8 6.8 0 0 1 13.6 0",
  "st-identified": "M5.2 20.2a6.8 6.8 0 0 1 13.6 0",
  "st-absent": "M8.4 12h7.2",
  "st-unreadable": "M12 8.2v4.6M12 16.4h.01",

  chevron: "M9.5 5.5 16 12l-6.5 6.5",
  close: "M6.5 6.5 17.5 17.5M17.5 6.5 6.5 17.5",
  plus: "M12 5.5v13M5.5 12h13",
  eye: "M2.5 12S6 5.8 12 5.8 21.5 12 21.5 12 18 18.2 12 18.2 2.5 12 2.5 12z",
  "eye-off": "M4 4l16 16M9.9 5.9A9 9 0 0 1 12 5.8c6 0 9.5 6.2 9.5 6.2a17 17 0 0 1-3.2 3.9M6.5 8.1A17 17 0 0 0 2.5 12S6 18.2 12 18.2a9 9 0 0 0 2.6-.4",
  search: "M20.5 20.5 16.2 16.2",
  drag: "",
  info: "M12 11.2v5.2M12 7.8h.01",
  released: "M12 4.2v11.4M7.6 11.2 12 15.6l4.4-4.4M4.8 19.2h14.4",
};

/** Circles and rectangles that cannot be expressed as a single path string
 *  without losing the round-join rendering. Kept beside the paths rather than
 *  inlined into them so the grid stays legible. */
const SHAPES: Partial<Record<IconName, string>> = {
  contexts: `<circle cx="7.7" cy="8.3" r="1.25" fill="currentColor" stroke="none"/>`,
  keys: `<circle cx="7.6" cy="12" r="3.6"/>`,
  dids: `<circle cx="16.2" cy="7.8" r="1.35"/>`,
  credentials: `<rect x="3.4" y="4.2" width="17.2" height="11.6" rx="2.2"/><circle cx="16.6" cy="17.4" r="2.9"/>`,
  persona: `<circle cx="12" cy="8.4" r="3.8"/>`,
  "app-state": `<rect x="3.4" y="4.6" width="17.2" height="14.8" rx="2.6"/><circle cx="6.7" cy="6.85" r=".75" fill="currentColor" stroke="none"/><circle cx="9.2" cy="6.85" r=".75" fill="currentColor" stroke="none"/>`,
  rooms: `<rect x="3.6" y="4.4" width="16.8" height="15.2" rx="2.4"/><circle cx="12" cy="12" r="3.5"/>`,
  services: `<circle cx="5.6" cy="6.4" r="2.3"/><circle cx="18.4" cy="17.6" r="2.3"/>`,
  audit: `<circle cx="7" cy="7.5" r="1.7"/><circle cx="7" cy="12" r="1.7"/><circle cx="7" cy="16.5" r="1.7"/>`,
  access: `<circle cx="7.4" cy="8.1" r="2.9"/>`,
  approvals: `<circle cx="12" cy="12" r="8.3"/>`,
  policy: `<circle cx="5.3" cy="12" r="2.2"/><circle cx="18.7" cy="6.6" r="2.2"/><circle cx="18.7" cy="17.4" r="2.2"/>`,
  sessions: `<circle cx="12" cy="12" r="8.3"/>`,
  "fam-identity": `<circle cx="12" cy="8.4" r="3.6"/>`,
  "fam-contact": `<circle cx="12" cy="10" r="2.5"/>`,
  "fam-public": `<circle cx="12" cy="12" r="8.3"/>`,
  "fam-gated": `<rect x="4.8" y="10.6" width="14.4" height="9.4" rx="2.2"/>`,
  "fam-unregistered": `<circle cx="12" cy="12" r="8.3"/><circle cx="12" cy="17.3" r=".95" fill="currentColor" stroke="none"/>`,
  // Filled: this context knows the holder, and the weight is what says so.
  "st-known": `<circle cx="12" cy="9" r="3.6" fill="currentColor" stroke="none"/>`,
  // Dashed: an identifier is present, wearing nothing. A real state, and the
  // outline is what distinguishes it from `known` without relying on hue.
  "st-identified": `<circle cx="12" cy="9" r="3.6"/>`,
  "st-absent": `<circle cx="12" cy="12" r="8.3"/>`,
  "st-unreadable": `<path d="M12 3.6 21.2 19.6H2.8z" stroke-linejoin="round"/>`,
  search: `<circle cx="11" cy="11" r="6.6"/>`,
  info: `<circle cx="12" cy="12" r="8.3"/>`,
  drag: `<circle cx="9" cy="6.5" r="1.2" fill="currentColor" stroke="none"/><circle cx="15" cy="6.5" r="1.2" fill="currentColor" stroke="none"/><circle cx="9" cy="12" r="1.2" fill="currentColor" stroke="none"/><circle cx="15" cy="12" r="1.2" fill="currentColor" stroke="none"/><circle cx="9" cy="17.5" r="1.2" fill="currentColor" stroke="none"/><circle cx="15" cy="17.5" r="1.2" fill="currentColor" stroke="none"/>`,
};

/** Glyphs whose outline is dashed rather than solid. `identified` and `absent`
 *  are the two states that are *partial*, and a dash is the form that says so
 *  before any colour does. */
const DASHED: Partial<Record<IconName, string>> = {
  "st-identified": "2.6 2.2",
  "st-absent": "2.6 2.4",
};

export interface IconProps {
  name: IconName;
  /** Rendered edge length in px. 18 is the rail and card size; 14 sits inline
   *  with `t.sm` text; 12 fits inside a chip. */
  size?: number;
  style?: CSSProperties;
  /** Given only when the icon carries meaning no adjacent text repeats. An
   *  icon beside its own label is decorative and must stay unlabelled, or a
   *  screen reader says the name twice. */
  title?: string;
}

/**
 * One glyph, inheriting `color` from whatever it is placed in.
 *
 * `flexShrink: 0` because these sit in flex rows beside text that is allowed
 * to truncate, and an icon squashed to 11px wide reads as a rendering fault
 * rather than as a narrow column.
 */
export function Icon({ name, size = 18, style, title }: IconProps) {
  const dash = DASHED[name];
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth={1.6}
      strokeLinecap="round"
      strokeLinejoin="round"
      role={title ? "img" : undefined}
      aria-label={title}
      aria-hidden={title ? undefined : true}
      style={{ flexShrink: 0, display: "block", ...style }}
      {...(dash ? { strokeDasharray: dash } : {})}
      // The shape half is static, author-written markup in this module — never
      // anything that came off the wire — which is what makes this safe.
      dangerouslySetInnerHTML={{
        __html: (SHAPES[name] ?? "") + (PATHS[name] ? `<path d="${PATHS[name]}"/>` : ""),
      }}
    />
  );
}
