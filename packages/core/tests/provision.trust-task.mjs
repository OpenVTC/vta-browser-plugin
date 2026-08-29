// Provisioning is an ordinary Trust Task, and its one specification-declared
// refusal survives as structured data.
//
// Both halves used to be true only of the bespoke DIDComm path: the envelope was
// hand-packed in send.ts, and `contextRequired` arrived as a problem-report with
// its own error class. What is pinned below is the pair of properties that made
// the migration worth doing — the document is addressed the way every other VTA
// operation's is, and the wallet's context picker still gets a list rather than
// a sentence to parse.

import { test } from "node:test";
import assert from "node:assert/strict";

import { sendProvisionIntegration, provisionRefusalOf } from "../dist/provision/index.js";
import { VtaClientError } from "../dist/vta/index.js";

const EPHEMERAL = "did:key:z6MkephemeralExampleExampleExampleExampleExample";
const VTA = "did:webvh:QmExample:example.test:agent";
const TASK = "https://trusttasks.org/spec/provision/integration/0.3";

/** Captures the envelope instead of sending it. */
function captor(reply = { bundle: "-----BEGIN VTA SEALED BUNDLE-----", summary: {} }) {
  const sent = [];
  return {
    sent,
    async send(envelope, opts) {
      sent.push({ envelope, opts });
      return reply;
    },
  };
}

test("the request goes out as a Trust Task addressed from the ephemeral to the VTA", async () => {
  const sender = captor();
  await sendProvisionIntegration({
    sender,
    ephemeralDid: EPHEMERAL,
    vtaDid: VTA,
    body: { request: { proof: {} }, createContext: true },
  });

  assert.equal(sender.sent.length, 1);
  const { envelope, opts } = sender.sent[0];
  assert.equal(envelope.type, TASK);
  // The ephemeral issues: the operator granted *it*, and the VTA authenticates
  // the sender against that grant identically on all three transports.
  assert.equal(envelope.issuer, EPHEMERAL);
  assert.equal(envelope.recipient, VTA);
  // A reply under any other type is a protocol error rather than something to
  // guess at — this is the check that caught VTI #1202.
  assert.equal(opts.expectedResponseType, `${TASK}#response`);
});

test("the option fields go out lowerCamelCase, and the signed VP is untouched", async () => {
  const sender = captor();
  // A stand-in for the signed BootstrapRequest: snake_case members that must
  // survive verbatim, because the holder's proof covers these exact bytes.
  const vp = { proof: { proofValue: "z…" }, credential_subject: { admin_template: "vta-admin" } };
  await sendProvisionIntegration({
    sender,
    ephemeralDid: EPHEMERAL,
    vtaDid: VTA,
    body: { request: vp, context: "acme", createContext: true },
  });

  const { payload } = sender.sent[0].envelope;
  assert.equal(payload.createContext, true, "the 0.2+ canonical spelling");
  assert.ok(!("create_context" in payload), "the legacy 0.1 spelling must not be sent");
  assert.equal(payload.context, "acme");
  assert.deepEqual(payload.request, vp, "the signed VP is relayed byte-for-byte");
});

test("contextRequired comes back as a code and a list, not a sentence", () => {
  // The shape a Trust-Task error document carries: `details` on the client
  // error is the framework payload verbatim.
  const e = new VtaClientError("e.p.msg.task_failed", "cannot infer the context", {
    details: {
      code: "provision/integration:contextRequired",
      message: "several contexts are plausible",
      details: { candidates: ["acme", "globex"] },
    },
  });

  const refusal = provisionRefusalOf(e);
  assert.ok(refusal);
  assert.equal(refusal.code, "provision/integration:contextRequired");
  assert.equal(refusal.message, "several contexts are plausible");
  assert.deepEqual(refusal.candidates, ["acme", "globex"]);
});

test("a refusal with no candidates is still a refusal", () => {
  const e = new VtaClientError("e.p.msg.task_failed", "nope", {
    details: { code: "provision/integration:someOtherCode", message: "nope" },
  });
  const refusal = provisionRefusalOf(e);
  assert.ok(refusal);
  assert.deepEqual(refusal.candidates, []);
});

test("an error that is not a VTA client error yields nothing to branch on", () => {
  assert.equal(provisionRefusalOf(new Error("socket closed")), undefined);
  assert.equal(provisionRefusalOf(undefined), undefined);
  // A client error with no framework payload behind it: there is no code to
  // report, and inventing one would be worse than saying so.
  assert.equal(provisionRefusalOf(new VtaClientError("e.p.msg.network", "timed out")), undefined);
});
