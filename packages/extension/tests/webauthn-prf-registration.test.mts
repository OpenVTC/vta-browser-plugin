// What a passkey registration says about PRF. A security key (YubiKey 5,
// Nitrokey 3) reports `enabled: true` and no output at `create`, and gives the
// output on an assertion; treating that as "unsupported" refused every such key.

import { test } from "node:test";
import assert from "node:assert/strict";

import { browserOffersPrf, registrationPrf } from "../src/webauthn-prf-wrap.ts";

const cred = (prf: unknown) => ({ getClientExtensionResults: () => (prf === undefined ? {} : { prf }) }) as never;

test("a platform passkey's output at create is used", () => {
  const out = new Uint8Array(32).fill(7);
  const r = registrationPrf(cred({ enabled: true, results: { first: out.buffer } }));
  assert.equal(r.kind, "output");
  assert.deepEqual(r.kind === "output" && [...r.prfOutput], [...out]);
});

test("a security key with hmac-secret but no output at create needs one assertion", () => {
  assert.deepEqual(registrationPrf(cred({ enabled: true })), { kind: "needs-assertion" });
});

test("no prf result, or enabled false, is an authenticator without PRF", () => {
  assert.deepEqual(registrationPrf(cred(undefined)), { kind: "unsupported" });
  assert.deepEqual(registrationPrf(cred({ enabled: false })), { kind: "unsupported" });
});

// The browser's own answer (`getClientCapabilities`, Chrome 133+) separates "this
// browser has no PRF" from "this passkey has none"; the fixes differ.

async function withCapabilities<T>(pkc: unknown, run: () => Promise<T>): Promise<T> {
  const had = Object.getOwnPropertyDescriptor(globalThis, "PublicKeyCredential");
  Object.defineProperty(globalThis, "PublicKeyCredential", { value: pkc, configurable: true, writable: true });
  try {
    return await run();
  } finally {
    if (had) Object.defineProperty(globalThis, "PublicKeyCredential", had);
    else delete (globalThis as { PublicKeyCredential?: unknown }).PublicKeyCredential;
  }
}

test("the browser's extension:prf answer is read when it gives one", async () => {
  const caps = (v: unknown) => ({ getClientCapabilities: async () => ({ "extension:prf": v }) });
  assert.equal(await withCapabilities(caps(true), browserOffersPrf), true);
  assert.equal(await withCapabilities(caps(false), browserOffersPrf), false);
});

test("a browser that cannot say is let through to try", async () => {
  assert.equal(await withCapabilities(undefined, browserOffersPrf), undefined);
  assert.equal(await withCapabilities({}, browserOffersPrf), undefined);
  assert.equal(
    await withCapabilities({ getClientCapabilities: async () => { throw new Error("x"); } }, browserOffersPrf),
    undefined,
  );
});
