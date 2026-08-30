// Which persona a site-initiated proxy login uses, and what gets bound on a
// first sign-in — see src/first-use-profile.ts.

import test from "node:test";
import assert from "node:assert/strict";
import {
  buildProfileEntry,
  decideSiteIdentity,
  matchProfileEntry,
  profileLabelFor,
  PROFILE_SECRET_KIND,
} from "../src/first-use-profile.ts";
import type { VaultEntryView } from "../src/bridge-protocol.ts";

const entry = (
  id: string,
  targets: VaultEntryView["targets"],
  over: Partial<VaultEntryView> = {},
): VaultEntryView => ({
  id,
  contextId: "personal",
  targets,
  label: id,
  secretKind: PROFILE_SECRET_KIND,
  createdAt: "2026-01-01T00:00:00Z",
  updatedAt: "2026-01-01T00:00:00Z",
  version: 1,
  ...over,
});

const origin = "https://shop.example";

test("an entry bound to this exact origin is the one used", () => {
  const e = entry("01A", [{ kind: "webOrigin", origin }]);
  assert.equal(matchProfileEntry([e], origin)?.id, "01A");
});

test("a prefix of the origin is NOT a match", () => {
  // The whole reason the match is local: `vault/list` filters by
  // `targetOriginPrefix`, and `https://shop.example` is a prefix of
  // `https://shop.example.evil.test`. A look-alike domain must not inherit the
  // persona the operator bound to the real one.
  const lookalike = entry("01A", [
    { kind: "webOrigin", origin: "https://shop.example.evil.test" },
  ]);
  assert.equal(matchProfileEntry([lookalike], origin), undefined);

  // And the reverse: the real site must not pick up the look-alike's entry.
  const real = entry("01B", [{ kind: "webOrigin", origin }]);
  assert.equal(
    matchProfileEntry([real], "https://shop.example.evil.test"),
    undefined,
  );
});

test("scheme and port are part of the origin", () => {
  const e = entry("01A", [{ kind: "webOrigin", origin: "https://shop.example" }]);
  assert.equal(matchProfileEntry([e], "http://shop.example"), undefined);
  assert.equal(matchProfileEntry([e], "https://shop.example:8443"), undefined);
});

test("entries of another secret kind are never used as a persona", () => {
  // A password entry for the same site is a different thing entirely; proxy
  // login as one would ask the VTA to mint an id_token it holds no key for.
  const pw = entry("01A", [{ kind: "webOrigin", origin }], { secretKind: "password" });
  assert.equal(matchProfileEntry([pw], origin), undefined);
});

test("a DID-targeted entry alone does not answer for an origin", () => {
  // The vault panel's did-self-issued form binds `{kind:"did"}` only, so an
  // entry created there carries no origin. Matching it here would let any page
  // claiming that RP DID pick it up — the origin is what the browser attests.
  const e = entry("01A", [{ kind: "did", did: "did:webvh:abc:rp.example" }]);
  assert.equal(matchProfileEntry([e], origin), undefined);
});

test("the oldest match wins, whatever order the VTA returned them in", () => {
  // An interrupted first-use flow can leave a second entry behind. The one the
  // operator has been signing in with is the one that keeps being used.
  const older = entry("01A", [{ kind: "webOrigin", origin }], {
    createdAt: "2026-01-01T00:00:00Z",
  });
  const newer = entry("01B", [{ kind: "webOrigin", origin }], {
    createdAt: "2026-06-01T00:00:00Z",
  });
  assert.equal(matchProfileEntry([newer, older], origin)?.id, "01A");
  assert.equal(matchProfileEntry([older, newer], origin)?.id, "01A");
});

test("a bound entry carries the origin, and the RP DID when the page named one", () => {
  const body = buildProfileEntry({
    origin,
    did: "did:webvh:scid:agent.example:contexts:personal",
    contextId: "personal",
    signingKeyId: "did:webvh:scid:agent.example:contexts:personal#key-0",
    rpDid: "did:webvh:abc:rp.example",
  });
  assert.deepEqual(body.targets, [
    { kind: "webOrigin", origin },
    { kind: "did", did: "did:webvh:abc:rp.example" },
  ]);
  assert.equal(body.contextId, "personal");
  assert.equal(body.secretKind, PROFILE_SECRET_KIND);
  assert.equal(body.secret?.did, "did:webvh:scid:agent.example:contexts:personal");
  assert.equal(
    body.secret?.signingKeyId,
    "did:webvh:scid:agent.example:contexts:personal#key-0",
  );
  // No id — the maintainer assigns one, so this always creates rather than
  // colliding with a guessed key.
  assert.equal(body.id, undefined);
});

test("without an RP DID the entry is bound to the origin alone", () => {
  const body = buildProfileEntry({
    origin,
    did: "did:webvh:scid:agent.example:contexts:personal",
    contextId: "personal",
    signingKeyId: "did:webvh:scid:agent.example:contexts:personal#key-0",
  });
  assert.deepEqual(body.targets, [{ kind: "webOrigin", origin }]);
});

test("a bound entry is findable by the matcher that will look for it", () => {
  // The round trip is the point: what `buildProfileEntry` writes must be what
  // `matchProfileEntry` reads, or a first sign-in re-prompts forever.
  const body = buildProfileEntry({
    origin,
    did: "did:webvh:scid:agent.example:contexts:personal",
    contextId: "personal",
    signingKeyId: "did:webvh:scid:agent.example:contexts:personal#key-0",
  });
  const stored = entry("01A", body.targets, { secretKind: body.secretKind });
  assert.equal(matchProfileEntry([stored], origin)?.id, "01A");
});

test("the label is the hostname, and never a fabricated one", () => {
  assert.equal(profileLabelFor("https://shop.example"), "shop.example");
  assert.equal(profileLabelFor("https://shop.example:8443"), "shop.example");
  // Unparseable input comes back verbatim rather than as a guess.
  assert.equal(profileLabelFor("not a url"), "not a url");
});

// ─── Which identity a login() at this origin uses ───

test("a bound persona is used, and beats a stale holder choice", () => {
  // The operator once chose the wallet's own identity here, then later bound a
  // persona (through proxyLogin, say). The persona is the more specific
  // statement and the one visible in the vault, so reading the local record
  // first would sign in as an identity the vault contradicts.
  const e = entry("01A", [{ kind: "webOrigin", origin }]);
  assert.deepEqual(decideSiteIdentity([e], origin, true), { kind: "persona", entryId: "01A" });
  assert.deepEqual(decideSiteIdentity([e], origin, false), { kind: "persona", entryId: "01A" });
});

test("the recorded holder choice is honoured when no persona is bound", () => {
  assert.deepEqual(decideSiteIdentity([], origin, true), { kind: "holder" });
});

test("neither recorded means ask — never a silent holder login", () => {
  // The whole point of the change: login() used to sign as the holder here,
  // unconditionally and with no signal, while the wallet told the operator
  // that each site gets its own identity.
  assert.deepEqual(decideSiteIdentity([], origin, false), { kind: "ask" });
});

test("another site's persona does not answer for this one", () => {
  const other = entry("01A", [{ kind: "webOrigin", origin: "https://other.example" }]);
  assert.deepEqual(decideSiteIdentity([other], origin, false), { kind: "ask" });
  assert.deepEqual(decideSiteIdentity([other], origin, true), { kind: "holder" });
});

test("a look-alike origin's entry never satisfies the real one", () => {
  const lookalike = entry("01A", [
    { kind: "webOrigin", origin: "https://shop.example.evil.test" },
  ]);
  assert.deepEqual(decideSiteIdentity([lookalike], origin, false), { kind: "ask" });
});
