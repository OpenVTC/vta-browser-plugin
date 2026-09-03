// What crosses the bridge when the console runs an admin task, and what must
// not.
//
// The console composes admin tasks with the `@openvtc/pnm-core/admin` helpers,
// which build a canonical envelope and hand it to `sender.send`. That envelope
// is a **carrier**: only its `type` and `payload` may travel. The device mints
// the real one — id, issuedAt, issuer, recipient — inside the wallet's trust
// boundary, and the channel signs it.
//
// If the carrier's parties ever reach the wire, the wallet is signing a
// document composed somewhere else and attesting to fields it never checked.
// That the composer is an extension page rather than a web page does not change
// what the signature would be claiming — which is why this is pinned here,
// rather than left resting on the fact that today's background handler happens
// to ignore them.

import { test } from "node:test";
import assert from "node:assert/strict";
import {
  ConsentRequiredError,
  carrierParams,
  interpretOutcome,
} from "../src/manager/carrier.ts";

/** A carrier with every authority-bearing field populated, and deliberately
 *  populated *wrongly* — if any of it survives, the assertions say which. */
const carrier = {
  id: "urn:uuid:carrier-chosen-id",
  type: "https://trusttasks.org/spec/acl/grant/0.1",
  issuer: "did:key:zATTACKER",
  recipient: "did:key:zSOMEONE-ELSES-AGENT",
  issuedAt: "1999-01-01T00:00:00Z",
  expiresAt: "2999-01-01T00:00:00Z",
  threadId: "urn:uuid:carrier-chosen-thread",
  payload: { entry: { subject: "did:key:zSUBJECT", role: "admin" } },
};

test("keeps the task type and payload", () => {
  assert.deepEqual(carrierParams(carrier), {
    type: carrier.type,
    payload: carrier.payload,
  });
});

test("drops every authority-bearing field", () => {
  const wire = JSON.stringify(carrierParams(carrier));
  for (const forged of [
    carrier.id,
    carrier.issuer,
    carrier.recipient,
    carrier.issuedAt,
    carrier.expiresAt,
    carrier.threadId,
  ]) {
    assert.ok(
      !wire.includes(forged),
      `the carrier's "${forged}" survived. Only type and payload may travel — the device ` +
        "mints the envelope, and a wallet that signs a document composed elsewhere " +
        "attests to fields it never checked.",
    );
  }
  // Stated positively too, so a future member added to `TrustTask` is caught by
  // shape rather than by having been listed above.
  assert.deepEqual(Object.keys(carrierParams(carrier)).sort(), ["payload", "type"]);
});

test("an absent payload becomes an empty object, not undefined", () => {
  // `auth/whoami` and friends legitimately send `{}`. Relaying `undefined`
  // reaches the agent as a missing member and fails schema validation for no
  // visible reason.
  assert.deepEqual(carrierParams({ ...carrier, payload: undefined }).payload, {});
});

test("an accepted outcome yields the agent's result, unwrapped", () => {
  const res = interpretOutcome<{ entries: number[] }>("t", "acl/list/0.1", {
    ok: true,
    result: { kind: "accepted", result: { entries: [1, 2, 3] } },
  });
  assert.deepEqual(res, { entries: [1, 2, 3] });
});

test("a consent refusal throws ConsentRequiredError with the digest intact", () => {
  const err = (() => {
    try {
      interpretOutcome(carrier.type, "acl/grant/0.1", {
        ok: true,
        result: {
          kind: "consentRequired",
          payloadDigest: "abcdef0123456789",
          challenge: "chal",
          approverSet: "set-1",
          minApprovals: 2,
          consentRequests: [{ one: 1 }],
        },
      });
      return null;
    } catch (e) {
      return e;
    }
  })();

  assert.ok(
    err instanceof ConsentRequiredError,
    "a consent refusal must be its own class — caught as a plain Error it renders as a red " +
      "string, discarding the ceremony at the moment the human was meant to act",
  );
  assert.equal(err.payloadDigest, "abcdef0123456789");
  assert.equal(err.minApprovals, 2);
  assert.equal(err.taskType, carrier.type);
  assert.deepEqual(err.consentRequests, [{ one: 1 }]);
});

test("a consent refusal missing its digest still throws the ceremony class", () => {
  // Degraded, not reclassified: the operator sees an empty match code and can
  // tell something is wrong, rather than the refusal arriving as a red error
  // that offers them nothing to do.
  const err = (() => {
    try {
      interpretOutcome("t", "l", { ok: true, result: { kind: "consentRequired" } });
      return null;
    } catch (e) {
      return e;
    }
  })();
  assert.ok(err instanceof ConsentRequiredError);
  assert.equal(err.payloadDigest, "");
  assert.equal(err.minApprovals, 1, "a missing count must not read as zero approvals needed");
});

test("a failed relay throws, naming the operation", () => {
  assert.throws(
    () => interpretOutcome("t", "acl/grant/0.1", { ok: false, error: "no active connection" }),
    /acl\/grant\/0\.1 failed: no active connection/,
  );
});

test("an unrecognised outcome is reported, not returned as a result", () => {
  // A relay that changed shape underneath this file. Returning it would hand a
  // pane an object whose members all read undefined, which renders as a
  // convincing empty result.
  assert.throws(
    () => interpretOutcome("t", "l", { ok: true, result: { kind: "somethingNew" } }),
    /outcome this console does not understand/,
  );
});

test("a reply with no result at all is reported rather than unwrapped", () => {
  assert.throws(() => interpretOutcome("t", "l", { ok: true }), /does not understand/);
});
