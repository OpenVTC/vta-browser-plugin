// Three-stage agent-name resolution — see src/agent-name-resolve.ts.
//
// The test that matters most is the last one: a redirect alone must never be
// enough. Anyone controlling a domain can point a name at somebody else's DID,
// so the document has to claim the name back or resolution fails outright.

import test from "node:test";
import assert from "node:assert/strict";
import {
  resolveAgentName,
  AgentNameError,
  AGENT_NAME_INVALID,
  AGENT_NAME_INSECURE,
  AGENT_NAME_NO_REDIRECT,
  AGENT_NAME_UNRESOLVABLE,
  AGENT_NAME_NOT_AUTHORIZED,
} from "../src/agent-name.ts";

const DID = "did:webvh:QmScid:example.com";

const deps = (over: Record<string, unknown> = {}) => ({
  fetchRedirect: async () => ({ status: 302, location: DID }),
  resolveDid: async () => ({ resolved: true, alsoKnownAs: ["https://example.com/@alice"] }),
  ...over,
}) as never;

async function codeOf(fn: () => Promise<unknown>): Promise<string> {
  try {
    await fn();
    return "no-error";
  } catch (e) {
    return e instanceof AgentNameError ? e.code : `unexpected: ${String(e)}`;
  }
}

test("a name whose document claims it back resolves", () => {
  return resolveAgentName("example.com/@alice", deps()).then((r) => {
    assert.equal(r.did, DID);
    assert.equal(r.name.canonical, "https://example.com/@alice");
  });
});

test("cosmetic spellings still verify", async () => {
  // The typed form is canonicalised before being compared with the document.
  const r = await resolveAgentName("EXAMPLE.COM/@alice/", deps());
  assert.equal(r.did, DID);
});

test("a redirect alone is not enough — the document must claim the name", async () => {
  // The whole point of stage 3. evil.com can redirect anywhere; only the DID's
  // controller can add an alsoKnownAs entry.
  assert.equal(
    await codeOf(() =>
      resolveAgentName("example.com/@alice", deps({
        resolveDid: async () => ({ resolved: true, alsoKnownAs: ["https://example.com/@someone-else"] }),
      })),
    ),
    AGENT_NAME_NOT_AUTHORIZED,
  );
});

test("a document with no alsoKnownAs claims nothing", async () => {
  assert.equal(
    await codeOf(() =>
      resolveAgentName("example.com/@alice", deps({ resolveDid: async () => ({ resolved: true }) })),
    ),
    AGENT_NAME_NOT_AUTHORIZED,
  );
});

test("plain HTTP is refused before any request is made", async () => {
  let called = false;
  const code = await codeOf(() =>
    resolveAgentName("http://example.com/@alice", deps({
      fetchRedirect: async () => {
        called = true;
        return { status: 302, location: DID };
      },
    })),
  );
  assert.equal(code, AGENT_NAME_INSECURE);
  assert.equal(called, false, "must not hit the network for an http name");
});

test("a non-redirect response fails", async () => {
  assert.equal(
    await codeOf(() =>
      resolveAgentName("example.com/@alice", deps({
        fetchRedirect: async () => ({ status: 404, location: null }),
      })),
    ),
    AGENT_NAME_NO_REDIRECT,
  );
  // A 200 is just as wrong as a 404: the Location header is the answer.
  assert.equal(
    await codeOf(() =>
      resolveAgentName("example.com/@alice", deps({
        fetchRedirect: async () => ({ status: 200, location: null }),
      })),
    ),
    AGENT_NAME_NO_REDIRECT,
  );
});

test("a redirect to something that is not a DID fails", async () => {
  assert.equal(
    await codeOf(() =>
      resolveAgentName("example.com/@alice", deps({
        fetchRedirect: async () => ({ status: 302, location: "https://example.com/login" }),
      })),
    ),
    AGENT_NAME_NO_REDIRECT,
  );
});

test("an unresolvable DID fails, naming the DID", async () => {
  assert.equal(
    await codeOf(() =>
      resolveAgentName("example.com/@alice", deps({
        resolveDid: async () => ({ resolved: false, error: "log chain broken" }),
      })),
    ),
    AGENT_NAME_UNRESOLVABLE,
  );
});

test("input that is not an agent name is rejected without a request", async () => {
  assert.equal(await codeOf(() => resolveAgentName("did:webvh:x:y", deps())), AGENT_NAME_INVALID);
  assert.equal(await codeOf(() => resolveAgentName("alice@example.com", deps())), AGENT_NAME_INVALID);
});

test("errors name both halves of the binding", async () => {
  // "Verification failed" is unactionable; the user needs to know which side
  // to go and fix.
  try {
    await resolveAgentName("example.com/@alice", deps({
      resolveDid: async () => ({ resolved: true, alsoKnownAs: [] }),
    }));
    assert.fail("should have thrown");
  } catch (e) {
    const msg = (e as Error).message;
    assert.match(msg, /example\.com\/@alice/);
    assert.match(msg, /did:webvh:QmScid:example\.com/);
    assert.match(msg, /alsoKnownAs/);
  }
});
