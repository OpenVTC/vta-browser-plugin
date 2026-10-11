// Two things that kept a console switching between agents from tripping, and
// then misreporting, the agent's per-IP sign-in limit.
//
//  - `getVtaBearer` shares one sign-in between concurrent callers. A console
//    loads several panes at once; each used to run its own challenge +
//    authenticate before any token was cached — six anonymous requests per
//    agent against a burst of ten.
//  - A 429 says who sent it. The agent's REST endpoint can sit behind a CDN,
//    and the wallet used to render both as a bare "429".

import { test } from "node:test";
import assert from "node:assert/strict";

import { Identity } from "../dist/didcomm/index.js";
import { getVtaBearer, makeReauth } from "../dist/vta/auth.js";
import { decodeTrustTaskHttpAck, decodeTrustTaskHttpReply } from "../dist/vta/http-reply.js";
import { parseRetryAfter, rateLimitFrom } from "../dist/vta/errors.js";
import { generateSigningIdentity, signTrustTask } from "../dist/index.js";

const CHALLENGE = "https://trusttasks.org/spec/auth/challenge/0.1";

const VTA = generateSigningIdentity();

function holderPair() {
  const signing = generateSigningIdentity();
  return { signing, holder: Identity.generate(signing.did) };
}

async function vtaReply(req) {
  const payload =
    req.type === CHALLENGE
      ? { challenge: "c".repeat(32), sessionId: "s-1", expiresAt: "2099-01-01T00:00:00Z" }
      : {
          session: {
            id: "s-1",
            subject: req.issuer,
            issuedAt: new Date().toISOString(),
            expiresAt: new Date(Date.now() + 900_000).toISOString(),
          },
          tokens: { accessToken: "vta.jwt", tokenType: "Bearer", expiresIn: 900 },
        };
  const doc = {
    id: `urn:uuid:${crypto.randomUUID()}`,
    threadId: req.id,
    type: `${req.type}#response`,
    issuer: VTA.did,
    recipient: req.issuer,
    issuedAt: new Date().toISOString(),
    payload,
  };
  await signTrustTask({ envelope: doc, signing: VTA, proofPurpose: "authentication" });
  return doc;
}

/** Re-sign a reply whose payload a test has edited. */
async function resign(doc) {
  const { proof: _drop, ...envelope } = doc;
  await signTrustTask({ envelope, signing: VTA, proofPurpose: "authentication" });
  return envelope;
}

/** The 429 the VTA's own limiter sends (`vta-service/src/routes/rate_limit.rs`). */
function vtaLimited({ headers = true } = {}) {
  return new Response(
    JSON.stringify({
      error: "rate_limited",
      limiter: "auth",
      message: "Too Many Requests: rejected by the VTA's `auth` rate limiter. Retry after 3 s.",
      retryAfterSecs: 3,
    }),
    {
      status: 429,
      headers: {
        "content-type": "application/json",
        ...(headers
          ? { "x-rate-limit-source": "vta", "x-rate-limit-scope": "auth", "retry-after": "3" }
          : {}),
      },
    },
  );
}

/** A CDN's 429: an HTML page, no attribution. */
function cdnLimited() {
  return new Response("<html><body>Error 1015 — You are being rate limited</body></html>", {
    status: 429,
    headers: { "content-type": "text/html", "retry-after": "60" },
  });
}

async function rejection(p) {
  return p.then(
    () => assert.fail("expected a rejection"),
    (e) => e,
  );
}

// ── single-flight sign-in ──

test("concurrent callers with no token share one sign-in", async () => {
  const { holder, signing } = holderPair();
  let calls = 0;
  const fetch = async (_url, init) => {
    calls++;
    // Let the other callers arrive while this sign-in is still running.
    await new Promise((r) => setTimeout(r, 5));
    return new Response(JSON.stringify(await vtaReply(JSON.parse(init.body))), { status: 200 });
  };
  const opts = { baseUrl: "https://vta.example", holder, service: { did: VTA.did }, signing, fetch };
  try {
    const tokens = await Promise.all([getVtaBearer(opts), getVtaBearer(opts), getVtaBearer(opts)]);
    assert.deepEqual(tokens, ["vta.jwt", "vta.jwt", "vta.jwt"]);
    assert.equal(calls, 2, "one challenge + one authenticate, not one pair per caller");
  } finally {
    holder.dispose();
  }
});

