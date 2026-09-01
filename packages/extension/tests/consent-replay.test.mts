// The one exempt replay that completes a consent ceremony — see
// src/consent-replay.ts for why it exists.
//
// The property under test is narrow and worth stating: a replay is exempt only
// when it is the *same request*, already refused for consent, and a grant for
// that exact payload has since arrived. Every other path prompts. The tests
// below are mostly about the "every other path" half, because that is the half
// a future edit could quietly widen.

import test from "node:test";
import assert from "node:assert/strict";
import { ConsentReplayLedger, replayKey } from "../src/consent-replay.ts";

const ORIGIN = "https://dids.eu.openvtc.net";
const OTHER_ORIGIN = "https://evil.example";
const PARAMS = { type: "https://trusttasks.org/spec/vta/webvh/dids/update/1.0", payload: { a: 1 } };
const OTHER_PARAMS = { ...PARAMS, payload: { a: 2 } };
const DIGEST = "zQmGrantedDigest";

/** A ledger with a clock we control, so TTL is tested without sleeping. */
function ledgerAt(clock: { now: number }) {
  return new ConsentReplayLedger({ now: () => clock.now });
}

test("the happy path: refused, granted, then one replay goes through", () => {
  const led = new ConsentReplayLedger();
  const key = replayKey(ORIGIN, PARAMS);

  assert.equal(led.consumeIfArmed(key), false, "nothing is exempt before a refusal");
  led.recordConsentRequired(key, DIGEST);
  assert.equal(led.consumeIfArmed(key), false, "a refusal alone must not exempt anything");
  led.recordGranted(DIGEST);
  assert.equal(led.consumeIfArmed(key), true);
});

test("the exemption is single-use", () => {
  const led = new ConsentReplayLedger();
  const key = replayKey(ORIGIN, PARAMS);
  led.recordConsentRequired(key, DIGEST);
  led.recordGranted(DIGEST);
  assert.equal(led.consumeIfArmed(key), true);
  // The VTA's grant is single-use, so a second replay is a new question.
  assert.equal(led.consumeIfArmed(key), false);
});

test("a grant does not exempt a different payload from the same origin", () => {
  const led = new ConsentReplayLedger();
  led.recordConsentRequired(replayKey(ORIGIN, PARAMS), DIGEST);
  led.recordGranted(DIGEST);
  assert.equal(led.consumeIfArmed(replayKey(ORIGIN, OTHER_PARAMS)), false);
});

test("a grant does not exempt the same payload from a different origin", () => {
  const led = new ConsentReplayLedger();
  led.recordConsentRequired(replayKey(ORIGIN, PARAMS), DIGEST);
  led.recordGranted(DIGEST);
  assert.equal(led.consumeIfArmed(replayKey(OTHER_ORIGIN, PARAMS)), false);
});

test("a grant for an unrelated digest arms nothing", () => {
  const led = new ConsentReplayLedger();
  const key = replayKey(ORIGIN, PARAMS);
  led.recordConsentRequired(key, DIGEST);
  led.recordGranted("zQmSomeOtherTaskEntirely");
  assert.equal(led.consumeIfArmed(key), false);
});

test("a grant arriving before any refusal arms nothing", () => {
  // Ordering matters: only a request the VTA actually refused for consent is
  // ever tracked, so a grant cannot pre-authorise a request not yet made.
  const led = new ConsentReplayLedger();
  led.recordGranted(DIGEST);
  led.recordConsentRequired(replayKey(ORIGIN, PARAMS), DIGEST);
  assert.equal(led.consumeIfArmed(replayKey(ORIGIN, PARAMS)), false);
});

test("a fresh refusal disarms an entry", () => {
  // The VTA re-issues `consentRequired` on every re-submit. A new refusal means
  // the question is open again, so a previously-armed entry must not stay armed.
  const led = new ConsentReplayLedger();
  const key = replayKey(ORIGIN, PARAMS);
  led.recordConsentRequired(key, DIGEST);
  led.recordGranted(DIGEST);
  led.recordConsentRequired(key, DIGEST);
  assert.equal(led.consumeIfArmed(key), false);
});

test("an armed replay expires with the grant it depends on", () => {
  const clock = { now: 1_000_000 };
  const led = ledgerAt(clock);
  const key = replayKey(ORIGIN, PARAMS);
  led.recordConsentRequired(key, DIGEST);
  led.recordGranted(DIGEST);
  // Past the VTA's own 600 s grant TTL the grant is dead server-side, so an
  // exemption could only wave through a submit that will be refused anyway.
  clock.now += 600_001;
  assert.equal(led.consumeIfArmed(key), false);
});

test("an armed replay still works just inside the window", () => {
  const clock = { now: 1_000_000 };
  const led = ledgerAt(clock);
  const key = replayKey(ORIGIN, PARAMS);
  led.recordConsentRequired(key, DIGEST);
  led.recordGranted(DIGEST);
  clock.now += 599_000;
  assert.equal(led.consumeIfArmed(key), true);
});

test("tracked requests are bounded, oldest evicted first", () => {
  const led = new ConsentReplayLedger({ maxEntries: 3 });
  for (let i = 0; i < 5; i++) led.recordConsentRequired(replayKey(ORIGIN, { i }), `d${i}`);
  assert.equal(led.size, 3);
  // The first two were evicted, so arming their digests exempts nothing.
  led.recordGranted("d0");
  assert.equal(led.consumeIfArmed(replayKey(ORIGIN, { i: 0 })), false);
  led.recordGranted("d4");
  assert.equal(led.consumeIfArmed(replayKey(ORIGIN, { i: 4 })), true);
});

test("replayKey separates origin from params", () => {
  // A page must not be able to spoof another origin's key by stuffing the
  // separator into its own params.
  assert.notEqual(replayKey(ORIGIN, PARAMS), replayKey(OTHER_ORIGIN, PARAMS));
  assert.notEqual(replayKey(ORIGIN, PARAMS), replayKey(ORIGIN, OTHER_PARAMS));
});
