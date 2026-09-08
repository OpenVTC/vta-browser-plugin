// `CLAIM-TYPES.md` §4, resolved against the table the AGENT serves.
//
// These moved here from the console when the vendored copy went. Resolution is
// not a rendering concern and never was: it is the same four rules whoever
// asks, and having it in one place is the point of reading the table rather
// than compiling one in.

import { test } from "node:test";
import assert from "node:assert/strict";

import {
  resolveTreatment,
  isRegisteredType,
  registeredRoots,
  unappliedClaimTypes,
} from "../dist/persona/index.js";

/** A registry shaped exactly as `persona/claim-types/list` returns one. */
const registry = {
  registryVersion: "0.1",
  entries: [
    // Family rows and exact rows, undistinguished — which one a row is depends
    // on the token being resolved.
    { type: "payment", sensitivity: "high", release: "stepUp", mask: "full" },
    { type: "gov", sensitivity: "high", release: "stepUp", mask: "full" },
    { type: "name", sensitivity: "normal", release: "consent", mask: "none" },
    { type: "name.legal", sensitivity: "normal", release: "consent", mask: "none" },
    { type: "payment.card", sensitivity: "high", release: "stepUp", mask: "last4" },
    { type: "email.work", sensitivity: "normal", release: "consent", mask: "emailLocal" },
    { type: "account.handle", sensitivity: "normal", release: "consent", mask: "none" },
  ],
  unregistered: { sensitivity: "high", release: "consent", mask: "full" },
  strictness: {
    sensitivity: ["high", "normal"],
    release: ["stepUp", "consent"],
    mask: ["full", "last2", "last4", "emailLocal", "none"],
  },
};

test("an exact entry is used as written, not compared against its family", () => {
  // `payment.card` is `last4`, not its family's `full`. Rule 2 answers before
  // rule 3 can tighten it.
  assert.deepEqual(resolveTreatment(registry, "payment.card"), {
    sensitivity: "high",
    mask: "last4",
  });
});

test("a bare name is a token, not just a prefix", () => {
  assert.deepEqual(resolveTreatment(registry, "name"), { sensitivity: "normal", mask: "none" });
});

test("a token invented under a gated family cannot escape it", () => {
  // The hole rule 3 exists for: without the walk this would take the floor's
  // `consent`, weaker than every registered member of the family it plainly
  // belongs to.
  assert.deepEqual(resolveTreatment(registry, "payment.giftCard"), {
    sensitivity: "high",
    mask: "full",
  });
});

test("a family entry can tighten but never loosen", () => {
  // `name` is `none`, but an unregistered member does NOT inherit that — the
  // more protective of the prefix and the floor wins, per axis. A family entry
  // cannot make an unknown token visible.
  assert.deepEqual(resolveTreatment(registry, "name.somethingNew"), {
    sensitivity: "high",
    mask: "full",
  });
});

test("an x: token borrows nothing, however it is spelled", () => {
  assert.deepEqual(resolveTreatment(registry, "x:payment.card"), {
    sensitivity: "high",
    mask: "full",
  });
  assert.deepEqual(resolveTreatment(registry, "x:name"), { sensitivity: "high", mask: "full" });
});

test("a prefix is matched on dot boundaries, not on characters", () => {
  // `paymentology.card` merely starts with those characters and is a member of
  // nothing.
  assert.deepEqual(resolveTreatment(registry, "paymentology.card"), {
    sensitivity: "high",
    mask: "full",
  });
});

test("a token the registry has never seen takes the floor", () => {
  assert.deepEqual(resolveTreatment(registry, "wholly.unknown"), {
    sensitivity: "high",
    mask: "full",
  });
});

test("a declared token is distinguishable from one that fell to the floor", () => {
  // A holder applying their own decision needs to know which they have: a
  // declared entry is a statement the registry made, the floor is one standing
  // in for a decision nobody took. `treatmentFor` in the console turns on it.
  assert.equal(isRegisteredType(registry, "payment.card"), true, "exact entry");
  assert.equal(isRegisteredType(registry, "payment.giftCard"), true, "via its family");
  assert.equal(isRegisteredType(registry, "wholly.unknown"), false);
  assert.equal(isRegisteredType(registry, "x:payment.card"), false, "x: is never registered");
});

