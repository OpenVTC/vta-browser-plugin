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
//   * **The behaviour** — reading a 0.2 capability scope, building one to
//     send, the two refusals — is this library's own, and is tested against
//     fixtures.
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
  ADDITIVE_CAPABILITIES,
  effectiveCapabilities,
  checkNarrowing,
  narrowingToSend,
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

test("the additive capabilities are the agent's", () => {
  // A console that did not know `persona-holder` was additive computed an entry
  // granted only that name as holding nothing — the snapshot predates it.
  assert.deepEqual(sorted(ADDITIVE_CAPABILITIES), sorted(SNAPSHOT.additive));
  for (const cap of ADDITIVE_CAPABILITIES) {
    for (const role of ACL_ROLES) {
      assert.ok(!DERIVED_CAPABILITIES[role].includes(cap), `${role} must not derive ${cap}`);
    }
  }
});

test("key-export is admin's alone", () => {
  // VTI-VTA-003: export is gated separately from use. `initiator` keeps
  // `key-mint` and does not get `key-export` with it.
  for (const role of ACL_ROLES) {
    assert.equal(DERIVED_CAPABILITIES[role].includes("key-export"), role === "admin", role);
  }
});

test("monitor derives nothing, and that is load-bearing", () => {
  // Asserted rather than assumed: it is the agent's `Default`, so a claim that
  // leaks past its expected reach lands here. A future edit that gave it a
  // capability "for convenience" would widen every default-constructed caller.
  assert.deepEqual(DERIVED_CAPABILITIES.monitor, []);
  assert.ok(DERIVED_CAPABILITIES.admin.length > 0, "admin must not be empty too");
});

// ── Intersection ────────────────────────────────────────────────────────────

const CEILING = { scope: "ceiling" };
/** A `listed` scope: plain names narrow, `+name` is an additive grant. */
const listed = (...names) => ({
  scope: "listed",
  grants: names.map((n) =>
    n.startsWith("+") ? { capability: n.slice(1), additive: true } : { capability: n },
  ),
});

test("the role's ceiling enumerated beside an additive grant reads as the whole role", () => {
  // How the agent renders "the whole role plus persona-holder" — 0.2 has no
  // other spelling for it. Reading it as "narrowed, 15 of 15" describes a
  // decision nobody took.
  const e = effectiveCapabilities(
    "admin",
    listed(...DERIVED_CAPABILITIES.admin, "+persona-holder"),
  );
  assert.equal(e.unnarrowed, true);
  assert.deepEqual(sorted(e.effective), sorted([...DERIVED_CAPABILITIES.admin, "persona-holder"]));
  assert.deepEqual(e.additive, ["persona-holder"]);
  assert.deepEqual(e.unrecognised, []);
});

test("an additive grant beside a narrowing: narrowed, then added", () => {
  const e = effectiveCapabilities("initiator", listed("sign", "+persona-holder"));
  assert.equal(e.unnarrowed, false);
  assert.deepEqual(sorted(e.effective), ["persona-holder", "sign"]);
});

test("additive is read from the grant, not from this build's table", () => {
  // `persona-holder` listed WITHOUT the flag is a narrowing name the role does
  // not carry, so it intersects away — exactly what the agent computes.
  const e = effectiveCapabilities("admin", listed("sign", "persona-holder"));
  assert.deepEqual(e.effective, ["sign"]);
  assert.deepEqual(e.additive, []);
});

test("editing a narrowing carries an additive grant through", () => {
  const stored = listed("sign", "+persona-holder");
  assert.deepEqual(narrowingToSend("initiator", ["vault-read"], stored, "narrow"), {
    ok: true,
    capabilities: listed("vault-read", "+persona-holder"),
  });
  // Clearing widens back to the role and does NOT revoke the pool grant: the
  // update replaces the scope, so `ceiling` here would drop it.
  assert.deepEqual(narrowingToSend("initiator", [], stored, "clear"), {
    ok: true,
    capabilities: listed(...DERIVED_CAPABILITIES.initiator, "+persona-holder"),
  });
  // Without an additive grant, clearing is the role's ceiling.
  assert.deepEqual(narrowingToSend("initiator", [], listed("sign"), "clear"), {
    ok: true,
    capabilities: CEILING,
  });
});

