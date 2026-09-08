// Which family a claim type is grouped and coloured by.
//
// The stripe is a shortcut, and a shortcut that points at the wrong family is
// worse than none: it groups a holder's attributes under a heading the registry
// never agreed to, in a colour that reads as though somebody had checked. So
// the two directions of error are tested separately — a registered token
// landing in the wrong group, and an *un*registered one landing in any group at
// all.

import { test } from "node:test";
import assert from "node:assert/strict";
import { PLACED_ROOTS, familyOf, familyStyle, FAMILY_ORDER, type Family } from "../src/manager/attribute-family.ts";
// The roots come from the agent now, so the test supplies a table the way the
// console receives one.
const REGISTRY = {
  registryVersion: "0.1",
  entries: [
    "name", "name.legal", "person", "person.birthDate", "email", "email.work",
    "phone", "phone.mobile", "address", "address.postal", "account",
    "account.handle", "url", "url.homepage", "org", "org.role", "gov",
    "gov.id.passport", "payment", "payment.card",
  ].map((type) => ({ type, sensitivity: "normal", release: "consent", mask: "none" })),
  unregistered: { sensitivity: "high", release: "consent", mask: "full" },
  strictness: {
    sensitivity: ["high", "normal"],
    release: ["stepUp", "consent"],
    mask: ["full", "last2", "last4", "emailLocal", "none"],
  },
} as never;


test("the registry's own vocabularies land where their words say", () => {
  assert.equal(familyOf("name.legal", REGISTRY), "identity");
  assert.equal(familyOf("person.birthDate", REGISTRY), "identity");
  assert.equal(familyOf("email.work", REGISTRY), "contact");
  assert.equal(familyOf("phone.mobile", REGISTRY), "contact");
  assert.equal(familyOf("address.postal", REGISTRY), "contact");
  assert.equal(familyOf("account.handle", REGISTRY), "public");
  assert.equal(familyOf("org.role", REGISTRY), "public");
  assert.equal(familyOf("gov.id.passport", REGISTRY), "gated");
  assert.equal(familyOf("payment.card", REGISTRY), "gated");
});

test("a token invented under a declared family stays in it", () => {
  // The same direction `treatmentOf` walks a prefix in: a family entry the
  // registry declares covers what is invented beneath it.
  assert.equal(familyOf("payment.giftCard", REGISTRY), "gated");
  assert.equal(familyOf("gov.id.somethingNew", REGISTRY), "gated");
});

test("a token no registry root covers is unregistered, not guessed at", () => {
  // `profile.*` and `employer` are what a holder actually types today, and
  // neither is in the table. Inventing a "profile" family here would draw a
  // grouping nobody has agreed to.
  assert.equal(familyOf("profile.github", REGISTRY), "unregistered");
  assert.equal(familyOf("profile.signal", REGISTRY), "unregistered");
  assert.equal(familyOf("employer", REGISTRY), "unregistered");
  assert.equal(familyOf("", REGISTRY), "unregistered");
});

test("the open extension namespace cannot borrow a core token's family", () => {
  // Tested first inside `familyOf` for the same reason `treatmentOf` tests it
  // first: `x:name.legal` must not inherit `name`.
  assert.equal(familyOf("x:name.legal", REGISTRY), "unregistered");
  assert.equal(familyOf("x:payment.card", REGISTRY), "unregistered");
});

test("every root this console places really is placed", () => {
  // What this used to assert — that every root in a *vendored* table had a
  // family — cannot survive reading the table from the agent: a maintainer may
  // serve a vocabulary this build has never heard of, and colouring one is not
  // something a compiled switch can promise. What is still checkable, and still
  // the bug worth catching, is the mapping being internally complete.
  const placed = {
    ...(REGISTRY as unknown as Record<string, unknown>),
    entries: PLACED_ROOTS.map((type) => ({
      type, sensitivity: "normal", release: "consent", mask: "none",
    })),
  } as never;
  const unplaced = PLACED_ROOTS.filter((r) => familyOf(`${r}.anything`, placed) === "unregistered");
  assert.deepEqual(unplaced, [], "place these roots in attribute-family.ts");
});

test("a family the agent declares and this build has no words for is the agent's own", () => {
  // This asserted `unregistered` until deployment extension types existed
  // (verifiable-trust-infrastructure#1327). `unregistered`'s words say the
  // agent's table does not declare this — which is now false about exactly the
  // rows an operator has just added, and the group heading is the first place
  // they would look to check their work.
  //
  // `declared` says the true thing instead: the agent declares it, and this
  // console has no family words of its own for it. Still no guessed colour,
  // still no invented grouping — only the caption changes, and it changes from
  // wrong to right.
  const novel = {
    ...(REGISTRY as unknown as Record<string, unknown>),
    entries: [{ type: "quantum", sensitivity: "normal", release: "consent", mask: "none" }],
  } as never;
  assert.equal(familyOf("quantum.state", novel), "declared");

  // …and a token the agent does NOT declare is still unregistered, which is
  // the distinction this whole test exists to keep.
  assert.equal(familyOf("nothing.likeit", novel), "unregistered");
});

test("a declared family's words do not accuse the agent of not declaring it", () => {
  const { label, note } = familyStyle("declared");
  assert.doesNotMatch(`${label} ${note}`.toLowerCase(), /does not declare|not in the registry/);
  assert.match(note.toLowerCase(), /declared by this agent/);
});

test("every family has words and a hue, and the order names them all", () => {
  const families: Family[] = [
    "identity",
    "contact",
    "public",
    "gated",
    "declared",
    "unregistered",
    "unknown",
  ];
  assert.deepEqual([...FAMILY_ORDER].sort(), [...families].sort(), "a family with no place in the order never draws");
  for (const family of families) {
    const style = familyStyle(family);
    assert.ok(style.label.length > 0 && style.note.length > 0);
    assert.match(style.hue, /^var\(--m-fam-[a-z]+\)$/, "colour comes from a token, so both themes resolve");
  }
});

test("no family's words claim the colour protects anything", () => {
  // The stripe is categorical. `claim-sensitivity.ts` is emphatic that even the
  // mask defends a screen and not the page, and a heading saying otherwise
  // would be the console overstating what it does — the one thing this pane
  // must never do about the holder's own data.
  for (const family of FAMILY_ORDER) {
    const { label, note } = familyStyle(family);
    const words = `${label} ${note}`.toLowerCase();
    for (const overclaim of ["secure", "protected", "safe", "encrypted", "hidden from"]) {
      assert.ok(!words.includes(overclaim), `"${overclaim}" claims a protection this colour does not give: ${words}`);
    }
  }
});

test("no table is its own answer, and it does not accuse the tokens", () => {
  // `unregistered` says the agent's table declines to declare this token.
  // Saying that when no table arrived is a claim about the token that nobody
  // checked — the same error as reporting a context the agent would not answer
  // for as a context that holds nothing.
  assert.equal(familyOf("name.legal", null), "unknown");
  assert.equal(familyOf("x:whatever", null), "unknown", "even the one case that is unregistered by construction");
  const { label, note } = familyStyle("unknown");
  assert.doesNotMatch(`${label} ${note}`.toLowerCase(), /does not declare/);
  assert.match(note.toLowerCase(), /did not answer/);
});
