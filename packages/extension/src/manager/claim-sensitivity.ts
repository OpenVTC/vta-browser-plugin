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
// **The control that would matter does not exist yet.** It is a read-path one —
// an `includeSensitive` flag on `persona/attribute/list`, so a listing that did
// not ask for sensitive values is answered without them and the console never
// holds the string in the first place. `CLAIM-TYPES.md` §3.1 says the same
// thing in one sentence: "Masking a value already fetched is theatre. The
// control that matters is on the read path; the mask is what makes the control
// visible." Until that flag lands in the spec and the agent, this file is the
// visible half of a control whose enforcing half is missing. Do not describe it
// as anything more in a UI string, a commit message or a review.
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

/** How carefully a value is shown to its own holder — `CLAIM-TYPES.md` §3.1. */
export type Sensitivity = "normal" | "high";

/** One of the styles `claim-types.json` enumerates under `maskStyles`. */
export type MaskStyle = "none" | "last2" | "last4" | "emailLocal" | "full";

export interface ClaimTreatment {
  sensitivity: Sensitivity;
  mask: MaskStyle;
}

/** The `registryVersion` the table below was taken from. Carried so a future
 *  re-sync against a served registry has something to compare, and so a reader
 *  can tell which draft this agrees with. */
export const REGISTRY_VERSION = "0.1";

/**
 * What an unregistered token resolves to — `CLAIM-TYPES.md` §4 rule 3.
 *
 * Deliberately the conservative answer, and the registry gives the reasoning
 * rather than leaving it to be inferred: a vocabulary the registry has never
 * seen is exactly the one nobody has reasoned about, and an unknown value
 * rendered in the clear is a decision nobody made.
 *
 * Note what this is *not* applied to. §4 keeps "absence is the most restrictive
 * answer" for an unknown **token**, never for an unset field on a known one —
 * applied to the latter it would mask every legal name in every pool, which
 * teaches an operator to press *Show* reflexively and leaves them less
 * protected than before. So `name.legal` is `normal`/`none` because the
 * registry says so, and only a token with no entry falls here.
 */
export const UNREGISTERED: ClaimTreatment = { sensitivity: "high", mask: "full" };

/**
 * The core vocabulary, as `claim-types.json` declares it.
 *
 * A plain record rather than a `Map` so a reader can diff it against the JSON
 * line for line, which is the maintenance operation this table actually gets.
 */
const REGISTERED: Readonly<Record<string, ClaimTreatment>> = {
  // Family entries — matched as a prefix by `treatmentOf`, and the reason a
  // token invented under a gated family cannot escape it.
  payment: { sensitivity: "high", mask: "full" },
  gov: { sensitivity: "high", mask: "full" },

  // Both an exact token and a family prefix: a pool that keeps one
  // undifferentiated name is using `name`, and without an entry it would mask
  // in full.
  name: { sensitivity: "normal", mask: "none" },

  "name.legal": { sensitivity: "normal", mask: "none" },
  "name.given": { sensitivity: "normal", mask: "none" },
  "name.family": { sensitivity: "normal", mask: "none" },
  "name.display": { sensitivity: "normal", mask: "none" },
  "name.previous": { sensitivity: "high", mask: "full" },

  "person.birthDate": { sensitivity: "high", mask: "full" },
  "person.pronouns": { sensitivity: "normal", mask: "none" },
  "person.locale": { sensitivity: "normal", mask: "none" },

  "email.personal": { sensitivity: "normal", mask: "emailLocal" },
  "email.work": { sensitivity: "normal", mask: "emailLocal" },

  "phone.mobile": { sensitivity: "high", mask: "last2" },
  "phone.landline": { sensitivity: "high", mask: "last2" },

  "address.postal": { sensitivity: "high", mask: "full" },
  "address.country": { sensitivity: "normal", mask: "none" },

  "gov.id.passport": { sensitivity: "high", mask: "last4" },
  "gov.id.driverLicence": { sensitivity: "high", mask: "last4" },
  "gov.id.national": { sensitivity: "high", mask: "last4" },
  "gov.taxId": { sensitivity: "high", mask: "last4" },

  "payment.card": { sensitivity: "high", mask: "last4" },
  "payment.cardExpiry": { sensitivity: "high", mask: "full" },
  "payment.iban": { sensitivity: "high", mask: "last4" },
  "payment.accountNumber": { sensitivity: "high", mask: "last4" },

  "account.handle": { sensitivity: "normal", mask: "none" },
  "url.homepage": { sensitivity: "normal", mask: "none" },

  "org.name": { sensitivity: "normal", mask: "none" },
  "org.role": { sensitivity: "normal", mask: "none" },
};

