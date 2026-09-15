// Extra service entries, before they are published.
//
// What is checked here is checked because the wire does not check it.
// `additionalServices` is written into the DID document **verbatim** — the agent
// composes nothing and validates nothing — and the document becomes a log entry,
// which is append-only. A bad entry is not a failed call; it is published, and
// the repair is a further entry superseding it. So a form that lets one through
// has already done the damage by the time anybody notices.

import { test } from "node:test";
import assert from "node:assert/strict";
import {
  additionalServices,
  draftProblems,
  draftsReady,
  emptyDraft,
  endpointProblem,
  isBlank,
  serviceEntry,
  type ServiceDraft,
} from "../src/manager/service-entries.js";

const draft = (over: Partial<ServiceDraft> = {}): ServiceDraft => ({
  key: "k1",
  fragment: "website",
  type: "LinkedDomains",
  endpoint: "https://example.com",
  ...over,
});

test("a well-formed entry has nothing wrong with it", () => {
  assert.deepEqual(draftProblems(draft(), [draft()]), {});
});

// The blank row at the bottom of the list is not an error, and a form that
// treated it as one could never be submitted.
test("an untouched row is blank, and blank is not a fault", () => {
  assert.equal(isBlank(emptyDraft("k")), true);
  assert.equal(isBlank(draft({ fragment: "  ", type: "", endpoint: " " })), true);
  assert.equal(isBlank(draft()), false);
  assert.equal(draftsReady([emptyDraft("k")]), true);
});

test("every field says what is wrong with it, not one combined message", () => {
  const problems = draftProblems(
    draft({ fragment: "", type: "", endpoint: "" }),
    [],
  );
  assert.ok(problems.fragment, "a nameless entry has no id");
  assert.ok(problems.type, "an entry with no type says nothing about itself");
  assert.ok(problems.endpoint, "an entry with no endpoint points nowhere");
});

// Two entries at one id is not a rejection at the agent — it is a document with
// an ambiguous service, and which one a resolver picks is its own business.
test("two entries cannot share a name", () => {
  const a = draft({ key: "a" });
  const b = draft({ key: "b" });
  assert.match(draftProblems(a, [a, b]).fragment ?? "", /already uses this name/);
  assert.equal(draftProblems(a, [a]).fragment, undefined);
});

test("a fragment is restricted to what survives being part of an id", () => {
  assert.ok(draftProblems(draft({ fragment: "my service" }), []).fragment);
  assert.ok(draftProblems(draft({ fragment: "-leading" }), []).fragment);
  assert.ok(draftProblems(draft({ fragment: "#hash" }), []).fragment);
  assert.equal(draftProblems(draft({ fragment: "api.v2_beta-1" }), []).fragment, undefined);
});

// The same reasoning as `walletNetPolicy`: what is written here is published for
// other people to dial, so a cleartext endpoint in a DID document is one they
// will use.
test("cleartext endpoints are refused, because others dial what is published", () => {
  assert.match(endpointProblem("http://example.com") ?? "", /https/);
  assert.match(endpointProblem("ws://example.com") ?? "", /wss/);
  assert.equal(endpointProblem("https://example.com"), null);
  assert.equal(endpointProblem("wss://example.com/socket"), null);
});

// A mediator entry names a DID rather than a URL. Refusing one would make this
// editor unable to express the commonest non-HTTP service there is.
test("a DID is a valid endpoint", () => {
  assert.equal(endpointProblem("did:web:mediator.example"), null);
  assert.match(endpointProblem("did:") ?? "", /no DID after it/);
});

test("credentials in a published endpoint are refused", () => {
  assert.match(endpointProblem("https://user:pw@example.com") ?? "", /Credentials/);
});

test("a scheme nobody would dial from a DID document is named, not shrugged at", () => {
  assert.match(endpointProblem("ftp://example.com") ?? "", /ftp/);
  assert.match(endpointProblem("not a url") ?? "", /not a URL/);
});

// The DID does not exist until the entry naming it has been written, so nothing
// on this side can spell the id — `{DID}` is the ambient placeholder the agent
// substitutes, the same one a DID template uses for `document.id`.
test("an id is built from the ambient DID placeholder, never guessed", () => {
  assert.deepEqual(serviceEntry(draft()), {
    id: "{DID}#website",
    type: "LinkedDomains",
    serviceEndpoint: "https://example.com",
  });
});

test("whitespace around a field never reaches the document", () => {
  const e = serviceEntry(draft({ fragment: " website ", type: " LinkedDomains ", endpoint: " https://example.com " }));
  assert.equal(e["id"], "{DID}#website");
  assert.equal(e["type"], "LinkedDomains");
  assert.equal(e["serviceEndpoint"], "https://example.com");
});

// A half-filled row abandoned mid-edit would otherwise be published as an entry.
test("only filled rows are sent", () => {
  const rows = [draft({ key: "a" }), emptyDraft("b"), draft({ key: "c", fragment: "api" })];
  assert.equal(additionalServices(rows).length, 2);
  assert.deepEqual(
    additionalServices(rows).map((s) => s["id"]),
    ["{DID}#website", "{DID}#api"],
  );
});

test("one bad row holds the whole form, and a blank one does not", () => {
  assert.equal(draftsReady([draft(), emptyDraft("b")]), true);
  assert.equal(draftsReady([draft(), draft({ key: "b", endpoint: "http://x.example" })]), false);
});
