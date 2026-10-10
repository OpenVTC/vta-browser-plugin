// Every wallet install registers itself as one of the member's devices before
// its first sign-in — `ensureDeviceRegistered` — and reads the VTA's sign-in
// refusals by their stable code (`vaultOobRefusal`), R3.7.

import { test } from "node:test";
import assert from "node:assert/strict";

import { ensureDeviceRegistered } from "../dist/device/index.js";
import {
  OOB_DEVICE_DISABLED,
  OOB_NOT_ENROLLED_DEVICE,
  vaultOobRefusal,
} from "../dist/vault/index.js";

const holder = { did: "did:key:z6MkBrowserA" };
const service = { did: "did:webvh:QmVta:vta.example.org" };
const PARAMS = {
  holder,
  service,
  consumerKind: { kind: "companion", formFactor: "browser" },
  displayName: "Chrome on macOS",
  platform: "macOS",
};

const refusal = (reason) =>
  Object.assign(new Error(reason), { details: { code: "taskFailed", details: { reason } } });

function recorder(reply) {
  const sent = [];
  return {
    sent,
    send: async (envelope) => {
      sent.push(envelope);
      return reply(envelope);
    },
  };
}

test("a registered device is left as it is: one heartbeat, no register", async () => {
  const ch = recorder(() => ({ serverTime: new Date().toISOString(), queuedOperations: [] }));
  assert.equal(await ensureDeviceRegistered(ch, PARAMS), "present");
  assert.equal(ch.sent.length, 1);
  assert.equal(ch.sent[0].type, "https://trusttasks.org/spec/device/heartbeat/0.2");
  assert.equal(ch.sent[0].issuer, holder.did);
  assert.deepEqual(ch.sent[0].payload, { platform: "macOS" });
});

test("an unregistered device registers as a browser companion under its own name", async () => {
  const ch = recorder((env) => {
    if (env.type.includes("heartbeat")) throw refusal("not_found");
    return { binding: { deviceId: "dev-1" } };
  });
  assert.equal(await ensureDeviceRegistered(ch, PARAMS), "registered");
  assert.equal(ch.sent[1].type, "https://trusttasks.org/spec/device/register/0.2");
  assert.equal(ch.sent[1].issuer, holder.did);
  assert.deepEqual(ch.sent[1].payload, {
    consumerKind: { kind: "companion", formFactor: "browser" },
    displayName: "Chrome on macOS",
    platform: "macOS",
  });
});

test("losing a registration race to another call is success, not a failure", async () => {
  const ch = recorder((env) => {
    throw refusal(env.type.includes("heartbeat") ? "not_found" : "conflict");
  });
  assert.equal(await ensureDeviceRegistered(ch, PARAMS), "present");
});

test("any other refusal is not papered over with a registration", async () => {
  const ch = recorder(() => {
    throw refusal("forbidden");
  });
  await assert.rejects(ensureDeviceRegistered(ch, PARAMS));
  assert.equal(ch.sent.length, 1);

  const reg = recorder((env) => {
    throw refusal(env.type.includes("heartbeat") ? "not_found" : "forbidden");
  });
  await assert.rejects(ensureDeviceRegistered(reg, PARAMS));
});

test("the VTA's sign-in refusal is read from details.details.code", () => {
  const vta = (code) =>
    Object.assign(new Error(`vault/sign-trust-task:${code} — …`), {
      details: { code: "taskFailed", message: "…", details: { code } },
    });
  assert.equal(vaultOobRefusal(vta(OOB_NOT_ENROLLED_DEVICE)), "oobNotEnrolledDevice");
  assert.equal(vaultOobRefusal(vta(OOB_DEVICE_DISABLED)), "oobDeviceDisabled");
  // Not a sign-in refusal, and never read from the message.
  assert.equal(vaultOobRefusal(vta("notFound")), undefined);
  assert.equal(vaultOobRefusal(new Error("oobNotEnrolledDevice")), undefined);
  assert.equal(vaultOobRefusal(undefined), undefined);
});
