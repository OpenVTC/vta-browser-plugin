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
  AGENT_NAME_UNREADABLE,
  AGENT_NAME_UNRESOLVABLE,
  AGENT_NAME_NOT_AUTHORIZED,
} from "../src/agent-name.ts";

const DID = "did:webvh:QmScid:example.com";

const deps = (over: Record<string, unknown> = {}) => ({
  fetchName: async () => ({ status: 302, location: DID }),
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
      fetchName: async () => {
        called = true;
        return { status: 302, location: DID };
      },
    })),
  );
  assert.equal(code, AGENT_NAME_INSECURE);
  assert.equal(called, false, "must not hit the network for an http name");
});

test("a response that names no DID fails", async () => {
  assert.equal(
    await codeOf(() =>
      resolveAgentName("example.com/@alice", deps({
        fetchName: async () => ({ status: 404, location: null }),
      })),
    ),
    AGENT_NAME_NO_REDIRECT,
  );
  // A 200 carrying nothing is just as wrong as a 404 — the point is the DID,
  // not the status.
  assert.equal(
    await codeOf(() =>
      resolveAgentName("example.com/@alice", deps({
        fetchName: async () => ({ status: 200, url: "https://example.com/@alice", body: "<html>hi</html>" }),
      })),
    ),
    AGENT_NAME_NO_REDIRECT,
  );
});

test("a redirect to something that is not a DID fails", async () => {
  assert.equal(
    await codeOf(() =>
      resolveAgentName("example.com/@alice", deps({
        fetchName: async () => ({ status: 302, location: "https://example.com/login" }),
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

// ── Stage 1 in browser shape ─────────────────────────────────────────────
//
// A browser cannot read a `Location` header at all: a manual redirect arrives
// as an opaque-redirect response with no headers, and Chrome refuses a `did:`
// target outright. So the extension follows the redirect instead and the DID
// arrives in the landing URL or the body. These cover the shapes the guide's
// permissive redirect contract allows.

test("a followed redirect to a did:webvh log resolves — the browser path", async () => {
  // Exactly what dids.firstperson.dev serves a browser: 302 to a relative
  // `/{mnemonic}/did.jsonl`, whose first line carries the DID in `state.id`.
  const log = [
    JSON.stringify({ versionId: "1-QmX", state: { id: DID, alsoKnownAs: ["https://example.com/@alice"] } }),
    JSON.stringify({ versionId: "2-QmY", state: { id: DID } }),
  ].join("\n");
  const r = await resolveAgentName("example.com/@alice", deps({
    fetchName: async () => ({ status: 200, url: "https://example.com/motion-knife/did.jsonl", body: log }),
  }));
  assert.equal(r.did, DID);
});

test("the DID may arrive as JSON, a query parameter, or a path segment", async () => {
  const shapes: Array<Record<string, unknown>> = [
    { status: 200, url: "https://example.com/@alice", body: JSON.stringify({ did: DID }) },
    { status: 200, url: "https://example.com/@alice", body: JSON.stringify({ id: DID }) },
    { status: 200, url: "https://example.com/@alice", body: JSON.stringify({ didDocument: { id: DID } }) },
    { status: 200, url: "https://example.com/@alice", body: `  ${DID}  ` },
    { status: 200, url: `https://example.com/resolve?did=${encodeURIComponent(DID)}` },
    { status: 200, url: `https://example.com/dids/${encodeURIComponent(DID)}` },
    { status: 302, location: `/resolve?did=${encodeURIComponent(DID)}` },
  ];
  for (const stage1 of shapes) {
    const r = await resolveAgentName("example.com/@alice", deps({ fetchName: async () => stage1 }));
    assert.equal(r.did, DID, `failed for ${JSON.stringify(stage1)}`);
  }
});

test("a landing page that names no DID does not become one", async () => {
  // The landing URL's last segment is not a DID and the body is not JSON:
  // nothing here may be manufactured into a candidate.
  assert.equal(
    await codeOf(() =>
      resolveAgentName("example.com/@alice", deps({
        fetchName: async () => ({
          status: 200,
          url: "https://example.com/profile/alice",
          body: "<!doctype html><title>alice</title>",
        }),
      })),
    ),
    AGENT_NAME_NO_REDIRECT,
  );
});

test("a DID found in stage 1 still has to survive stages 2 and 3", async () => {
  // The permissive extraction is safe only because the candidate is untrusted.
  // A body naming somebody else's DID buys nothing.
  assert.equal(
    await codeOf(() =>
      resolveAgentName("example.com/@alice", deps({
        fetchName: async () => ({
          status: 200,
          url: "https://example.com/other/did.jsonl",
          body: JSON.stringify({ state: { id: "did:webvh:QmOther:example.com" } }),
        }),
        resolveDid: async () => ({ resolved: true, alsoKnownAs: ["https://example.com/@bob"] }),
      })),
    ),
    AGENT_NAME_NOT_AUTHORIZED,
  );
});

test("a transport that cannot read the answer says so with its own code", async () => {
  // What the extension throws when Chrome refuses the `did:` redirect. It must
  // not be reported as "the server did not redirect" — the server did.
  assert.equal(
    await codeOf(() =>
      resolveAgentName("example.com/@alice", deps({
        fetchName: async () => {
          throw new AgentNameError(AGENT_NAME_UNREADABLE, "Could not read example.com/@alice");
        },
      })),
    ),
    AGENT_NAME_UNREADABLE,
  );
});
