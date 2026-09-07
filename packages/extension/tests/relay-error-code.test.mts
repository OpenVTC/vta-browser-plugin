// A refusal keeps its machine-readable half all the way to the console.
//
// The wallet's bridge used to collapse every rejection to a sentence — each
// handler wrote `e instanceof Error ? e.message : String(e)`, and the console's
// `interpretOutcome` re-wrapped that string in a fresh `Error`. The agent's
// stable code and its structured details were gone by the time a pane saw the
// failure, so a pane that wanted to *act* on one particular refusal had one
// option left: matching on the message text. R3.7 forbids exactly that, because
// the agent may reword a message whenever it likes and may not change a code.
//
// The case that forced it: deleting a persona profile while personas are still
// bound to it is refused with an extended code and a `details.personaDids`
// naming them. The console could render neither — not the reason, not the list.
//
// Two things are pinned here and they pull in opposite directions:
//
//  1. The **console** path (`RUNTIME_MANAGER_TASK`) carries `code` and
//     `details` end to end, through a serializing message channel, and arrives
//     as a typed throw a pane can narrow on.
//  2. The **page** path (`RUNTIME_REQUEST_TASK`) does not. It shares the
//     offscreen handler, so the narrowing is a deliberate act in
//     `handleRequestTask` rather than something the shapes do for us — and a
//     deliberate act is the kind that gets undone by a passing refactor.
//
// Every negative assertion below is paired with a positive one. A test that
// only checks something is absent passes just as happily against an
// implementation that returns nothing at all, and this repo has been bitten by
// that shape of test before.

import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { VtaClientError, errorFromBody, parseTrustTaskReply } from "@openvtc/pnm-core";
import { relayFailure } from "../src/relay-failure.ts";
import {
  ConsentRequiredError,
  RelayTaskError,
  interpretOutcome,
} from "../src/manager/carrier.ts";

/** Run something that must throw and hand back what it threw. `assert.throws`
 *  cannot be used for most of this file: the assertions are about the thrown
 *  value's *members*, not its message. */
function caught(fn: () => unknown): unknown {
  try {
    fn();
  } catch (e) {
    return e;
  }
  assert.fail("expected a throw, and nothing was thrown");
}

const PROFILE_DELETE = "https://trusttasks.org/spec/persona/profile/delete/0.1";
const BOUND_DIDS = ["did:key:zBoundOne", "did:key:zBoundTwo"];

/**
 * The refusal as the agent actually sends it, run through core's own
 * `parseTrustTaskReply`.
 *
 * Deliberately not a hand-built `VtaClientError`. The thing this whole change
 * turns on is *where* the agent's code ends up inside the thrown error —
 * `parseTrustTaskReply` puts the entire `trust-task-error` payload on
 * `details`, so the real code is nested one level down and `err.code` is only
 * the bucket `coerceTrustTaskCode` mapped it into. A stub built to match what
 * `relayFailure` reads would agree with it by construction and prove nothing.
 */
function profileInUseRefusal(): unknown {
  return caught(() =>
    parseTrustTaskReply({
      id: "urn:uuid:9d0b1f1a-0000-4000-8000-000000000001",
      type: "https://trusttasks.org/spec/trust-task-error/0.3",
      payload: {
        code: "persona/profile/delete:profileInUse",
        message: "2 personas are still bound to this profile",
        retryable: false,
        details: { personaDids: BOUND_DIDS },
      },
    }),
  );
}

test("core really does nest the agent's code, which is what this file exists for", () => {
  // The premise, asserted rather than assumed. If core ever puts the wire code
  // on `err.code` directly, `relayFailure`'s extraction is reading a shape that
  // no longer exists and every assertion below would still pass on the
  // fallback.
  const err = profileInUseRefusal();
  assert.ok(err instanceof VtaClientError);
  assert.equal(
    err.code,
    "e.p.msg.bad_request",
    "the client's coerced bucket — this is the lossy value the console used to be left with",
  );
  assert.equal(
    (err.details as { code?: string }).code,
    "persona/profile/delete:profileInUse",
    "the agent's real code lives inside `details`",
  );
});

test("a trust-task refusal keeps the agent's extended code and its details", () => {
  const failure = relayFailure(profileInUseRefusal());

  assert.equal(failure.ok, false);
  assert.equal(
    failure.code,
    "persona/profile/delete:profileInUse",
    "the code a pane switches on must be the agent's own, verbatim",
  );
  assert.notEqual(
    failure.code,
    "e.p.msg.bad_request",
    "the coerced bucket was sent instead of the agent's code. `coerceTrustTaskCode` funnels " +
      "every extended code it does not recognise into bad_request, which is precisely the " +
      "loss this change exists to stop.",
  );
  assert.deepEqual(failure.details, { personaDids: BOUND_DIDS });
  assert.match(
    failure.error,
    /2 personas are still bound/,
    "the human sentence must survive too — it is what a pane renders",
  );
});

