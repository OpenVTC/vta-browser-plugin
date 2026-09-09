// The eight colours a world may wear, and the one rule about them.
//
// A world (`persona/facet` on the wire — see
// `design-docs/persona-vocabulary.md`) carries a colour **name**, never a
// literal. This module is where the name becomes something to draw with, and
// it is deliberately the only such place: a second mapping is a second answer
// to "what colour is Work", and the one nobody re-checks is the one that goes
// wrong.
//
// ## Why a closed set, and why this file exists at all
//
// `manager-theme.css` holds the rule: `--w-ok` / `--w-warn` / `--w-danger` are
// the only colours that *mean* anything, and every other set is categorical.
// A world colour is the third categorical set, and it is the first one chosen
// by a **person** rather than by this codebase — which is exactly why it needs
// a guard. Given a free-form hex from a holder, nothing here could keep a
// decorative choice out of the semantic channel: someone names a world "Work",
// picks red, and every card in it reads as an alarm with no way to discover
// why. A closed set of eight makes that unrepresentable rather than merely
// discouraged, and `manager-world-colour.test.mts` asserts the distance from
// the semantic three rather than trusting the eye that picked them.
//
// The wire carrying a name is what makes this possible at all: the same world
// is legible here, in a terminal and on a phone, each resolving the name
// against its own palette. A stored `#8B0000` is a colour that is wrong
// somewhere and the holder has no way to know where.

import type { FacetColour } from "@openvtc/pnm-core/admin";

/**
 * Every colour a world may wear, in the order a picker offers them.
 *
 * Typed against the generated `FacetColour` rather than restated as strings:
 * a ninth colour published in the specification is then a compile error here —
 * a picker missing an option the agent will happily store — instead of a name
 * this console silently cannot draw.
 */
export const WORLD_COLOURS: readonly FacetColour[] = [
  "slate",
  "indigo",
  "teal",
  "moss",
  "sand",
  "clay",
  "rose",
  "plum",
];

/**
 * The CSS custom property for one world colour.
 *
 * A token reference rather than a value, so both themes resolve: the light and
 * dark blocks in `manager-theme.css` define the same eight names at different
 * lightness, and a component that reached for a hex would be correct in exactly
 * one of them.
 */
export function worldHue(colour: FacetColour): string {
  return `var(--m-world-${colour})`;
}

/**
 * The holder's own words for a colour, for a picker's accessible name.
 *
 * Present because a swatch alone is not a choice anyone can make with a screen
 * reader, and because "the third one" is not a thing a person can say to
 * support. Deliberately plain: these name a colour and must not acquire
 * connotations — no "danger red", no "success green" — which is the same rule
 * that keeps the eight away from the semantic three in the first place.
 */
export function worldColourName(colour: FacetColour): string {
  switch (colour) {
    case "slate":
      return "Slate";
    case "indigo":
      return "Indigo";
    case "teal":
      return "Teal";
    case "moss":
      return "Moss";
    case "sand":
      return "Sand";
    case "clay":
      return "Clay";
    case "rose":
      return "Rose";
    case "plum":
      return "Plum";
    default:
      // Unreachable while `WORLD_COLOURS` and the generated union agree, and
      // the honest answer if a ninth is published and this switch is not
      // updated: the token, which is at least the word the agent stored.
      return colour;
  }
}
