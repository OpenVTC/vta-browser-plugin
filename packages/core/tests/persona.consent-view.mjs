// What the last screen before a disclosure says.
//
// These assert wording and order, which is unusual for a test and right here:
// the screen is the security control, and each of these cases is a way a
// perfectly reasonable render defeats it.

import { test } from "node:test";
import assert from "node:assert/strict";

import {
  buildConsentView,
  summarise,
  isLinkable,
} from "../dist/persona/consent-view.js";

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

const asked = { verifierDid: "did:key:zVerifier", purpose: "age check" };

// The recipient is half of what a preview says. A view built without one would
// render a list of fields rather than a decision, so it is a required argument
// rather than something read out of a response that does not echo it.
test("the view names who is asking and why", () => {
  const v = buildConsentView(preview({ claims: [claim("name.legal")] }), asked);
  assert.equal(v.verifierDid, "did:key:zVerifier");
  assert.equal(v.purpose, "age check");
  assert.equal(v.subject, "did:key:zPairwise");
});

// A predicate discloses no value at all. Rendering it as an empty cell reads as
// missing data — the opposite of the truth, which is that this is the
// strongest outcome available.
test("a predicate reads as a proof, never as a blank", () => {
  const v = buildConsentView(
    preview({
      claims: [
        claim("person.birthDate", {
          value: undefined,
          predicate: { op: "gte", arg: 18, over: "person.birthDate" },
        }),
      ],
    }),
    asked,
  );
  assert.equal(v.rows[0].kind, "predicate");
  assert.equal(
    v.rows[0].shown,
    "proves is at least 18 — the value itself is not sent",
  );
  assert.notEqual(v.rows[0].shown.trim(), "");
});

// A stale claim is listed and cannot be sent. Dropping it would show a
// disclosure that looks complete and is not.
test("a claim that cannot be sent says so, and is counted separately", () => {
  const v = buildConsentView(
    preview({
      claims: [claim("name.legal"), claim("email.work", { stale: true })],
    }),
    asked,
  );
  assert.equal(v.rows.length, 2, "the withheld claim must still be listed");
  const withheld = v.rows.find((r) => r.kind === "withheld");
  assert.match(withheld.shown, /will NOT be sent/);
  assert.equal(v.sendingCount, 1);
  assert.equal(v.withheldCount, 1);
});

// "3 claims" beside five rows invites the reader to assume they miscounted.
test("the summary says the withheld part out loud", () => {
  const clean = buildConsentView(
    preview({ claims: [claim("a.one"), claim("b.two")] }),
    asked,
  );
  assert.equal(summarise(clean), "2 claims");

  const short = buildConsentView(
    preview({
      claims: [claim("a.one"), claim("b.two", { stale: true })],
    }),
    asked,
  );
  assert.equal(summarise(short), "1 claim — 1 cannot be sent");
});

// The ranking from `rankPreview` has to survive into the rows, or the screen is
// a list again.
test("rows arrive ranked, with the withheld claim first", () => {
  const v = buildConsentView(
    preview({
      claims: [
        claim("routine.one"),
        claim("odd.two", { newToThisVerifier: true }),
        claim("gone.three", { stale: true }),
      ],
      anomalous: ["odd.two"],
    }),
    asked,
  );
  assert.deepEqual(
    v.rows.map((r) => r.type),
    ["gone.three", "odd.two", "routine.one"],
  );
  assert.deepEqual(v.rows.at(-1).notices, []);
});

// Lossiness is declared, not discovered — the holder is owed "this verifier
// will see your work number but not that your employer attested it" BEFORE
// deciding.
test("what the renderer discards is carried into the view", () => {
  const v = buildConsentView(
    preview({
      claims: [claim("phone.work")],
      renderer: { id: "jcard", drops: ["provenance"] },
    }),
    asked,
  );
  assert.deepEqual(v.renderer, { id: "jcard", drops: ["provenance"] });
});

// Absent correlation is `none`, and `none` is the only value that is not worth
// leading with.
test("linkability is read from the agent and defaults to none", () => {
  const quiet = buildConsentView(preview({ claims: [claim("a.one")] }), asked);
  assert.equal(quiet.correlation.severity, "none");
  assert.equal(isLinkable(quiet), false);

  const loud = buildConsentView(
    preview({
      claims: [claim("a.one")],
      correlation: { severity: "high", reason: "issuer signature is identical everywhere" },
    }),
    asked,
  );
  assert.equal(isLinkable(loud), true);
  assert.match(loud.correlation.reason, /identical/);
});

// An empty preview is a real answer — the bound profile presents nothing to
// this verifier — and must not render as a broken screen.
test("a preview with no claims is a valid, empty decision", () => {
  const v = buildConsentView(preview(), asked);
  assert.deepEqual(v.rows, []);
  assert.equal(v.sendingCount, 0);
  assert.equal(summarise(v), "0 claims");
});

// Every row must carry something readable. A blank cell is the failure this
// module exists to prevent, whatever produced it.
test("no row is ever blank", () => {
  const v = buildConsentView(
    preview({
      claims: [
        claim("a.one", { value: undefined }),
        claim("b.two", { value: { nested: true } }),
        claim("c.three", { value: 42 }),
      ],
    }),
    asked,
  );
  for (const row of v.rows) {
    assert.notEqual(row.shown.trim(), "", `row ${row.type} rendered blank`);
  }
});
