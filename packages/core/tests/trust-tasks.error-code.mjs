// Extended error codes across the SPEC §4.10 re-casing — see
// src/trust-tasks/error-code.ts.
//
// The property under test is not "the helper does string manipulation". It is
// **deploy-order safety**: this wallet ships into browsers on the Web Store's
// schedule and the VTA ships on its own, so the fleet is permanently split
// across trustoverip/dtgwg-trust-tasks-tf#279 and every code match has to work
// against both halves at once. That property is what lets the service-side
// rename be deployed without a coordinated wallet release, and it is worth
// pinning here rather than trusting a comment, because breaking it is silent —
// an equality that goes false takes no branch and raises no error. The
// symptom is a UI affordance that simply stops appearing.

import { test } from "node:test";
import assert from "node:assert/strict";

import {
  matchesTrustTaskCode,
  trustTaskCodeSnakeCase,
} from "../dist/trust-tasks/error-code.js";
import { PROVISION_CONTEXT_REQUIRED } from "../dist/provision/send.js";

/** The registry's current (post-#279) spelling of every code this repo matches
 *  or documents, paired with the pre-#279 spelling the same agent used to send.
 *  Verified against trustoverip/dtgwg-trust-tasks-tf@main `specs/`. */
const RENAMED = [
  ["provision/integration:contextRequired", "provision/integration:context_required"],
  ["vault/delete:versionConflict", "vault/delete:version_conflict"],
  ["vault/sign-trust-task:notSignable", "vault/sign-trust-task:not_signable"],
  ["vault/upsert:sealedSecretInvalid", "vault/upsert:sealed_secret_invalid"],
];

test("both spellings match — neither half of the fleet is left out", () => {
  for (const [camel, snake] of RENAMED) {
    assert.equal(matchesTrustTaskCode(camel, camel), true, `new: ${camel}`);
    assert.equal(matchesTrustTaskCode(snake, camel), true, `old: ${snake}`);
  }
});

test("the snake_case form is derived, not hand-maintained", () => {
  // If this drifts, the fold silently stops covering the old spelling — which
  // looks exactly like the fold not being there at all.
  for (const [camel, snake] of RENAMED) {
    assert.equal(trustTaskCodeSnakeCase(camel), snake, camel);
  }
});

test("only the local part is re-cased; the namespace is untouched", () => {
  // #279 changed nothing before the `:`. A helper that re-cased the whole
  // string would mangle namespaces like `vault/sign-trust-task` — and because
  // they are already lowercase it would do so only for a future namespace that
  // is not, which is the worst kind of latent bug.
  assert.equal(
    trustTaskCodeSnakeCase("did-management/agent-name/set:nameTaken"),
    "did-management/agent-name/set:name_taken",
  );
  assert.equal(trustTaskCodeSnakeCase("auth/refresh:tokenExpired"), "auth/refresh:token_expired");
});

test("a different code in the same namespace does not match", () => {
  // The fold is for one rename, not a general fuzzy compare. Two codes that
  // differ by more than casing are two different codes, and matching them would
  // turn a rename into a collision — surfacing the wrong recovery UX for a
  // rejection that means something else.
  assert.equal(
    matchesTrustTaskCode("provision/integration:contextNotFound", PROVISION_CONTEXT_REQUIRED),
    false,
  );
  assert.equal(
    matchesTrustTaskCode("provision/integration:context_not_found", PROVISION_CONTEXT_REQUIRED),
    false,
  );
});

test("the namespace is part of the identity", () => {
  // `vault/upsert:versionConflict` and `vault/delete:versionConflict` are both
  // real registry codes with the same local part.
  assert.equal(
    matchesTrustTaskCode("vault/upsert:version_conflict", "vault/delete:versionConflict"),
    false,
  );
});

test("a missing or empty code is not a match", () => {
  // `code` is optional on the runtime response: a transport failure carries no
  // problem-report at all. Absent must not be mistaken for the one code we act
  // on, or a network blip would open the context picker.
  for (const absent of [undefined, null, ""]) {
    assert.equal(matchesTrustTaskCode(absent, PROVISION_CONTEXT_REQUIRED), false, String(absent));
  }
});

test("the constant the wallet matches on is the registry's current spelling", () => {
  // Call sites read as the code the registry declares today; the compatibility
  // lives in the helper. That is what makes dropping the fold one edit rather
  // than a sweep, when the supported-agent floor eventually allows it.
  assert.equal(PROVISION_CONTEXT_REQUIRED, "provision/integration:contextRequired");
  assert.match(PROVISION_CONTEXT_REQUIRED.split(":")[1], /^[a-z][a-zA-Z0-9]*$/);
});
