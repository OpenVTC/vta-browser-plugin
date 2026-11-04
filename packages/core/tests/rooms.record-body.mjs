// The sealed record body's members: exactly `SealedRecordBody`'s at
// `rooms/_shared/0.2`, each with the shape the schema gives it.
//
// A reader refuses an unknown member, so this list decides which honest records
// a member can read at all. Every released member is accepted here, each with a
// shape the schema refuses; members of an unreleased draft are refused.

import { test } from "node:test";
import assert from "node:assert/strict";

import {
  RECORD_BODY_MEMBERS,
  RecordBodyError,
  readSealedVersion,
  signRecordBody,
  verifyRecordBody,
} from "../dist/rooms/index.js";
import * as files from "../dist/rooms/files.js";
import { signingIdentityFromSecret } from "../dist/siop/index.js";
import { signTrustTask } from "../dist/trust-tasks/sign.js";

const ROOM = "did:webvh:QmRoom:rooms.example";
const SIGNER = signingIdentityFromSecret(new Uint8Array(32).fill(4));
const AT = { roomId: ROOM, key: "k1", version: 3 };
const base = { ...AT, author: SIGNER.did };

/** Sign `extra` on top of a minimal body, directly — so the signature holds and only the shape is judged. */
async function signedWith(extra) {
  const doc = { ...base, ...extra };
  await signTrustTask({ envelope: doc, signing: SIGNER, proofPurpose: "assertionMethod" });
  return new TextEncoder().encode(JSON.stringify(doc));
}

const refusedAs = (kind) => (e) => e instanceof RecordBodyError && e.kind === kind;

const PROFILE = {
  profile: { name: "Planning", description: "Where we plan", tags: ["ops", "q3-plan"], emoji: "📋" },
  issuedAt: "2026-11-01T10:00:00Z",
  authority: ["eyJhbGciOi.credential"],
};

// Each released member, a value the schema accepts, and values it refuses.
const MEMBERS = {
  title: { good: ["Term sheet"], bad: [7, "x".repeat(513)] },
  description: { good: ["Notes"], bad: [false, "x".repeat(2049)] },
  body: { good: ["# Markdown"], bad: [{}] },
  tags: { good: [["a", "b"]], bad: ["a", [1], Array.from({ length: 33 }, () => "t"), ["x".repeat(65)]] },
  basis: { good: ["declared", "observed", "verified", "inferred"], bad: ["certain", 1] },
  confidence: { good: [0, 0.5, 1], bad: [-0.1, 1.1, "0.5"] },
  evidence: {
    good: [
      [{ kind: "record", key: "k0" }],
      [{ kind: "record", key: "k0", version: 2, roomId: "did:webvh:QmOther:rooms.example" }],
      [{ kind: "credential", credentialId: "urn:uuid:1" }],
      [{ kind: "credential", credentialId: "urn:uuid:1", digest: "zQmbWqxBEKC3P8tqsKc98xmWNzrzDtRLMiMPL8wBuTGsMnR" }],
    ],
    bad: [
      [],
      [{ kind: "record" }],
      [{ kind: "record", key: "k0", extra: 1 }],
      [{ kind: "record", key: "k0", roomId: "not-a-did" }],
      [{ kind: "credential", credentialId: "urn:uuid:1", digest: "short" }],
      [{ kind: "link", href: "https://example.com" }],
      Array.from({ length: 33 }, () => ({ kind: "record", key: "k0" })),
    ],
  },
  validFor: {
    good: [{ purposes: ["https://w3id.org/dpv#ServicePersonalisation"] }, { note: "instructional use only" }],
    bad: [{}, { purposes: [] }, { purposes: ["not an iri"] }, { purposes: ["a:b", "a:b"] }, { note: "" }, { other: 1 }],
  },
  validUntil: { good: ["2027-01-01T00:00:00Z", "2027-01-01T00:00:00.5+02:00"], bad: ["2027-01-01", "tomorrow", 1] },
  file: { good: [{ name: "a.pdf", size: 1, blobRef: "zQmBlob" }], bad: ["a.pdf", null] },
  roomProfile: {
    good: [PROFILE, { ...PROFILE, padding: "   ", ext: { "org.example.x": 1 } }],
    bad: [
      { ...PROFILE, authority: [] },
      { ...PROFILE, issuedAt: "yesterday" },
      { ...PROFILE, profile: { name: "" } },
      { ...PROFILE, profile: { name: "P", tags: ["Not Lower"] } },
      { ...PROFILE, extra: 1 },
      { ...PROFILE, ext: { bad: 1 } },
    ],
  },
};

