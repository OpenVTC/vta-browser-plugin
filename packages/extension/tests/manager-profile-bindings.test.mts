// Who presents a profile — the scan, and the one wrong answer it must never
// give.
//
// This view assembles the holder's linkage map from calls that were each
// designed not to answer it: `binding/list` is per context and returns a
// profile *name*, never an id, because a binding read that returned more would
// make the disclosure gate decorative. So the console filters by name and then
// confirms by id, and the soundness of that ordering is what this file pins.
//
// The asymmetry is the point. A false positive shows a linkage that is not
// there, which a holder can see and which `binding/get` removes anyway. A false
// negative renders as "no persona presents this profile" — a holder concluding
// no linkage exists when nobody actually looked. Every test here is written
// against that direction.

import { test } from "node:test";
import assert from "node:assert/strict";

import {
  bindingCandidates,
  scanForProfile,
  type BindingDetail,
  type BindingListRow,
} from "../src/manager/profile-bindings.ts";

const PROFILE = { profileId: "01WORK", name: "work" };

const row = (
  personaDid: string,
  profileName: string | undefined,
  bound = true,
): BindingListRow => ({ personaDid, bound, ...(profileName ? { profileName } : {}) });

/** A reader pair over a fixed world, recording what it was asked. */
function world(
  contexts: Record<string, BindingListRow[]>,
  ids: Record<string, BindingDetail>,
  refuse: { list?: string[]; get?: string[] } = {},
) {
  const gets: string[] = [];
  return {
    gets,
    readers: {
      list: async (contextId: string) => {
        if (refuse.list?.includes(contextId)) throw new Error(`refused ${contextId}`);
        return { personas: contexts[contextId] ?? [] };
      },
      get: async (contextId: string, personaDid: string) => {
        const key = `${contextId}/${personaDid}`;
        gets.push(key);
        if (refuse.get?.includes(key)) throw new Error(`refused ${key}`);
        return ids[key] ?? {};
      },
    },
  };
}

test("a name match is a candidate; a different name is not", () => {
  const rows = [
    row("did:a", "work"),
    row("did:b", "personal"),
    row("did:c", "work", false),
    row("did:d", undefined),
  ];
  assert.deepEqual(
    bindingCandidates(rows, "work").map((r) => r.personaDid),
    ["did:a"],
    "an unbound persona and a differently-named one are not candidates",
  );
});

test("the profile is found where it is presented", async () => {
  // The positive. Without it every assertion below is satisfied by a scan that
  // finds nothing anywhere.
  const w = world(
    { alpha: [row("did:a", "work")], beta: [row("did:b", "work")] },
    { "alpha/did:a": { profileId: "01WORK", claimCount: 3 }, "beta/did:b": { profileId: "01WORK", claimCount: 3 } },
  );
  const { rows, unreadable } = await scanForProfile(["alpha", "beta"], PROFILE, w.readers);
  assert.deepEqual(rows, [
    { contextId: "alpha", personaDid: "did:a", claimCount: 3 },
    { contextId: "beta", personaDid: "did:b", claimCount: 3 },
  ]);
  assert.deepEqual(unreadable, []);
});

test("two profiles sharing a name do not become one linkage", async () => {
  // The false positive the name filter admits, and the reason `binding/get`
  // confirms by id. Presenting this as a linkage would invent a correlation
  // the holder does not have — and correlation is the thing they came to check.
  const w = world(
    { alpha: [row("did:a", "work"), row("did:impostor", "work")] },
    {
      "alpha/did:a": { profileId: "01WORK", claimCount: 2 },
      "alpha/did:impostor": { profileId: "01OTHER", claimCount: 9 },
    },
  );
  const { rows } = await scanForProfile(["alpha"], PROFILE, w.readers);
  assert.deepEqual(rows.map((r) => r.personaDid), ["did:a"]);
});

test("confirmation is asked only of name matches", async () => {
  // The cost claim: proportional to the answer, not to the store. If this ever
  // starts confirming every persona, the view still works and quietly becomes
  // a fan-out over everything the agent holds.
  const w = world(
    {
      alpha: [row("did:a", "work"), row("did:b", "personal"), row("did:c", "dating")],
    },
    { "alpha/did:a": { profileId: "01WORK", claimCount: 1 } },
  );
  await scanForProfile(["alpha"], PROFILE, w.readers);
  assert.deepEqual(w.gets, ["alpha/did:a"]);
});

test("a context that refuses is named, not silently dropped", async () => {
  // The failure this view must never produce: "no persona presents this" when
  // nobody looked. A refused context has to reach the operator as a gap.
  const w = world(
    { alpha: [row("did:a", "work")], beta: [row("did:b", "work")] },
    { "alpha/did:a": { profileId: "01WORK", claimCount: 1 } },
    { list: ["beta"] },
  );
  const { rows, unreadable } = await scanForProfile(["alpha", "beta"], PROFILE, w.readers);
  assert.deepEqual(rows.map((r) => r.personaDid), ["did:a"], "the readable context still answers");
  assert.deepEqual(unreadable, ["beta"]);
});

test("a persona that refuses confirmation is named too", async () => {
  const w = world(
    { alpha: [row("did:a", "work"), row("did:b", "work")] },
    { "alpha/did:a": { profileId: "01WORK", claimCount: 1 } },
    { get: ["alpha/did:b"] },
  );
  const { rows, unreadable } = await scanForProfile(["alpha"], PROFILE, w.readers);
  assert.deepEqual(rows.map((r) => r.personaDid), ["did:a"]);
  assert.deepEqual(unreadable, ["alpha/did:b"]);
});

test("nothing found is an empty answer, not an incomplete one", async () => {
  // The two must stay distinguishable: `rows: []` with `unreadable: []` means
  // the agent answered everywhere and nobody presents it.
  const w = world({ alpha: [row("did:b", "personal")] }, {});
  const { rows, unreadable } = await scanForProfile(["alpha"], PROFILE, w.readers);
  assert.deepEqual(rows, []);
  assert.deepEqual(unreadable, []);
});

test("no contexts is not an answer about any context", async () => {
  const w = world({}, {});
  const { rows, unreadable } = await scanForProfile([], PROFILE, w.readers);
  assert.deepEqual(rows, []);
  assert.deepEqual(unreadable, []);
  assert.deepEqual(w.gets, []);
});
