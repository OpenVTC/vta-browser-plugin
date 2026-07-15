import { test } from "node:test";
import assert from "node:assert/strict";

import { requestTask, ORIGIN_EXT_KEY } from "../dist/vta/request-task.js";
import { VtaSession } from "../dist/vta/session.js";
import { parseTrustTaskReply } from "../dist/vta/trust-task.js";

/**
 * A session that records the envelope it was handed.
 *
 * NOTE: `reply` is what the *channel* returns, i.e. the already-parsed payload.
 * For anything to do with rejections, use `rejecting()` below — a fake session
 * that simply RESOLVES with an error object proves nothing, because the real
 * stack throws long before the value would reach us. An earlier version of this
 * file made exactly that mistake and the resulting test passed against code that
 * could not work.
 */
function capturing(reply = { ok: true }) {
  const sent = [];
  return {
    sent,
    session: {
      async send(envelope) {
        sent.push(envelope);
        return reply;
      },
    },
  };
}

/**
 * A REAL session over a channel that returns a `trust-task-error` document —
 * exactly what the executor sends when a task needs human approval.
 *
 * This exercises `parseTrustTaskReply`, which THROWS on an error document. That
 * throw is the whole point of the test: the refusal has to survive it.
 */
function rejecting(errorPayload) {
  const channel = {
    kind: "test",
    async send(envelope) {
      // What a channel does with the reply document, everywhere in this codebase.
      return parseTrustTaskReply(
        {
          id: "urn:uuid:reply",
          type: "https://trusttasks.org/spec/trust-task-error/0.1",
          payload: errorPayload,
        },
        { operationLabel: envelope.type },
      );
    },
  };
  return new VtaSession([channel]);
}

// The REAL wire shape the VTA emits for a consent-gated task: the standard
// Trust Task error code `taskFailed` (see trust-tasks-rs `RejectReason::TaskFailed`
// -> `ErrorPayload`), with the machine-readable reason and payload in `details`.
// The reason is NOT the top-level code, and it is NOT only in `message`.
const CONSENT_REJECT = {
  code: "taskFailed",
  retryable: false,
  message: "task failed: auth:consent_required",
  details: {
    reason: "auth:consent_required",
    payloadDigest: "3b0c7f1d9e2a5648c1f30b7ae4d2986153ca0f7b8d41e6295af03c8bd71e4a62",
    challenge: "9c1f4b7a2e6d80f35a4c9b1e7d2f6083",
    approverSet: "operators",
    minApprovals: 1,
    consentRequests: [{ type: "…/task-consent/request/0.1", proof: {} }],
  },
};

const base = {
  type: "https://trusttasks.org/spec/webvh/dids/update/1.0",
  payload: { did: "did:webvh:example.com:acme", document: { id: "did:webvh:example.com:acme" } },
  holderDid: "did:key:zHolder",
  vtaDid: "did:key:zVta",
  origin: "https://control.example.com",
};

test("the device mints the envelope — the page supplies only type and payload", async () => {
  const { sent, session } = capturing();
  await requestTask(session, base);

  const [env] = sent;
  // Every field that carries authority is written here, not by the page. A relay
  // that let the RP choose the issuer or the recipient would be notarising a
  // document it never checked.
  assert.equal(env.issuer, "did:key:zHolder");
  assert.equal(env.recipient, "did:key:zVta");
  assert.equal(env.type, base.type);
  assert.ok(env.id, "the device mints the id");
  assert.ok(env.issuedAt, "the device mints the timestamp");
});

test("an envelope the page tried to author is not honoured — there is nowhere to put one", async () => {
  const { sent, session } = capturing();
  // The page can only reach `payload`. Anything it puts there that looks like an
  // envelope field stays in the payload, where the VTA's closed schema rejects
  // it — it does not become the envelope.
  await requestTask(session, {
    ...base,
    payload: { ...base.payload, issuer: "did:key:zAttacker", recipient: "did:key:zAttacker" },
  });

  const [env] = sent;
  assert.equal(env.issuer, "did:key:zHolder");
  assert.equal(env.recipient, "did:key:zVta");
  assert.equal(env.payload.issuer, "did:key:zAttacker", "it stays in the payload");
});

test("the origin is stamped by the device, inside the payload", async () => {
  const { sent, session } = capturing();
  await requestTask(session, base);
  assert.equal(sent[0].payload.ext[ORIGIN_EXT_KEY], "https://control.example.com");
});

test("a page cannot forge the origin — the device's stamp wins", async () => {
  const { sent, session } = capturing();
  await requestTask(session, {
    ...base,
    payload: { ...base.payload, ext: { [ORIGIN_EXT_KEY]: "https://bank.example" } },
  });
  assert.equal(
    sent[0].payload.ext[ORIGIN_EXT_KEY],
    "https://control.example.com",
    "the browser-attested origin overwrites whatever the page claimed",
  );
});

