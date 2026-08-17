// Transport selection — see src/transports.ts.
//
// These pin the rule the offscreen session actually routes by. If the UI and
// the router disagree, the status line confidently reports the wrong thing.

import test from "node:test";
import assert from "node:assert/strict";
import {
  activeTransport,
  advertisedTransports,
  transportSummary,
} from "../src/transports.ts";

const ALL = {
  tspMediatorDid: "did:webvh:a:host:tsp",
  mediatorDid: "did:webvh:b:host:mediator",
  restBaseUrl: "https://host/api",
};

test("TSP wins when preferred and advertised", () => {
  assert.equal(activeTransport(ALL, true), "TSP");
});

test("turning preferTsp off pins to DIDComm", () => {
  // The documented workaround for a mediator whose TSP delivery misbehaves.
  assert.equal(activeTransport(ALL, false), "DIDComm");
});

test("DIDComm beats REST when there is no TSP", () => {
  assert.equal(activeTransport({ mediatorDid: "did:x", restBaseUrl: "https://h" }, true), "DIDComm");
});

test("REST is the last resort", () => {
  assert.equal(activeTransport({ restBaseUrl: "https://h" }, true), "REST");
});

test("TSP advertised but switched off, with nothing else, is no transport", () => {
  // A real state the UI has to be able to show, not an impossible one.
  assert.equal(activeTransport({ tspMediatorDid: "did:x" }, false), undefined);
  assert.equal(activeTransport({}, true), undefined);
});

test("advertised list keeps priority order", () => {
  assert.deepEqual(advertisedTransports(ALL), ["TSP", "DIDComm", "REST"]);
  assert.deepEqual(advertisedTransports({ restBaseUrl: "https://h" }), ["REST"]);
});

test("summary names the active one and what else is idle", () => {
  assert.equal(transportSummary(ALL, true), "TSP · DIDComm, REST available");
  assert.equal(transportSummary({ mediatorDid: "did:x" }, true), "DIDComm");
  assert.equal(transportSummary({}, true), "no transport");
});
