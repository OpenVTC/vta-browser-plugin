import { test } from "node:test";
import assert from "node:assert/strict";

import {
  vaultList,
  vaultDelete,
  vaultSignTrustTask,
  vtaListDids,
  setDeviceWake,
  contextsList,
  contextsCreate,
  swapAcl,
  generateSigningIdentity,
  VtaSession,
  decodeDigestMultibase,
} from "../dist/index.js";

/** A TrustTaskChannel that records the envelope + opts and returns a canned
 *  payload — lets us assert an op builds the right Trust-Task and routes it
 *  over whatever channel it's handed, with no transport at all. */
function captureChannel(payload) {
  const sent = [];
  return {
    kind: "didcomm",
    sent,
    async send(envelope, opts) {
      sent.push({ envelope, opts });
      return payload;
    },
  };
}

const holder = { did: "did:example:holder" };
const service = { did: "did:example:vta", keyAgreementKid: "did:example:vta#ka", keyAgreementPublicJwk: {} };

test("vaultList builds vault/list/0.3 with issuer+recipient and maps the reply", async () => {
  const ch = captureChannel({ entries: [{ id: "e1" }], truncated: true, cursor: "c2" });
  const res = await vaultList(ch, { holder, service, filter: { contextId: "work" } });

  const { envelope, opts } = ch.sent[0];
  assert.equal(envelope.type, "https://trusttasks.org/spec/vault/list/0.3");
  assert.equal(envelope.issuer, "did:example:holder");
  assert.equal(envelope.recipient, "did:example:vta");
  assert.deepEqual(envelope.payload, { contextId: "work" });
  assert.equal(opts.expectedResponseType, "https://trusttasks.org/spec/vault/list/0.3#response");
  assert.ok(typeof envelope.id === "string" && envelope.id.length > 0);
  assert.ok(typeof envelope.issuedAt === "string");

  assert.deepEqual(res, { entries: [{ id: "e1" }], truncated: true, cursor: "c2" });
});

test("vaultList defaults filter to {} and truncated to false", async () => {
  const ch = captureChannel({ entries: [] });
  const res = await vaultList(ch, { holder, service });
  assert.deepEqual(ch.sent[0].envelope.payload, {});
  assert.deepEqual(res, { entries: [], truncated: false });
});

test("vaultDelete carries id + optimistic-concurrency token", async () => {
  const ch = captureChannel({ id: "x", deletedAt: "t", graceUntil: "t" });
  await vaultDelete(ch, { holder, service, id: "x", expectedVersion: 4, reason: "rotated" });
  const { envelope, opts } = ch.sent[0];
  assert.equal(envelope.type, "https://trusttasks.org/spec/vault/delete/0.1");
  assert.deepEqual(envelope.payload, { id: "x", expectedVersion: 4, reason: "rotated" });
  assert.equal(opts.expectedResponseType, "https://trusttasks.org/spec/vault/delete/0.1#response");
});

test("vaultSignTrustTask forwards the unsigned envelope and returns signedEnvelope", async () => {
  const unsignedEnvelope = { id: "u", type: "t", issuer: "did:example:persona", payload: {} };
  const signedEnvelope = { ...unsignedEnvelope, proof: { cryptosuite: "eddsa-jcs-2022" } };
  const ch = captureChannel({ signedEnvelope });
  const res = await vaultSignTrustTask(ch, { holder, service, entryId: "e9", unsignedEnvelope });
  assert.equal(ch.sent[0].envelope.type, "https://trusttasks.org/spec/vault/sign-trust-task/0.2");
  assert.deepEqual(ch.sent[0].envelope.payload, { entryId: "e9", unsignedEnvelope });
  assert.deepEqual(res, { signedEnvelope });
});

test("vtaListDids scopes by context and unwraps dids[]", async () => {
  const ch = captureChannel({ dids: [{ did: "did:webvh:a", contextId: "work" }] });
  const res = await vtaListDids(ch, { holder, service, contextId: "work" });
  assert.equal(ch.sent[0].envelope.type, "https://trusttasks.org/spec/vta/webvh/dids/list/1.0");
  // camelCase both ways: the schema names `contextId` and sets
  // additionalProperties:false, so `context_id` was malformed rather than an
  // accepted synonym — and the agent emits the canonical spelling too, so the
  // read path no longer folds.
  assert.deepEqual(ch.sent[0].envelope.payload, { contextId: "work" });
  assert.deepEqual(res, [{ did: "did:webvh:a", contextId: "work" }]);
});

test("contextsList sends contexts/list/1.0 with empty payload and unwraps contexts[]", async () => {
  const ch = captureChannel({ contexts: [{ id: "work", name: "Work" }] });
  const res = await contextsList(ch, { holder, service });
  const { envelope, opts } = ch.sent[0];
  assert.equal(envelope.type, "https://trusttasks.org/spec/vta/contexts/list/1.0");
  assert.deepEqual(envelope.payload, {});
  assert.equal(opts.expectedResponseType, "https://trusttasks.org/spec/vta/contexts/list/1.0#response");
  assert.deepEqual(res, [{ id: "work", name: "Work" }]);
});

test("contextsCreate defaults name to id and forwards description/parent", async () => {
  const record = { id: "team", name: "Team", did: null, description: "d", basePath: "/team", createdAt: "t", updatedAt: "t" };
  const ch = captureChannel(record);
  const res = await contextsCreate(ch, { holder, service, id: "team", description: "d", parent: "org" });
  assert.equal(ch.sent[0].envelope.type, "https://trusttasks.org/spec/vta/contexts/create/1.0");
  assert.deepEqual(ch.sent[0].envelope.payload, { id: "team", name: "team", description: "d", parent: "org" });
  assert.deepEqual(res, record);
});

