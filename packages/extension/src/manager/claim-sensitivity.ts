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
 * How this **type's** values are treated — `CLAIM-TYPES.md` §4, minus rule 1,
 * which is about one attribute rather than a type.
 *
 * §4's first rule is a per-attribute override the holder set explicitly, which
 * wins over the registry. It stays *above* this call, in `treatmentFor` below —
 * "the holder decided" and "the registry says" are two different claims about
 * one value, and a UI that wants to explain the difference needs both. This
 * function is only ever the second of them.
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
export function maskedFact(
  type: string,
  text: string,
  override?: Sensitivity | undefined,
): { text: string; masked: boolean } {
  const { treatment } = treatmentFor(type, override);
  if (treatment.mask === "none") return { text, masked: false };
  const masked = maskText(text, treatment.mask);
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
  type: string,
  override?: Sensitivity | undefined,
): { treatment: ClaimTreatment; source: "holder" | "registry" } {
  const registry = treatmentOf(type);
  if (override === undefined) return { treatment: registry, source: "registry" };
  return {
    treatment: {
      sensitivity: override,
      mask: isRegistered(type) ? registry.mask : override === "high" ? "full" : "none",
    },
    source: "holder",
  };
}

/** Whether the registry declares this token, or a family it belongs to — the
 *  same walk `treatmentOf` performs, asked as a question. An `x:` token is
 *  never registered, per §4's last rule. */
function isRegistered(type: string): boolean {
  if (type.startsWith("x:")) return false;
  if (REGISTERED[type]) return true;
  const segments = type.split(".");
  for (let i = segments.length - 1; i > 0; i--) {
    if (REGISTERED[segments.slice(0, i).join(".")]) return true;
  }
  return false;
}

/** Whether this attribute's value is hidden until asked for, the holder's own
 *  decision included. The `type`-only {@link isSensitive} is the registry's
 *  answer alone and stays that way — a call site holding a whole attribute
 *  should use this one. */
export function isSensitiveFor(type: string, override?: Sensitivity | undefined): boolean {
  return treatmentFor(type, override).treatment.mask !== "none";
}