test("a failure with no code at all is still readable", () => {
  // The common case, and the one that must not regress: a dead connection, a
  // thrown string, anything that never reached the agent.
  const failure = relayFailure(new Error("no active connection"));

  assert.equal(failure.ok, false);
  assert.equal(failure.error, "no active connection");
  assert.equal(failure.code, undefined, "a plain Error has no stable code to invent one from");
  assert.equal(failure.details, undefined);

  // A non-Error throw is not a shape the bridge may drop on the floor.
  assert.equal(relayFailure("something threw a string").error, "something threw a string");
});

test("a client-side failure carries its own code rather than none", () => {
  // `e.client.timeout` is every bit as matchable as an agent's code, and the
  // `e.` prefix keeps the two namespaces apart on sight. Sending nothing here
  // would mean a pane cannot tell "the VTA refused" from "the VTA never
  // answered" without reading prose.
  const failure = relayFailure(
    new VtaClientError("e.client.timeout", "the VTA did not answer in time"),
  );
  assert.equal(failure.code, "e.client.timeout");
  assert.equal(failure.error, "the VTA did not answer in time");
  assert.equal(failure.details, undefined, "there were no details, so none may be invented");
});

test("an HTTP-level refusal keeps the server's details, which sit at a different depth", () => {
  // `errorFromBody` puts `body.error.details` straight on the error with no
  // wrapping payload — the other of the two shapes `VtaClientError.details`
  // arrives in. Reading only the trust-task shape would silently drop this one.
  const failure = relayFailure(
    errorFromBody(
      {
        error: {
          code: "e.p.msg.forbidden",
          message: "the caller is scoped to one context",
          details: { requiredScope: "unrestricted" },
        },
      },
      403,
      "Forbidden",
    ),
  );
  assert.equal(failure.code, "e.p.msg.forbidden");
  assert.deepEqual(failure.details, { requiredScope: "unrestricted" });
});

test("details survive the message channel's serialization", () => {
  // `chrome.runtime.sendMessage` structured-clones what it is given. Anything
  // with behaviour arrives as `{}`, so this asserts on the *far side* of a
  // clone rather than on what `relayFailure` returned.
  const sent = relayFailure(profileInUseRefusal());
  const received = structuredClone(sent);

  assert.deepEqual(received, sent, "the failure changed shape crossing the bridge");
  assert.deepEqual(
    (received.details as { personaDids: string[] }).personaDids,
    BOUND_DIDS,
    "the DIDs a pane has to name did not survive the clone",
  );
  // And it is plain JSON, not merely cloneable: the console reads these members
  // straight off the wire.
  assert.deepEqual(JSON.parse(JSON.stringify(sent)), sent);
});

test("an Error handed in as details is dropped rather than sent as an empty object", () => {
  // `JSON.stringify(new Error("boom"))` is `"{}"`. Sending that would give a
  // pane a details object that looks present and says nothing, which is worse
  // than absent: `if (details)` takes the branch and finds no members.
  const failure = relayFailure(
    new VtaClientError("e.p.msg.internal", "the agent blew up", {
      details: { code: "vault/list:internalError", details: new Error("boom") },
    }),
  );
  assert.equal(failure.details, undefined, "an unserializable details value must be dropped");
  // Paired with what must still be there: dropping details may not cost the
  // code or the sentence.
  assert.equal(failure.code, "vault/list:internalError");
  assert.equal(failure.error, "the agent blew up");
});

test("a cyclic details value costs the details and nothing else", () => {
  const cyclic: Record<string, unknown> = { self: null };
  cyclic.self = cyclic;
  const failure = relayFailure(
    new VtaClientError("e.p.msg.bad_request", "refused", {
      details: { code: "acl/grant:malformedRequest", details: cyclic },
    }),
  );
  assert.equal(failure.details, undefined);
  assert.equal(failure.code, "acl/grant:malformedRequest");
});

test("the console's caller receives a typed error carrying both", () => {
  // The whole trip: the offscreen document's catch, the message channel, and
  // the console's `interpretOutcome`.
  const reply = structuredClone(relayFailure(profileInUseRefusal()));
  const err = caught(() => interpretOutcome(PROFILE_DELETE, "delete this profile", reply));

  assert.ok(
    err instanceof RelayTaskError,
    "a refusal must arrive as its own class. Caught as a plain Error there is nothing to " +
      "narrow on, and a pane is back to matching message text.",
  );
  assert.equal(err.code, "persona/profile/delete:profileInUse");
  assert.deepEqual(err.details, { personaDids: BOUND_DIDS });
  assert.equal(err.taskType, PROFILE_DELETE);
  assert.match(
    err.message,
    /delete this profile failed: 2 personas are still bound/,
    "the operation label and the agent's sentence must both still be in the message",
  );
  assert.ok(err instanceof Error, "anything that renders `.message` today must keep working");
});

