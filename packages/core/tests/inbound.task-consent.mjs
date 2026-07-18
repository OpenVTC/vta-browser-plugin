import { test } from "node:test";
import assert from "node:assert/strict";

import { generateSigningIdentity } from "../dist/siop/self-issued.js";
import {
  parseTaskConsentRequest,
  parseTaskConsentGranted,
  describeEffects,
  buildTaskConsentDecisionDocument,
  TASK_CONSENT_REQUEST_TYPE,
  TASK_CONSENT_DECISION_TYPE,
  TASK_CONSENT_GRANTED_TYPE,
} from "../dist/inbound/task-consent.js";
import { signTrustTask } from "../dist/trust-tasks/sign.js";
import { TRUST_TASK_ENVELOPE_TYPE } from "../dist/vta/protocol.js";

// Real did:key identities — the wallet's own minting helper, so the DID, the
// verification method and the key actually agree with what the verifier resolves.
const VTA = generateSigningIdentity();
const IMPOSTOR = generateSigningIdentity();
const DEVICE = generateSigningIdentity();
const HOLDER = DEVICE.did;

function payload(over = {}) {
  return {
    challenge: "9c1f4b7a2e6d80f35a4c9b1e7d2f6083",
    taskType: "https://trusttasks.org/spec/webvh/dids/update/1.0",
    payloadDigest: "3b0c7f1d9e2a5648c1f30b7ae4d2986153ca0f7b8d41e6295af03c8bd71e4a62",
    sideEffects: "mutating",
    exposure: { discloses: "none", actsAsSubject: false },
    effects: [
      { kind: "documentChange", summary: "Adds a FileStore service endpoint at #files." },
      {
        kind: "keyRotation",
        summary: "Rotates this DID's update key — the current one stops working.",
      },
    ],
    requester: "did:key:zRequesterBrowser",
    approverSet: "operators",
    minApprovals: 1,
    excludeRequester: true,
    expiresAt: new Date(Date.now() + 600_000).toISOString(),
    subject: "did:webvh:example.com:acme",
    ...over,
  };
}

/** A signed, correctly-addressed inbound request from `as` (default: the VTA). */
async function inbound({ as = VTA, over = {}, drop = [], recipient = HOLDER, unsigned = false } = {}) {
  const p = payload(over);
  for (const k of drop) delete p[k];
  const doc = {
    id: "urn:uuid:00000000-0000-0000-0000-000000000001",
    type: TASK_CONSENT_REQUEST_TYPE,
    issuer: as.did,
    recipient,
    issuedAt: new Date().toISOString(),
    payload: p,
  };
  if (!unsigned) {
    await signTrustTask({ envelope: doc, signing: as });
  }
  return { id: doc.id, type: TRUST_TASK_ENVELOPE_TYPE, from: as.did, body: doc };
}

const opts = { expectedVtaDid: VTA.did, holderDid: HOLDER };

test("a request signed by this device's VTA is accepted", async () => {
  const res = await parseTaskConsentRequest(await inbound(), opts);
  assert.equal(res.ok, true);
  assert.equal(res.parsed.vtaDid, VTA.did);
  assert.equal(res.parsed.request.taskType, "https://trusttasks.org/spec/webvh/dids/update/1.0");
});

test("an unsigned request never reaches a human", async () => {
  // The transport authenticates the hop, not the content. Without the proof,
  // anything that can reach this device could author the effects the user reads.
  const res = await parseTaskConsentRequest(await inbound({ unsigned: true }), opts);
  assert.equal(res.ok, false);
  assert.equal(res.reason, "untrusted_issuer");
});

