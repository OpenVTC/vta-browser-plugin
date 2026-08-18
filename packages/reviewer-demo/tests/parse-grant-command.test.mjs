// The paste box is the one place reviewer input reaches a subprocess, so its
// parser is the one piece of this demo worth testing properly.

import { test } from "node:test";
import assert from "node:assert/strict";

process.env.VTA_DID ??= "did:webvh:QmTest:example.com";
process.env.VTA_BASE_URL ??= "https://example.com/api";

const { parseGrantCommand } = await import("../server.mjs");

const DID = "did:key:z6MkhaXgBZDvotDkL5257faiztiGiC2QtKLGpbnnEGta2doK";

test("takes the DID out of the command the wallet prints", () => {
  const r = parseGrantCommand(`pnm acl create --did ${DID} --role admin --expires 1h`);
  assert.equal(r.ok, true);
  assert.equal(r.did, DID);
  assert.equal(r.role, "admin");
});

test("accepts the super-admin variant the wallet prints for context creation", () => {
  const r = parseGrantCommand(`pnm acl create --did ${DID} --role super-admin --expires 1h`);
  assert.equal(r.ok, true);
  assert.equal(r.role, "super-admin");
});

test("accepts a bare DID — copying only that is the likelier mistake", () => {
  const r = parseGrantCommand(`  ${DID}  `);
  assert.equal(r.ok, true);
  assert.equal(r.did, DID);
  assert.equal(r.role, "admin");
});

test("survives a command that wrapped across lines on the way through a UI", () => {
  const r = parseGrantCommand(`pnm acl create \\\n  --did ${DID} \\\n  --role admin --expires 1h`);
  assert.equal(r.ok, true);
  assert.equal(r.did, DID);
});

test("refuses a role this demo does not hand out", () => {
  const r = parseGrantCommand(`pnm acl create --did ${DID} --role owner --expires 1h`);
  assert.equal(r.ok, false);
  assert.match(r.error, /admin/);
});

test("refuses input with no DID in it", () => {
  const r = parseGrantCommand("pnm acl create --role admin --expires 1h");
  assert.equal(r.ok, false);
  assert.match(r.error, /No did:key/);
});

test("refuses empty input", () => {
  assert.equal(parseGrantCommand("").ok, false);
  assert.equal(parseGrantCommand(null).ok, false);
});

test("a DID with shell metacharacters attached is not a DID", () => {
  // base58btc has no `;`, no `$`, no backtick and no space, so an injection
  // attempt cannot pass the pattern — it is rejected as malformed, and the
  // value would go to execFile as a single argv entry even if it did.
  const r = parseGrantCommand(`pnm acl create --did ${DID}; rm -rf / --role admin`);
  assert.equal(r.ok, true);
  assert.equal(r.did, DID, "must capture only the DID, never the trailing shell text");
});

test("ignores the expiry in the pasted command", () => {
  // The site always grants its own (7d); nothing in the parse result carries
  // an expiry, so a pasted `--expires 5m` cannot shorten it.
  const r = parseGrantCommand(`pnm acl create --did ${DID} --role admin --expires 5m`);
  assert.equal(r.ok, true);
  assert.equal(r.expires, undefined);
});
