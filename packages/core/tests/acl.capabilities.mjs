// The capability narrowing on an ACL entry.
//
// Two things are under test and they fail for different reasons, so they are
// kept apart deliberately:
//
//   * **The tables** are a hand-kept copy of `vti-common::acl`, because roles
//     and capabilities are ecosystem-local and there is no generated binding to
//     import. They are checked against `acl-capabilities.json`, the committed
//     snapshot `scripts/sync-acl-capabilities.mjs` writes. A failure here means
//     the agent moved and this library did not.
//   * **The behaviour** — intersection, the three write intentions, the two
//     refusals — is this library's own, and is tested against fixtures.
//
// Written with VTI#1268's lesson in view: a suite that only asserts refusals
// proves nothing, since a module that refuses everything passes it. Every
// refusal below is paired with the acceptance it is the boundary of.

import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

import {
  ACL_CAPABILITIES,
  ACL_ROLES,
  DERIVED_CAPABILITIES,
  CAPABILITIES_EXT_MEMBER,
  capabilitiesFromExt,
  capabilitiesIntoExt,
  effectiveCapabilities,
  checkNarrowing,
  entryNarrowing,
  aclUpdate,
} from "../dist/admin/index.js";

const SNAPSHOT = JSON.parse(
  readFileSync(new URL("../acl-capabilities.json", import.meta.url), "utf8"),
);

const HOLDER = { did: "did:key:zHolder" };
const SERVICE = { did: "did:webvh:QmAgent:agent.example" };
const PARTIES = { holder: HOLDER, service: SERVICE };

function recorder(reply) {
  const sent = [];
  return {
    sent,
    send(envelope, opts) {
      sent.push({ envelope, opts });
      return Promise.resolve(reply);
    },
  };
}

const sorted = (xs) => [...xs].sort();

// ── The copy, against the snapshot ──────────────────────────────────────────

test("the capability vocabulary is the agent's", () => {
  assert.deepEqual(sorted(ACL_CAPABILITIES), sorted(SNAPSHOT.capabilities));
});

test("the roles are the agent's", () => {
  assert.deepEqual(sorted(ACL_ROLES), sorted(SNAPSHOT.roles));
});

test("every role derives what the agent says it derives", () => {
  // Per role rather than as one blob: a diff naming `application` is a diff an
  // operator can act on, where "the tables differ" is not.
  for (const role of SNAPSHOT.roles) {
    assert.deepEqual(
      sorted(DERIVED_CAPABILITIES[role]),
      sorted(SNAPSHOT.derived[role]),
      `${role}'s derived set has drifted from vti-common`,
    );
  }
});

test("the ext member is spelled the way the agent spells it", () => {
  // The one string that has to match byte for byte across two languages: a
  // narrowing under a misspelled namespace is silently ignored by the agent,
  // which reads to the operator as a narrowing that did not take.
  assert.equal(CAPABILITIES_EXT_MEMBER, SNAPSHOT.extMember);
});

test("monitor derives nothing, and that is load-bearing", () => {
  // Asserted rather than assumed: it is the agent's `Default`, so a claim that
  // leaks past its expected reach lands here. A future edit that gave it a
  // capability "for convenience" would widen every default-constructed caller.
  assert.deepEqual(DERIVED_CAPABILITIES.monitor, []);
  assert.ok(DERIVED_CAPABILITIES.admin.length > 0, "admin must not be empty too");
});

// ── Intersection ────────────────────────────────────────────────────────────

test("an entry with no narrowing holds its whole role", () => {
  const e = effectiveCapabilities("reader", undefined);
  assert.deepEqual(sorted(e.effective), sorted(DERIVED_CAPABILITIES.reader));
  assert.equal(e.unnarrowed, true);

  // Empty means the same thing on the READ path, which is the shape every
  // entry written before the agent gained this feature has.
  assert.equal(effectiveCapabilities("reader", []).unnarrowed, true);
});

test("a narrowing subtracts, and cannot add", () => {
  const narrowed = effectiveCapabilities("reader", ["vault-read"]);
  assert.deepEqual(narrowed.effective, ["vault-read"]);
  assert.equal(narrowed.unnarrowed, false);

  // The half that matters: naming a capability the role lacks does not grant
  // it. A reader narrowed to `sign` holds nothing, not signing authority.
  const beyond = effectiveCapabilities("reader", ["sign"]);
  assert.deepEqual(beyond.effective, []);
  assert.ok(
    !beyond.effective.includes("sign"),
    "a narrowing that named a capability outside the role would have widened it",
  );
});

test("an unknown role is undefined, never an empty set", () => {
  // The two would render identically as "holds nothing", and one of them is a
  // lie about an entry that may hold everything.
  assert.equal(effectiveCapabilities("superuser", ["sign"]), undefined);
  assert.notEqual(effectiveCapabilities("admin", ["sign"]), undefined);
});

