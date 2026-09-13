// A redirect is not a way round the endpoint check — proved over real sockets.
//
// `assertPublicHttpsUrl`, the did:webvh host guard and the library's
// `assertSafeEndpoint` all judge a URL's *text*. A 302 is how a host that
// passed that judgement sends the request somewhere that would not have:
// `https://vta.example` is vetted, answers `Location: http://169.254.169.254/`,
// and a `fetch` with the default `redirect: "follow"` makes that second request
// with no second vet. In a browser there is no way to inspect the hop —
// `redirect: "manual"` yields an opaque response with no headers — so the only
// control available is to refuse the redirect outright, which is what
// `guardedFetch` does and what `getVtaBearer` wires it in for.
//
// What this file pins is **the wiring**, and that is the part that lives here.
// The refusal itself is `@openvtc/vti-didcomm-js`'s; the decision that every
// VTA REST request goes through it is `vta/auth.ts`, one line
// (`guardedFetch(opts.fetch, vtaRestEndpointPolicy(...))`) that a refactor can
// drop without any other test noticing. `vta.rest-net-policy.mjs` next door
// would not: it drives the same function with an injected spy `fetch`, and a
// spy never redirects.
//
// ── Hermetic, and hermetic when RED ─────────────────────────────────────────
//
// Two listeners, both on 127.0.0.1. One stands for the VTA and answers the
// redirect; the other stands for the internal address the redirect points at,
// and exists only to count connections. So the target of the attack in this
// test is a port on this machine: with the wiring removed, the redirect is
// followed to a loopback listener rather than to a metadata service, and the
// test fails on a count instead of egressing.
//
// `netPolicy` is the dev pair (`allowInsecure` + `allowPrivate`), deliberately.
// Without it the loopback base URL is refused on its address and the test would
// pass with the redirect control gone — green for the wrong reason, pinning the
// address table twice and the redirect not at all. With it, the address and
// scheme checks are both satisfied and a refusal can only be the redirect.

import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { createServer as createTcpServer } from "node:net";

import * as x25519 from "@openvtc/vti-didcomm-js/x25519";
import * as jwk from "@openvtc/vti-didcomm-js/jwk";
import * as multibase from "@openvtc/vti-didcomm-js/multibase";

import { Identity } from "../dist/didcomm/index.js";
import { getVtaBearer } from "../dist/vta/auth.js";

/** The stable code every refusal carries. Spelled out rather than imported so
 *  the test would notice the constant changing value (R3.7). */
const BLOCKED_ENDPOINT = "E_BLOCKED_ENDPOINT";
/** The only combination that admits a loopback base URL over http. */
const DEV_POLICY = { allowInsecure: true, allowPrivate: true };

/** A VTA keyAgreement endpoint the handshake can authcrypt to. */
function vtaEndpoint() {
  const kp = x25519.generateKeyPair();
  const mb = multibase.encodeMultikey(multibase.MULTICODEC.X25519_PUB, kp.publicKey);
  return {
    did: `did:key:${mb}`,
    keyAgreementKid: `did:key:${mb}#${mb}`,
    keyAgreementPublicJwk: jwk.publicJwk("X25519", kp.publicKey),
  };
}

/** What the stand-in VTA does with a request: redirect it, or answer it. */
let mode = "redirect";
/** Every path the stand-in VTA was asked for. */
let asked = [];
/** Every connection the internal listener accepted. */
let reached = [];

let vta;
let internal;
/** `http://127.0.0.1:<port>` for each. */
let vtaBase;
let internalBase;

before(async () => {
  // The internal service: a bare TCP listener, because the question is whether
  // anything connects at all rather than what it would have said. Dropping the
  // socket keeps a RED run fast.
  internal = createTcpServer((socket) => {
    reached.push(socket.remoteAddress ?? "?");
    socket.destroy();
  });
  await new Promise((resolve) => internal.listen(0, "127.0.0.1", resolve));
  internalBase = `http://127.0.0.1:${internal.address().port}`;

  vta = createServer((req, res) => {
    asked.push(req.url);
    if (mode === "redirect") {
      // A 302 to the internal listener. The `Location` is a loopback port
      // rather than 169.254.169.254 on purpose: it is the same hop, and it
      // cannot leave the machine when this test is RED.
      res.writeHead(302, { location: `${internalBase}/latest/meta-data/` });
      res.end();
      return;
    }
    const body =
      req.url === "/auth/challenge"
        ? { sessionId: "s-1", challenge: "c-1" }
        : { tokens: { accessToken: "vta.jwt" } };
    res.writeHead(200, { "content-type": "application/json" });
    res.end(JSON.stringify(body));
  });
  await new Promise((resolve) => vta.listen(0, "127.0.0.1", resolve));
  vtaBase = `http://127.0.0.1:${vta.address().port}`;
});