test("a failed sign-in is shared by the callers waiting on it, and not replayed to the next", async () => {
  const { holder, signing } = holderPair();
  let calls = 0;
  let refuse = true;
  const fetch = async (_url, init) => {
    calls++;
    await new Promise((r) => setTimeout(r, 5));
    if (refuse) return vtaLimited();
    return new Response(JSON.stringify(await vtaReply(JSON.parse(init.body))), { status: 200 });
  };
  const opts = { baseUrl: "https://vta.example", holder, service: { did: VTA.did }, signing, fetch };
  try {
    const errs = await Promise.all([rejection(getVtaBearer(opts)), rejection(getVtaBearer(opts))]);
    for (const e of errs) assert.equal(e.code, "e.p.msg.rate_limited");
    assert.equal(calls, 1, "both callers waited on the one challenge");

    refuse = false;
    assert.equal(await getVtaBearer(opts), "vta.jwt");
    assert.equal(calls, 3, "the next caller signs in afresh");
  } finally {
    holder.dispose();
  }
});

test("a stale 401 does not discard the token a concurrent re-auth just minted", async () => {
  // The VTA keeps one live token per DID; every sign-in supersedes the last
  // (`token superseded (jti mismatch)` in its log). Three requests refused
  // together used to each drop the cache and sign in again, superseding one
  // another's replacement.
  const { holder, signing } = holderPair();
  let n = 0;
  const fetch = async (_url, init) => {
    const reply = await vtaReply(JSON.parse(init.body));
    if (reply.payload.tokens) reply.payload.tokens.accessToken = `jwt-${++n}`;
    return new Response(JSON.stringify(await resign(reply)), { status: 200 });
  };
  const opts = { baseUrl: "https://vta.example", holder, service: { did: VTA.did }, signing, fetch };
  try {
    const first = await getVtaBearer(opts);
    assert.equal(first, "jwt-1");
    const reauth = makeReauth(opts);
    // The first refused request re-authenticates…
    assert.equal(await reauth(first), "jwt-2");
    // …and a second, refused with the same old token, reuses that replacement.
    assert.equal(await reauth(first), "jwt-2");
    assert.equal(n, 2);
    // A refusal of the current token does replace it.
    assert.equal(await reauth("jwt-2"), "jwt-3");
  } finally {
    holder.dispose();
  }
});

// ── 429 attribution ──

test("the agent's own limiter is named, with its limiter and wait", async () => {
  const err = await rejection(decodeTrustTaskHttpReply(vtaLimited()));
  assert.equal(err.code, "e.p.msg.rate_limited");
  assert.equal(err.status, 429);
  assert.deepEqual(err.details, { rateLimit: { source: "vta", limiter: "auth", retryAfterSecs: 3 } });
  assert.match(err.message, /the agent's `auth` limiter/);
  assert.match(err.message, /retry after 3 s/);
});

test("the body attributes it when the browser hides the headers", async () => {
  // `x-rate-limit-source` and `retry-after` are not CORS-safelisted.
  const err = await rejection(decodeTrustTaskHttpReply(vtaLimited({ headers: false })));
  assert.deepEqual(err.details, { rateLimit: { source: "vta", limiter: "auth", retryAfterSecs: 3 } });
});

test("a CDN's 429 is reported as not the agent's", async () => {
  const err = await rejection(decodeTrustTaskHttpReply(cdnLimited()));
  assert.equal(err.code, "e.p.msg.rate_limited");
  assert.deepEqual(err.details, { rateLimit: { source: "upstream", retryAfterSecs: 60 } });
  assert.match(err.message, /not the agent's own limiter/);
});

test("a one-way POST's 429 is attributed the same way", async () => {
  const err = await rejection(decodeTrustTaskHttpAck(cdnLimited()));
  assert.equal(err.details.rateLimit.source, "upstream");
  const vta = await rejection(decodeTrustTaskHttpAck(vtaLimited()));
  assert.equal(vta.details.rateLimit.source, "vta");
});

test("an unidentified source header does not claim to be anyone", () => {
  const rl = rateLimitFrom(new Headers({ "x-rate-limit-source": "cloudflare" }), undefined);
  assert.deepEqual(rl, { source: "upstream" });
});

test("retry-after reads both RFC 9110 forms and bounds what it is given", () => {
  const now = Date.parse("2026-10-11T00:00:00Z");
  assert.equal(parseRetryAfter("4", now), 4);
  assert.equal(parseRetryAfter("Sun, 11 Oct 2026 00:00:30 GMT", now), 30);
  assert.equal(parseRetryAfter("soon", now), undefined);
  assert.equal(parseRetryAfter(null, now), undefined);
  assert.equal(parseRetryAfter("99999999999", now), 86_400 * 365);
});
