// What to offer someone who has just arrived and holds nothing.
//
// ## Why a suggested set at all
//
// The first step of the guided setup opens an empty editor with a free-text
// claim type. That is correct and unhelpable: a person who has never seen this
// model does not know that `name.given` is a thing they may write, and the
// registry that would tell them is not on the screen. So they type one
// attribute, or none, and the face they build next has nothing to select.
//
// This is the answer to "what should I put in", in the holder's words, drawn
// from the vocabulary their agent actually declares.
//
// ## The set is checked against the agent, not compiled as truth
//
// The tokens below are a *suggestion*, and `starterFor` marks each one with
// whether **this** agent's registry declares it. That matters because of §4
// rule 3: an undeclared leaf resolves to the more protective of its family and
// the unregistered floor, so offering `person.pronouns` to an agent that has
// never heard of it produces an attribute masked as though it were a passport
// number. Suggesting it anyway and saying nothing would be this console
// inventing a vocabulary — the thing `familyOf` already refuses to do.
//
// The check is for an **exact** entry rather than `isRegisteredType`'s family
// walk, because the walk answers a different question. `person` being declared
// does not mean `person.pronouns` inherits its treatment; rule 3 only ever
// tightens, so the walk would return `true` for a token that is nevertheless
// about to be masked.
//
// ## What is deliberately not offered
//
// Every `gov.*` and `payment.*` token. Two reasons, and the second is the one
// that matters:
//
// 1. They resolve to `release: stepUp`, so every disclosure needs a fresh
//    approval on the holder's device — a real cost to accept before anyone has
//    seen the model work once.
// 2. A passport number that a person **typed** has provenance `selfAsserted`.
//    On screen that reads *you said so*, and to a verifier it is worth exactly
//    that: nothing. Inviting someone to type one into a browser form in their
//    first five minutes teaches the reflex this whole model exists to break,
//    in exchange for a value no counterparty can rely on.
//
// The wizard points at credentials instead, which is where a provable
// government identifier comes from.

import type { ClaimTypeRegistry } from "@openvtc/pnm-core/persona";

/** How eagerly a suggestion is put in front of someone. */
export type Tier = "basics" | "often";

export interface Suggestion {
  /** The claim type this writes. */
  type: string;
  /** The holder's words for it — never the token, which is shown beside it. */
  label: string;
  /** What the agent stores it as. Only `person.birthDate` is not a string. */
  valueType: "string" | "date";
  tier: Tier;
  /** Placeholder text. Shows the *shape* expected, never a real-looking value:
   *  a greyed specimen that reads as data is one people leave in place. */
  hint?: string;
}

/**
 * The suggestions, in the order they are offered.
 *
 * `basics` first and expanded — ordinary values that resolve to `mask: none`,
 * so what a person types stays legible on their own screen and nothing about
 * the first five minutes reads as a vault. `often` is the set most sites ask
 * for and most of it is `sensitivity: high`, so it is offered folded: worth
 * having, not worth insisting on before anyone has seen what a face does.
 */
export const SUGGESTIONS: readonly Suggestion[] = [
  { type: "name.given", label: "First name", valueType: "string", tier: "basics" },
  { type: "name.family", label: "Last name", valueType: "string", tier: "basics" },
  {
    type: "name.display",
    label: "What you like to be called",
    valueType: "string",
    tier: "basics",
  },
  { type: "email.personal", label: "Personal email", valueType: "string", tier: "basics" },
  { type: "person.pronouns", label: "Pronouns", valueType: "string", tier: "basics" },
  {
    type: "address.country",
    label: "Country you live in",
    valueType: "string",
    tier: "basics",
    hint: "Australia",
  },
  { type: "person.locale", label: "Language", valueType: "string", tier: "basics", hint: "en-AU" },

  { type: "phone.mobile", label: "Mobile number", valueType: "string", tier: "often" },
  { type: "person.birthDate", label: "Date of birth", valueType: "date", tier: "often" },
  { type: "address.postal", label: "Home address", valueType: "string", tier: "often" },
  { type: "email.work", label: "Work email", valueType: "string", tier: "often" },
  { type: "org.name", label: "Where you work", valueType: "string", tier: "often" },
  { type: "org.role", label: "What you do there", valueType: "string", tier: "often" },
];

/** Prefixes this wizard will not offer, and the sentence that says why. */
export const WITHHELD_PREFIXES = ["gov.", "payment."] as const;

/**
 * Why a passport or a card is not among the suggestions.
 *
 * Exported so it is asserted rather than described — a later change that adds
 * `gov.id.passport` to the list above has to delete this, and deleting a
 * sentence is visible in a diff in a way that appending a row is not.
 */
export function whyNoIdentityDocuments(): string {
  return (
    "Government identifiers and payment details are not suggested here. Typed in, they are only " +
    "ever worth what you say they are worth — your agent will show them as “you said so”, and a " +
    "site that needs to rely on one cannot. They belong in a credential from whoever issued them."
  );
}

/** A suggestion, plus what this agent's registry says about it. */
export interface OfferedSuggestion extends Suggestion {
  /**
   * Whether the registry declares this exact token.
   *
   * `false` is not a reason to hide the row — the holder may still want the
   * value — but it is a reason to say that their agent will treat it as the
   * most private kind it has, which is otherwise a surprise discovered after
   * typing.
   */
  declared: boolean;
}

/**
 * The suggestions to offer, marked against a registry.
 *
 * `null` — the table is in flight, or the agent would not serve one — marks
 * every row undeclared rather than assuming the tokens are fine. That is the
 * same fail-closed direction the rest of the pane takes: with no table, whether
 * a token is declared is unknowable, and the honest answer is the conservative
 * one.
 */
export function starterFor(registry: ClaimTypeRegistry | null): OfferedSuggestion[] {
  return SUGGESTIONS.map((s) => ({
    ...s,
    declared: registry !== null && registry.entries.some((e) => e.type === s.type),
  }));
}

/**
 * Guard: no suggestion may name a withheld prefix.
 *
 * Called by the test rather than at runtime. The list above is hand-written and
 * the exclusion is the kind of decision that gets undone by someone adding a
 * plausible row without reading the header.
 */
export function offersWithheldType(): string | null {
  for (const s of SUGGESTIONS) {
    for (const prefix of WITHHELD_PREFIXES) {
      if (s.type.startsWith(prefix)) return s.type;
    }
  }
  return null;
}

/** What will actually be written: the rows someone typed a value into. */
export interface StarterEntry {
  type: string;
  valueType: "string" | "date";
  label: string;
  value: string;
}

/**
 * The entries to write, from the form's raw text.
 *
 * Whitespace-only is nothing, not an empty string. Writing `""` for a row
 * somebody tabbed through would put an attribute in their list that says their
 * first name is blank — and `attribute/put` is a replace, so the correction is
 * a second round trip rather than a no-op.
 */
export function entriesToWrite(
  offered: readonly OfferedSuggestion[],
  values: Readonly<Record<string, string>>,
): StarterEntry[] {
  return offered.flatMap((s) => {
    const raw = (values[s.type] ?? "").trim();
    if (raw === "") return [];
    return [{ type: s.type, valueType: s.valueType, label: s.label, value: raw }];
  });
}
