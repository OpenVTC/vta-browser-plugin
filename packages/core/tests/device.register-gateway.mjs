// Unit test for `registerPushChannel` — the device→gateway `push/register`
// call of the push wake-up binding (https://trusttasks.org/binding/push/0.1).
//
// register is an UNAUTHENTICATED plain POST of the canonical Trust Task doc to
// `{gateway}/trust-tasks`, so it's fully testable with a stub fetch (no DIDComm,
// no holder identity). Covers: (1) a well-formed Web Push registration produces
// the right wire doc and unwraps the WakeHandle from the `#response`; (2) a
// `trust-task-error` envelope surfaces `code: message` (the canonical
// framework field — the gateway emits it via trust-tasks-rs `reject_with`).

import { test } from "node:test";
import assert from "node:assert/strict";

import { registerPushChannel } from "../dist/index.js";

const REGISTRATION = {
  platform: "webpush",
  endpoint: "https://push.example/abc",
  keys: { p256dh: "p256dh-key", auth: "auth-secret" },
};

/** A real `Response`, not an ad-hoc `{ ok, json }` literal. A hand-rolled stub
 *  only implements whatever the code happened to call when it was written, so
 *  it silently stops representing a Response the moment the code reads the body
 *  a different way — which is how these tests failed against a change that is
 *  correct for every real Response. */
function jsonResponse(body, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

test("registerPushChannel posts a push/register doc and returns the handle", async () => {
  let captured;
  const fetchStub = async (url, init) => {
    captured = { url, init };
    return jsonResponse({
      type: "https://trusttasks.org/spec/push/register/0.2#response",
      payload: { wakeHandle: { gateway: "https://gw.example", handle: "z6MkHandle" } },
    });
  };

  const handle = await registerPushChannel({
    gatewayUrl: "https://gw.example/", // trailing slash trimmed
    registration: REGISTRATION,
    controllerVtaDid: "did:webvh:example:vta",
    fetch: fetchStub,
  });

  assert.deepEqual(handle, { gateway: "https://gw.example", handle: "z6MkHandle" });

  // Posted to the gateway's /trust-tasks (no double slash).
  assert.equal(captured.url, "https://gw.example/trust-tasks");
  assert.equal(captured.init.method, "POST");
  assert.equal(captured.init.headers["content-type"], "application/json");
  // No auth header — register is open.
  assert.equal(captured.init.headers.authorization, undefined);

  const doc = JSON.parse(captured.init.body);
  assert.equal(doc.type, "https://trusttasks.org/spec/push/register/0.2");
  assert.deepEqual(doc.payload.registration, REGISTRATION);
  assert.equal(doc.payload.controllerVtaDid, "did:webvh:example:vta");
  assert.ok(typeof doc.id === "string" && doc.id.length > 0);
});

test("registerPushChannel surfaces a trust-task-error envelope", async () => {
  const fetchStub = async () =>
    jsonResponse({
      type: "https://trusttasks.org/spec/trust-task-error/0.1",
      payload: { code: "push/register:bad_token", message: "unsupported platform" },
    });

  await assert.rejects(
    () =>
      registerPushChannel({
        gatewayUrl: "https://gw.example",
        registration: REGISTRATION,
        controllerVtaDid: "did:webvh:example:vta",
        fetch: fetchStub,
      }),
    /push\/register:bad_token: unsupported platform/,
  );
});

// ── R3.7: parse the body before throwing on status ───────────────────────────

test("a refusal at a non-2xx status still surfaces its machine-readable code", async () => {
  // The bug this replaces: `/trust-tasks` is the dispatcher, so a rejected task
  // arrives as a trust-task-error document at a NON-2xx status. Throwing on
  // `!res.ok` first made the error branch unreachable for every rejected task,
  // flattening the code into an opaque `failed (403): {...}` string.
  const fetchStub = async () =>
    jsonResponse(
      {
        type: "https://trusttasks.org/spec/trust-task-error/0.1",
        payload: { code: "auth:consent_required", message: "operator approval needed" },
      },
      403,
    );

  await assert.rejects(
    () =>
      registerPushChannel({
        gatewayUrl: "https://gw.example",
        registration: REGISTRATION,
        controllerVtaDid: "did:webvh:example:vta",
        fetch: fetchStub,
      }),
    /auth:consent_required: operator approval needed/,
  );
});

test("a non-2xx that is NOT a trust-task document still reports status and body", async () => {
  const fetchStub = async () => new Response("upstream exploded", { status: 502 });

  await assert.rejects(
    () =>
      registerPushChannel({
        gatewayUrl: "https://gw.example",
        registration: REGISTRATION,
        controllerVtaDid: "did:webvh:example:vta",
        fetch: fetchStub,
      }),
    /failed \(502\): upstream exploded/,
  );
});
