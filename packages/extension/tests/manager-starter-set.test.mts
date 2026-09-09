// What the guided setup offers someone holding nothing.
//
// Two properties carry the weight here and neither is visible in the component:
// the set never suggests a value that is worthless when typed, and it never
// claims a token is ordinary when the agent in front of it has not said so.

import { test } from "node:test";
import assert from "node:assert/strict";
import {
  SUGGESTIONS,
  WITHHELD_PREFIXES,
  starterFor,
  offersWithheldType,
  entriesToWrite,
  whyNoIdentityDocuments,
} from "../src/manager/starter-set.ts";

const registryOf = (types: string[]) =>
  ({
    registryVersion: "0.1",
    entries: types.map((type) => ({
      type,
      sensitivity: "normal",
      release: "consent",
      mask: "none",
    })),
    unregistered: { sensitivity: "high", release: "consent", mask: "full" },
    strictness: {
      sensitivity: ["high", "normal"],
      release: ["stepUp", "consent"],
      mask: ["full", "last2", "last4", "emailLocal", "none"],
    },
  }) as never;

test("no identity document or payment instrument is ever suggested", () => {
  // Typed in, they are worth exactly what the holder says they are worth, and
  // asking for one in the first five minutes teaches the reflex the model
  // exists to break. Adding one has to delete this test.
  assert.equal(offersWithheldType(), null);
  for (const prefix of WITHHELD_PREFIXES) {
    assert.ok(
      !SUGGESTIONS.some((s) => s.type.startsWith(prefix)),
      `a ${prefix} token reached the suggestions`,
    );
  }
  assert.match(whyNoIdentityDocuments(), /you said so/);
});

test("the basics are the ones that stay legible on your own screen", () => {
  // `basics` is expanded on arrival, so nothing in it should resolve to a mask.
  // These are the registry's `mask: none` tokens by construction; the test
  // pins the membership so a later addition has to be thought about.
  const basics = SUGGESTIONS.filter((s) => s.tier === "basics").map((s) => s.type);
  assert.deepEqual(basics, [
    "name.given",
    "name.family",
    "name.display",
    "email.personal",
    "person.pronouns",
    "address.country",
    "person.locale",
  ]);
  // The high-sensitivity ones are offered, just not put in front of anyone.
  const often = SUGGESTIONS.filter((s) => s.tier === "often").map((s) => s.type);
  assert.ok(often.includes("phone.mobile"));
  assert.ok(often.includes("person.birthDate"));
  assert.ok(often.includes("org.name"), "the workplace question is missing");
});

test("a suggestion is marked against the agent in front of it", () => {
  const registry = registryOf(["name.given", "email.personal"]);
  const offered = starterFor(registry);
  assert.equal(offered.find((o) => o.type === "name.given")?.declared, true);
  assert.equal(offered.find((o) => o.type === "person.locale")?.declared, false);
});

test("a declared FAMILY does not make its leaf declared", () => {
  // §4 rule 3 only ever tightens: `person` being declared does not lend its
  // treatment to `person.pronouns`, which still resolves to the conservative
  // floor. `isRegisteredType`'s family walk would answer true here and would be
  // answering a different question.
  const offered = starterFor(registryOf(["person"]));
  assert.equal(
    offered.find((o) => o.type === "person.pronouns")?.declared,
    false,
    "a family entry was read as declaring its leaf",
  );
});

test("no table means nothing is claimed about any token", () => {
  // Fail closed, in the same direction as the rest of the pane: with no table,
  // whether a token is declared is unknowable.
  assert.ok(starterFor(null).every((o) => !o.declared));
});

test("only rows somebody typed into are written", () => {
  const offered = starterFor(registryOf(["name.given"]));
  const entries = entriesToWrite(offered, {
    "name.given": "Ada",
    "name.family": "   ",
    "email.personal": "",
  });
  assert.deepEqual(
    entries.map((e) => e.type),
    ["name.given"],
    "a blank or whitespace-only row was written",
  );
  assert.equal(entries[0]!.value, "Ada");
  assert.equal(entries[0]!.label, "First name");
});

test("a typed value is trimmed before it is written", () => {
  const entries = entriesToWrite(starterFor(null), { "name.given": "  Ada  " });
  assert.equal(entries[0]!.value, "Ada");
});

test("a date is written as a date", () => {
  // The store validates the value against `valueType` and refuses a mismatch.
  const entries = entriesToWrite(starterFor(null), { "person.birthDate": "1815-12-10" });
  assert.equal(entries[0]!.valueType, "date");
});
