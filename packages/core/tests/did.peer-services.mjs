// What the wallet publishes about itself, and why more than one entry.
//
// A wallet negotiates against a VTA's published services (TSP > DIDComm >
// REST). Nothing negotiates in the other direction unless the wallet publishes
// too — an executor has no signal that this holder accepts TSP inbound, so it
// will never send any. These tests pin the encoding, and pin it against the
// resolver that actually reads it rather than against my own decoder.

import { test } from "node:test";
import assert from "node:assert/strict";

import { createDidPeer2 } from "../dist/did/index.js";
import { resolve as resolveDidPeer } from "@openvtc/vti-didcomm-js/did-peer";
import { ed25519, x25519 } from "@noble/curves/ed25519.js";

const MEDIATOR = "did:webvh:QmMediator:example.test:mediator";

function keys() {
  const ed = ed25519.utils.randomSecretKey();
  return {
    ed25519PublicKey: ed25519.getPublicKey(ed),
    x25519PublicKey: x25519.getPublicKey(ed25519.utils.toMontgomerySecret(ed)),
  };
}

test("a holder advertising both transports resolves to two typed services", () => {
  const { did } = createDidPeer2({
    ...keys(),
    services: [
      { serviceEndpoint: MEDIATOR },
      { type: "TSPTransport", serviceEndpoint: MEDIATOR },
    ],
  });

  // One `.S` element per service — the form every resolver here indexes.
  assert.equal(did.match(/\.S/g)?.length, 2);

  const doc = resolveDidPeer(did);
  const services = doc.didDocument.service;
  assert.equal(services.length, 2);

  // `dm` expands; the ids follow the did:peer:2 numbering both resolvers use.
  assert.equal(services[0].type, "DIDCommMessaging");
  assert.equal(services[0].id, `${did}#service`);
  assert.equal(services[0].serviceEndpoint, MEDIATOR);

  assert.equal(services[1].type, "TSPTransport");
  assert.equal(services[1].id, `${did}#service-1`);
  assert.equal(services[1].serviceEndpoint, MEDIATOR);
});

test("the TSP entry is spelled out, because the abbreviation is not portable", () => {
  // `affinidi-did-common` expands `"tsp"` to `TSPTransport`; `vti-didcomm-js`
  // expands only `"dm"` and passes the rest through. So `"tsp"` resolves to two
  // different service types depending on which side reads the DID — a drift
  // that would show up as "the VTA sees a TSP service and the wallet does not".
  //
  // This asserts the trap is real, so that if the JS side ever learns the
  // abbreviation this test fails and the comment above stops being true.
  const { did } = createDidPeer2({
    ...keys(),
    services: [{ type: "tsp", serviceEndpoint: MEDIATOR }],
  });
  const svc = resolveDidPeer(did).didDocument.service[0];
  assert.equal(
    svc.type,
    "tsp",
    "if this now reads TSPTransport, the JS resolver learned the abbreviation " +
      "and `tsp` became safe to publish",
  );
});

test("no services means no `.S` element at all", () => {
  const { did } = createDidPeer2(keys());
  assert.ok(!did.includes(".S"));
  assert.equal(resolveDidPeer(did).didDocument.service, undefined);
});

test("a DIDComm service carries `accept`; a TSP one does not", () => {
  const { did } = createDidPeer2({
    ...keys(),
    services: [
      { serviceEndpoint: MEDIATOR },
      { type: "TSPTransport", serviceEndpoint: MEDIATOR },
    ],
  });
  const [didcomm, tsp] = resolveDidPeer(did).didDocument.service;
  // `didcomm/v2` is a DIDComm media type. Asserting it on a TSP endpoint would
  // advertise something untrue about what that endpoint speaks.
  assert.deepEqual(didcomm.accept, ["didcomm/v2"]);
  assert.equal(tsp.accept, undefined);
});
