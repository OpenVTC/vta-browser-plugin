// R3.7 for the REST channel's reply decoding: a refusal must keep its
// machine-readable code AND its details, and the body must be read exactly
// once. Exercises `decodeTrustTaskHttpReply` directly — the same function
// `RestChannel.send` calls — so it does not need the bearer handshake.

import { test } from "node:test";
import assert from "node:assert/strict";

import { decodeTrustTaskHttpReply } from "../dist/vta/rest-channel.js";

const RESPONSE_TYPE = "https://trusttasks.org/spec/vault/list/0.1#response";
const ERROR_TYPE = "https://trusttasks.org/spec/trust-task-error/0.1";

function json(body, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

test("a successful reply is unwrapped", async () => {
  const out = await decodeTrustTaskHttpReply(
    json({ type: RESPONSE_TYPE, payload: { items: [1, 2] } }),
    { expectedResponseType: RESPONSE_TYPE },
  );
  assert.deepEqual(out, { items: [1, 2] });
});

test("a refusal at a non-2xx status keeps its details, not just a status guess", async () => {
  // This is the case the whole read-once rule exists for: an approver cannot
  // render a consent prompt from an error whose `details` were thrown away.
  const details = {
    reason: "auth:consent_required",
    payloadDigest: "z6Mkdigest",
    challenge: "c-123",
    consentRequests: [{ id: "cr-1" }],
  };

  const err = await decodeTrustTaskHttpReply(
    json({ type: ERROR_TYPE, payload: { code: "auth:consent_required", message: "need consent", details } }, 403),
    { expectedResponseType: RESPONSE_TYPE },
  ).then(
    () => null,
    (e) => e,
  );

  assert.ok(err, "a refusal must reject");
  assert.ok(
    JSON.stringify(err.details ?? err.message).includes("auth:consent_required"),
    "the machine-readable reason must survive the HTTP layer",
  );
});

test("a non-2xx that is NOT a trust-task document keeps the server's error code", async () => {
  // The double-read bug lived here: after `res.json()` consumed the stream,
  // re-reading it lost `error.code` and degraded to a status-only mapping.
  // A server code that does NOT match its status is the case that detects it.
  const err = await decodeTrustTaskHttpReply(
    json({ error: { code: "e.p.msg.rate_limited", message: "slow down", details: { retryAfter: 30 } } }, 403),
  ).then(
    () => null,
    (e) => e,
  );

  assert.equal(
    err.code,
    "e.p.msg.rate_limited",
    "must use the server's code, not the 403→forbidden status guess",
  );
  assert.equal(err.message, "slow down");
  assert.deepEqual(err.details, { retryAfter: 30 }, "details must survive");
});

test("a non-JSON error body still produces a typed error from the status", async () => {
  const err = await decodeTrustTaskHttpReply(new Response("gateway exploded", { status: 502 })).then(
    () => null,
    (e) => e,
  );
  assert.equal(err.code, "e.p.msg.internal");
  assert.equal(err.status, 502);
});

test("a non-JSON body on a 2xx is a parse error, not a transport error", async () => {
  const err = await decodeTrustTaskHttpReply(new Response("not json", { status: 200 })).then(
    () => null,
    (e) => e,
  );
  assert.equal(err.code, "e.client.parse");
  assert.equal(err.status, 200);
});

test("the body is read exactly once", async () => {
  // A second read would throw "Body has already been read" into a swallowing
  // catch — the silent-degradation path. Assert the stream is spent and that
  // decoding did not depend on reading it twice.
  let reads = 0;
  const res = json({ type: ERROR_TYPE, payload: { code: "x:y", message: "m" } }, 400);
  const originalJson = res.json.bind(res);
  res.json = async () => {
    reads++;
    return originalJson();
  };

  await decodeTrustTaskHttpReply(res).catch(() => undefined);
  assert.equal(reads, 1, "exactly one read of the body");
});
