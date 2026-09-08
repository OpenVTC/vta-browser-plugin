// `persona/*` — the holder-scoped half, the one the console speaks.
//
// The wallet's half is covered by `persona.consent-view.mjs` and
// `persona.preview-ranking.mjs`. This file covers the ten tasks that read or
// write the attribute pool, and it is written against the lesson VTI#1268
// taught the other side of this family: **a suite that only asserts refusals
// proves nothing.** An implementation that sent an empty payload for every task
// would pass a file full of "does not send a contextId" assertions, so every
// structural claim here is paired with one that the call actually carries what
// it is for.

import { test } from "node:test";
import assert from "node:assert/strict";

import {
  personaAttributeList,
  personaAttributePut,
  personaAttributeDelete,
  personaProfileList,
  personaProfileGet,
  personaProfilePut,
  personaProfileDelete,
  personaBindingSet,
  personaCorrelationAnalyze,
  personaDisclosureHistory,
  personasBlockingDelete,
  PROFILE_DELETE_BOUND,
} from "../dist/admin/index.js";

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

const SPEC = "https://trusttasks.org/spec";

// ── Versions ────────────────────────────────────────────────────────────────
//
// The whole family is 1.0 and every one of these compiles fine against the
// wrong version — only the agent would object, and it would object by refusing.

test("every task names its 1.0 URI, request and response", async () => {
  const cases = [
    [personaAttributeList, { ...PARTIES }, "persona/attribute/list/1.0", { attributes: [] }],
    [
      personaAttributePut,
      { ...PARTIES, type: "email", valueType: "string", value: "a@b.c", provenance: { kind: "selfAsserted" } },
      "persona/attribute/put/1.0",
      { attributeId: "01J", version: 1, created: true, updatedAt: "2026-09-07T00:00:00Z" },
    ],
    [
      personaAttributeDelete,
      { ...PARTIES, attributeId: "01J" },
      "persona/attribute/delete/1.0",
      { attributeId: "01J", existed: true },
    ],
    [personaProfileList, { ...PARTIES }, "persona/profile/list/1.0", { profiles: [] }],
    [
      personaProfileGet,
      { ...PARTIES, profileId: "01P" },
      "persona/profile/get/1.0",
      { profile: { profileId: "01P", name: "work", entries: [], version: 1, updatedAt: "x" } },
    ],
    [
      personaProfilePut,
      { ...PARTIES, name: "work", entries: [] },
      "persona/profile/put/1.0",
      { profileId: "01P", version: 1, created: true, updatedAt: "x" },
    ],
    [
      personaProfileDelete,
      { ...PARTIES, profileId: "01P" },
      "persona/profile/delete/1.0",
      { profileId: "01P", existed: true },
    ],
    [
      personaBindingSet,
      { ...PARTIES, contextId: "demo", personaDid: "did:key:zP" },
      "persona/binding/set/1.0",
      { contextId: "demo", personaDid: "did:key:zP", version: 1, boundAt: "x" },
    ],
    [personaCorrelationAnalyze, { ...PARTIES }, "persona/correlation/analyze/1.0", { findings: [] }],
    [
      personaDisclosureHistory,
      { ...PARTIES },
      "persona/disclosure/history/1.0",
      { disclosures: [] },
    ],
  ];

  for (const [fn, params, slug, reply] of cases) {
    const channel = recorder(reply);
    await fn(channel, params);
    const { envelope, opts } = channel.sent[0];
    assert.equal(envelope.type, `${SPEC}/${slug}`, `${fn.name} sends the wrong task URI`);
    assert.equal(
      opts.expectedResponseType,
      `${SPEC}/${slug}#response`,
      `${fn.name} expects the wrong response URI`,
    );
    assert.equal(envelope.from ?? envelope.issuer, HOLDER.did);
  }
});

// ── The boundary, from the client side ──────────────────────────────────────