test("swapAcl sends acl/swap-key with currentSubject/newSubject/linkProof (ephemeral issuer)", async () => {
  const holderSigning = generateSigningIdentity();
  // The response shape the AGENT sends (VTI #857): the realized entry wrapped,
  // plus the DID swapped out. This fixture used to be a flat entry with `did`,
  // `allowedContexts` and a numeric `createdAt` — built from the client's own
  // hand-written type rather than from the schema, so it agreed with the drift
  // instead of catching it. Nothing read it either, which is how a response
  // type can be wrong in three ways and stay green.
  const ch = captureChannel({
    entry: {
      subject: holderSigning.did,
      role: "admin",
      scopes: [],
      createdAt: "2026-01-01T00:00:00Z",
      createdBy: "did:web:vta.example",
    },
    previousSubject: "did:key:zEphemeral",
  });
  const res = await swapAcl(ch, {
    ephemeralDid: "did:key:zEphemeral",
    holderSigning,
    vtaDid: "did:web:vta.example",
  });
  const { envelope, opts } = ch.sent[0];
  assert.equal(envelope.type, "https://trusttasks.org/spec/acl/swap-key/0.1");
  assert.equal(envelope.issuer, "did:key:zEphemeral"); // authenticated as the ephemeral
  assert.equal(envelope.recipient, "did:web:vta.example");
  assert.equal(envelope.payload.currentSubject, "did:key:zEphemeral");
  assert.equal(envelope.payload.newSubject, holderSigning.did);

  // Assert the RESPONSE too. The absence of this is what let the return type
  // drift: `sender.send<T>()` is an unchecked cast, so a wrong `T` costs
  // nothing until a caller reads a field and gets `undefined`.
  assert.equal(res.entry.subject, holderSigning.did);
  assert.equal(res.entry.role, "admin");
  assert.equal(res.previousSubject, "did:key:zEphemeral");
  assert.ok(
    typeof envelope.payload.linkProof === "string" && envelope.payload.linkProof.length > 0,
    "linkProof VP-JWT is present",
  );
  assert.equal(opts.expectedResponseType, "https://trusttasks.org/spec/acl/swap-key/0.1#response");
});

test("ops accept a VtaSession (not just a raw channel) and route through it", async () => {
  // The whole point of TrustTaskSender: hand an op a multi-channel session and
  // it works. Here the primary (didcomm) channel routes the vault/list.
  const didcomm = captureChannel({ entries: [{ id: "via-session" }] });
  const session = new VtaSession([didcomm]);
  const res = await vaultList(session, { holder, service });
  assert.equal(didcomm.sent[0].envelope.type, "https://trusttasks.org/spec/vault/list/0.3");
  assert.deepEqual(res.entries, [{ id: "via-session" }]);
});

test("setDeviceWake sets the handle; omitting it clears", async () => {
  const ch = captureChannel({ pushCapable: true });
  await setDeviceWake(ch, { holder, service, wakeHandle: { gateway: "g", handle: "h" } });
  assert.deepEqual(ch.sent[0].envelope.payload, { wakeHandle: { gateway: "g", handle: "h" } });

  const ch2 = captureChannel({ pushCapable: false });
  await setDeviceWake(ch2, { holder, service });
  assert.deepEqual(ch2.sent[0].envelope.payload, {}); // clear
});

test("the canonical spelling is passed through untouched", async () => {
  const ch = captureChannel({ contexts: [{ id: "work", name: "Work", basePath: "/work" }] });
  const [ctx] = await contextsList(ch, { holder, service });
  assert.equal(ctx.basePath, "/work");
});

test("an attachment's integrity is a digestMultibase, and it decodes", async () => {
  // The point of the 0.3 cutover. `AttachmentRef` at 0.2 carried `sha256`, a
  // bare hex string that hard-codes one algorithm into the wire contract;
  // `vault/_shared/0.3` replaces it with a self-describing multibase multihash.
  //
  // Pinned as a *decode*, not a string compare. Two encodings of one digest are
  // the same digest, so comparing the encoded forms answers a different
  // question than the one a caller verifying an attachment is asking.
  const entry = {
    id: "e1",
    contextId: "c1",
    targets: [{ kind: "webOrigin", origin: "https://example.com" }],
    label: "Recovery codes",
    secretKind: "custom",
    attachments: [
      {
        id: "a1",
        name: "recovery-codes.txt",
        sizeBytes: 128,
        digestMultibase: "zQmSK9pGKFnmc77pqyNAPJyPKt8rMqctngfg3vwuMArwGYZ",
      },
    ],
    createdAt: "2026-08-28T00:00:00Z",
    updatedAt: "2026-08-28T00:00:00Z",
    version: 1,
  };
  const ch = captureChannel({ entries: [entry], truncated: false });
  const res = await vaultList(ch, { holder, service });

  const ref = res.entries[0].attachments[0];
  assert.equal("sha256" in ref, false, "the 0.2 hex member is gone");
  const bytes = decodeDigestMultibase(ref.digestMultibase);
  assert.equal(bytes.length, 32, "sha2-256 digest bytes, multihash prefix stripped");
});

test("an attachment digest that is not a sha2-256 multihash is refused", () => {
  // Fails closed rather than guessing. A bare hex string is exactly what a 0.2
  // producer would send, and silently accepting it would make the cutover
  // invisible at the one place it matters.
  assert.throws(() => decodeDigestMultibase("deadbeef"), /unsupported multibase prefix/);
});