test("the allow-list is SealedRecordBody's released members, exactly", () => {
  assert.deepEqual(
    [...RECORD_BODY_MEMBERS].sort(),
    [
      "author", "basis", "body", "confidence", "description", "evidence", "file", "key",
      "roomId", "roomProfile", "tags", "title", "validFor", "validUntil", "version",
    ],
  );
  // Every member this file tests is on the list, and every optional member on the list is tested.
  const required = ["roomId", "key", "version", "author"];
  assert.deepEqual(
    RECORD_BODY_MEMBERS.filter((m) => !required.includes(m)).sort(),
    Object.keys(MEMBERS).sort(),
  );
});

for (const [member, { good, bad }] of Object.entries(MEMBERS)) {
  test(`${member}: a released member verifies with a value the schema accepts`, async () => {
    for (const value of good) {
      const verified = await verifyRecordBody(await signedWith({ [member]: value }), AT, SIGNER.did);
      assert.deepEqual(verified[member], value, `${member} = ${JSON.stringify(value)}`);
    }
  });
  test(`${member}: a value the schema refuses is refused as malformed`, async () => {
    for (const value of bad) {
      await assert.rejects(
        verifyRecordBody(await signedWith({ [member]: value }), AT, undefined),
        refusedAs("malformed"),
        `${member} = ${JSON.stringify(value).slice(0, 60)}`,
      );
    }
  });
}

// Members of an open draft (trust-tasks-tf #1027) are not released: a reader
// that predates them refuses them, which shows nothing rather than something wrong.
for (const member of ["kind", "inReplyTo", "writtenAt", "editedAt", "extra"]) {
  test(`${member}: a member outside the released schema is refused`, async () => {
    await assert.rejects(
      verifyRecordBody(await signedWith({ [member]: "x" }), AT, undefined),
      refusedAs("malformed"),
    );
  });
}

test("a profile record carries none of a record's members", async () => {
  for (const member of ["title", "description", "body", "tags", "file", "basis", "confidence", "evidence", "validFor", "validUntil"]) {
    const value = MEMBERS[member].good[0];
    await assert.rejects(
      verifyRecordBody(await signedWith({ roomProfile: PROFILE, [member]: value }), AT, undefined),
      refusedAs("malformed"),
      member,
    );
  }
});

test("signRecordBody writes the provenance members, and what it writes verifies", async () => {
  const body = {
    ...base,
    body: "Venue booked",
    basis: "observed",
    confidence: 0.8,
    evidence: [{ kind: "record", key: "booking" }],
    validFor: { note: "planning only" },
    validUntil: "2027-01-01T00:00:00Z",
  };
  const verified = await verifyRecordBody(await signRecordBody(body, SIGNER), AT, SIGNER.did);
  for (const m of ["basis", "confidence", "evidence", "validFor", "validUntil"]) assert.deepEqual(verified[m], body[m]);
});

test("the verifier is the same one through rooms/files", () => {
  assert.equal(files.verifyRecordBody, verifyRecordBody);
  assert.equal(files.signRecordBody, signRecordBody);
});

test("readSealedVersion: the agent's sealedAt, else the record's version, never above it", () => {
  assert.equal(readSealedVersion({ version: 9 }), 9);
  assert.equal(readSealedVersion({ version: 9, ext: { "org.openvtc.rooms": { member: "did:key:z" } } }), 9);
  assert.equal(readSealedVersion({ version: 9, ext: { "org.openvtc.rooms": { sealedAt: 4 } } }), 4);
  assert.throws(() => readSealedVersion({ version: 9, ext: { "org.openvtc.rooms": { sealedAt: 10 } } }));
  assert.throws(() => readSealedVersion({ version: 9, ext: { "org.openvtc.rooms": { sealedAt: 0 } } }));
  assert.throws(() => readSealedVersion({ version: 9, ext: { "org.openvtc.rooms": { sealedAt: "4" } } }));
});