test("the pool and profile tasks carry no contextId — they have no compartment", async () => {
  const noContext = [
    [personaAttributeList, { ...PARTIES }, { attributes: [] }],
    [personaProfileList, { ...PARTIES }, { profiles: [] }],
    [personaProfileGet, { ...PARTIES, profileId: "01P" }, { profile: {} }],
    [personaCorrelationAnalyze, { ...PARTIES }, { findings: [] }],
  ];
  for (const [fn, params, reply] of noContext) {
    const channel = recorder(reply);
    await fn(channel, params);
    assert.ok(
      !("contextId" in channel.sent[0].envelope.payload),
      `${fn.name} sent a contextId. These tasks sit ABOVE every context; a member here ` +
        `would be this library inventing a compartment the pool does not have.`,
    );
  }
});

test("binding/set carries the context it pushes a copy into", async () => {
  // The paired positive. Without it the assertion above is satisfied by a
  // client that never sends a contextId anywhere, including where it is the
  // entire point of the call.
  const channel = recorder({ contextId: "demo", personaDid: "did:key:zP", version: 1, boundAt: "x" });
  await personaBindingSet(channel, {
    ...PARTIES,
    contextId: "demo",
    personaDid: "did:key:zP",
    profileId: "01P",
  });
  assert.deepEqual(channel.sent[0].envelope.payload, {
    contextId: "demo",
    personaDid: "did:key:zP",
    profileId: "01P",
  });
});

test("disclosure/history omits contextId to read across every context", async () => {
  const all = recorder({ disclosures: [] });
  await personaDisclosureHistory(all, { ...PARTIES });
  assert.deepEqual(all.sent[0].envelope.payload, {});

  const one = recorder({ disclosures: [] });
  await personaDisclosureHistory(one, { ...PARTIES, contextId: "demo" });
  assert.deepEqual(one.sent[0].envelope.payload, { contextId: "demo" });
});

// ── Values ──────────────────────────────────────────────────────────────────

test("a string value is sent as a string, not wrapped in an object", async () => {
  // The generated payload type renders `value` as an index signature, because
  // the schema places no type constraint on it. That is a codegen artifact —
  // `vta-sdk` types the same member `Value` — and the cast in `attributePut` is
  // what keeps this library from making callers invent an object. If someone
  // "fixes" the cast by wrapping, every string attribute this console writes
  // starts disagreeing with its own `valueType` and the agent refuses it.
  const channel = recorder({ attributeId: "01J", version: 1, created: true, updatedAt: "x" });
  await personaAttributePut(channel, {
    ...PARTIES,
    type: "email",
    valueType: "string",
    value: "glenn@example.com",
    provenance: { kind: "selfAsserted" },
  });
  assert.equal(channel.sent[0].envelope.payload.value, "glenn@example.com");
});

test("values are withheld unless asked for", async () => {
  const bare = recorder({ attributes: [] });
  await personaAttributeList(bare, { ...PARTIES });
  assert.deepEqual(
    bare.sent[0].envelope.payload,
    {},
    "an unfiltered list must send an empty payload — not `includeValues: false`, and " +
      "certainly not nulls, which every optional member in this family refuses",
  );

  const asked = recorder({ attributes: [] });
  await personaAttributeList(asked, { ...PARTIES, includeValues: true, typePrefix: "phone" });
  assert.deepEqual(asked.sent[0].envelope.payload, { includeValues: true, typePrefix: "phone" });
});

// ── Unbinding is a value, not an absence ────────────────────────────────────

test("profileId null unbinds; omitting it leaves the binding alone", async () => {
  const reply = { contextId: "demo", personaDid: "did:key:zP", version: 2, boundAt: "x" };

  const unbind = recorder(reply);
  await personaBindingSet(unbind, {
    ...PARTIES,
    contextId: "demo",
    personaDid: "did:key:zP",
    profileId: null,
  });
  assert.equal(
    unbind.sent[0].envelope.payload.profileId,
    null,
    "an explicit null is how a persona stops presenting anything; dropping it because it " +
      "is falsy turns an unbind into a no-op the operator believes worked",
  );

  const untouched = recorder(reply);
  await personaBindingSet(untouched, {
    ...PARTIES,
    contextId: "demo",
    personaDid: "did:key:zP",
    publicEntries: ["01E"],
  });
  assert.ok(!("profileId" in untouched.sent[0].envelope.payload));
});

