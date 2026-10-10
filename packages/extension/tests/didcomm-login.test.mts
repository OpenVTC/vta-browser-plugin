// `window.vtaWallet.loginDidcomm`'s page-level result, pinned.
//
// The sign-in underneath is now `auth/challenge` then a signed
// `auth/authenticate`, because the did-hosting RP no longer serves the bare
// DIDComm authenticate (affinidi-webvh-service #213). The page must not be able
// to tell: it receives exactly the members it always did. And a per-site
// persona is refused here, because the RP acts on a DIDComm or TSP document
// only when its signer is its sender, and the wallet cannot send as a persona.

import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

import { didcommLoginRefusal, didcommLoginResult } from "../src/didcomm-login.ts";

const HOLDER = "did:key:z6MkHolder";
const TIMINGS = [{ label: "load holder", ms: 3 }];

test("the result carries exactly the members it always has", () => {
  const got = didcommLoginResult(
    { accessToken: "at", refreshToken: "rt", sessionId: "sess-1" },
    HOLDER,
    TIMINGS,
  );
  assert.deepEqual(got, {
    accessToken: "at",
    refreshToken: "rt",
    sessionId: "sess-1",
    holderDid: HOLDER,
    timings: TIMINGS,
  });
});

test("nothing else from the RP's session leaks into the page's result", () => {
  // `loginViaTrustTask` returns more than the page ever received (expiry, the
  // granted scope). A page that deep-compares or forwards the result sees what
  // it saw before.
  const session = {
    accessToken: "at",
    refreshToken: "rt",
    sessionId: "sess-1",
    expiresIn: 900,
    scope: ["dids:read"],
  };
  const got = didcommLoginResult(session, HOLDER, TIMINGS);
  assert.deepEqual(Object.keys(got).sort(), [
    "accessToken",
    "holderDid",
    "refreshToken",
    "sessionId",
    "timings",
  ]);
});

test("an RP that rotates no refresh token gives an empty string, never undefined", () => {
  const got = didcommLoginResult({ accessToken: "at", sessionId: "s" }, HOLDER, []);
  assert.equal(got.refreshToken, "");
  assert.equal(typeof got.refreshToken, "string");
});

test("a per-site persona is refused, and the holder is not", () => {
  assert.equal(didcommLoginRefusal(undefined), undefined);
  assert.equal(didcommLoginRefusal(""), undefined);
  assert.match(didcommLoginRefusal("entry-1") ?? "", /persona cannot sign in over DIDComm or TSP/);
});

test("the DIDComm sign-in refuses a persona first, signs as the holder, and returns the pinned shape", () => {
  const offscreen = readFileSync(
    fileURLToPath(new URL("../src/offscreen.ts", import.meta.url)),
    "utf8",
  );
  const fn = /async function doDidcommLogin\([\s\S]*?\n}\n/.exec(offscreen)?.[0] ?? "";
  assert.ok(fn, "doDidcommLogin not found");
  // The refusal comes before anything is resolved or signed.
  const refuse = fn.indexOf("didcommLoginRefusal(req.entryId)");
  assert.ok(refuse > 0, "the persona refusal is gone");
  assert.ok(refuse < fn.indexOf("loadHolder("), "the refusal must come first");
  // No persona signer on this path.
  assert.equal(/personaTaskSigner|vaultTaskSigner|documentSigner/.test(fn), false);
  assert.match(fn, /didcommLoginResult\(rpSession, signing\.did, sw\.marks\)/);
});
