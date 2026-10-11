// An agent that stops replying through its mediator: the wallet uses REST for
// a while, and says so.
//
// The field case: a socket to `fpdev-mediator` opened cleanly, every request
// to `gt-vta` timed out after 30 seconds, and the agent's REST endpoint was
// healthy throughout. The mediator channel connected fine, so nothing took it
// out of the selection and the console could not load.

import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import {
  FALLBACK_COOLDOWN_MS,
  MediatorFallback,
  NOTIFY_QUIET_MS,
  agentLabel,
  fallbackNotification,
  sittingOutTransports,
  withExpiredFallbackDropped,
} from "../src/mediator-fallback.js";
import { TRANSPORT_DIAGNOSIS } from "../src/transport-diagnosis.js";

const VTA = "did:webvh:QmScid:dids.example.org:gt-vta";
const OTHER_VTA = "did:webvh:QmScid2:dids.example.org:other-vta";
const MEDIATOR = "did:webvh:QmMed:dids.example.org:mediator";
const OTHER_MEDIATOR = "did:webvh:QmMed2:dids.example.org:mediator-2";
const T = Date.parse("2026-10-11T09:33:07Z");

test("a reply timeout takes the pair's mediator channels out, then lets them back", () => {
  const f = new MediatorFallback();
  assert.equal(f.isSittingOut(VTA, MEDIATOR, T), false);
  f.noteNoReply(VTA, MEDIATOR, T);
  assert.equal(f.isSittingOut(VTA, MEDIATOR, T + 1), true);
  assert.equal(f.isSittingOut(VTA, MEDIATOR, T + FALLBACK_COOLDOWN_MS - 1), true);
  // A mediator that recovers gets its traffic back without anyone acting.
  assert.equal(f.isSittingOut(VTA, MEDIATOR, T + FALLBACK_COOLDOWN_MS), false);
});

test("the fallback is per (agent, relay) pair, not per relay or per agent", () => {
  // One relay can be one agent's broken hop and another's working inbox.
  const f = new MediatorFallback();
  f.noteNoReply(VTA, MEDIATOR, T);
  assert.equal(f.isSittingOut(OTHER_VTA, MEDIATOR, T + 1), false);
  assert.equal(f.isSittingOut(VTA, OTHER_MEDIATOR, T + 1), false);
});

test("a further timeout extends the cooldown from that timeout", () => {
  const f = new MediatorFallback();
  f.noteNoReply(VTA, MEDIATOR, T);
  f.noteNoReply(VTA, MEDIATOR, T + 60_000);
  assert.equal(f.isSittingOut(VTA, MEDIATOR, T + FALLBACK_COOLDOWN_MS + 30_000), true);
});

test("one alert per agent per quiet window", () => {
  const f = new MediatorFallback();
  assert.equal(f.claimNotification(VTA, T), true);
  assert.equal(f.claimNotification(VTA, T + FALLBACK_COOLDOWN_MS), false, "a re-entry is not news");
  assert.equal(f.claimNotification(OTHER_VTA, T + 1), true, "another agent is");
  assert.equal(f.claimNotification(VTA, T + NOTIFY_QUIET_MS), true);
});

test("the alert says it fell back and that approvals may not be arriving", () => {
  const { title, message } = fallbackNotification(agentLabel(VTA));
  assert.match(title, /REST/);
  assert.match(message, /dids\.example\.org\/gt-vta/);
  assert.match(message, /Approval requests/);
});

test("an agent is named by where it lives, not by its SCID", () => {
  assert.equal(agentLabel(VTA), "dids.example.org/gt-vta");
  assert.equal(agentLabel("did:webvh:QmS:example.org%3A8443:a:b"), "example.org:8443/a/b");
  assert.equal(agentLabel("did:key:z6Mk"), "did:key:z6Mk");
});

test("only a no-reply observation counts as sitting out", () => {
  const noReply = { state: "down" as const, code: TRANSPORT_DIAGNOSIS.noReply };
  assert.deepEqual(sittingOutTransports({}), []);
  assert.deepEqual(sittingOutTransports({ TSP: noReply, DIDComm: noReply, REST: { state: "unknown" } }), [
    "TSP",
    "DIDComm",
  ]);
  // A mediator that could not be reached at all is a different failure, shown
  // by the Transports pane; it is not this fallback.
  assert.deepEqual(
    sittingOutTransports({ TSP: { state: "down", code: TRANSPORT_DIAGNOSIS.unreachable } }),
    [],
  );
});

test("the offscreen document never calls chrome.notifications itself", () => {
  // It has `chrome.runtime` and no other extension API, so a direct call is
  // undefined there and the notification silently never appears. The approval
  // refusal notice was lost this way.
  const src = readFileSync(new URL("../src/offscreen.ts", import.meta.url), "utf8");
  assert.doesNotMatch(src, /chrome\.notifications\??\.\w+\(/);
});

// ── the console's warning, per agent and no longer than the cooldown ──
//
// Field report: switching the console between two agents, the REST warning
// lingered and came back. It was always per agent; what lingered was a record
// of a fallback that had ended, shown until the agent's next request.

const NO_REPLY = { state: "down" as const, code: TRANSPORT_DIAGNOSIS.noReply, detail: "x" };

test("one agent sitting out says nothing about another", () => {
  const f = new MediatorFallback();
  f.noteNoReply(VTA, MEDIATOR, T);
  assert.equal(f.isAnySittingOut(VTA, T + 1), true);
  assert.equal(f.isAnySittingOut(OTHER_VTA, T + 1), false);
});

test("isAnySittingOut ends with the cooldown and does not consume it", () => {
  const f = new MediatorFallback();
  f.noteNoReply(VTA, MEDIATOR, T);
  assert.equal(f.isAnySittingOut(VTA, T + FALLBACK_COOLDOWN_MS - 1), true);
  assert.equal(f.isAnySittingOut(VTA, T + FALLBACK_COOLDOWN_MS), false);
  // The status read left the session build's answer alone.
  assert.equal(f.isSittingOut(VTA, MEDIATOR, T + FALLBACK_COOLDOWN_MS - 1), true);
});

test("an agent's DID that prefixes another's does not borrow its fallback", () => {
  const f = new MediatorFallback();
  f.noteNoReply(`${VTA}-two`, MEDIATOR, T);
  assert.equal(f.isAnySittingOut(VTA, T + 1), false);
});

test("a fallback that has ended is not reported", () => {
  const health = { TSP: NO_REPLY, DIDComm: NO_REPLY, REST: { state: "unknown" as const } };
  assert.deepEqual(sittingOutTransports(withExpiredFallbackDropped(health, true)), ["TSP", "DIDComm"]);
  const after = withExpiredFallbackDropped(health, false);
  assert.deepEqual(sittingOutTransports(after), []);
  assert.deepEqual(after, { REST: { state: "unknown" } });
});

test("dropping an ended fallback leaves other down reasons alone", () => {
  // A mediator that refused the handshake is down for a reason the cooldown
  // has nothing to do with.
  const refused = { state: "down" as const, code: TRANSPORT_DIAGNOSIS.originNotAllowed, detail: "y" };
  assert.deepEqual(withExpiredFallbackDropped({ TSP: refused }, false), { TSP: refused });
});