test("deleting a profile does not unbind unless asked", async () => {
  const bare = recorder({ profileId: "01P", existed: true });
  await personaProfileDelete(bare, { ...PARTIES, profileId: "01P" });
  assert.deepEqual(bare.sent[0].envelope.payload, { profileId: "01P" });

  const forced = recorder({ profileId: "01P", existed: true });
  await personaProfileDelete(forced, { ...PARTIES, profileId: "01P", unbind: true });
  assert.deepEqual(forced.sent[0].envelope.payload, { profileId: "01P", unbind: true });
});

test("cascade is what removes an attribute from the profiles naming it", async () => {
  const channel = recorder({ attributeId: "01J", existed: true, removedFromProfiles: ["01P"] });
  const res = await personaAttributeDelete(channel, {
    ...PARTIES,
    attributeId: "01J",
    cascade: true,
  });
  assert.deepEqual(channel.sent[0].envelope.payload, { attributeId: "01J", cascade: true });
  assert.deepEqual(res.removedFromProfiles, ["01P"]);
});

// ── Empty answers ───────────────────────────────────────────────────────────

test("a list returns [] rather than undefined when the pool holds nothing", async () => {
  assert.deepEqual(await personaAttributeList(recorder({}), { ...PARTIES }), []);
  assert.deepEqual(await personaProfileList(recorder({}), { ...PARTIES }), []);
  assert.deepEqual(await personaCorrelationAnalyze(recorder({}), { ...PARTIES }), []);
});

test("disclosure history returns the whole response, so nextCursor survives", async () => {
  // Returning just the array would erase the difference between "that is all of
  // it" and "the agent stopped early", which is the one misreading a disclosure
  // history exists to prevent.
  const res = await personaDisclosureHistory(recorder({ disclosures: [], nextCursor: "c2" }), {
    ...PARTIES,
  });
  assert.equal(res.nextCursor, "c2");
});

test("resolve is opt-in on profile/get", async () => {
  const bare = recorder({ profile: {} });
  await personaProfileGet(bare, { ...PARTIES, profileId: "01P" });
  assert.deepEqual(bare.sent[0].envelope.payload, { profileId: "01P" });

  const resolved = recorder({ profile: {}, resolved: [] });
  await personaProfileGet(resolved, { ...PARTIES, profileId: "01P", resolve: true });
  assert.deepEqual(resolved.sent[0].envelope.payload, { profileId: "01P", resolve: true });
});

test("a resolved profile entry is typed as a projection, not as a pool record", async () => {
  // Keys on the generated schema rather than on this library's behaviour.
  //
  // The distinction matters because the console renders an `inline` claim —
  // "held only here" — by testing `claim.attributeId === undefined`, and until
  // `@openvtc/trust-tasks` 0.17.0 the response typed `resolved` as the pool
  // `Attribute`, whose `attributeId`, `version` and `updatedAt` are all
  // REQUIRED. That branch was unreachable by construction: the schema said the
  // member is always there, so a conforming agent could not describe a profile
  // holding an inline value at all (dtgwg-trust-tasks-tf#370).
  //
  // A test asserting the console's own rendering would have passed against
  // either version, which is the shape VTI#1258 got wrong — it asserted
  // behaviour this side controls instead of the constraint it was waiting on.
  // So this asserts the constraint: the three pool members are optional here,
  // and a downgrade of the dependency fails rather than silently restoring a
  // branch nothing can reach.
  const { RESPONSE_PAYLOAD_SCHEMA } = await import(
    "@openvtc/trust-tasks/persona/profile/get/1.0/payload"
  );

  const response = RESPONSE_PAYLOAD_SCHEMA.$defs.Response;
  const items = response.properties.resolved.items;
  assert.equal(
    items.$ref,
    "#/$defs/ResolvedClaim",
    "`resolved` must project a ResolvedClaim; the pool Attribute cannot describe an inline entry",
  );

  const claim = RESPONSE_PAYLOAD_SCHEMA.$defs.ResolvedClaim;
  for (const member of ["attributeId", "version", "updatedAt"]) {
    assert.ok(
      claim.properties[member],
      `ResolvedClaim should still carry ${member} — its presence is what says the value is pooled`,
    );
    assert.ok(
      !claim.required.includes(member),
      `${member} must be OPTIONAL on ResolvedClaim: an inline value has no pool record to have one`,
    );
  }
});

