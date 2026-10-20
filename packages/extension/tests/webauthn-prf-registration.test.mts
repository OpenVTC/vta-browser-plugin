// What a passkey registration says about PRF. A security key (YubiKey 5,
// Nitrokey 3) reports `enabled: true` and no output at `create`, and gives the
// output on an assertion; treating that as "unsupported" refused every such key.

import { test } from "node:test";
import assert from "node:assert/strict";

import { registrationPrf } from "../src/webauthn-prf-wrap.ts";

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
