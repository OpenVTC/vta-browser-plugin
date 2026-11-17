// `didHost` — the host a DID names, whatever its method.
//
// The wallet asked `didWebvhDomain` which host to request access to when
// onboarding an agent, and got `undefined` for a did:webs agent: no grant was
// asked for, and its first REST call was refused by the browser as CORS.

import { test } from "node:test";
import assert from "node:assert/strict";

import { didHost } from "../dist/did/index.js";

test("each host-naming method yields its host", () => {
  assert.equal(didHost("did:webvh:QmScid:vta.example.org:agents:a"), "vta.example.org");
  assert.equal(didHost("did:webs:webvh.storm.ws:nodes:EJdeTq8v1SPknlbBkCXj"), "webvh.storm.ws");
  assert.equal(didHost("did:scid:vh:1:QmScid?src=dids.example.org/farm"), "dids.example.org");
});

test("a port stays percent-encoded, as the webvh helper leaves it", () => {
  assert.equal(didHost("did:webs:localhost%3A8000:people:EAid"), "localhost%3A8000");
});

test("a DID that names no host yields none", () => {
  for (const did of [
    "did:key:z6MkhaXgBZDvotDkL5257faiztiGiC2QtKLGpbnnEGta2doK",
    "did:peer:2.Ez6LS",
    "did:scid:vh:1:QmScid",
    "did:scid:vh:1:QmScid?src=a.example&x=1",
    "did:webs:example.org",
  ]) {
    assert.equal(didHost(did), undefined, did);
  }
});
