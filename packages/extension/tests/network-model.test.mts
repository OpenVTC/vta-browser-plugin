// Site rows for the trust graph — see src/network-model.ts.
//
// The duplication bug these pin: a vault entry and a trust record describe the
// same site but spell it differently, so keying on the raw string drew one
// site as two boxes — one with an identity and no trust, one with trust and no
// identity.

import test from "node:test";
import assert from "node:assert/strict";
import { mergeRpRows, lastActivity, siteTitle, identityUsage } from "../src/network-model.ts";

const hostOf = (s: string) =>
  s.replace(/^https?:\/\//, "").replace(/\/+$/, "").replace(/:\d+$/, "").toLowerCase();

const entry = (over: Record<string, unknown> = {}) =>
  ({
    id: "e1",
    contextId: "work",
    targets: [{ kind: "webOrigin", origin: "https://first.openvtc.net" }],
    label: "First VTC",
    secretKind: "didSelfIssued",
    principalDid: "did:webvh:Qm:host:persona",
    createdAt: "2026-08-01T00:00:00Z",
    updatedAt: "2026-08-01T00:00:00Z",
    version: 1,
    ...over,
  }) as never;

const site = (origin: string, trustedAt = 1000) => ({ origin, trustedAt });

test("an entry and a trust record for one site collapse to one row", () => {
  const rows = mergeRpRows([entry()], [site("https://first.openvtc.net")], hostOf);
  assert.equal(rows.length, 1);
  assert.equal(siteTitle(rows[0]!, hostOf), "first.openvtc.net");
  assert.equal(rows[0]?.principalDid, "did:webvh:Qm:host:persona");
  assert.ok(rows[0]?.trusted, "trust record should be attached, not a separate row");
});

test("cosmetic spelling differences still merge", () => {
  const rows = mergeRpRows([entry()], [site("https://First.OpenVTC.net/")], hostOf);
  assert.equal(rows.length, 1);
  assert.ok(rows[0]?.entry && rows[0]?.trusted);
});

test("a trusted site with no entry still appears, without an identity", () => {
  const rows = mergeRpRows([], [site("https://admin.webvh.storm.ws")], hostOf);
  assert.equal(rows.length, 1);
  assert.equal(siteTitle(rows[0]!, hostOf), "admin.webvh.storm.ws");
  assert.equal(rows[0]?.principalDid, undefined);
});

test("an entry with no trust record appears, and is not marked trusted", () => {
  const rows = mergeRpRows([entry()], [], hostOf);
  assert.equal(rows.length, 1);
  assert.equal(rows[0]?.trusted, undefined);
});

test("an entry with no web target keys on itself and never pairs", () => {
  const rows = mergeRpRows(
    [entry({ id: "e2", targets: [{ kind: "did", did: "did:webvh:Qm:host:other" }] })],
    [site("https://first.openvtc.net")],
    hostOf,
  );
  assert.equal(rows.length, 2);
});

test("rows order most-recently-used first", () => {
  const older = entry({ id: "old", label: "Older", lastUsedAt: "2026-01-01T00:00:00Z",
    targets: [{ kind: "webOrigin", origin: "https://old.example" }] });
  const newer = entry({ id: "new", label: "Newer", lastUsedAt: "2026-08-01T00:00:00Z",
    targets: [{ kind: "webOrigin", origin: "https://new.example" }] });
  const rows = mergeRpRows([older, newer], [], hostOf);
  assert.deepEqual(rows.map((r) => siteTitle(r, hostOf)), ["new.example", "old.example"]);
});

test("lastActivity falls back through the timestamps each source carries", () => {
  assert.equal(lastActivity({ key: "k", trusted: site("https://x", 4242) }), 4242);
  assert.equal(lastActivity({ key: "k" }), 0);
});

test("a DID-targeted entry merges with a trust record that captured that DID", () => {
  // The real duplication: the entry knows only the RP's DID, the trust record
  // knows only its origin, and they share the DID.
  const e = entry({ targets: [{ kind: "did", did: "did:webvh:Qm:host:rp" }] });
  const rows = mergeRpRows(
    [e],
    [{ origin: "https://first.openvtc.net", trustedAt: 1, rpDid: "did:webvh:Qm:host:rp" }],
    hostOf,
  );
  assert.equal(rows.length, 1);
  assert.ok(rows[0]?.entry && rows[0]?.trusted);
  assert.equal(siteTitle(rows[0]!, hostOf), "first.openvtc.net");
});

test("the site is named by its host, not by the credential label", () => {
  const rows = mergeRpRows([entry()], [], hostOf);
  assert.equal(siteTitle(rows[0]!, hostOf), "first.openvtc.net");
  assert.equal(rows[0]?.entry?.label, "First VTC");
});

test("identity reuse is counted across every row", () => {
  // Two entries naming the same principalDid means those sites can correlate
  // you — the UI must not claim otherwise.
  const a = entry({ id: "a", targets: [{ kind: "webOrigin", origin: "https://a.example" }] });
  const b = entry({ id: "b", targets: [{ kind: "webOrigin", origin: "https://b.example" }] });
  const counts = identityUsage(mergeRpRows([a, b], [], hostOf));
  assert.equal(counts.get("did:webvh:Qm:host:persona"), 2);
});

test("a row with no identity is not counted", () => {
  const counts = identityUsage(mergeRpRows([], [site("https://x.example")], hostOf));
  assert.equal(counts.size, 0);
});
