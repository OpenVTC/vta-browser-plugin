// How carefully an attribute's value is shown to the person who owns it.
//
// ## This is not a security control, and saying so is the point
//
// By the time this module runs, the value is already in the page: the console
// asked `persona/attribute/list`, the agent answered, and the string sits in a
// React tree that any script on this origin — and every screenshot, screen
// share and shoulder — can reach. Masking it afterwards changes what is
// *drawn*, not what was *fetched*. Anyone reading this code and concluding that
// a masked card is a card whose value the console does not hold has read it
// wrong.
//
// What it does defend against is the whole of what it claims: someone standing
// behind the operator, a screen recording, a support call where the console is
// shared, a screenshot pasted into an issue. Those are real, and they are the
// entire scope.
//
// **The control that matters is the read path, and it now exists.**
// `includeSensitive` on `persona/attribute/list` (trust-tasks 0.17.4) is what
// keeps a sensitive value out of the page in the first place, and the persona
// pane lists *without* it: see `reveal-value.ts`, where *Show* becomes the
// request for one value rather than a curtain drawn back over a string that was
// already here. `CLAIM-TYPES.md` §3.1 says it in one sentence — "Masking a value
// already fetched is theatre. The control that matters is on the read path; the
// mask is what makes the control visible." This file is that visible half, and
// only that half. Do not describe it as anything more in a UI string, a commit
// message or a review.
//
// ## The table below is vendored, and will go stale
//
// Copied by hand from **`dtgwg-trust-tasks-tf/specs/persona/_shared/0.1/claim-types.json`**
// (`registryVersion` 0.1, draft/in review), because the agent does not serve
// this table: `CLAIM-TYPES.md` §6 lists a `persona/claim-types/list` task as an
// open question, deliberately deferred until the first extension type ships.
// Clients ship it statically in the meantime, and this is the static copy.
//
// Only the two members this console reads are transcribed — `sensitivity` and
// `mask`. The registry also carries `valueType`, `release`, `minimumSet` and
// `oidc` mappings; a vendored copy that reproduced all of them would look like
// a client that acts on all of them, and none of the others has a consumer
// here. Re-sync by comparing this table against that file, not by rewriting it
// from memory.

import {
  resolveTreatment,
  isRegisteredType,
  type ClaimTypeRegistry,
  type ClaimTreatment,
} from "@openvtc/pnm-core/persona";

export type { ClaimTreatment };

/** One of the styles the registry enumerates under `maskStyles`. */
export type MaskStyle = "none" | "last2" | "last4" | "emailLocal" | "full";

/** How carefully a value is shown to its own holder — `CLAIM-TYPES.md` §3.1. */
export type Sensitivity = "normal" | "high";

const DOT = "•";

/**
 * The bullet run is a **fixed** width, not one per hidden character.
 *
 * Per-character would draw a 34-glyph run for an IBAN and a 3-glyph one for a
 * short code, which publishes the length of every value the mask is meant to
 * hide — and length is a real hint for a card number, a passport number or a
 * postcode. A fixed run says "hidden" and says nothing else.
 */
const RUN = DOT.repeat(4);

/**
 * Apply a mask style to a value's **rendering**, not to the value.
 *
 * The caller passes what `formatValue` produced, so an object arrives as JSON.
 * Every object-valued type in the registry is `mask: "full"`, so a tail style
 * never meets a JSON blob today; a future entry pairing `object` with `last4`
 * would be a bug in the registry — it would publish the closing braces of a
 * structure and hide the interesting part — and is not something to compensate
 * for here.
 */
export function maskText(text: string, style: MaskStyle): string {
  switch (style) {
    case "none":
      return text;
    case "last2":
      return tail(text, 2);
    case "last4":
      return tail(text, 4);
    case "emailLocal":
      return emailLocal(text);
    case "full":
    default:
      return RUN;
  }
}

/**
 * The final `keep` characters, and a run for everything before them.
 *
 * A value no longer than the tail falls through to a full mask: "the last four
 * of a four-character value" is the value, so honouring the style literally
 * would render the whole secret and call it masked.
 */
function tail(text: string, keep: number): string {
  if (text.length <= keep) return RUN;
  return `${RUN} ${text.slice(-keep)}`;
}

/**
 * `a{RUN}@example.com` — the registry's own rendering.
 *
 * The domain is what makes an address recognisable to its owner; the local part
 * is what makes it usable to anyone else. Anything that is not an address is
 * masked in full rather than guessed at: a tail style over a non-address is the
 * case where a mask silently reveals the wrong half.
 */
