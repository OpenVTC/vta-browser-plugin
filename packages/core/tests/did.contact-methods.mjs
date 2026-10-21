// The contact-method registry (VTI-LNK-102 / 112, dtgwg-vti-spec #58).
//
// Pinned: did:webvh, did:web and did:scid (with `src`) are registered, all
// host-named; a bare did:scid names no host and has no route; a
// method with no registered resolver is unsupported-vid; did:key and did:peer
// stay from-not-allowed; and a domain-linked method is added by registering it
// and nothing else — the parser, the contact rule and resolution all follow.

import { test } from "node:test";
import assert from "node:assert/strict";
import {
  CONTACT_METHODS,
  ContactMethodRegistry,
  WEBVH_CONTACT_METHOD,
  didIdentity,
  defaultContactMethods,
  resolveContactDocument,
  contactKindOf,
} from "../dist/did/index.js";
import {
  parseTriggerLink,
  contactRoute,
  contactDomainLabel,
  contactIdentity,
  isHostNamedServiceContact,
  isServiceContact,
  SIGN_IN_FLOW,
} from "../dist/links/index.js";
import { resolveCommunityDocument } from "../dist/vtc/index.js";

const WEBVH = "did:webvh:QmPEQVM1JPTyrvEgBcDXwjK4TeyLGSX1PxjgyeAisPviUx:members.example.org";
const SCID = "did:scid:vh:1:QmXa7Rk2ZpLwT9vNc4HbYe1Jd8sMfU3qGo6PtVnEyKiBhW";
const ID = "Hk2pQ9xV4mT7rW1sZ8yN3A";
const EXP = 1791460920;
const link = (from) =>
  `https://link.trustoverip.org/t#_from=${from}&_id=${ID}&_exp=${EXP}&_type=/vti/flow/sign-in/0.1`;
const read = (from, contactMethods) => parseTriggerLink(link(from), { now: EXP, ...(contactMethods ? { contactMethods } : {}) });

/** A test-only domain-linked method. */
const testMethod = (resolved = []) => ({
  kind: "did:test",
  route: "domain-linked",
  listsServices: true,
  verified: true,
  resolve: async (did) => {
    resolved.push(did);
    return { ok: true, doc: { id: did } };
  },
});

test("registry: did:webvh, did:web and did:scid have a route, all host-named", () => {
  assert.deepEqual(CONTACT_METHODS.kinds(), ["did:webvh", "did:web", "did:scid", "did:key", "did:peer"]);
  assert.equal(CONTACT_METHODS.routeOf(`${SCID}?src=members.example.org`), "host-named");
  assert.equal(CONTACT_METHODS.routeOf(SCID), undefined, "a bare did:scid names no host");
  assert.equal(CONTACT_METHODS.routeOf(WEBVH), "host-named");
  assert.equal(CONTACT_METHODS.routeOf("did:web:members.example.org"), "host-named");
  assert.equal(CONTACT_METHODS.routeOf("did:key:z6MkhaXgBZDvotDkL5257faiztiGiC2QtKLGpbnnEGta2doK"), undefined);
  assert.equal(CONTACT_METHODS.routeOf("did:peer:2.Ez6L"), undefined);
  assert.equal(CONTACT_METHODS.routeOf("did:example:abc"), undefined);
  assert.equal(typeof CONTACT_METHODS.policyFor("did:webvh").resolve, "function");
  assert.equal(typeof CONTACT_METHODS.policyFor("did:web").resolve, "function");
});

test("registry: did:webvh and did:web are accepted by the parser through the registry", () => {
  for (const from of [WEBVH, "did:web:members.example.org"]) {
    const r = read(from, CONTACT_METHODS);
    assert.equal(r.ok, true, from);
    assert.equal(contactRoute(r.link.from, CONTACT_METHODS), "host-named");
  }
});

