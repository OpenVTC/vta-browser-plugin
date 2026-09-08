// What a web page may ask the wallet to run.
//
// The case that matters is not "an unknown task is refused" — it is that a
// *known, working, consent-prompted* task is refused, because the prompt it
// would get cannot say what it would give away.

import { test } from "node:test";
import assert from "node:assert/strict";

import { pageTaskRefusal } from "../src/page-task-policy.ts";

const P = "https://trusttasks.org/spec/persona/";

// `preview` is the dangerous one and reads as the safe one. It is documented as
// "signs nothing and sends nothing" — true of the VTA, and irrelevant here,
// because `requestTask` hands the VTA's reply to the page. The reply contains
// the holder's claim values.
test("a page cannot preview a disclosure, whatever the task says about itself", () => {
  const why = pageTaskRefusal(`${P}disclosure/preview/1.0`);
  assert.notEqual(why, null);
  assert.match(why, /disclosure flow/);
});

test("a page cannot present a disclosure", () => {
  assert.notEqual(pageTaskRefusal(`${P}disclosure/present/1.0`), null);
});

// The same shape aimed at other people: the holder's record of what their peers
// disclosed to them.
test("a page cannot read the holder's contacts", () => {
  for (const verb of ["get", "list", "put", "delete"]) {
    assert.notEqual(
      pageTaskRefusal(`${P}contact/${verb}/1.0`),
      null,
      `contact/${verb} should be refused`,
    );
  }
});

// The whole family, so a task added later is refused by default rather than
// admitted by omission — which is the direction this guard must fail in.
test("the refusal covers the family, not a list of known members", () => {
  assert.notEqual(pageTaskRefusal(`${P}some/future/task/9.9`), null);
});

// ── The rooms family ────────────────────────────────────────────────────────
//
// Same shape as persona, aimed at a room instead of the holder. `keys/open`
// returns plaintext the room withholds from its own host, and `requestTask`
// hands the VTA's reply straight to the page.
const R = "https://trusttasks.org/spec/rooms/";

test("a page cannot open a sealed record", () => {
  const why = pageTaskRefusal(`${R}keys/open/0.1`);
  assert.notEqual(why, null);
  assert.match(why, /plaintext/);
});

// The worst of the three: these mint credentials in the ROOM's name, so one
// prompt got past an owner is a page issuing itself membership or admin.
test("a page cannot mint a room's own credentials", () => {
  for (const verb of ["invite", "issue-membership", "issue-authority"]) {
    assert.notEqual(
      pageTaskRefusal(`${R}owner/${verb}/0.1`),
      null,
      `owner/${verb} should be refused`,
    );
  }
});

// Which rooms someone holds keys for is the membership of every one of them,
// seen from their side — the fact a `private` room exists to withhold.
test("a page cannot enumerate the holder's rooms", () => {
  assert.notEqual(pageTaskRefusal(`${R}keys/list/0.1`), null);
});

// Host-served verbs are refused here too. A page reaching them through the
// wallet would be borrowing the member's standing to read or write a room,
// which is the same borrowing whichever party ends up serving the request.
test("the refusal covers the host-served half as well", () => {
  for (const uri of [`${R}records/get/0.1`, `${R}records/put/0.1`, `${R}create/0.1`]) {
    assert.notEqual(pageTaskRefusal(uri), null, `${uri} should be refused`);
  }
});

test("the rooms refusal covers the family, not a list of known members", () => {
  assert.notEqual(pageTaskRefusal(`${R}some/future/task/9.9`), null);
});

// And it must not become a blanket ban: the wallet's other page-facing tasks
// are the reason `requestTask` exists.
test("tasks outside the family are still a page's to request", () => {
  for (const uri of [
    "https://trusttasks.org/spec/vault/list/0.3",
    "https://trusttasks.org/spec/auth/authenticate/0.1",
    "https://trusttasks.org/spec/vta/app-state/get/1.0",
  ]) {
    assert.equal(pageTaskRefusal(uri), null, `${uri} should be permitted`);
  }
});

// A refusal that does not say what to do instead gets worked around, and the
// workaround is usually worse than the thing refused.
test("the refusal names the route that exists instead", () => {
  const why = pageTaskRefusal(`${P}disclosure/present/1.0`);
  assert.match(why, /shows the holder/);
  assert.match(why, /returns the presentation rather than the underlying values/);
});

// ── The route that exists instead ──────────────────────────────────────────
//
// `disclose` is what the refusal above points at, and the reason it is safe
// where `requestTask` was not is entirely in its parameters: a site says who it
// is and what it wants, and cannot say which of the holder's faces answers.

import { PAGE_FACING_RUNTIME_TYPES, RUNTIME_DISCLOSE } from "../src/bridge-protocol.ts";
import type { DiscloseParams } from "../src/bridge-protocol.ts";

test("disclose is reachable from a page", () => {
  assert.ok(
    (PAGE_FACING_RUNTIME_TYPES as readonly string[]).includes(RUNTIME_DISCLOSE),
    "the refusal points at a route the page cannot actually call",
  );
});

// A site naming the persona could ask, from a gaming page, for the holder's
// work identity. The type is what stops it — asserted here so a later edit
// that "helpfully" widens the params has to delete this line and say why.
test("a site cannot choose which face answers", () => {
  const params: DiscloseParams = { verifierDid: "did:key:zVerifier" };
  const keys = new Set(Object.keys(params as Record<string, unknown>));
  // @ts-expect-error — personaDid is not part of the contract, deliberately.
  params.personaDid = "did:key:zSomeoneElsesFace";
  // @ts-expect-error — nor is contextId; the wallet takes both from its own
  // profile entry for this origin.
  params.contextId = "ctx-of-my-choosing";
  assert.ok(!keys.has("personaDid") && !keys.has("contextId"));
});
