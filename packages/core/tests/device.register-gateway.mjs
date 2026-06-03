// Unit test for `registerPushChannel` — the device→gateway `push/register`
// call of the push wake-up binding (https://trusttasks.org/binding/push/0.1).
//
// register is an UNAUTHENTICATED plain POST of the canonical Trust Task doc to
// `{gateway}/trust-tasks`, so it's fully testable with a stub fetch (no DIDComm,
// no holder identity). Covers: (1) a well-formed Web Push registration produces
// the right wire doc and unwraps the WakeHandle from the `#response`; (2) a
// `trust-task-error/0.1` envelope surfaces `code: comment`.

import { test } from "node:test";
import assert from "node:assert/strict";

import { registerPushChannel } from "../dist/index.js";

const REGISTRATION = {
  platform: "webpush",
  endpoint: "https://push.example/abc",
  keys: { p256dh: "p256dh-key", auth: "auth-secret" },
};

test("registerPushChannel posts a push/register doc and returns the handle", async () => {
  let captured;
  const fetchStub = async (url, init) => {
    captured = { url, init };
    return {
      ok: true,
      json: async () => ({
        type: "https://trusttasks.org/spec/push/register/0.1#response",
        payload: { wakeHandle: { gateway: "https://gw.example", handle: "z6MkHandle" } },
      }),
    };
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
  assert.equal(doc.type, "https://trusttasks.org/spec/push/register/0.1");
  assert.deepEqual(doc.payload.registration, REGISTRATION);
  assert.equal(doc.payload.controllerVtaDid, "did:webvh:example:vta");
  assert.ok(typeof doc.id === "string" && doc.id.length > 0);
});

test("registerPushChannel surfaces a trust-task-error envelope", async () => {
  const fetchStub = async () => ({
    ok: true,
    json: async () => ({
      type: "https://trusttasks.org/spec/trust-task-error/0.1",
      payload: { code: "push/register:bad_token", comment: "unsupported platform" },
    }),
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