test("registry: an unregistered method is unsupported-vid (update)", () => {
  for (const from of ["did:example:abc", "did:webs:example.org", "did:ion:abc"]) {
    const r = read(from, CONTACT_METHODS);
    assert.equal(r.ok, false);
    assert.equal(r.reason, "unsupported-vid", from);
    assert.equal(r.outcome, "update");
  }
});

test("registry: did:key and did:peer stay from-not-allowed", () => {
  for (const from of ["did:key:z6MkhaXgBZDvotDkL5257faiztiGiC2QtKLGpbnnEGta2doK", "did:peer:0z6MkqRYqQiSgvZQdnBytw86Qbs2ZWUkGv22od935YF4s8M7V"]) {
    const r = read(from, CONTACT_METHODS);
    assert.equal(r.reason, "from-not-allowed", from);
  }
});

test("registry: resolution of an unregistered method is unsupported-vid, nothing resolved", async () => {
  let called = 0;
  const r = await resolveContactDocument("did:example:abc", { resolveDid: async () => (called++, {}) });
  assert.deepEqual(r, { ok: false, reason: "unsupported-vid" });
  const c = await resolveCommunityDocument("did:ion:abc", { resolveDid: async () => (called++, {}) });
  assert.deepEqual(c, { ok: false, reason: "unsupported-vid" });
  assert.equal(called, 0);
});

test("registry: host-named resolution keeps the host rules and returns the route", async () => {
  const ok = await resolveCommunityDocument("did:web:members.example.org", {
    resolveDid: async (did) => ({ didDocument: { id: did } }),
  });
  assert.equal(ok.ok, true);
  assert.equal(ok.route, "host-named");
  const bad = await resolveCommunityDocument("did:web:example.com%3A8443", {
    resolveDid: async () => assert.fail("must not resolve"),
  });
  assert.deepEqual(bad, { ok: false, reason: "did-document-unverified" });
});

test("registry: a method with a route but no resolver is refused at registration", () => {
  assert.throws(() => new ContactMethodRegistry([{ kind: "did:test", route: "domain-linked", listsServices: true, verified: true }]));
  assert.throws(() => new ContactMethodRegistry([{ ...testMethod(), kind: "did:Bad" }]));
});

test("registry: a test-only domain-linked method needs only registering", async () => {
  const resolved = [];
  const methods = defaultContactMethods().register(testMethod(resolved));
  // The shared registry is untouched.
  assert.equal(CONTACT_METHODS.policyFor("did:test"), undefined);
  assert.equal(read("did:test:abc").reason, "unsupported-vid");

  const r = read("did:test:abc", methods);
  assert.equal(r.ok, true);
  assert.equal(r.link.from.kind, "did:test");
  assert.equal(contactRoute(r.link.from, methods), "domain-linked");
  assert.equal(isServiceContact(r.link.from, methods), true);
  assert.equal(SIGN_IN_FLOW.allowsContact(r.link.from, methods), true);
  assert.equal(isHostNamedServiceContact(r.link.from, methods), false);
  // It names no host: no domain label to show before resolution.
  assert.equal(contactDomainLabel(r.link.from, methods), undefined);

  const doc = await resolveCommunityDocument("did:test:abc", { contactMethods: methods });
  assert.deepEqual(doc, { ok: true, doc: { id: "did:test:abc" }, route: "domain-linked" });
  assert.deepEqual(resolved, ["did:test:abc"]);
  // Built-ins still work in the extended registry.
  assert.equal(read(WEBVH, methods).ok, true);
});

test("registry: a resolver whose document is for another DID is unverified", async () => {
  const methods = defaultContactMethods().register({
    ...testMethod(),
    resolve: async () => ({ ok: true, doc: { id: "did:test:other" } }),
  });
  const r = await resolveContactDocument("did:test:abc", { methods });
  assert.deepEqual(r, { ok: false, reason: "did-document-unverified" });
});

test("contactKindOf", () => {
  assert.equal(contactKindOf(WEBVH), "did:webvh");
  assert.equal(contactKindOf("did:web:x.example"), "did:web");
  assert.equal(contactKindOf("urn:x"), undefined);
  assert.equal(contactKindOf("did::x"), undefined);
});