test("a name this build does not know is reported, not dropped", () => {
  const e = effectiveCapabilities("admin", ["sign", "quantum-entangle"]);
  assert.deepEqual(e.effective, ["sign"]);
  assert.deepEqual(e.unrecognised, ["quantum-entangle"]);
});

// ── The ext codec ───────────────────────────────────────────────────────────

test("an absent member reads as no narrowing, a malformed one as an error", () => {
  assert.equal(capabilitiesFromExt(undefined), undefined);
  assert.equal(capabilitiesFromExt({}), undefined);
  assert.deepEqual(capabilitiesFromExt({ [CAPABILITIES_EXT_MEMBER]: ["sign"] }), ["sign"]);

  // Not `undefined`: absence and "cannot parse this" are opposite conclusions
  // about an entry's authority, and the safe-looking one is the wrong one.
  assert.throws(() => capabilitiesFromExt({ [CAPABILITIES_EXT_MEMBER]: "sign" }), /must be an array/);
  assert.throws(() => capabilitiesFromExt({ [CAPABILITIES_EXT_MEMBER]: [1] }), /must contain strings/);
});

test("writing a narrowing keeps the rest of ext", () => {
  const ext = capabilitiesIntoExt({ "org.openvtc.vault-session": "s-1" }, ["sign"]);
  assert.equal(ext["org.openvtc.vault-session"], "s-1");
  assert.deepEqual(ext[CAPABILITIES_EXT_MEMBER], ["sign"]);
});

test("an empty narrowing is WRITTEN on the request path, not omitted", () => {
  // The one place this deliberately differs from the agent's own helper, which
  // drops an empty set because it serves the response path. Here `[]` is the
  // instruction to clear, and omitting it would leave the entry narrowed while
  // reporting success — a silent privilege DECREASE surviving a request to
  // remove it.
  const ext = capabilitiesIntoExt(undefined, []);
  assert.deepEqual(ext[CAPABILITIES_EXT_MEMBER], []);
  assert.ok(CAPABILITIES_EXT_MEMBER in ext);
});

test("entryNarrowing reads the entry the agent echoes back", () => {
  assert.deepEqual(entryNarrowing({ subject: "did:key:z", role: "admin" }), undefined);
  assert.deepEqual(
    entryNarrowing({
      subject: "did:key:z",
      role: "admin",
      ext: { [CAPABILITIES_EXT_MEMBER]: ["memory-read"] },
    }),
    ["memory-read"],
  );
});

// ── The two refusals ────────────────────────────────────────────────────────

test("a narrowing within the role is accepted", () => {
  assert.deepEqual(checkNarrowing("admin", ["memory-read", "room-present"]), { ok: true });
  // Clearing always passes: it widens back to the role, which bounds itself.
  assert.deepEqual(checkNarrowing("reader", []), { ok: true });
});

test("an unknown capability is refused, naming what it refused", () => {
  const res = checkNarrowing("admin", ["memory-read", "quantum-entangle"]);
  assert.equal(res.ok, false);
  assert.match(res.reason, /quantum-entangle/);
});

test("a capability the role does not carry is refused", () => {
  // `policy-admin` is real, and an initiator does not have it — so this fails
  // on the role check rather than the vocabulary check, which is the arm that
  // would otherwise never run.
  const res = checkNarrowing("initiator", ["policy-admin"]);
  assert.equal(res.ok, false);
  assert.match(res.reason, /policy-admin/);
  assert.match(res.reason, /initiator/);
  // And it is genuinely a real capability, or the test above proves nothing.
  assert.ok(ACL_CAPABILITIES.includes("policy-admin"));
});

// ── The wire ────────────────────────────────────────────────────────────────

test("aclUpdate keeps the three intentions apart on the wire", async () => {
  const entry = { subject: "did:key:zSub", role: "admin" };

  const leave = recorder({ entry });
  await aclUpdate(leave, { ...PARTIES, subject: "did:key:zSub", label: "ops" });
  assert.equal(
    leave.sent[0].envelope.payload.ext,
    undefined,
    "an omitted narrowing must not send an ext member — that would clear it",
  );

  const clear = recorder({ entry });
  await aclUpdate(clear, { ...PARTIES, subject: "did:key:zSub", capabilities: [] });
  assert.deepEqual(clear.sent[0].envelope.payload.ext, { [CAPABILITIES_EXT_MEMBER]: [] });

  const narrow = recorder({ entry });
  await aclUpdate(narrow, {
    ...PARTIES,
    subject: "did:key:zSub",
    capabilities: ["memory-read"],
  });
  assert.deepEqual(narrow.sent[0].envelope.payload.ext, {
    [CAPABILITIES_EXT_MEMBER]: ["memory-read"],
  });
  // The rest of the call still works — a wrapper that sent only `ext` would
  // pass every assertion above.
  assert.equal(narrow.sent[0].envelope.payload.subject, "did:key:zSub");
});
