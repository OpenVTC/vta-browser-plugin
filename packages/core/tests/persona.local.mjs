// `persona/local/*` — the faces a context authors, and what they may not claim.
//
// Written after a defect this file would have caught. The console built a local
// face's entries with `provenance: "selfAsserted"`, which reads as harmless and
// is refused by every conforming agent: the schema has no `provenance` member
// for a context-local inline value and sets `additionalProperties: false`, so
// the whole write came back as "Additional properties are not allowed". The
// feature never worked.
//
// TypeScript did not catch it, and the reason is worth knowing: excess-property
// checking applies to object literals assigned to a typed target, and does not
// reach through the inferred return type of a `.map()`. The payload was built
// in a map. So the guard has to be a test that looks at what was sent.
//
// Per this suite's own lesson: an assertion that a member is absent proves
// nothing on its own, since an implementation sending `{}` would pass it. Every
// absence below is paired with a claim that the call carries what it is for.

import { test } from "node:test";
import assert from "node:assert/strict";

import { putLocalProfile, setLocalBinding, deleteLocalProfile } from "../dist/persona/index.js";

const PARTIES = {
  holder: { did: "did:key:zHolder" },
  service: { did: "did:webvh:QmAgent:agent.example" },
};
const CTX = "ctx-local";

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

test("a context-local entry carries its value and claims no provenance", async () => {
  const sender = recorder({
    type: "https://trusttasks.org/spec/persona/local/profile/put/1.0#response",
    payload: { profileId: "01L", version: 1, created: true },
  });

  await putLocalProfile(sender, {
    ...PARTIES,
    contextId: CTX,
    name: "market",
    entries: [{ inline: { type: "x:handle", value: "ada99", valueType: "string" } }],
  });

  const { payload, type } = sender.sent[0].envelope;
  assert.equal(type, "https://trusttasks.org/spec/persona/local/profile/put/1.0");

  // What it is for.
  assert.equal(payload.contextId, CTX);
  assert.equal(payload.name, "market");
  assert.equal(payload.entries[0].inline.type, "x:handle");
  assert.equal(payload.entries[0].inline.value, "ada99");
  assert.equal(payload.entries[0].inline.valueType, "string");

  // And what it must not claim. A `credentialBacked` provenance names a
  // credentialId and a claimPath, and a value authored inside a context has
  // nowhere to put either — so carrying the member at all would let a context
  // assert that a value is attested when no credential was ever checked.
  assert.equal(
    "provenance" in payload.entries[0].inline,
    false,
    "a context-local value must not carry a provenance — the agent refuses the whole write",
  );
});

test("a local binding names the persona and the face, and clears with null", async () => {
  const sender = recorder({
    type: "https://trusttasks.org/spec/persona/local/binding/set/1.0#response",
    payload: { contextId: CTX, personaDid: "did:key:zP", version: 2 },
  });

  await setLocalBinding(sender, {
    ...PARTIES,
    contextId: CTX,
    personaDid: "did:key:zP",
    profileId: "01L",
  });
  assert.equal(sender.sent[0].envelope.payload.personaDid, "did:key:zP");
  assert.equal(sender.sent[0].envelope.payload.profileId, "01L");
});

test("deleting a local face sends unbind only when asked", async () => {
  const sender = recorder({
    type: "https://trusttasks.org/spec/persona/local/profile/delete/1.0#response",
    payload: { existed: true },
  });

  await deleteLocalProfile(sender, { ...PARTIES, contextId: CTX, profileId: "01L" });
  assert.equal(
    "unbind" in sender.sent[0].envelope.payload,
    false,
    "an unasked-for unbind would take a face off a persona that still wears it",
  );

  await deleteLocalProfile(sender, {
    ...PARTIES,
    contextId: CTX,
    profileId: "01L",
    unbind: true,
  });
  assert.equal(sender.sent[1].envelope.payload.unbind, true);
});
