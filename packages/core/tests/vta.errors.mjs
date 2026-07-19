// R3.7: the server's machine-readable error code must survive, and must never
// be recovered by matching on message text.

import { test } from "node:test";
import assert from "node:assert/strict";

import { errorFromBody, errorFromResponse } from "../dist/vta/errors.js";

const SERVER_ERROR = {
  error: {
    code: "e.p.msg.rate_limited",
    message: "slow down",
    details: { retryAfter: 30 },
    suggestion: "retry later",
  },
};

test("errorFromBody keeps the server's code, message, details and suggestion", () => {
  const err = errorFromBody(SERVER_ERROR, 429, "Too Many Requests");
  assert.equal(err.code, "e.p.msg.rate_limited");
  assert.equal(err.message, "slow down");
  assert.equal(err.status, 429);
  assert.deepEqual(err.details, { retryAfter: 30 });
  assert.equal(err.suggestion, "retry later");
});

test("a body already consumed by the caller no longer loses the code", async () => {
  // The regression this fixes: `RestChannel` must read the body to tell a
  // Trust-Task refusal from a transport failure. It then passed the SAME
  // Response to `errorFromResponse`, whose own `res.json()` threw
  // "Body has already been read" into a bare `catch {}` — so `error.code` was
  // always undefined and the code degraded to a status-only guess.
  const res = new Response(JSON.stringify(SERVER_ERROR), {
    status: 429,
    headers: { "content-type": "application/json" },
  });

  const doc = await res.json(); // caller parses first, consuming the stream
  assert.equal(res.bodyUsed, true, "precondition: the stream is spent");

  // The old path, demonstrating the loss.
  const viaResponse = await errorFromResponse(res);
  assert.equal(
    viaResponse.details,
    undefined,
    "re-reading a spent body cannot recover details — this is the bug",
  );

  // The new path recovers everything from the already-parsed document.
  const viaBody = errorFromBody(doc, res.status, res.statusText);
  assert.equal(viaBody.code, "e.p.msg.rate_limited");
  assert.deepEqual(viaBody.details, { retryAfter: 30 });
  assert.equal(viaBody.suggestion, "retry later");
});

test("a code the server invented is not trusted — it degrades to the status", () => {
  const err = errorFromBody({ error: { code: "e.made.up", message: "?" } }, 403, "Forbidden");
  assert.equal(err.code, "e.p.msg.forbidden", "unknown codes fall back to the status mapping");
});

test("no body at all still yields a typed error from the status", () => {
  const err = errorFromBody(undefined, 404, "Not Found");
  assert.equal(err.code, "e.p.msg.notfound");
  assert.equal(err.message, "404 Not Found");
  assert.equal(err.status, 404);
});

test("a missing statusText does not leave a trailing space in the message", () => {
  const err = errorFromBody(undefined, 500);
  assert.equal(err.message, "500");
});

test("errorFromResponse still works when the caller has NOT read the body", async () => {
  const res = new Response(JSON.stringify(SERVER_ERROR), {
    status: 429,
    headers: { "content-type": "application/json" },
  });
  const err = await errorFromResponse(res);
  assert.equal(err.code, "e.p.msg.rate_limited");
  assert.deepEqual(err.details, { retryAfter: 30 });
});
