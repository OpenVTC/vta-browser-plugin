// Which family an attribute's claim type belongs to, and the colour that says so.
//
// ## Why a family at all
//
// The identity map draws every attribute the holder keeps as one card in one
// row. At five cards that is a row; at thirty it is a wall, and a wall is where
// the answer to "what does this person actually keep about themselves" goes to
// hide. Grouping the row into families — who you are, how to reach you, what is
// already public, what your agent gates — restores the shape of the pool at a
// glance, and the colour is what carries that shape onto the face cards, where
// a composition can then be read without opening it.
//
// ## Colour here is categorical, and that distinction is the whole licence
//
// `manager-theme.css` sets the rule this module has to live inside: `--w-ok` /
// `--w-warn` / `--w-danger` are the only colours that *mean* something, and the
// act colours are navigation, never state. A family hue is the second kind. It
// says which vocabulary a token comes from and nothing about whether anything
// is wrong, which is why it is only ever a 3px stripe or a 6px dot — never a
// card border (selection and reach own that channel) and never a pill (status
// owns that one). Three channels, three meanings, no overlap.
//
// It is also never the only carrier: the type token itself is printed in mono
// on every card, and each group wears its family's words as a heading. Someone
// who cannot separate the hues loses nothing but the shortcut.
//
// ## Only what the registry declares gets classified
//
// `familyOf` reads the vendored claim-type table's roots and refuses to invent
// anything beyond them. A token the registry has never seen resolves to
// `unregistered` — not to a family guessed from its spelling — for the same
// reason `claim-sensitivity.ts` will not walk a prefix into a *looser*
// treatment: a local rule that groups `profile.github` under some invented
// "profile" family is a statement about a vocabulary nobody has agreed, drawn
// in a colour that reads as though somebody had. `unregistered` is an honest
// answer and its words on screen say so.

import { REGISTERED_ROOTS } from "./claim-sensitivity.js";

/** The families this console groups by. `unregistered` is a real member, not a
 *  fallback bucket to be tidied away: it is the answer for every token the
 *  registry does not declare, which today includes most of what a holder
 *  invents for themselves. */
export type Family = "identity" | "contact" | "public" | "gated" | "unregistered";

/** Top to bottom, the order the map lays the groups out in — roughly how
 *  closely a value identifies the person, so the row reads as a gradient rather
 *  than an alphabet. `unregistered` sits last because it is the group whose
 *  size is a question rather than a fact about the holder. */
export const FAMILY_ORDER: readonly Family[] = ["identity", "contact", "public", "gated", "unregistered"];

export interface FamilyStyle {
  /** The group heading, in the vocabulary of `design-docs/persona-vocabulary.md`. */
  label: string;
  /** One line under the heading. Says what the group *is*, never what it
   *  protects — the mask defends a screen and this colour defends nothing. */
  note: string;
  /** The stripe/dot colour, as a token reference so both themes resolve. */
  hue: string;
}

const STYLES: Readonly<Record<Family, FamilyStyle>> = {
  identity: {
    label: "Who you are",
    note: "names, and what is true of you as a person",
    hue: "var(--m-fam-identity)",
  },
  contact: {
    label: "How to reach you",
    note: "an address someone can arrive at",
    hue: "var(--m-fam-contact)",
  },
  public: {
    label: "Where you already appear",
    note: "handles, pages and roles others can already see",
    hue: "var(--m-fam-public)",
  },
  gated: {
    // Not "sensitive" and not "protected": the registry marks these
    // `release: stepUp`, so the agent refuses a disclosure until the holder
    // approves that particular one. That is an agent behaviour worth naming,
    // and it is the only claim this label makes.
    label: "Your agent asks first",
    note: "the registry gates these — a disclosure needs your approval each time",
    hue: "var(--m-fam-gated)",
  },
  unregistered: {
    label: "Not in the registry",
    note: "your agent's claim-type table does not declare these, so they are treated as the most private kind",
    hue: "var(--m-fam-unregistered)",
  },
};

export function familyStyle(family: Family): FamilyStyle {
  return STYLES[family];
}

/**
 * The family of a claim type.
 *
 * Matched on the **root segment only**, and only when the registry declares
 * that root. `payment.giftCard` is `gated` because `payment` is a declared
 * family entry; `profile.github` is `unregistered` because no `profile` entry
 * exists, and inventing one here would put a colour on a grouping the registry
 * has never agreed to.
 *
 * `x:` is the open extension namespace and is unregistered by construction —
 * tested first so `x:name.legal` cannot borrow `name`'s group, exactly as
 * `treatmentOf` refuses to let it borrow `name`'s mask.
 */
export function familyOf(type: string): Family {
  if (type.startsWith("x:")) return "unregistered";
  const root = type.split(".")[0] ?? "";
  if (!REGISTERED_ROOTS.has(root)) return "unregistered";
  switch (root) {
    case "name":
    case "person":
      return "identity";
    case "email":
    case "phone":
    case "address":
      return "contact";
    case "account":
    case "url":
    case "org":
      return "public";
    case "payment":
    case "gov":
      return "gated";
    default:
      // A root the registry declares and this file has not placed. It reads as
      // unclassified rather than being forced into the nearest group, and
      // `manager-attribute-family.test.mts` fails on it — a re-sync that adds a
      // vocabulary should be a decision someone makes, not a silent regrouping.
      return "unregistered";
  }
}
