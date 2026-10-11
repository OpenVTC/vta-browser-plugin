// Joining a community from a wallet (`vtc/join-requests/*` 0.3): which
// criterion a wallet can apply under, the submission it builds, and how it
// reads the community's verdict.
//
// Pinned: a criterion asking for a credential, an invitation or vetting is
// never applied under; an automatic one is preferred; the applicant is the
// document's issuer and the presentation's holder; `registryConsent` is always
// explicit; the verdict is read by `effect`.

import { test } from "node:test";
import assert from "node:assert/strict";

import {
  planJoin,
  unmetRequirements,
  buildJoinManifestRequest,
  buildJoinSubmit,
  checkJoinManifest,
  joinOutcomeOf,
  JOIN_MANIFEST_TYPE,
  JOIN_SUBMIT_TYPE,
} from "../dist/vtc/index.js";

const VTC = "did:webvh:QmVtc:members.example.org";
const ALICE = "did:webvh:QmAlice:dids.example.net:alice";

const invited = { id: "invited", admission: "automatic", invitationRequired: true, requirementsDigest: "zInvited" };
const credential = {
  id: "member-credential",
  admission: "automatic",
  description: "Hold a member credential",
  presentationDefinition: { credentials: [] },
  credentialIssuers: "community",
  requirementsDigest: "zCredential",
};
const vetted = { id: "vetted", admission: "automatic", vetting: { version: "0.1" }, requirementsDigest: "zVetted" };
const review = { id: "review", admission: "review", requirementsDigest: "zReview" };
const open = { id: "open", admission: "automatic", requirementsDigest: "zOpen" };

test("a criterion's unmet requirements, as a wallet sees them", () => {
  assert.deepEqual(unmetRequirements(invited), ["an invitation from the community"]);
  assert.deepEqual(unmetRequirements(credential), ["a credential"]);
  assert.deepEqual(unmetRequirements(vetted), ["identity vetting by its vetters"]);
  assert.deepEqual(unmetRequirements(review), []);
});

test("the VTC's default criteria: applied under review", () => {
  const plan = planJoin({ communityDid: VTC, criteria: [invited, credential, review] });
  assert.deepEqual(plan, { ok: true, criterion: "zReview", admission: "review", requestedAttributes: [] });
});

test("an automatic criterion that asks for nothing is preferred over review", () => {
  const plan = planJoin({ communityDid: VTC, criteria: [review, open], branding: { displayName: " Example " } });
  assert.equal(plan.ok && plan.criterion, "zOpen");
  assert.equal(plan.ok && plan.admission, "automatic");
  assert.equal(plan.displayName, "Example");
});

test("nothing a wallet can apply under: what the criteria ask, in the community's words where given", () => {
  assert.deepEqual(planJoin({ communityDid: VTC, criteria: [invited, credential, vetted] }), {
    ok: false,
    reason: "needs-more",
    needs: ["an invitation from the community", "Hold a member credential", "identity vetting by its vetters"],
  });
  assert.deepEqual(planJoin({ communityDid: VTC, criteria: [] }), { ok: false, reason: "not-accepting", needs: [] });
});

test("requested attributes: required read strictly, malformed types dropped", () => {
  const plan = planJoin({
    communityDid: VTC,
    criteria: [review],
    requestedAttributes: [
      { type: "name.display", required: true, purpose: " So we know you " },
      { type: "address.country" },
      { type: "Not A Type", required: true },
    ],
  });
  assert.deepEqual(plan.ok && plan.requestedAttributes, [
    { type: "name.display", required: true, purpose: "So we know you" },
    { type: "address.country", required: false },
  ]);
});

test("the manifest request carries nothing; its reply must be this community's", () => {
  const doc = buildJoinManifestRequest("did:key:z6MkX", VTC);
  assert.equal(doc.type, JOIN_MANIFEST_TYPE);
  assert.equal(JOIN_MANIFEST_TYPE, "https://trusttasks.org/spec/vtc/join-requests/manifest/0.3");
  assert.deepEqual(doc.payload, {});
  assert.equal(doc.recipient, VTC);
  assert.throws(() => checkJoinManifest({ communityDid: "did:web:other.example", criteria: [] }, VTC), /a different community/);
  assert.throws(() => checkJoinManifest({ communityDid: VTC }, VTC), /no criteria/);
});

test("the submission: the applicant is issuer and holder, consent explicit, attributes as given", () => {
  const doc = buildJoinSubmit(ALICE, VTC, { criterion: "zReview", attributes: [{ type: "name.display", value: "Ada" }], registryConsent: false });
  assert.equal(doc.type, JOIN_SUBMIT_TYPE);
  assert.equal(JOIN_SUBMIT_TYPE, "https://trusttasks.org/spec/vtc/join-requests/submit/0.3");
  assert.equal(doc.issuer, ALICE);
  assert.equal(doc.proof, undefined, "the applicant's agent signs it");
  assert.deepEqual(doc.payload, {
    vp: { "@context": ["https://www.w3.org/ns/credentials/v2"], type: ["VerifiablePresentation"], holder: ALICE },
    criterion: "zReview",
    registryConsent: false,
    attributes: [{ type: "name.display", value: "Ada" }],
  });
  const none = buildJoinSubmit(ALICE, VTC, { criterion: "zOpen", attributes: [], registryConsent: true });
  assert.equal("attributes" in none.payload, false);
  assert.equal(none.payload.registryConsent, true);
});

test("the verdict is read by effect", () => {
  assert.deepEqual(joinOutcomeOf({ requestId: "r", verdict: { effect: "allow", with: { role: "member", vmc: {} } } }), { kind: "admitted", requestId: "r", role: "member" });
  assert.deepEqual(joinOutcomeOf({ requestId: "r", verdict: { effect: "refer", with: { queue: "admin-review" } } }), { kind: "pending", requestId: "r" });
  assert.deepEqual(joinOutcomeOf({ requestId: "r", verdict: { effect: "requestMore", with: { needs: ["criterion"] } } }), { kind: "pending", requestId: "r", needs: ["criterion"] });
  assert.deepEqual(joinOutcomeOf({ requestId: "r", verdict: { effect: "deny", with: { code: "policy", reason: "No" } } }), { kind: "declined", requestId: "r", code: "policy", reason: "No" });
  assert.throws(() => joinOutcomeOf({ requestId: "r", verdict: { effect: "maybe", with: {} } }), /does not know/);
  assert.throws(() => joinOutcomeOf({ verdict: { effect: "allow", with: {} } }), /no verdict/);
});
