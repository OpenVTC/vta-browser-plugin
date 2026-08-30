// Transport selection — see src/transports.ts.
//
// These pin the rule the offscreen session actually routes by. If the UI and
// the router disagree, the status line confidently reports the wrong thing.

import test from "node:test";
import assert from "node:assert/strict";
import {
  activeTransport,
  advertisedTransports,
  isObserved,
  transportSummary,
  unavailableTransports,
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

// ─── Health: advertisement is not availability ───
//
// The gap these close is the one that shipped: a mediator refusing the
// extension's origin took TSP and DIDComm out, and the status line went on
// naming TSP because the stored connection still advertised it.

const DOWN = { state: "down" as const, code: "mediator/origin-not-allowed" };
const UP = { state: "up" as const };

test("a transport observed down is never named as the active one", () => {
  assert.equal(activeTransport(ALL, true, { TSP: DOWN }), "DIDComm");
  assert.equal(activeTransport(ALL, true, { TSP: DOWN, DIDComm: DOWN }), "REST");
});

test("every advertised transport down is no transport, not a false claim", () => {
  assert.equal(
    activeTransport(ALL, true, { TSP: DOWN, DIDComm: DOWN, REST: DOWN }),
    undefined,
  );
});

test("absent health reproduces the advertisement-only answer", () => {
  // Nothing observed yet is the state on a wallet that has done no work. The
  // old answer is the right guess there — it just must not be stated as fact.
  assert.equal(activeTransport(ALL, true, {}), activeTransport(ALL, true));
  assert.equal(activeTransport(ALL, false, {}), "DIDComm");
});

test("REST reporting `unknown` does not take it out of the running", () => {
  // `unknown` is what a built-but-unproven RestChannel records. Treating it
  // as a failure would strand a wallet whose only transport is REST.
  assert.equal(
    activeTransport(ALL, true, { TSP: DOWN, DIDComm: DOWN, REST: { state: "unknown" } }),
    "REST",
  );
});

test("isObserved separates `nothing seen yet` from `seen and fine`", () => {
  assert.equal(isObserved({}), false);
  assert.equal(isObserved({ REST: { state: "unknown" } }), false);
  assert.equal(isObserved({ TSP: UP }), true);
  assert.equal(isObserved({ TSP: DOWN }), true);
});

test("unavailable list names what is advertised but broken", () => {
  assert.deepEqual(unavailableTransports(ALL, { TSP: DOWN, DIDComm: DOWN }), ["TSP", "DIDComm"]);
  assert.deepEqual(unavailableTransports(ALL, {}), []);
  // Not advertised cannot be unavailable — it was never on offer.
  assert.deepEqual(unavailableTransports({ restBaseUrl: "https://h" }, { TSP: DOWN }), []);
});

test("summary says what is broken, not just what is idle", () => {
  assert.equal(
    transportSummary(ALL, true, { TSP: DOWN, DIDComm: DOWN }),
    "REST · TSP, DIDComm unavailable",
  );
  assert.equal(transportSummary(ALL, true, { TSP: DOWN }), "DIDComm · REST available · TSP unavailable");
  assert.equal(
    transportSummary(ALL, true, { TSP: DOWN, DIDComm: DOWN, REST: DOWN }),
    "no transport · TSP, DIDComm, REST unavailable",
  );
});
