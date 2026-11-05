// A DID document as it stood at an instant (`resolveDidDocumentAt`): the host
// guard first, `versionTime` to the resolver, the library's "no version then"
// read as `null` by its code, `undefined` for a method without history, and a
// memo that answers each DID and instant once.

import { test } from "node:test";
import assert from "node:assert/strict";
import { DidVersionNotFoundError } from "@openvtc/vti-didcomm-js";

import {
  isBlockedEndpointError,
  isDidVersionNotFound,
  memoResolveDidDocumentAt,
  resolveDidDocumentAt,
} from "../dist/did/index.js";

const WEBVH = "did:webvh:QmAuthor:people.example.org";
const SCID = "did:scid:vh:1:QmXa7Rk2ZpLwT9vNc4HbYe1Jd8sMfU3qGo6PtVnEyKiBhW";
const T = "2026-10-01T00:00:00Z";

/** A resolver that records what it was asked and answers with a document naming the instant. */
function recording() {
  const asked = [];
  const resolve = async (did, options) => {
    asked.push([did, options]);
    return { didDocument: { id: did, at: options.versionTime } };
  };
  return { asked, resolve };
}

test("did:webvh and did:scid:vh:1 resolve with versionTime", async () => {
  const r = recording();
  assert.deepEqual(await resolveDidDocumentAt(WEBVH, T, r), { id: WEBVH, at: T });
  const scidUrl = `${SCID}?src=dids.example.org/alice`;
  assert.deepEqual(await resolveDidDocumentAt(scidUrl, T, r), { id: scidUrl, at: T });
  // A bare did:scid names no host: it resolves through a source the resolver vetted.
  assert.deepEqual(await resolveDidDocumentAt(SCID, T, r), { id: SCID, at: T });
  assert.deepEqual(r.asked, [
    [WEBVH, { versionTime: T }],
    [scidUrl, { versionTime: T }],
    [SCID, { versionTime: T }],
  ]);
});

test("a method without history answers undefined and resolves nothing", async () => {
  const r = recording();
  for (const did of ["did:key:z6MkhaXgBZDvotDkL5257faiztiGiC2QtKLGpbnnEGta2doK", "did:peer:2.Ez6LS", "did:web:example.org"]) {
    assert.equal(await resolveDidDocumentAt(did, T, r), undefined, did);
  }
  assert.deepEqual(r.asked, []);
});

test("the host guard runs before anything is resolved", async () => {
  const r = recording();
  for (const did of ["did:webvh:QmA:localhost", "did:webvh:QmA:127.0.0.1", `${SCID}?src=10.0.0.1/alice`]) {
    await assert.rejects(resolveDidDocumentAt(did, T, r), (e) => isBlockedEndpointError(e), did);
  }
  assert.deepEqual(r.asked, []);
});

test("an instant before the DID's first entry is null, matched on the code", async () => {
  const created = "2026-09-01T00:00:00Z";
  const before = async (did, { versionTime }) => {
    throw new DidVersionNotFoundError(`${did} did not exist at ${versionTime}`, { did, versionTime, created });
  };
  assert.equal(await resolveDidDocumentAt(WEBVH, "2026-08-01T00:00:00Z", { resolve: before }), null);

  // The code decides, not the class or the words.
  const coded = Object.assign(new Error("anything"), { code: "E_DID_VERSION_NOT_FOUND" });
  assert.equal(await resolveDidDocumentAt(WEBVH, T, { resolve: async () => Promise.reject(coded) }), null);
  const worded = new Error("no version of the DID in force at that time");
  await assert.rejects(resolveDidDocumentAt(WEBVH, T, { resolve: async () => Promise.reject(worded) }), worded);
  assert.equal(isDidVersionNotFound(worded), false);
});

test("a resolution with no document throws", async () => {
  await assert.rejects(resolveDidDocumentAt(WEBVH, T, { resolve: async () => ({}) }), /could not resolve/);
});

test("the memo answers each DID and instant once", async () => {
  const r = recording();
  const at = memoResolveDidDocumentAt(r);
  const later = "2026-10-02T00:00:00Z";
  const answers = await Promise.all([at(WEBVH, T), at(WEBVH, T), at(WEBVH, later), at(WEBVH, T)]);
  assert.deepEqual(answers.map((d) => d.at), [T, T, later, T]);
  assert.deepEqual(r.asked, [
    [WEBVH, { versionTime: T }],
    [WEBVH, { versionTime: later }],
  ]);
  // A second memo is a second batch: it asks again.
  await memoResolveDidDocumentAt(r)(WEBVH, T);
  assert.equal(r.asked.length, 3);
});

test("the memo keeps a failure for its batch too", async () => {
  let calls = 0;
  const at = memoResolveDidDocumentAt({
    resolve: async () => {
      calls += 1;
      throw new Error("offline");
    },
  });
  await assert.rejects(at(WEBVH, T), /offline/);
  await assert.rejects(at(WEBVH, T), /offline/);
  assert.equal(calls, 1);
});