test("a request signed by someone other than this device's VTA is refused", async () => {
  const res = await parseTaskConsentRequest(await inbound({ as: IMPOSTOR }), opts);
  assert.equal(res.ok, false);
  assert.equal(res.reason, "untrusted_issuer");
  assert.match(res.detail, /not this device's VTA/);
});

test("a tampered request is refused — the effects are inside the signature", async () => {
  const msg = await inbound();
  // Rewrite the one thing a human actually reads.
  msg.body.payload.effects[1].summary = "Nothing else happens.";
  const res = await parseTaskConsentRequest(msg, opts);
  assert.equal(res.ok, false);
  assert.equal(res.reason, "untrusted_issuer");
});

test("a request addressed to another device is refused", async () => {
  // Otherwise a request routed to one approver, replayed at another, would be
  // indistinguishable — and approving it casts a vote the VTA attributes to us.
  const res = await parseTaskConsentRequest(
    await inbound({ recipient: "did:key:zSomeOtherDevice" }),
    opts,
  );
  assert.equal(res.ok, false);
  assert.equal(res.reason, "untrusted_issuer");
  assert.match(res.detail, /another device/);
});

test("a lapsed request is refused rather than shown", async () => {
  const res = await parseTaskConsentRequest(
    await inbound({ over: { expiresAt: new Date(Date.now() - 1000).toISOString() } }),
    opts,
  );
  assert.equal(res.ok, false);
  assert.equal(res.reason, "expired");
});

test("this device refuses to approve a task it proposed, when policy excludes the requester", async () => {
  // The point of excludeRequester is that one compromised device must not both
  // propose and approve. A device on both ends declines rather than asking its
  // user a question whose answer the VTA would discard.
  const res = await parseTaskConsentRequest(
    await inbound({ over: { requester: HOLDER, excludeRequester: true } }),
    opts,
  );
  assert.equal(res.ok, false);
  assert.equal(res.reason, "not_eligible");
});

test("…but may approve its own task when policy permits it", async () => {
  const res = await parseTaskConsentRequest(
    await inbound({ over: { requester: HOLDER, excludeRequester: false } }),
    opts,
  );
  assert.equal(res.ok, true);
});

test("a payload missing required members is refused", async () => {
  // A genuinely-signed request that is nonetheless unusable: without the digest
  // there is nothing to bind an approval to, so there is nothing to approve.
  const res = await parseTaskConsentRequest(await inbound({ drop: ["payloadDigest"] }), opts);
  assert.equal(res.ok, false);
  assert.equal(res.reason, "not-a-task-consent-request");
});

// ── What the human is shown ──────────────────────────────────────────────────

test("effects are rendered from the VTA's own summaries", () => {
  const { lines, determined } = describeEffects(payload());
  assert.equal(determined, true);
  assert.equal(lines.length, 2);
  assert.match(lines[1], /Rotates this DID's update key/);
});

test("an unrecognised effect kind is still rendered — never silently dropped", () => {
  // Handlers evolve faster than this client. A surface that dropped a kind it did
  // not recognise would misinform the human exactly where the design is weakest.
  const { lines } = describeEffects(
    payload({ effects: [{ kind: "somethingThisBuildHasNeverHeardOf", summary: "Burns the barn." }] }),
  );
  assert.deepEqual(lines, ["Burns the barn."]);
});

test("no effects and no consequences reads as UNKNOWN, not as harmless", () => {
  // The case worth being careful about. "No effects" and "effects unknown" render
  // identically if you let them, and the difference is the whole decision: one
  // means the task is inert, the other means nobody can tell you what it does.
  const { lines, determined } = describeEffects(payload({ effects: [] }));
  assert.equal(determined, false);
  assert.match(lines[0], /could not determine/i);
});

test("static consequences are the fallback when the VTA has no dry-run", () => {
  const { lines, determined } = describeEffects(
    payload({ effects: [], consequences: ["Any document change rotates the update keys."] }),
  );
  assert.equal(determined, true);
  assert.deepEqual(lines, ["Any document change rotates the update keys."]);
});

// ── The decision ─────────────────────────────────────────────────────────────

test("the decision echoes the challenge and digest verbatim, and is signed", async () => {
  const doc = await buildTaskConsentDecisionDocument({
    signing: DEVICE,
    vta: { did: VTA.did },
    decision: "approve",
    challenge: "9c1f4b7a2e6d80f35a4c9b1e7d2f6083",
    payloadDigest: "3b0c7f1d9e2a5648c1f30b7ae4d2986153ca0f7b8d41e6295af03c8bd71e4a62",
  });

  assert.equal(doc.type, TASK_CONSENT_DECISION_TYPE);
  assert.equal(doc.recipient, VTA.did);
  assert.equal(doc.payload.challenge, "9c1f4b7a2e6d80f35a4c9b1e7d2f6083");
  assert.equal(
    doc.payload.payloadDigest,
    "3b0c7f1d9e2a5648c1f30b7ae4d2986153ca0f7b8d41e6295af03c8bd71e4a62",
  );
  // The proof IS the authorization — the VTA takes the approver's identity from
  // it, not from the session that carried it.
  assert.ok(doc.proof, "an unsigned decision authorizes nothing");
});

test("a denial is an explicit decision, not an absent one", async () => {
  const doc = await buildTaskConsentDecisionDocument({
    signing: DEVICE,
    vta: { did: VTA.did },
    decision: "deny",
    challenge: "9c1f4b7a2e6d80f35a4c9b1e7d2f6083",
    payloadDigest: "3b0c",
  });
  // The wire form is an enum precisely so a missing or falsy value can never read
  // as assent: silence, timeouts and dismissals are denials.
  assert.equal(doc.payload.decision, "deny");
});

// ── task-consent/granted (the pub/sub nudge) ──────────────────────────────

test("parseTaskConsentGranted accepts a granted notice from our VTA", () => {
  const msg = {
    type: TASK_CONSENT_GRANTED_TYPE,
    from: VTA.did,
    body: { status: "granted", payloadDigest: "abc123", taskType: "t" },
  };
  assert.deepEqual(parseTaskConsentGranted(msg, VTA.did), { payloadDigest: "abc123" });
});

test("parseTaskConsentGranted ignores a non-granted message type", () => {
  const msg = { type: "other", from: VTA.did, body: { payloadDigest: "x" } };
  assert.equal(parseTaskConsentGranted(msg, VTA.did), null);
});

test("parseTaskConsentGranted rejects a sender that is not our VTA", () => {
  const msg = { type: TASK_CONSENT_GRANTED_TYPE, from: IMPOSTOR.did, body: { payloadDigest: "x" } };
  assert.equal(parseTaskConsentGranted(msg, VTA.did), null);
});

test("parseTaskConsentGranted tolerates a missing sender (page re-checks the digest)", () => {
  const msg = { type: TASK_CONSENT_GRANTED_TYPE, body: { payloadDigest: "x" } };
  assert.deepEqual(parseTaskConsentGranted(msg, VTA.did), { payloadDigest: "x" });
});

test("parseTaskConsentGranted requires a string payloadDigest", () => {
  const msg = { type: TASK_CONSENT_GRANTED_TYPE, from: VTA.did, body: {} };
  assert.equal(parseTaskConsentGranted(msg, VTA.did), null);
});
