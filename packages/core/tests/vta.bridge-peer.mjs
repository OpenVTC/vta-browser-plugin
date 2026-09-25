// A reply is accepted only from the peer the request was addressed to.
//
// The DIDComm bridge correlates a reply to its request by thread id, and a
// thread id is the id of a message this wallet sent through the mediator — not
// a secret. So every `sendAndAwaitReply` names the peer(s) whose reply it is,
// and the mediator-session bridge hands that to the session's `waitFor` filter,
// which leaves anyone else's frame on the thread unclaimed.

import { test } from "node:test";
import assert from "node:assert/strict";

import { signTrustTask } from "../dist/trust-tasks/sign.js";
import {
  DidcommVtaTransport,
  Identity,
  InMemoryDidcommBridge,
  MediatorSessionBridge,
  TRUST_TASK_ENVELOPE_TYPE,
  buildTrustTask,
  generateSigningIdentity,
} from "../dist/index.js";

const VAULT_DELETE = "https://trusttasks.org/spec/vault/delete/0.1";

test("MediatorSessionBridge passes the expected peer to the session's waitFor", async () => {
  const calls = [];
  const connection = {
    waitFor: async (thid, timeoutMs, options) => {
      calls.push({ thid, timeoutMs, options });
      return { thid, from: "did:example:vta" };
    },
    send: () => {},
    close: () => {},
  };
  const bridge = new MediatorSessionBridge(connection, 1234);
  await bridge.sendAndAwaitReply("jwe", "urn:uuid:t", { from: ["did:example:vta"] });
  assert.deepEqual(calls, [
    { thid: "urn:uuid:t", timeoutMs: 1234, options: { from: ["did:example:vta"] } },
  ]);
});

async function vtaFixture({ replier } = {}) {
  const signing = generateSigningIdentity();
  const holder = Identity.generate(signing.did);
  const vtaSigning = generateSigningIdentity();
  const vta = Identity.generate(vtaSigning.did);
  const signedReply = { type: `${VAULT_DELETE}#response`, payload: { deleted: true } };
  await signTrustTask({ envelope: signedReply, signing: vtaSigning });
  const inner = new InMemoryDidcommBridge({
    vta,
    holderPublicJwk: holder.publicJwk(),
    vtaHandlers: {
      [TRUST_TASK_ENVELOPE_TYPE]: () => ({ type: TRUST_TASK_ENVELOPE_TYPE, body: signedReply }),
    },
  });
  const seen = [];
  const bridge = {
    async sendAndAwaitReply(outer, thid, options) {
      seen.push(options);
      const reply = await inner.sendAndAwaitReply(outer, thid, options);
      return replier ? { ...reply, from: replier } : reply;
    },
    send: (outer) => inner.send(outer),
  };
  const transport = new DidcommVtaTransport({
    bridge,
    holder,
    signing,
    vta: {
      did: vta.did,
      keyAgreementKid: vta.publicJwk().kid,
      keyAgreementPublicJwk: vta.publicJwk().jwk,
    },
  });
  const call = () =>
    transport.send(
      buildTrustTask(VAULT_DELETE, { id: "e-1" }, { issuer: signing.did, recipient: vta.did }),
      { expectedResponseType: `${VAULT_DELETE}#response` },
    );
  return { vta, seen, call };
}

test("a VTA request names the VTA as the only peer that may answer", async () => {
  const { vta, seen, call } = await vtaFixture();
  await call();
  assert.deepEqual(seen.map((o) => o.from), [[vta.did]]);
});

test("the in-memory bridge refuses a reply from a peer the caller did not name", async () => {
  const inner = new InMemoryDidcommBridge({
    holderPublicJwk: Identity.generate("did:key:zH").publicJwk(),
  });
  // Drive the check directly: the simulator's reply comes from its replier,
  // which here is not the named peer.
  inner.process = async () => ({ type: "t", from: "did:example:someone-else", thid: "x" });
  await assert.rejects(
    () => inner.sendAndAwaitReply("jwe", "x", { from: "did:example:vta" }),
    /is not from did:example:vta/,
  );
});

test("a mediator request names the mediator as the only peer that may answer", async () => {
  const { MediatorClient } = await import("../dist/vta/mediator-client.js");
  const mediator = Identity.generate("did:key:zMediatorPeer");
  const holder = Identity.generate("did:key:zHolderPeer");
  const seen = [];
  const client = new MediatorClient({
    holder,
    mediator: {
      did: mediator.did,
      keyAgreementKid: mediator.publicJwk().kid,
      keyAgreementPublicJwk: mediator.publicJwk().jwk,
    },
    bridge: {
      async sendAndAwaitReply(_outer, thid, options) {
        seen.push(options);
        return { type: "https://didcomm.org/coordinate-mediation/3.0/keylist", from: mediator.did, thid, body: { keys: [] } };
      },
      send: async () => {},
    },
  });
  await client.queryKeylist().catch(() => {});
  assert.deepEqual(seen.map((o) => o.from), [mediator.did]);
});
