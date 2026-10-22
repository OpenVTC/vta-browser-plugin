// Verified directory fields (`vtc/directory/card/present/0.1`), as a wallet
// reads what they ask of a credential before its agent presents one.
//
// Pinned: only active `credential`-sourced claim fields are answered, and all of
// one credential type; the claims disclosed are the claims the paths start in,
// RFC 6901-unescaped; issuers narrow to those every field accepts; and the
// document carries the id the presentation was bound to, not a fresh one.

import { test } from "node:test";
import assert from "node:assert/strict";

import { buildCardPresent, claimNameOf, credentialAskFor, verifiedValuesOf, CARD_PRESENT } from "../dist/vtc/index.js";

const claimField = (key, label, claim, extra = {}) => ({
  key,
  label,
  type: "claim",
  source: "credential",
  base: false,
  required: false,
  ceiling: "community",
  defaultVisibility: "members",
  searchable: false,
  facet: false,
  order: 1,
  state: "active",
  constraints: { claim },
  ...extra,
});

const EMPLOYER = claimField("org.example.employer", "Employer", {
  credentialType: "EmploymentCredential",
  claimPath: "/employer",
  issuers: ["did:example:hr", "did:example:payroll"],
});
const TITLE = claimField("org.example.title", "Job title", {
  credentialType: "EmploymentCredential",
  claimPath: "/role/title",
  issuers: ["did:example:hr"],
});
const REGISTRATION = claimField("org.example.registration", "Registration", {
  credentialType: "ProfessionalRegistration",
  claimPath: "/number",
});

test("claimNameOf reads the first segment, unescaped", () => {
  assert.equal(claimNameOf("/employer"), "employer");
  assert.equal(claimNameOf("/role/title"), "role");
  assert.equal(claimNameOf("/a~1b/c"), "a/b");
  assert.equal(claimNameOf("/a~0b"), "a~b");
  assert.equal(claimNameOf("employer"), null);
  assert.equal(claimNameOf("/"), null);
});

test("fields of one type ask for one credential, issuers narrowed to the common ones", () => {
  const got = credentialAskFor([EMPLOYER, TITLE, REGISTRATION], ["org.example.employer", "org.example.title"]);
  assert.ok(got.ok);
  assert.deepEqual(got.ask, {
    credentialType: "EmploymentCredential",
    issuers: ["did:example:hr"],
    claims: ["employer", "role"],
    fields: [
      { key: "org.example.employer", label: "Employer" },
      { key: "org.example.title", label: "Job title" },
    ],
  });
});

test("a field without issuers leaves the community's policy to decide", () => {
  const got = credentialAskFor([REGISTRATION], ["org.example.registration"]);
  assert.ok(got.ok);
  assert.equal(got.ask.issuers, undefined);
  assert.deepEqual(got.ask.claims, ["number"]);
});

test("refused: two credential types, an unknown field, a member-sourced field, a retired one", () => {
  assert.equal(credentialAskFor([EMPLOYER, REGISTRATION], ["org.example.employer", "org.example.registration"]).ok, false);
  assert.equal(credentialAskFor([EMPLOYER], ["org.example.nope"]).ok, false);
  const memberField = { ...EMPLOYER, source: "member" };
  assert.match(credentialAskFor([memberField], ["org.example.employer"]).error, /isn't a field a credential fills/);
  assert.equal(credentialAskFor([{ ...EMPLOYER, state: "retired" }], ["org.example.employer"]).ok, false);
});

test("the document carries the presentation's nonce as its id", () => {
  const doc = buildCardPresent("urn:uuid:nonce-1", "did:example:carol", "did:example:community", ["org.example.employer"], "sd~jwt~kb");
  assert.equal(doc.id, "urn:uuid:nonce-1");
  assert.equal(doc.type, CARD_PRESENT);
  assert.equal(doc.issuer, "did:example:carol");
  assert.equal(doc.recipient, "did:example:community");
  assert.deepEqual(doc.payload, { fields: ["org.example.employer"], presentation: "sd~jwt~kb" });
});

test("verifiedValuesOf refuses an answer without values", () => {
  assert.throws(() => verifiedValuesOf({ revision: 1 }));
  const v = { value: "Acme", issuer: "did:example:hr", credentialType: "EmploymentCredential", verifiedAt: "2026-10-22T09:00:00Z" };
  assert.deepEqual(verifiedValuesOf({ verified: { "org.example.employer": v }, revision: 3 }), {
    verified: { "org.example.employer": v },
    revision: 3,
  });
});