// ── did:scid (VTI-KEY-160 to 163; the spec's 07a Examples rows) ──────────────

const SCID_URL = `${SCID}?src=dids.example.org/farm-auth`;

test("did:scid with src: accepted, route A, shown as its src host and path, recorded as the bare DID", () => {
  const r = read(SCID_URL, CONTACT_METHODS);
  assert.equal(r.ok, true, JSON.stringify(r));
  assert.equal(r.link.from.kind, "did:scid");
  assert.equal(r.link.from.value, SCID_URL);
  assert.equal(contactRoute(r.link.from, CONTACT_METHODS), "host-named");
  assert.equal(SIGN_IN_FLOW.allowsContact(r.link.from, CONTACT_METHODS), true);
  assert.equal(contactDomainLabel(r.link.from, CONTACT_METHODS), "dids.example.org/farm-auth");
  assert.equal(contactIdentity(r.link.from), SCID);
  assert.equal(didIdentity(SCID_URL), SCID);
});

test("did:scid with src resolves to the bare DID's document", async () => {
  const asked = [];
  const ok = await resolveCommunityDocument(SCID_URL, {
    resolveDid: async (did) => (asked.push(did), { didDocument: { id: SCID } }),
  });
  assert.equal(ok.ok, true);
  assert.equal(ok.route, "host-named");
  // Resolved through the DID URL, so a first-contact resolver has a source.
  assert.deepEqual(asked, [SCID_URL]);
});

test("did:scid: a document whose id is not the bare DID is unverified", async () => {
  const r = await resolveCommunityDocument(SCID_URL, {
    resolveDid: async () => ({ didDocument: { id: SCID_URL } }),
  });
  assert.deepEqual(r, { ok: false, reason: "did-document-unverified" });
});

test("did:scid: a source serving a log older than one verified is did-document-unverified", async () => {
  const r = await resolveCommunityDocument(SCID_URL, {
    resolveDid: async () => {
      throw new Error("did:scid resolve: the log at dids.example.org/farm-auth is at version 1-Qm…, behind 2-Qm…");
    },
  });
  assert.deepEqual(r, { ok: false, reason: "did-document-unverified" });
});

test("did:scid with src=localhost%3A8000: refused at resolution by the host rules, nothing fetched", async () => {
  const r = read(`${SCID}?src=localhost%3A8000`, CONTACT_METHODS);
  assert.equal(r.ok, true, "the link parses; the host rules apply at resolution");
  const res = await resolveCommunityDocument(r.link.from.value, {
    resolveDid: async () => assert.fail("must not resolve"),
  });
  assert.deepEqual(res, { ok: false, reason: "did-document-unverified" });
});

test("did:scid with no src: from-not-allowed (it names no host)", () => {
  const r = read(SCID, CONTACT_METHODS);
  assert.equal(r.ok, false);
  assert.equal(r.reason, "from-not-allowed");
  assert.equal(r.outcome, "invalid");
});

test("did:scid of another format, and a reader with no did:scid method: unsupported-vid", () => {
  assert.equal(read("did:scid:ke:1:EKYLUMmNPZeEs77Zvclf0bSN5IN?src=example.org", CONTACT_METHODS).reason, "unsupported-vid");
  const noScid = new ContactMethodRegistry([WEBVH_CONTACT_METHOD]);
  const r = read(`${SCID}?src=dids.example.org`, noScid);
  assert.equal(r.reason, "unsupported-vid");
  assert.equal(r.outcome, "update");
});

test("did:scid: a malformed src or a second query parameter is bad-from", () => {
  // A raw `&` would end `_from` (VTI-LNK-020); `%26` decodes into the value.
  for (const from of [`${SCID}?src=`, `${SCID}?src=dids.example.org%26x=1`, `${SCID}?versionId=1`]) {
    assert.equal(read(from, CONTACT_METHODS).reason, "bad-from", from);
  }
});
