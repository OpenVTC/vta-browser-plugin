import { test } from "node:test";
import assert from "node:assert/strict";

import {
  transition,
  canSend,
  admitsApplicationMessage,
  resolveInviteRace,
  resolveAccept,
  resolveCancel,
  compareBytes,
  InvalidTransitionError,
} from "../dist/index.js";

const digest = (...bytes) => Uint8Array.from(bytes.concat(Array(32 - bytes.length).fill(0)));

test("the outbound flow: invite, accept, established", () => {
  let state = "none";
  state = transition(state, "sendInvite");
  assert.equal(state, "pending");
  assert.equal(canSend(state), false, "an unanswered invite does not license application messages");
  state = transition(state, "receiveAccept");
  assert.equal(state, "bidirectional");
  assert.equal(canSend(state), true);
});

test("the inbound flow: invite received, accepted, established", () => {
  let state = transition("none", "receiveInvite");
  assert.equal(state, "inviteReceived");
  assert.equal(canSend(state), false);
  state = transition(state, "sendAccept");
  assert.equal(state, "bidirectional");
});

test("gating admits any recorded relationship, not only a completed one", () => {
  // §3.6 lets a sender pack user data alongside its invite, so gating on
  // `bidirectional` would drop messages the specification expects to arrive.
  assert.equal(admitsApplicationMessage("none"), false);
  assert.equal(admitsApplicationMessage("pending"), true);
  assert.equal(admitsApplicationMessage("inviteReceived"), true);
  assert.equal(admitsApplicationMessage("bidirectional"), true);
});

test("send is strict where receive is lenient, and that asymmetry is deliberate", () => {
  // If both were strict the two sides deadlock, each waiting for the other to
  // go first. Pinned because it looks like an inconsistency and is not.
  for (const state of ["pending", "inviteReceived"]) {
    assert.equal(canSend(state), false);
    assert.equal(admitsApplicationMessage(state), true);
  }
});

test("invalid transitions are refused with both halves named", () => {
  assert.throws(
    () => transition("pending", "sendInvite"),
    (err) => err instanceof InvalidTransitionError && err.state === "pending" && err.event === "sendInvite",
  );
  assert.throws(() => transition("none", "sendAccept"), InvalidTransitionError);
  assert.throws(() => transition("none", "receiveAccept"), InvalidTransitionError);
  assert.throws(() => transition("bidirectional", "sendInvite"), InvalidTransitionError);
});

test("a cancellation resets from any live state", () => {
  for (const state of ["pending", "inviteReceived", "bidirectional"]) {
    assert.equal(transition(state, "receiveCancel"), "none");
    assert.equal(transition(state, "sendCancel"), "none");
  }
});

// ── §7.2.3, the invite race ──

test("both sides keep the lexicographically lower invite digest", () => {
  const low = digest(0x01, 0x00);
  const high = digest(0x02, 0x00);

  // The rule only converges because both endpoints compute it identically on
  // the same two values. Asserting both perspectives is what checks that: run
  // from either side, the *same* invite survives.
  assert.equal(resolveInviteRace(low, high).keep, "ours");
  assert.equal(resolveInviteRace(high, low).keep, "theirs");
});

test("the race is decided on bytes, not on who asked first", () => {
  // No timestamp, no "ours wins", no tie-break on VID — any of which would let
  // the two sides disagree and form two half-relationships.
  const a = digest(0x00, 0xff);
  const b = digest(0x01, 0x00);
  assert.equal(resolveInviteRace(a, b).keep, "ours", "0x00ff < 0x0100 byte by byte");
  assert.equal(compareBytes(a, b) < 0, true);
});

test("compareBytes orders like a byte string, including on length", () => {
  assert.equal(compareBytes(new Uint8Array([1, 2]), new Uint8Array([1, 2])), 0);
  assert.equal(compareBytes(new Uint8Array([1]), new Uint8Array([1, 0])) < 0, true);
  assert.equal(compareBytes(new Uint8Array([2]), new Uint8Array([1, 9])) > 0, true);
});

// ── §7.3, cancellation ──

test("a cancellation naming a relationship we do not hold is ignored, not answered", () => {
  // A privacy property, not tidiness: answering would let anyone probe which
  // relationships we hold by cancelling ones they guessed at.
  const held = digest(0xaa);
  assert.equal(resolveCancel("none", held, [held]).action, "ignore");
  assert.equal(resolveCancel("bidirectional", digest(0xbb), [held]).action, "ignore");
});

test("a cancellation on one direction removes it silently; on both, it is answered", () => {
  const held = digest(0xaa);
  assert.equal(resolveCancel("pending", held, [held]).action, "remove");
  assert.equal(resolveCancel("inviteReceived", held, [held]).action, "remove");
  assert.equal(resolveCancel("bidirectional", held, [held]).action, "removeAndReply");
});

test("a cancellation may name either half of the relationship", () => {
  // §7.2.1: the invite and the accept each have a digest, and a cancellation
  // names one of them. Matching only the invite's would drop half of the
  // legitimate cancellations.
  const invite = digest(0xaa);
  const accept = digest(0xbb);
  assert.equal(resolveCancel("bidirectional", invite, [invite, accept]).action, "removeAndReply");
  assert.equal(resolveCancel("bidirectional", accept, [invite, accept]).action, "removeAndReply");
});

test("an accept is adopted only when it answers our outstanding invite", () => {
  const ours = digest(0xaa);
  assert.equal(resolveAccept("pending", ours, ours).action, "adopt");
  assert.equal(resolveAccept("pending", digest(0xbb), ours).action, "ignore", "an invite we never sent");
  assert.equal(resolveAccept("pending", undefined, ours).action, "ignore");
  assert.equal(resolveAccept("pending", ours, undefined).action, "ignore", "no invite on record");
  assert.equal(resolveAccept("none", ours, ours).action, "ignore");
  assert.equal(resolveAccept("bidirectional", ours, ours).action, "ignore");
});