test("narrowing to nothing is refused, because the agent cannot hold it", () => {
  assert.equal(narrowingToSend("admin", [], listed("sign"), "narrow").ok, false);
  assert.equal(narrowingToSend("admin", [], listed("+persona-holder"), "narrow").ok, false);
  assert.equal(narrowingToSend("admin", ["persona-holder"], CEILING, "narrow").ok, false);
  // Keeping one is expressible, and is sent as asked.
  assert.deepEqual(narrowingToSend("admin", ["sign"], CEILING, "narrow"), {
    ok: true,
    capabilities: listed("sign"),
  });
});

test("a narrowing outside the role is refused before it is sent", () => {
  // Paired with the acceptance above: same call, a name the role lacks.
  const res = narrowingToSend("reader", ["key-export"], CEILING, "narrow");
  assert.equal(res.ok, false);
  assert.match(res.reason, /key-export/);
});

test("an additive name is not refused for want of a role that carries it", () => {
  // Paired with the refusal below it: the same role, a derived-set name it
  // lacks, still refused. Whether the caller may confer `persona-holder` is the
  // agent's check on the granter.
  assert.deepEqual(checkNarrowing("reader", ["persona-holder"]), { ok: true });
  assert.equal(checkNarrowing("reader", ["key-export"]).ok, false);
});

test("a ceiling scope holds its whole role", () => {
  const e = effectiveCapabilities("reader", CEILING);
  assert.deepEqual(sorted(e.effective), sorted(DERIVED_CAPABILITIES.reader));
  assert.equal(e.unnarrowed, true);
});

test("a none scope holds nothing, and says it is narrowed", () => {
  const e = effectiveCapabilities("reader", { scope: "none" });
  assert.deepEqual(e.effective, []);
  assert.equal(e.unnarrowed, false);
});

test("a narrowing subtracts, and cannot add", () => {
  const narrowed = effectiveCapabilities("reader", listed("vault-read"));
  assert.deepEqual(narrowed.effective, ["vault-read"]);
  assert.equal(narrowed.unnarrowed, false);

  // The half that matters: naming a capability the role lacks does not grant
  // it. A reader narrowed to `sign` holds nothing, not signing authority.
  const beyond = effectiveCapabilities("reader", listed("sign"));
  assert.deepEqual(beyond.effective, []);
  assert.ok(
    !beyond.effective.includes("sign"),
    "a narrowing that named a capability outside the role would have widened it",
  );
});

test("an unknown role is undefined, never an empty set", () => {
  // The two would render identically as "holds nothing", and one of them is a
  // lie about an entry that may hold everything.
  assert.equal(effectiveCapabilities("superuser", listed("sign")), undefined);
  assert.notEqual(effectiveCapabilities("admin", listed("sign")), undefined);
});

test("a name this build does not know is reported, not dropped", () => {
  const e = effectiveCapabilities("admin", listed("sign", "quantum-entangle"));
  assert.deepEqual(e.effective, ["sign"]);
  assert.deepEqual(e.unrecognised, ["quantum-entangle"]);
});

test("a scope shape this build does not know throws rather than guessing", () => {
  assert.throws(() => effectiveCapabilities("admin", { scope: "everything" }), /unrecognised/);
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

test("aclUpdate sends a capability scope only when one is stated", async () => {
  const entry = { subject: "did:key:zSub", role: "admin" };

  const leave = recorder({ entry });
  await aclUpdate(leave, { ...PARTIES, subject: "did:key:zSub", label: "ops" });
  const left = leave.sent[0].envelope.payload;
  assert.equal("capabilities" in left, false, "an omitted scope must not be sent — it would replace");
  assert.equal(left.ext, undefined, "0.2 carries no capability narrowing in ext");

  const clear = recorder({ entry });
  await aclUpdate(clear, { ...PARTIES, subject: "did:key:zSub", capabilities: CEILING });
  assert.deepEqual(clear.sent[0].envelope.payload.capabilities, CEILING);

  const narrow = recorder({ entry });
  await aclUpdate(narrow, {
    ...PARTIES,
    subject: "did:key:zSub",
    capabilities: listed("memory-read"),
  });
  assert.deepEqual(narrow.sent[0].envelope.payload.capabilities, listed("memory-read"));
  // The rest of the call still works — a wrapper that sent only the scope
  // would pass every assertion above.
  assert.equal(narrow.sent[0].envelope.payload.subject, "did:key:zSub");
});
