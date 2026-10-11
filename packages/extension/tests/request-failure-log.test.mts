// Every request the offscreen document fails is logged where someone debugging
// a transport looks, with the TSP decline reason the console banner showed and
// the offscreen console did not.

import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { requestFailureLog } from "../src/request-failure-log.js";

const VTA = "did:webvh:QmScid:dids.example.org:gt-vta";
const REQUEST = {
  target: "offscreen",
  type: "offscreen/request-task",
  vtaDid: VTA,
  params: { type: "https://trusttasks.org/spec/auth/whoami/0.1", payload: { secret: "hunter2" } },
};

test("a failed request is logged with the agent, the task, the time and the whole error", () => {
  const error =
    "tsp: timed out awaiting reply frame — last inbound frame declined: unpack failed: bad tag";
  const line = requestFailureLog(REQUEST, { ok: false, error, code: "e.client.network" }, 30_012);
  assert.ok(line);
  const [head, fields] = line;
  assert.equal(head, "[pnm request] offscreen/request-task failed after 30.0s");
  assert.deepEqual(fields, {
    error,
    elapsedMs: 30_012,
    vtaDid: VTA,
    task: "https://trusttasks.org/spec/auth/whoami/0.1",
    code: "e.client.network",
  });
});

test("the request's payload never reaches the log", () => {
  const line = requestFailureLog(REQUEST, { ok: false, error: "x" }, 1);
  assert.doesNotMatch(JSON.stringify(line), /hunter2|payload/);
});

test("an agent's structured details are kept", () => {
  const details = { lastDecline: "threadId mismatch" };
  const [, fields] = requestFailureLog(REQUEST, { ok: false, error: "x", details }, 1)!;
  assert.deepEqual(fields.details, details);
});

test("only a failure is logged", () => {
  assert.equal(requestFailureLog(REQUEST, { ok: true, result: {} }, 1), undefined);
  assert.equal(requestFailureLog(REQUEST, undefined, 1), undefined);
  assert.equal(requestFailureLog(REQUEST, "port", 1), undefined);
});

test("a request with nothing recognisable still logs the failure", () => {
  const line = requestFailureLog(null, { ok: false }, 5);
  assert.deepEqual(line, [
    "[pnm request] (unknown request) failed after 0.0s",
    { error: "(no message)", elapsedMs: 5 },
  ]);
});

test("every offscreen reply goes through the logging wrapper", () => {
  // The listener renames Chrome's callback so the handlers below it can only
  // reach the wrapped one. A handler that took Chrome's directly would answer
  // without being logged, and nothing else would notice.
  const src = readFileSync(new URL("../src/offscreen.ts", import.meta.url), "utf8");
  assert.match(src, /chrome\.runtime\.onMessage\.addListener\(\(message, sender, respond\) =>/);
  assert.equal(src.match(/\brespond\(/g)?.length, 1, "Chrome's callback is called in one place only");
});
