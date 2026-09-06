// Ranking a disclosure preview for a consent screen.
//
// The agent hands back a flat array of claims plus two signals about them —
// `anomalous` (unusual for the verifier's stated purpose) and
// `newToThisVerifier`. A screen that renders the array as it arrived throws
// both away and becomes a notice-and-consent dialog: fourteen fields at
// fourteen equal weights, which is the pattern that teaches people to click
// through. `rankPreview` is what turns the signals into an order.
//
// So these tests are about a security control, not a sort. What is asserted is
// the property a holder relies on: **the line most worth reading is first, and
// equal lines never move between renders.**

import { test } from "node:test";
import assert from "node:assert/strict";

import {
  rankPreview,
  staleClaims,
  correlationSeverity,
} from "../dist/persona/disclosure.js";
import { dropsOf } from "../dist/persona/renderers.js";

const claim = (type, over = {}) => ({
  type,
  value: `value-of-${type}`,
  provenance: "selfAsserted",
  rung: "whole",
  ...over,
});

const preview = (over = {}) => ({
  previewId: "01J0000000000000000000000A",
  subject: "did:key:zPairwise",
  claims: [],
  expiresAt: "2030-01-01T00:00:00Z",
  ...over,
});

test("a stale claim leads, because it is the only notice that changes what the verifier gets", () => {
  const ranked = rankPreview(
    preview({
      claims: [
        claim("name.legal"),
        claim("email.work", { stale: true }),
        claim("phone.mobile", { newToThisVerifier: true }),
      ],
      anomalous: ["phone.mobile"],
    }),
  );

  assert.equal(ranked[0].claim.type, "email.work");
  assert.deepEqual(ranked[0].notices, ["stale"]);
});

test("a claim carries every notice that applies, not just the first", () => {
  const ranked = rankPreview(
    preview({
      claims: [claim("phone.mobile", { newToThisVerifier: true })],
      anomalous: ["phone.mobile"],
    }),
  );

  assert.deepEqual(ranked[0].notices, ["anomalous", "new"]);
});

test("a routine claim carries no notices and sorts last", () => {
  const ranked = rankPreview(
    preview({
      claims: [claim("name.legal"), claim("email.work", { newToThisVerifier: true })],
    }),
  );

  assert.equal(ranked.at(-1).claim.type, "name.legal");
  assert.deepEqual(ranked.at(-1).notices, []);
});

// A predicate discloses no value at all, so it is the one notice that is good
// news. Labelled, but never led with — putting it first would spend the top of
// a consent screen on the safest thing on it.
test("a predicate is labelled but does not lead", () => {
  const ranked = rankPreview(
    preview({
      claims: [
        claim("person.birthDate", {
          value: undefined,
          predicate: { op: "gte", arg: 18, over: "person.birthDate" },
        }),
        claim("email.work", { stale: true }),
      ],
    }),
  );

  assert.equal(ranked[0].claim.type, "email.work");
  assert.deepEqual(ranked[1].notices, ["predicate"]);
});

// The property that makes the order trustworthy. A screen that reshuffled
// equal claims between two renders of the SAME preview would read as
// arbitrary, and a holder who cannot trust the order stops reading it.
test("claims of equal rank keep the order the agent sent them in", () => {
  const claims = [
    claim("a.one", { newToThisVerifier: true }),
    claim("b.two", { newToThisVerifier: true }),
    claim("c.three", { newToThisVerifier: true }),
  ];
  const first = rankPreview(preview({ claims })).map((r) => r.claim.type);
  const again = rankPreview(preview({ claims })).map((r) => r.claim.type);

  assert.deepEqual(first, ["a.one", "b.two", "c.three"]);
  assert.deepEqual(again, first, "ranking is not stable across renders");
});

test("ranking never drops or duplicates a claim", () => {
  const claims = [
    claim("a.one", { stale: true }),
    claim("b.two"),
    claim("c.three", { newToThisVerifier: true }),
    claim("d.four"),
  ];
  const ranked = rankPreview(preview({ claims, anomalous: ["d.four"] }));

  assert.equal(ranked.length, claims.length);
  assert.deepEqual(
    ranked.map((r) => r.claim.type).sort(),
    claims.map((c) => c.type).sort(),
  );
});

test("the claims that will not be sent are separable from the rest", () => {
  const p = preview({
    claims: [claim("name.legal"), claim("email.work", { stale: true })],
  });
  assert.deepEqual(
    staleClaims(p).map((c) => c.type),
    ["email.work"],
  );
});

// The severity comes from the agent and is not re-derived here. The
// derivation inverts in a way that is easy to get backwards — a credential
// presented WHOLE correlates more than a self-asserted value, because the
// issuer's signature is identical at every verifier — and a second opinion
// computed from less information would be worse than none.
test("correlation severity is read, not inferred, and absent means none", () => {
  assert.equal(correlationSeverity(preview()), "none");
  assert.equal(
    correlationSeverity(preview({ correlation: { severity: "high" } })),
    "high",
  );
  // A self-asserted, whole-rung claim looks alarming to a naive rule and is
  // not: this preview says `low`, and that is the answer.
  assert.equal(
    correlationSeverity(
      preview({
        claims: [claim("name.legal", { provenance: "selfAsserted", rung: "whole" })],
        correlation: { severity: "low" },
      }),
    ),
    "low",
  );
});

// `[]` and `undefined` are different answers and a screen must not conflate
// them: `[]` is a lossless renderer, `undefined` is one this agent cannot
// produce. Rendering the second as "discards nothing" would tell a holder a
// format is safe when the disclosure is about to be refused.
test("an unknown renderer is undefined, not an empty drops list", () => {
  const renderers = [
    { id: "rcard", drops: [] },
    { id: "jcard", drops: ["provenance"] },
  ];
  assert.deepEqual(dropsOf(renderers, "rcard"), []);
  assert.deepEqual(dropsOf(renderers, "jcard"), ["provenance"]);
  assert.equal(dropsOf(renderers, "vcard4"), undefined);
});