function emailLocal(text: string): string {
  const at = text.lastIndexOf("@");
  if (at < 1 || at === text.length - 1) return RUN;
  return `${text[0]}${DOT.repeat(3)}${text.slice(at)}`;
}

/**
 * What to draw for an attribute, and whether a *Show* control belongs beside it.
 *
 * `masked` is the caller's cue for two separate things and both matter: a
 * reveal control, and a rendering distinct from an absent value. A pane that
 * greys a mask the way it greys a value the agent never sent has told the
 * operator that an attribute they hold is an attribute they do not.
 *
 * **The mask style decides, not the sensitivity.** §3.3 made the two axes
 * independent — `high` means *withheld from a listing that did not ask*, a mask
 * style means *not shown in the clear* — and this function used to gate on
 * `high` anyway. `email.*` is the case that showed it: `normal`/`emailLocal`,
 * so `isSensitive` called it hidden and the strip promised it was "hidden until
 * you press Show", while the address sat on screen in full with no button to
 * press. Two functions, one question, two answers.
 *
 * `override` is the holder's own `sensitivity`, where they set one — see
 * `treatmentFor`, which is where that decision is applied and where the reason
 * an unregistered token's mask follows it is written down.
 */
export function maskedValue(
  registry: ClaimTypeRegistry | null,
  type: string,
  text: string,
  override?: Sensitivity | undefined,
): { text: string; masked: boolean } {
  const { treatment } = treatmentFor(registry, type, override);
  if (treatment.mask === "none") return { text, masked: false };
  const masked = maskText(text, treatment.mask as MaskStyle);
  // A mask that changed nothing would claim to hide while hiding nothing — the
  // honest answer is to draw the value plainly and offer no control, rather
  // than a *Show* button that does not change what is on screen.
  return { text: masked, masked: masked !== text };
}

/**
 * How this attribute's value is treated, with the holder's own decision applied
 * over the registry's — `CLAIM-TYPES.md` §4 rule 1.
 *
 * `sensitivity` on an attribute record is present **only** where the holder
 * chose; absent means they chose nothing and the registry answers, which is why
 * this takes the override rather than a resolved value. The two are kept apart
 * all the way to the screen: `source` says which is speaking, so a pane can say
 * "you decided" instead of presenting the registry's answer as the holder's.
 *
 * **Only the axis the holder decided moves — with one exception, and it is the
 * one worth reading.** For a token the registry *declares*, the mask is a
 * separate statement it has made (§3.3: the axes are independent — an email is
 * worth hiding from the person behind you without being worth withholding from
 * every listing), so deciding sensitivity leaves it alone. A holder who marks
 * `phone.mobile` unsensitive gets the value delivered and still sees `•• 25`
 * until they press Show.
 *
 * For an **unregistered** token there is no such statement. `UNREGISTERED` is
 * one conservative answer standing in for a decision nobody made — §4 rule 3's
 * own reasoning, "a vocabulary the registry has never seen is exactly the one
 * nobody has reasoned about" — so when the holder decides, the thing it stood
 * in for has arrived and the mask follows their answer instead of the floor.
 * Without this, someone who marked their own `profile.github` as not sensitive
 * would still be shown four bullets and told to press a button, by a rule whose
 * only justification was that nobody had looked at it yet.
 *
 * The narrowness is the point: a *declared* token's mask never moves, because
 * there the registry has an opinion and this console does not overrule it.
 */
export function treatmentFor(
  registry: ClaimTypeRegistry | null,
  type: string,
  override?: Sensitivity | undefined,
): { treatment: ClaimTreatment; source: "holder" | "registry" } {
  // No table yet. Everything is drawn masked and attributed to the registry,
  // which is the fail-closed answer *and* the honest one: the holder's decision
  // cannot be applied over an answer that has not arrived, and claiming
  // `source: "holder"` here would put their name on a default.
  if (!registry) {
    return { treatment: { sensitivity: "high", mask: "full" }, source: "registry" };
  }
  const declared = resolveTreatment(registry, type);
  if (override === undefined) return { treatment: declared, source: "registry" };
  return {
    treatment: {
      sensitivity: override,
      mask: isRegisteredType(registry, type)
        ? declared.mask
        : override === "high"
          ? "full"
          : "none",
    },
    source: "holder",
  };
}


/** Whether this attribute's value is hidden until asked for, the holder's own
 *  decision included. The `type`-only {@link isSensitive} is the registry's
 *  answer alone and stays that way — a call site holding a whole attribute
 *  should use this one. */
export function isSensitiveFor(
  registry: ClaimTypeRegistry | null,
  type: string,
  override?: Sensitivity | undefined,
): boolean {
  return treatmentFor(registry, type, override).treatment.mask !== "none";
}