test("a rejection carrying neither code nor details still throws something readable", () => {
  const err = caught(() =>
    interpretOutcome("t", "acl/grant/0.1", { ok: false, error: "no active connection" }),
  );

  assert.ok(err instanceof RelayTaskError);
  assert.match(
    err.message,
    /acl\/grant\/0\.1 failed: no active connection/,
    "the prose a pane renders is unchanged from before this class existed",
  );
  assert.equal(err.code, undefined, "no code was sent, so none may be invented");
  assert.equal(err.details, undefined);
});

test("a reply with no error string at all still says something", () => {
  const err = caught(() => interpretOutcome("t", "acl/grant/0.1", { ok: false }));
  assert.ok(err instanceof RelayTaskError);
  assert.match(err.message, /acl\/grant\/0\.1 failed: unknown error/);
});

test("a consent refusal is untouched by any of this", () => {
  // `consentRequired` is not a failure and must never be reclassified as one:
  // it carries the executor-signed requests an approver has to see and the
  // digest the operator matches on their approving device.
  const err = caught(() =>
    interpretOutcome(PROFILE_DELETE, "delete this profile", {
      ok: true,
      result: {
        kind: "consentRequired",
        payloadDigest: "abcdef0123456789",
        challenge: "chal",
        approverSet: "set-1",
        minApprovals: 2,
        consentRequests: [{ one: 1 }],
      },
    }),
  );

  assert.ok(err instanceof ConsentRequiredError);
  assert.ok(
    !(err instanceof RelayTaskError),
    "the ceremony was reclassified as a failure. It would then render as a red string at the " +
      "exact moment the human was supposed to act.",
  );
  assert.equal(err.payloadDigest, "abcdef0123456789");
  assert.equal(err.minApprovals, 2);
  assert.deepEqual(err.consentRequests, [{ one: 1 }]);
});

// ── The page-facing relay must not have been widened along with the console's ──
//
// Read from the sources, the way `manager-surface.test.mts` does: `background.ts`
// registers listeners at import and cannot be loaded in a test process.

const src = (name: string) =>
  readFileSync(fileURLToPath(new URL(`../src/${name}`, import.meta.url)), "utf8");

const protocol = src("bridge-protocol.ts");
const background = src("background.ts");

test("the page's reply shape carries prose and nothing else", () => {
  const page = /export type RuntimeRequestTaskResponse =([\s\S]*?);\n/.exec(protocol);
  assert.ok(page, "RuntimeRequestTaskResponse not found — this test is reading the wrong shape");
  assert.ok(
    !/\bcode\b|\bdetails\b|RelayTaskFailure/.test(page[1]!),
    "RuntimeRequestTaskResponse gained a machine-readable member. A page proposed a task and " +
      "is entitled to know it was refused; the agent's account of why can name other personas, " +
      "other contexts or an ACL's contents, and would reach any site that called requestTask.",
  );

  // The positive half: the console's reply must actually carry the shape, or
  // the assertion above is true of a change that did nothing at all.
  const console_ = /export type RuntimeManagerTaskResponse =([\s\S]*?);\n/.exec(protocol);
  assert.ok(console_, "RuntimeManagerTaskResponse not found");
  assert.match(
    console_[1]!,
    /RelayTaskFailure/,
    "RuntimeManagerTaskResponse no longer carries RelayTaskFailure — the console is back to prose",
  );
});

test("the background narrows the offscreen reply before a page sees it", () => {
  // One offscreen handler answers both relays, so the page path only stays
  // narrow because `handleRequestTask` rebuilds the failure. A cast would
  // narrow the type and copy the object whole, which is the failure this
  // assertion exists to catch — it looks identical in review.
  const pageHandler = /async function handleRequestTask\([\s\S]*?\n\}/.exec(background);
  assert.ok(pageHandler, "handleRequestTask not found in background.ts");
  assert.match(
    pageHandler[0]!,
    /return \{ ok: false, error: res\.error \};/,
    "handleRequestTask no longer rebuilds the failure from the error string alone — the " +
      "offscreen reply's code and details would travel on to the page",
  );

  // …and the console's handler must still pass the reply through whole.
  const consoleHandler = /async function handleManagerTask\([\s\S]*?\n\}/.exec(background);
  assert.ok(consoleHandler, "handleManagerTask not found in background.ts");
  assert.match(
    consoleHandler[0]!,
    /as OffscreenRequestTaskResponse/,
    "handleManagerTask no longer types the offscreen reply as the richer shape, which is how " +
      "the console's code and details would be quietly dropped again",
  );
});
