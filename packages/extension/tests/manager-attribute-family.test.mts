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
import { familyOf, familyStyle, FAMILY_ORDER, type Family } from "../src/manager/attribute-family.ts";
import { REGISTERED_ROOTS } from "../src/manager/claim-sensitivity.ts";

test("the registry's own vocabularies land where their words say", () => {
  assert.equal(familyOf("name.legal"), "identity");
  assert.equal(familyOf("person.birthDate"), "identity");
  assert.equal(familyOf("email.work"), "contact");
  assert.equal(familyOf("phone.mobile"), "contact");
  assert.equal(familyOf("address.postal"), "contact");
  assert.equal(familyOf("account.handle"), "public");
  assert.equal(familyOf("org.role"), "public");
  assert.equal(familyOf("gov.id.passport"), "gated");
  assert.equal(familyOf("payment.card"), "gated");
});

test("a token invented under a declared family stays in it", () => {
  // The same direction `treatmentOf` walks a prefix in: a family entry the
  // registry declares covers what is invented beneath it.
  assert.equal(familyOf("payment.giftCard"), "gated");
  assert.equal(familyOf("gov.id.somethingNew"), "gated");
});

test("a token no registry root covers is unregistered, not guessed at", () => {
  // `profile.*` and `employer` are what a holder actually types today, and
  // neither is in the table. Inventing a "profile" family here would draw a
  // grouping nobody has agreed to.
  assert.equal(familyOf("profile.github"), "unregistered");
  assert.equal(familyOf("profile.signal"), "unregistered");
  assert.equal(familyOf("employer"), "unregistered");
  assert.equal(familyOf(""), "unregistered");
});

test("the open extension namespace cannot borrow a core token's family", () => {
  // Tested first inside `familyOf` for the same reason `treatmentOf` tests it
  // first: `x:name.legal` must not inherit `name`.
  assert.equal(familyOf("x:name.legal"), "unregistered");
  assert.equal(familyOf("x:payment.card"), "unregistered");
});

test("every root the registry declares has been placed in a family", () => {
  // A re-sync that adds a vocabulary fails here rather than quietly colouring
  // it as unregistered — which would look identical to a token nobody has
  // reasoned about, and be a different fact entirely.
  const unplaced = [...REGISTERED_ROOTS].filter((root) => familyOf(`${root}.anything`) === "unregistered");
  assert.deepEqual(unplaced, [], "place these roots in attribute-family.ts");
});

test("every family has words and a hue, and the order names them all", () => {
  const families: Family[] = ["identity", "contact", "public", "gated", "unregistered"];
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