test("an unrecognised value on an axis is treated as most protective", () => {
  // A maintainer serving a style this build has never heard of must not have it
  // read as "no mask" — the unknown-value branch is the difference between
  // showing a value and hiding it.
  const future = {
    ...registry,
    entries: [
      { type: "novel", sensitivity: "high", release: "consent", mask: "someFutureStyle" },
    ],
  };
  // The style survives resolution rather than being rewritten — a renderer that
  // knows it should use it. What must never happen is it resolving to `none`:
  // that is the branch where an unknown style shows a value in the clear.
  const resolved = resolveTreatment(future, "novel.thing").mask;
  assert.notEqual(resolved, "none", "an unknown style must never resolve to no mask");
});

test("the roots come from the served table, not a compiled list", () => {
  const roots = registeredRoots(registry);
  assert.ok(roots.has("payment"));
  assert.ok(roots.has("email"));
  assert.ok(!roots.has("wholly"));
});

// ── What the agent could not apply ─────────────────────────────────────────
//
// A refused claim-type row is invisible from the outside: the token resolves
// from the core table exactly as it would with no file at all, so the screen
// looks normal while an operator's intended tightening is not in force. The
// agent reports its refusals under `ext` so somebody can be told; these are the
// checks on the half that reads them.

test("the rejected rows are read out of the agent's ext", () => {
  const registry = {
    registryVersion: "0.1",
    entries: [],
    unregistered: { sensitivity: "high", release: "consent", mask: "full" },
    strictness: { sensitivity: ["high", "normal"], release: ["stepUp", "consent"], mask: ["full", "none"] },
    ext: {
      "org.openvtc.claim-types": {
        rejected: [{ type: "gov.id.passport", reason: "would weaken sensitivity" }],
      },
    },
  };
  const report = unappliedClaimTypes(registry);
  assert.deepEqual(report.rejected, [{ type: "gov.id.passport", reason: "would weaken sensitivity" }]);
  assert.equal(report.fileError, undefined);
});

test("a file the agent could not read is its own sentence", () => {
  // Different from a rejected row: then *nothing* the deployment declared is in
  // force, and the console says so rather than listing zero refusals.
  const registry = {
    registryVersion: "0.1",
    entries: [],
    unregistered: { sensitivity: "high", release: "consent", mask: "full" },
    strictness: { sensitivity: ["high", "normal"], release: ["stepUp", "consent"], mask: ["full", "none"] },
    ext: { "org.openvtc.claim-types": { fileError: "/etc/vta/claim-types.json: No such file" } },
  };
  const report = unappliedClaimTypes(registry);
  assert.deepEqual(report.rejected, []);
  assert.match(report.fileError, /No such file/);
});

test("an agent that reports nothing reports nothing", () => {
  // The ordinary case, and the one every existing deployment is in.
  const bare = {
    registryVersion: "0.1",
    entries: [],
    unregistered: { sensitivity: "high", release: "consent", mask: "full" },
    strictness: { sensitivity: ["high", "normal"], release: ["stepUp", "consent"], mask: ["full", "none"] },
  };
  assert.deepEqual(unappliedClaimTypes(bare), { rejected: [] });
  assert.deepEqual(unappliedClaimTypes(null), { rejected: [] }, "and no table at all is not a complaint");
});

test("a malformed report is dropped rather than rendered", () => {
  // `ext` is vendor-namespaced and the schema does not constrain it, so nothing
  // upstream has checked this shape. A banner built from `undefined` would be a
  // second fault reported as the first.
  for (const bad of [
    { "org.openvtc.claim-types": { rejected: "not a list" } },
    { "org.openvtc.claim-types": { rejected: [{ type: 7, reason: "wrong type" }] } },
    { "org.openvtc.claim-types": { rejected: [{ type: "ok" }] } },
    { "org.openvtc.claim-types": "not an object" },
    { "someone.else": { rejected: [{ type: "x", reason: "y" }] } },
  ]) {
    const report = unappliedClaimTypes({ ext: bad });
    assert.deepEqual(report.rejected, [], `should have dropped ${JSON.stringify(bad)}`);
  }
});

test("a well-formed row beside a malformed one still gets through", () => {
  // Dropping the whole report because one row is wrong would hide a real
  // refusal — the same mistake, one layer up, that the agent stopped making
  // when it moved to per-row rejection.
  const report = unappliedClaimTypes({
    ext: {
      "org.openvtc.claim-types": {
        rejected: [{ type: "good.one", reason: "a reason" }, { nonsense: true }],
      },
    },
  });
  assert.deepEqual(report.rejected, [{ type: "good.one", reason: "a reason" }]);
});