test("other ext members the page set are preserved", async () => {
  const { sent, session } = capturing();
  await requestTask(session, {
    ...base,
    payload: { ...base.payload, ext: { "vendor.hint": "x" } },
  });
  assert.equal(sent[0].payload.ext["vendor.hint"], "x");
  assert.equal(sent[0].payload.ext[ORIGIN_EXT_KEY], "https://control.example.com");
});

test("no origin means no stamp — never an invented one", async () => {
  const { sent, session } = capturing();
  const { origin: _drop, ...noOrigin } = base;
  await requestTask(session, noOrigin);
  assert.equal(sent[0].payload.ext, undefined);
});

test("the caller's payload object is not mutated", async () => {
  const { session } = capturing();
  const payload = { did: "did:webvh:x" };
  await requestTask(session, { ...base, payload });
  assert.deepEqual(payload, { did: "did:webvh:x" }, "no ext leaked back into the caller's object");
});

test("an accepted task comes back as an accepted outcome", async () => {
  const { session } = capturing({ ok: true, versionId: "4-Qm" });
  const res = await requestTask(session, base);
  assert.equal(res.kind, "accepted");
  assert.deepEqual(res.result, { ok: true, versionId: "4-Qm" });
});

test("a consent refusal SURVIVES the transport's throw and comes back as a result", async () => {
  // The regression that matters.
  //
  // The executor rejects with a trust-task-error document, and every channel in
  // this codebase runs that through `parseTrustTaskReply`, which THROWS. Left
  // alone, the throw propagates: the extension flattens it to a message string,
  // the page sees `Error: consent_required`, and the digest the user was supposed
  // to match — along with the signed consent requests their approver needs to
  // render — is gone. The informed-consent flow dies at the last hop, silently.
  //
  // Note this drives a REAL VtaSession over a REAL channel. A fake session that
  // merely resolved with the error object would pass while the shipped code was
  // broken, which is precisely what happened the first time.
  const res = await requestTask(rejecting(CONSENT_REJECT), base);

  assert.equal(res.kind, "consentRequired");
  assert.equal(
    res.payloadDigest,
    "3b0c7f1d9e2a5648c1f30b7ae4d2986153ca0f7b8d41e6295af03c8bd71e4a62",
  );
  assert.equal(res.challenge, "9c1f4b7a2e6d80f35a4c9b1e7d2f6083");
  assert.equal(res.approverSet, "operators");
  assert.equal(res.minApprovals, 1);
  assert.equal(res.consentRequests.length, 1, "the approver's signed request must survive");
});

test("consent is recognised by the machine-readable reason in the error details, not the top-level code", async () => {
  // The regression this replaces. The VTA emits the STANDARD `taskFailed` code
  // (per the Trust Task error spec) and carries `auth:consent_required` as a
  // structured `reason` inside `details`. An earlier version matched that token
  // against the top-level `code`, which the VTA never sets — so every
  // consent-gated task surfaced as a generic error and the approval UI never
  // opened. `CONSENT_REJECT` is now that real shape; it must be recognised.
  const res = await requestTask(rejecting(CONSENT_REJECT), base);
  assert.equal(res.kind, "consentRequired");
  assert.equal(res.consentRequests.length, 1);
});

test("consent is recognised before the VTA emits an explicit reason — by the signed consentRequests", async () => {
  // Rollout-order safety: a VTA build that has not yet added `details.reason`
  // still delivers the executor-signed `consentRequests`. Their presence is the
  // structural fallback that keeps the flow working during a staged rollout.
  const noReason = {
    code: "taskFailed",
    retryable: false,
    message: "task failed: auth:consent_required",
    details: {
      payloadDigest: "3b0c7f1d9e2a5648c1f30b7ae4d2986153ca0f7b8d41e6295af03c8bd71e4a62",
      challenge: "9c1f4b7a2e6d80f35a4c9b1e7d2f6083",
      approverSet: "operators",
      minApprovals: 1,
      consentRequests: [{ type: "…/task-consent/request/0.1", proof: {} }],
    },
  };
  const res = await requestTask(rejecting(noReason), base);
  assert.equal(res.kind, "consentRequired");
});

test("an ordinary taskFailed with no consent details still throws", async () => {
  // `taskFailed` is a generic failure code; without a consent reason OR signed
  // consentRequests it is not a consent refusal and must surface as the error.
  await assert.rejects(() =>
    requestTask(
      rejecting({ code: "taskFailed", retryable: false, message: "task failed: something else", details: {} }),
      base,
    ),
  );
});

test("any other rejection still throws — we only special-case consent", async () => {
  await assert.rejects(() =>
    requestTask(rejecting({ code: "permissionDenied", retryable: false }), base),
  );
});
