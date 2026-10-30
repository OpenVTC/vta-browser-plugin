// Reading a did:webvh document's did:scid alias.
//
// Three answers, and the two "listed" ones are the reason this is a module: a
// DID URL whose `src` is where the log used to be served still names the SCID,
// and calling it listed would tell the operator a recipient can follow it.

import { test } from "node:test";
import assert from "node:assert/strict";
import { scidAliasOf, scidSourceOf } from "../src/manager/scid-alias.js";

const DID = "did:webvh:QmScid:example.com:rooms:northwind";
const HERE = "did:scid:vh:1:QmScid?src=example.com/rooms/northwind";

test("the source is the DID's location with each colon made a slash", () => {
  assert.deepEqual(scidSourceOf(DID), { scid: "QmScid", src: "example.com/rooms/northwind" });
  // A port stays percent-encoded — decoding it would make a different locator.
  assert.deepEqual(scidSourceOf("did:webvh:QmScid:localhost%3A8000:alice"), {
    scid: "QmScid",
    src: "localhost%3A8000/alice",
  });
  assert.equal(scidSourceOf("did:scid:vh:1:QmScid"), null);
});

test("listed for the current location", () => {
  assert.deepEqual(scidAliasOf(DID, ["did:web:example.com", HERE]), { kind: "listed", url: HERE });
});

test("listed only for an old location, or with no locator, is not listed here", () => {
  const old = "did:scid:vh:1:QmScid?src=old.example/northwind";
  assert.deepEqual(scidAliasOf(DID, [old]), { kind: "elsewhere", urls: [old] });
  assert.deepEqual(scidAliasOf(DID, ["did:scid:vh:1:QmScid"]), {
    kind: "elsewhere",
    urls: ["did:scid:vh:1:QmScid"],
  });
});

test("another SCID — even one this SCID prefixes — is not the alias", () => {
  assert.deepEqual(
    scidAliasOf(DID, ["did:scid:vh:1:QmScidLonger?src=example.com/rooms/northwind", "did:scid:vh:1:QmOther"]),
    { kind: "absent" },
  );
});

test("no alsoKnownAs, or a malformed one, lists nothing", () => {
  assert.deepEqual(scidAliasOf(DID, undefined), { kind: "absent" });
  assert.deepEqual(scidAliasOf(DID, "did:scid:vh:1:QmScid"), { kind: "absent" });
  assert.deepEqual(scidAliasOf(DID, [42, null]), { kind: "absent" });
});