after(async () => {
  await Promise.all([
    new Promise((r) => vta.close(r)),
    new Promise((r) => internal.close(r)),
  ]);
});

test("a VTA that answers the bearer handshake with a redirect is refused, and the target never dialled", async () => {
  mode = "redirect";
  asked = [];
  reached = [];
  // A fresh holder DID each time: `getVtaBearer` caches a bearer per
  // base URL + holder, and a cache hit would answer without a request.
  const holder = Identity.generate("did:example:holder-redirect");
  try {
    await assert.rejects(
      () =>
        getVtaBearer({
          baseUrl: vtaBase,
          holder,
          service: vtaEndpoint(),
          netPolicy: DEV_POLICY,
        }),
      (err) => {
        assert.equal(err.code, BLOCKED_ENDPOINT, "must carry the stable code (R3.7)");
        // The reason is what says the redirect did the refusing. `scheme` or
        // `private_address` here would mean the dev policy was not applied and
        // this test proves nothing about redirects.
        assert.equal(err.reason, "redirect");
        assert.equal(err.status, 302);
        return true;
      },
    );
    // It got as far as asking — otherwise the refusal above could have happened
    // before the request, which is a different control.
    assert.deepEqual(asked, ["/auth/challenge"]);
    // And this is the assertion the file is for.
    assert.deepEqual(reached, [], "the redirect was followed to the internal listener");
  } finally {
    holder.dispose();
  }
});

test("the redirect is real and the internal listener is reachable — the control", async () => {
  // Without this, an empty `reached` above could mean the 302 was malformed,
  // the internal listener was never listening, or the `Location` pointed
  // nowhere. A plain `fetch` that *does* follow redirects reaches it, so the
  // only difference between this and the test above is the refusal.
  mode = "redirect";
  asked = [];
  reached = [];

  await assert.rejects(
    () =>
      fetch(`${vtaBase}/auth/challenge`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: "{}",
        redirect: "follow",
      }),
    // The internal listener drops the socket, so the followed hop fails — after
    // it has been made, which is the whole point.
    () => true,
  );
  assert.deepEqual(asked, ["/auth/challenge"]);
  assert.ok(reached.length > 0, "the internal listener never saw the followed redirect");
});

test("the same handshake over the same sockets succeeds when the VTA does not redirect", async () => {
  // The positive control for the path as a whole: real fetch, real loopback
  // sockets, `guardedFetch` in place. A redirect refusal that also broke
  // ordinary requests would be caught here rather than in production.
  mode = "answer";
  asked = [];
  reached = [];
  const holder = Identity.generate("did:example:holder-answer");
  try {
    const token = await getVtaBearer({
      baseUrl: vtaBase,
      holder,
      service: vtaEndpoint(),
      netPolicy: DEV_POLICY,
    });
    assert.equal(token, "vta.jwt");
    assert.deepEqual(asked, ["/auth/challenge", "/auth/"]);
    assert.deepEqual(reached, [], "nothing should have gone near the internal listener");
  } finally {
    holder.dispose();
  }
});

test("without the dev policy the same base URL never reaches a socket at all", async () => {
  // States the layering, so the dev policy above cannot be read as the wallet
  // being willing to dial loopback in a shipped build. `walletNetPolicy()` in
  // the extension returns `{}` for every packaged build.
  //
  // Both refusals are named, and separately, because the order matters to the
  // test above: `http:` is refused on its scheme *before* the host is looked
  // at, so a redirect test written against `http://127.0.0.1` with no dev
  // policy would be green with the redirect control deleted — pinning the
  // scheme gate twice. That is why the test above passes `allowInsecure` and
  // `allowPrivate` together, and why a refusal there with reason `scheme` or
  // `private_address` is asserted against.
  mode = "answer";
  asked = [];
  reached = [];
  const holder = Identity.generate("did:example:holder-strict");
  try {
    // Plaintext: refused on the scheme, first.
    await assert.rejects(
      () => getVtaBearer({ baseUrl: vtaBase, holder, service: vtaEndpoint() }),
      (err) => err.code === BLOCKED_ENDPOINT && err.reason === "scheme",
    );
    // TLS on the same loopback host: refused on the address, which is the check
    // the dev policy's `allowPrivate` is what suspends.
    await assert.rejects(
      () =>
        getVtaBearer({
          baseUrl: vtaBase.replace("http://", "https://"),
          holder,
          service: vtaEndpoint(),
        }),
      (err) => err.code === BLOCKED_ENDPOINT && err.reason === "private_address",
    );
    assert.deepEqual(asked, [], "a refused base URL must not be dialled");
  } finally {
    holder.dispose();
  }
});
