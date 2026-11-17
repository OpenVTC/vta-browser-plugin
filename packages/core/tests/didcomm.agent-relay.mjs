// Which mediator an agent pushes through, and so where a wallet's inbox for it
// is. A did:webs VTA may advertise TSP alone; its inbox is the TSP mediator,
// since the inbox session carries TSP frames beside DIDComm ones.

import { test } from "node:test";
import assert from "node:assert/strict";

import { agentRelayMediator } from "../dist/didcomm/index.js";

const DIDCOMM = "did:webvh:QmD:relay.example:didcomm";
const TSP = "did:webvh:QmT:relay.example:tsp";

test("a TSP-only agent's relay is its TSP mediator", () => {
  assert.equal(agentRelayMediator({ tsp: { mediatorDid: TSP } }), TSP);
});

test("DIDComm's mediator is the relay when both are advertised", () => {
  assert.equal(agentRelayMediator({ tsp: { mediatorDid: TSP }, didcomm: { mediatorDid: DIDCOMM } }), DIDCOMM);
});

test("a REST-only agent has no relay", () => {
  assert.equal(agentRelayMediator({ rest: { baseUrl: "https://vta.example" } }), undefined);
});
