// Reading a did:webvh log.
//
// Every test here is a line the parser must not refuse. The log is written by
// whichever agent held the DID at the time, over the DID's whole life, and a
// console that goes blank on one entry it does not recognise goes blank exactly
// for the histories worth reading — so "unreadable" is a state an entry can be
// in, not a reason to stop.

import { test } from "node:test";
import assert from "node:assert/strict";
import { parseDidLog, servicesOf, methodsOf } from "../src/manager/did-log.js";

const entry = (over: Record<string, unknown> = {}) =>
  JSON.stringify({
    versionId: "1-QmScid",
    versionTime: "2026-09-11T00:00:00Z",
    parameters: { method: "did:webvh:1.0", scid: "QmScid", portable: false },
    state: { id: "did:webvh:QmScid:example.com" },
    proof: [{ type: "DataIntegrityProof" }],
    ...over,
  });

test("a log is its lines, numbered by position", () => {
  const entries = parseDidLog([entry(), entry({ versionId: "2-QmNext" })].join("\n"));
  assert.equal(entries.length, 2);
  assert.deepEqual(
    entries.map((e) => e.index),
    [1, 2],
  );
  assert.equal(entries[1]!.versionId, "2-QmNext");
});

test("the trailing newline of a JSONL file is not an entry", () => {
  assert.equal(parseDidLog(`${entry()}\n`).length, 1);
  assert.equal(parseDidLog(`${entry()}\n\n  \n`).length, 1);
});

// The whole reason `index` is derived from order rather than parsed out of
// `versionId`: an entry that omits it still has a place in the log, and a
// parser that numbered from the field would leave a hole.
test("an entry with no versionId still has a position", () => {
  const [e] = parseDidLog(entry({ versionId: undefined }));
  assert.equal(e!.index, 1);
  assert.equal(e!.versionId, undefined);
  assert.equal(e!.problem, null);
});

test("a line that is not JSON is an entry, not a thrown parser", () => {
  const entries = parseDidLog([entry(), "{ truncated", entry()].join("\n"));
  assert.equal(entries.length, 3);
  assert.match(entries[1]!.problem ?? "", /not JSON/);
  // The raw line survives, because an entry this console cannot read is still
  // part of the DID's history and the operator may need to hand it to something
  // that can.
  assert.equal(entries[1]!.raw, "{ truncated");
  assert.equal(entries[2]!.problem, null, "one bad line must not poison the rest");
});

test("a line that is JSON but not an object is said to be exactly that", () => {
  const [e] = parseDidLog("[1,2,3]");
  assert.match(e!.problem ?? "", /not an object/);
});

// A single proof may be an object rather than a one-element array — both are
// legal — and counting only the array form reports a signed entry as unsigned,
// which the pane draws as a red `unsigned` pill. A false alarm on a correct log
// is as bad as silence on a broken one.
test("one proof counts whether it is an array or a bare object", () => {
  assert.equal(parseDidLog(entry({ proof: { type: "DataIntegrityProof" } }))[0]!.proofCount, 1);
  assert.equal(parseDidLog(entry({ proof: [{}, {}] }))[0]!.proofCount, 2);
});

test("an entry with no proof counts zero, which is what the pane flags", () => {
  assert.equal(parseDidLog(entry({ proof: undefined }))[0]!.proofCount, 0);
});

test("parameters and state are kept only when they are objects", () => {
  const [e] = parseDidLog(entry({ parameters: "nonsense", state: 7 }));
  assert.equal(e!.parameters, undefined);
  assert.equal(e!.state, undefined);
  assert.equal(e!.problem, null, "an odd member is not an unreadable entry");
});

test("services are read out of the entry's document", () => {
  const [e] = parseDidLog(
    entry({
      state: {
        id: "did:webvh:QmScid:example.com",
        service: [
          {
            id: "did:webvh:QmScid:example.com#didcomm",
            type: "DIDCommMessaging",
            serviceEndpoint: "did:web:mediator.example",
          },
        ],
      },
    }),
  );
  assert.deepEqual(servicesOf(e!), [
    {
      id: "did:webvh:QmScid:example.com#didcomm",
      type: "DIDCommMessaging",
      serviceEndpoint: "did:web:mediator.example",
    },
  ].map((s) => ({ id: s.id, type: s.type, endpoint: s.serviceEndpoint })));
});

// `serviceEndpoint` is `string | object | array` in DID Core, and a mediator
// entry uses the object form. A renderer that assumed a string printed
// `[object Object]` where the endpoint should be.
test("an object endpoint is stringified rather than coerced", () => {
  const [e] = parseDidLog(
    entry({
      state: {
        id: "did:x",
        service: [
          { id: "did:x#m", type: ["DIDCommMessaging"], serviceEndpoint: { uri: "wss://m.example" } },
        ],
      },
    }),
  );
  const [s] = servicesOf(e!);
  assert.equal(s!.endpoint, '{"uri":"wss://m.example"}');
  assert.equal(s!.type, "DIDCommMessaging", "an array type reads as its members");
});

test("an entry with no services or methods lists neither, and does not throw", () => {
  const [e] = parseDidLog(entry({ state: { id: "did:x" } }));
  assert.deepEqual(servicesOf(e!), []);
  assert.deepEqual(methodsOf(e!), []);
});

test("verification methods are listed by id", () => {
  const [e] = parseDidLog(
    entry({
      state: {
        id: "did:x",
        verificationMethod: [{ id: "did:x#key-1" }, { id: "did:x#key-2" }, { noId: true }],
      },
    }),
  );
  assert.deepEqual(methodsOf(e!), ["did:x#key-1", "did:x#key-2"]);
});