/**
 * The first segment of every token the table above declares.
 *
 * Derived rather than written out, so it cannot drift from the table on a
 * re-sync — a root that appears here without anyone editing this line is the
 * registry having grown one, which is exactly what `attribute-family.ts` wants
 * to be told about. It is the only thing outside this module that may ask what
 * the registry *covers*: whether a token is known is a registry question,
 * while what a family means on screen is a console one.
 */
export const REGISTERED_ROOTS: ReadonlySet<string> = new Set(
  Object.keys(REGISTERED).map((token) => token.split(".")[0]!),
);

/**
 * How this type's values are treated — `CLAIM-TYPES.md` §4, minus the rule
 * this console cannot take part in.
 *
 * §4's first rule is a per-attribute override the holder set explicitly, which
 * wins over the registry. No field carries one on the wire yet, so nothing here
 * can read it; when one exists it belongs *above* this call, not inside it,
 * because "the holder decided" and "the registry says" are different attributes and
 * a UI that wants to explain the difference needs both.
 *
 * **The prefix walk is rule 3, and it only ever tightens.** An unregistered
 * token takes the *more protective* of its longest registered prefix and the
 * unregistered floor, per axis — never the prefix outright. That direction is
 * the whole point: `payment.giftCard` inherits `payment`'s treatment because a
 * gated family must not be leavable by inventing a token, while `name.somethingNew`
 * does **not** inherit `name`'s `none` and stays masked, because a family entry
 * cannot make an unknown token visible.
 *
 * This console reported the walk's absence when it first vendored this table;
 * the registry gained it in trust-tasks#377, and this is that rule.
 */
export function treatmentOf(type: string): ClaimTreatment {
  // `x:` is the open extension namespace (`ClaimType` in
  // `persona-record.schema.json`), and §4's last rule names it alongside an
  // unregistered token. Tested before anything else so an `x:`-prefixed
  // spelling of a core token cannot borrow that token's entry — nor, now,
  // its family's.
  if (type.startsWith("x:")) return UNREGISTERED;

  const exact = REGISTERED[type];
  if (exact) return exact;

  // Longest registered prefix, on dot boundaries only: `payment.card` is under
  // `payment`, but a token merely *starting with* those characters is not.
  let prefix: ClaimTreatment | undefined;
  const segments = type.split(".");
  for (let i = segments.length - 1; i > 0; i--) {
    const candidate = REGISTERED[segments.slice(0, i).join(".")];
    if (candidate) {
      prefix = candidate;
      break;
    }
  }
  if (!prefix) return UNREGISTERED;

  return {
    sensitivity: stricter(SENSITIVITY_ORDER, prefix.sensitivity, UNREGISTERED.sensitivity),
    mask: stricter(MASK_ORDER, prefix.mask, UNREGISTERED.mask),
  };
}

/** `strictness` in `claim-types.json`, most protective first. Kept as arrays
 *  rather than comparisons so the ordering is diffable against the registry. */
const SENSITIVITY_ORDER: readonly Sensitivity[] = ["high", "normal"];
const MASK_ORDER: readonly MaskStyle[] = ["full", "last2", "last4", "emailLocal", "none"];

/** The more protective of two values on one axis. A value the order does not
 *  know is treated as least protective, so an unrecognised entry can never win
 *  and quietly loosen a treatment. */
function stricter<T>(order: readonly T[], a: T, b: T): T {
  const rank = (v: T) => {
    const i = order.indexOf(v);
    return i === -1 ? order.length : i;
  };
  return rank(a) <= rank(b) ? a : b;
}

/** Whether a value of this type is hidden until asked for.
 *
 *  Masking no longer requires `sensitivity: high` — §3.3 made the two
 *  independent, because they are two strengths of protection rather than one.
 *  `high` means *withheld from a listing that did not ask*; a mask style means
 *  *not shown in the clear*. An email address is worth hiding from the person
 *  behind you without being worth withholding from every listing, and until the
 *  two were separated there was no way to say so — `email.*` carried a style no
 *  rule could ever apply. */
export function isSensitive(type: string): boolean {
  return treatmentOf(type).mask !== "none";
}

/** The character a mask is drawn with. One glyph, everywhere, so a masked value
 *  is recognisable as one at a glance and never reads as a value that happens
 *  to contain punctuation. */
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
 * greys a mask the way it greys "not requested" has told the operator that a
 * attribute they hold is an attribute they do not.
 */
export function maskedFact(type: string, text: string): { text: string; masked: boolean } {
  const treatment = treatmentOf(type);
  if (treatment.sensitivity !== "high") return { text, masked: false };
  const masked = maskText(text, treatment.mask);
  // A style of `none` on a `high` type would mask nothing while claiming to.
  // No such entry exists; if one is added, the honest answer is to draw the
  // value plainly and offer no control, rather than a *Show* button that
  // changes nothing.
  return { text: masked, masked: masked !== text };
}