// ── The refusal a profile deletion has to be able to read ───────────────────
//
// `personasBlockingDelete` parses unvalidated wire data, which is the one place
// a client is entitled to be paranoid. Its `null` is load-bearing and easy to
// erase: a caller that collapsed it into `[]` would render "0 personas are
// bound" over a refusal that exists precisely because some are.

test("the bound code is the extended form the agent actually sends", () => {
  // Assembled by the agent as `TrustTaskCode::new_extended(slug, "bound")`,
  // where the slug is the task URI minus the spec prefix and the version. A
  // constant here rather than a string at the call site, because a caller
  // matching on a code it built itself is matching on its own assumption.
  assert.equal(PROFILE_DELETE_BOUND, "persona/profile/delete:bound");
});

test("the personas blocking a deletion are read out of the refusal", () => {
  assert.deepEqual(
    personasBlockingDelete({ personaDids: ["did:key:zA", "did:key:zB"] }),
    ["did:key:zA", "did:key:zB"],
  );
});

test("an absent or unreadable details is null, never an empty list", () => {
  // Each of these means "the agent did not tell us", and every one of them
  // would render as "nothing is bound" if it came back as [] — over a refusal
  // whose whole cause is that something is.
  for (const bad of [undefined, null, "personaDids", 42, {}, { personaDids: "did:key:zA" }]) {
    assert.equal(personasBlockingDelete(bad), null, `${JSON.stringify(bad)} should be null`);
  }
});

test("a mixed array is refused rather than filtered", () => {
  // Keeping the strings and dropping the rest would under-report the blockers,
  // and the operator would unbind what they were shown while something they
  // were not shown kept the profile alive.
  assert.equal(personasBlockingDelete({ personaDids: ["did:key:zA", 7] }), null);
});

test("an empty list is a real answer and is not null", () => {
  // The paired positive for the null tests. `[]` from the agent means it named
  // no blockers — a refusal that contradicts itself, which a pane should be
  // able to notice and say rather than have flattened into "we don't know".
  assert.deepEqual(personasBlockingDelete({ personaDids: [] }), []);
});

// ── The holder's own decisions travel, and absence is one of them ───────────
//
// `sensitivity` and `release` are OPTIONAL on the wire and their absence is
// load-bearing: it records that the holder decided nothing, so every consumer
// resolves from the claim-type registry. Sending a resolved value back would
// freeze the attribute to today's table — a later tightening would protect
// every new attribute and leave this one exposed — which is why these are
// spread conditionally rather than always named.

test("a decision the holder made is carried on the put", async () => {
  const r = recorder({ attributeId: "01J", version: 2, created: false, updatedAt: "x" });
  await personaAttributePut(r, {
    ...PARTIES,
    type: "profile.github",
    valueType: "string",
    value: "octocat",
    provenance: { kind: "selfAsserted" },
    sensitivity: "normal",
    release: "stepUp",
  });
  const { payload } = r.sent[0].envelope;
  assert.equal(payload.sensitivity, "normal");
  assert.equal(payload.release, "stepUp");
});

test("a decision the holder did not make is absent, not resolved", async () => {
  const r = recorder({ attributeId: "01J", version: 1, created: true, updatedAt: "x" });
  await personaAttributePut(r, {
    ...PARTIES,
    type: "phone.mobile",
    valueType: "string",
    value: "+65 8262 2325",
    provenance: { kind: "selfAsserted" },
  });
  const { payload } = r.sent[0].envelope;
  assert.ok(!("sensitivity" in payload), "omitted means the registry answers");
  assert.ok(!("release" in payload), "omitted means the registry answers");
});

test("a values listing can ask for the sensitive ones, and does not by default", async () => {
  // The half of sensitivity that is not cosmetic: without this member the agent
  // returns the metadata of every `sensitivity: high` attribute and the
  // plaintext of none.
  const r = recorder({ attributes: [] });
  await personaAttributeList(r, { ...PARTIES, includeValues: true, includeSensitive: true });
  assert.equal(r.sent[0].envelope.payload.includeSensitive, true);

  const plain = recorder({ attributes: [] });
  await personaAttributeList(plain, { ...PARTIES, includeValues: true });
  assert.ok(!("includeSensitive" in plain.sent[0].envelope.payload));
});
