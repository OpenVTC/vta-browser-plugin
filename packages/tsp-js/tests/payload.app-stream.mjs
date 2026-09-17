import { test } from "node:test";
import assert from "node:assert/strict";

import * as wire from "../dist/cesr/wire.js";
import { decodePayloadFrame } from "../dist/rev3/payload.js";

// An XSCS body is exactly one Bytes primitive (tswg-tsp-specification#77):
// an -H## group, a second primitive, or data after the stream is refused,
// never truncated to the first primitive.
const enc = new TextEncoder();
const prim = (s) => {
  const out = [];
  wire.encodeVariableData(wire.TSP_PLAINTEXT, enc.encode(s), out);
  return out;
};
const frameOf = (stream, trailing = []) => {
  const body = [...wire.XSCS, ...prim(""), ...prim("")]; // NULL sender, no padding
  wire.encodeCount(wire.TSP_GENERIC_STREAM, stream.length / 3, body);
  body.push(...stream, ...trailing);
  const frame = [];
  wire.encodeCount(wire.TSP_PAYLOAD, body.length / 3, frame);
  return Uint8Array.from([...frame, ...body]);
};
const open = (f) => decodePayloadFrame(f, "did:example:alice", new Uint8Array());

test("a single Bytes primitive is the application body", () => {
  assert.equal(new TextDecoder().decode(open(frameOf(prim("hello world"))).body), "hello world");
});

test("an -H## group is refused", () => {
  const json = prim('{"hello":"world"}');
  const group = [];
  wire.encodeCount(wire.cesrInt("H"), json.length / 3, group);
  assert.throws(() => open(frameOf([...group, ...json])));
});

test("a second primitive is refused, not dropped", () => {
  assert.throws(() => open(frameOf([...prim("one"), ...prim("two")])), /exactly one Bytes primitive/);
});

test("data after the stream is refused", () => {
  assert.throws(() => open(frameOf(prim("one"), prim("x"))), /does not end the payload frame/);
});
