// Transport failure classification — see src/transport-diagnosis.ts.
//
// These pin the inference that replaces a reason the platform refuses to give
// us. The browser hands JavaScript a bare `TypeError: Failed to fetch` for a
// CORS refusal and for a dead host alike; everything actionable is in telling
// those two apart, so that is what is tested hardest.

import test from "node:test";
import assert from "node:assert/strict";
import {
  TRANSPORT_DIAGNOSIS,
  classifyTransportFailure,
  originOf,
  probeReachable,
} from "../src/transport-diagnosis.ts";

const FETCH_FAILURE = new TypeError("Failed to fetch");

test("a host that answers a probe but refused the request is a policy refusal", () => {
  // The exact shape of the incident: mediator up, endpoint healthy for a
  // native client, extension origin absent from `cors_allow_origin`.
  const d = classifyTransportFailure({
    error: FETCH_FAILURE,
    reachable: "reachable",
    host: "https://mediator.example",
    origin: "chrome-extension://abc",
  });
  assert.equal(d.code, TRANSPORT_DIAGNOSIS.originNotAllowed);
  // The origin has to appear verbatim — an operator pastes it into a config.
  assert.match(d.detail, /chrome-extension:\/\/abc/);
  assert.match(d.remediation ?? "", /cors_allow_origin/);
});

test("the remediation does not promise a fix the wallet cannot deliver", () => {
  // A host permission exempts the REST handshake but not the WebSocket
  // upgrade, which the mediator checks server-side. Telling someone to grant
  // a permission would send them down a path that half-works.
  const d = classifyTransportFailure({ error: FETCH_FAILURE, reachable: "reachable" });
  assert.doesNotMatch(d.remediation ?? "", /permission/i);
  assert.match(d.remediation ?? "", /WebSocket/);
});

test("a host that answers nothing is unreachable, not refused", () => {
  const d = classifyTransportFailure({
    error: FETCH_FAILURE,
    reachable: "unreachable",
    host: "https://mediator.example",
  });
  assert.equal(d.code, TRANSPORT_DIAGNOSIS.unreachable);
});

test("without a probe the failure is not guessed at", () => {
  // Claiming a cause on no evidence is how a diagnostic starts misleading
  // people; `unknown` is the honest answer and still beats `Failed to fetch`.
  const d = classifyTransportFailure({ error: FETCH_FAILURE, reachable: "unprobed" });
  assert.equal(d.code, TRANSPORT_DIAGNOSIS.unknown);
});

test("an error that is not a network failure means the mediator answered", () => {
  // `authenticateToMediator` throws a descriptive Error when the mediator
  // replies with a refusal. That is not a connectivity story and must not be
  // told as one — and the mediator's own words survive.
  const d = classifyTransportFailure({
    error: new Error("mediator-auth: challenge response missing session_id"),
    reachable: "reachable",
  });
  assert.equal(d.code, TRANSPORT_DIAGNOSIS.rejected);
  assert.match(d.detail, /missing session_id/);
});

test("a timeout is its own cause, not a refusal", () => {
  // Reachability says "reachable" here precisely because a probe that lands
  // must not turn a slow host into an accusation about its CORS config.
  const timeout = new DOMException("The operation timed out.", "TimeoutError");
  const d = classifyTransportFailure({ error: timeout, reachable: "reachable" });
  assert.equal(d.code, TRANSPORT_DIAGNOSIS.timeout);
});

test("probe reports reachable when anything answers at all", async () => {
  // Opaque responses carry no status, so the probe must not try to read one.
  // A 405 from a POST-only auth route is a perfectly good "yes, I am here".
  const calls: Array<[string, RequestInit | undefined]> = [];
  const fake = (async (url: string | URL | Request, init?: RequestInit) => {
    calls.push([String(url), init]);
    // A real Response, not an `{ ok }` literal (see CLAUDE.md). 405 is what
    // the mediator's POST-only auth route actually answers a GET with — and
    // the probe must not care, because an opaque response has no readable
    // status at all. Note `status: 0` is not constructible here; a stub that
    // tried it would throw and be misread as a broken probe.
    return new Response(null, { status: 405 });
  }) as unknown as typeof fetch;

  assert.equal(await probeReachable("https://mediator.example/auth", fake), "reachable");
  assert.equal(calls[0]?.[0], "https://mediator.example/auth");
  assert.equal(calls[0]?.[1]?.mode, "no-cors");
  // A cached opaque response would answer for a host that has since gone away.
  assert.equal(calls[0]?.[1]?.cache, "no-store");
});

test("probe reports unreachable when the request never lands", async () => {
  const fake = (async () => {
    throw new TypeError("Failed to fetch");
  }) as unknown as typeof fetch;
  assert.equal(await probeReachable("https://mediator.example/auth", fake), "unreachable");
});

test("a probe that cannot run says so rather than blaming the host", async () => {
  const fake = (async () => {
    throw new Error("probe misconfigured");
  }) as unknown as typeof fetch;
  assert.equal(await probeReachable("https://mediator.example/auth", fake), "unprobed");
});

test("originOf keeps the scheme and drops the path", () => {
  assert.equal(originOf("https://mediator.example/mediator/v1/authenticate"), "https://mediator.example");
  assert.equal(originOf("not a url"), undefined);
  assert.equal(originOf(undefined), undefined);
});
