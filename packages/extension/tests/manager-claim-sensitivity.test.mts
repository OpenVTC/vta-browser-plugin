// What the console hides, and what it must not hide by accident.
//
// The table under test is a hand-copied one — the agent does not serve the
// claim-type registry yet — so the failure it is most exposed to is not a wrong
// algorithm but a wrong transcription: an entry copied with the wrong
// sensitivity hides nothing, and one copied under the wrong token hides
// everything. These pin the entries where getting it wrong costs something, and
// the two rules around them: the conservative default for a token nobody has
// classified, and the refusal to reveal a value the mask was meant to cover.
//
// None of this is a security control. The value has already been fetched into
// the page by the time any of it runs, and `claim-sensitivity.ts` says so at
// length. These tests assert what is *drawn*.

import { test } from "node:test";
import assert from "node:assert/strict";
import {
  UNREGISTERED,
  isSensitive,
  maskText,
  maskedFact,
  treatmentOf,
} from "../src/manager/claim-sensitivity.ts";

// ── The registry's own answers ──────────────────────────────────────────────

test("a registered normal type is shown as it is", () => {
  // The half that is easy to lose. If a tightening of the default ever reaches
  // the registered types, every legal name in every pool masks — which teaches
  // an operator to press Show reflexively, and `CLAIM-TYPES.md` §4 names that
  // outcome as the reason the rule is scoped to unknown tokens only.
  assert.equal(isSensitive("name.legal"), false);
  assert.equal(maskedFact("name.legal", "Glenn Gore").text, "Glenn Gore");
  assert.equal(maskedFact("name.legal", "Glenn Gore").masked, false);
});

test("the types whose exposure costs the most are hidden", () => {
  for (const type of [
    "payment.card",
    "gov.id.passport",
    "gov.taxId",
    "phone.mobile",
    "person.birthDate",
    "address.postal",
    // A former name is not a lesser name: the registry marks it `high` because
    // it is the one a holder keeps in order to answer a question once and never
    // show again. Copied as `normal` it would sit beside the current name.
    "name.previous",
  ]) {
    assert.equal(isSensitive(type), true, `${type} must not be shown in the clear`);
  }
});

test("a hidden value keeps the characters its type says are the recognisable ones", () => {
  // The last four of a card are what let the owner tell one card from another;
  // the rest is what a stranger needs. That split is a property of the type,
  // which is why the style travels with the registry entry rather than with the
  // renderer.
  assert.equal(maskedFact("payment.card", "4242424242424242").text, "•••• 4242");
  assert.equal(maskedFact("phone.mobile", "+65 8262 2325").text, "•••• 25");
  assert.equal(maskedFact("person.birthDate", "1975-03-11").text, "••••");
});

// ── The conservative default ────────────────────────────────────────────────

test("a token the registry has never seen is hidden completely", () => {
  // `CLAIM-TYPES.md` §4 rule 3: a vocabulary nobody has reasoned about is
  // exactly the one where showing the value is a decision nobody made.
  assert.deepEqual(treatmentOf("crypto.walletSeed"), UNREGISTERED);
  assert.equal(maskedFact("crypto.walletSeed", "correct horse battery").text, "••••");
});

test("an x: token is hidden however it is spelled", () => {
  // The extension namespace is open by design, so nothing about an `x:` token
  // can be assumed — including that its author meant the core token it happens
  // to resemble. `x:payment.card` must not inherit `payment.card`'s `last4` and
  // publish four digits of something nobody has classified.
  assert.deepEqual(treatmentOf("x:acme.loyaltyId"), UNREGISTERED);
  assert.equal(maskedFact("x:payment.card", "4242424242424242").text, "••••");
});

test("an unregistered member of a hidden family is hidden, not guessed at", () => {
  // There is no prefix walk. `claim-types.json` declares only leaves, and §4
  // consults no prefix, so `payment.giftCard` is an unregistered token — which
  // resolves *more* carefully than a family rule would, not less. If a served
  // registry ever grows family entries, this expectation changes with it.
  assert.equal(treatmentOf("payment.giftCard").mask, "full");
  assert.equal(treatmentOf("name.middle").mask, "full");
});

// ── Masks that would otherwise reveal what they hide ────────────────────────

test("a value no longer than its own tail is hidden completely", () => {
  // Honouring `last4` literally on a four-character value renders the whole
  // value and calls it masked. The same trap sits behind every tail style, and
  // it fires on exactly the short values — a PIN-length account number — where
  // the whole string is the secret.
  assert.equal(maskText("4242", "last4"), "••••");
  assert.equal(maskText("42", "last2"), "••••");
  assert.equal(maskText("", "full"), "••••");
});

test("the mask does not publish the length of what it hides", () => {
  // One glyph per hidden character would report that this IBAN is 22 long and
  // that card 16 — a real hint for a value whose format is fixed. The run is
  // the same width whatever it covers.
  const short = maskedFact("payment.accountNumber", "12345678").text;
  const long = maskedFact("payment.iban", "GB33BUKB2020155555555555").text;
  assert.equal(short.length, long.length);
});

test("emailLocal keeps the domain and nothing else, and refuses to guess", () => {
  assert.equal(maskText("glenn.gore@example.com", "emailLocal"), "g•••@example.com");
  // Not an address. A tail style over a non-address is where a mask silently
  // keeps the wrong half, so it falls back to hiding all of it.
  assert.equal(maskText("no-at-sign-here", "emailLocal"), "••••");
  assert.equal(maskText("@example.com", "emailLocal"), "••••");
  assert.equal(maskText("someone@", "emailLocal"), "••••");
});

// ── The thing a mask must still say ─────────────────────────────────────────

test("a hidden value is not an empty one", () => {
  // A mask that rendered as nothing — or as the pane's word for a value the
  // agent did not send — would tell the operator that a fact they hold is a
  // fact they do not. `masked` is what the pane draws differently on; it must
  // be set, and the text must not be blank.
  const hidden = maskedFact("gov.id.passport", "X1234567");
  assert.equal(hidden.masked, true);
  assert.ok(hidden.text.trim().length > 0, "a hidden value still occupies its row");
  assert.notEqual(hidden.text, "X1234567");

  // And the paired negative: an unhidden value reports itself as one, so the
  // pane offers no control that would do nothing.
  assert.equal(maskedFact("org.name", "OpenVTC").masked, false);
});
