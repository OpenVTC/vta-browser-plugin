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
import { memoResolveDidDocumentAt } from "../dist/did/index.js";
import { DidVersionNotFoundError } from "@openvtc/vti-didcomm-js";

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
  // trust-tasks-tf #1027: what a reader shows a record as, what it answers, and when it was written and edited.
  kind: { good: ["note", "message", "reaction", "poll", "a".repeat(64)], bad: ["Message", "chat-message", "", "a".repeat(65), 1] },
  inReplyTo: {
    good: [{ key: "k0" }, { key: "k0", version: 2 }],
    bad: ["k0", {}, { key: "" }, { key: "k0", version: 0 }, { key: "k0", extra: 1 }, { key: "x".repeat(513) }],
  },
  writtenAt: { good: ["2026-11-01T10:00:00Z", "2026-11-01T10:00:00.123Z"], bad: ["2026-11-01T10:00:00+02:00", "2026-11-01", "now", 1] },
  editedAt: { good: ["2026-11-02T10:00:00Z"], bad: ["2026-11-02T10:00:00+00:00", "2026-11-02T10:00:00z", 1] },
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
    good: [
      PROFILE,
      { ...PROFILE, padding: "   ", ext: { "org.example.x": 1 } },
      // A profile that turns the #1027 members on is read, not refused.
      { ...PROFILE, profile: { ...PROFILE.profile, recordMembers: ["kind", "inReplyTo", "writtenAt", "editedAt"] } },
    ],
    bad: [
      { ...PROFILE, authority: [] },
      { ...PROFILE, issuedAt: "yesterday" },
      { ...PROFILE, profile: { name: "" } },
      { ...PROFILE, profile: { name: "P", tags: ["Not Lower"] } },
      { ...PROFILE, extra: 1 },
      { ...PROFILE, profile: { name: "P", recordMembers: [] } },
      { ...PROFILE, profile: { name: "P", recordMembers: ["kind", "kind"] } },
      { ...PROFILE, profile: { name: "P", recordMembers: ["Kind"] } },
      { ...PROFILE, ext: { bad: 1 } },
    ],
  },
};

test("the allow-list is SealedRecordBody's released members, exactly", () => {
  assert.deepEqual(
    [...RECORD_BODY_MEMBERS].sort(),
    [
      "author", "basis", "body", "confidence", "description", "editedAt", "evidence", "file", "inReplyTo", "key",
      "kind", "roomId", "roomProfile", "tags", "title", "validFor", "validUntil", "version", "writtenAt",
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

// A member the released schema does not name is refused: a reader shows nothing
// rather than something it does not understand.
for (const member of ["extra", "replyTo", "reactions"]) {
  test(`${member}: a member outside the released schema is refused`, async () => {
    await assert.rejects(
      verifyRecordBody(await signedWith({ [member]: "x" }), AT, undefined),
      refusedAs("malformed"),
    );
  });
}

test("a profile record carries none of a record's members", async () => {
  for (const member of [
    "title", "description", "body", "tags", "kind", "inReplyTo", "writtenAt", "editedAt", "file", "basis",
    "confidence", "evidence", "validFor", "validUntil",
  ]) {
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

test("signRecordBody writes kind, inReplyTo, writtenAt and editedAt, and what it writes verifies", async () => {
  const body = {
    ...base,
    kind: "message",
    body: "Agreed",
    inReplyTo: { key: "k0", version: 2 },
    writtenAt: "2026-11-01T10:00:00Z",
    editedAt: "2026-11-01T10:05:00Z",
  };
  const verified = await verifyRecordBody(await signRecordBody(body, SIGNER), AT, SIGNER.did);
  for (const m of ["kind", "inReplyTo", "writtenAt", "editedAt"]) assert.deepEqual(verified[m], body[m]);
});

// ── Which DID document (`SealedRecordBody`, rule 2) ─────────────────────────
//
// The proof is checked against the author's document as it stood at the host's
// `bodyStoredAt`. Where that document can be had, a failing proof is refused.
// Where it cannot — a method without history, or no `bodyStoredAt` — the
// current document is used, and a proof failing there is shown as a
// placeholder: a forgery and a key rotated away since look the same.

const WEBVH = "did:webvh:QmAuthor:people.example";
const KEY_NOW = signingIdentityFromSecret(new Uint8Array(32).fill(8));
const KEY_THEN = signingIdentityFromSecret(new Uint8Array(32).fill(9));
/** A did:webvh author signing with `key` as `#key-1`. */
const webvhSigner = (key) => ({ ...key, did: WEBVH, kid: `${WEBVH}#key-1` });
/** The author's document listing `key` as `#key-1` for assertionMethod. */
const documentWith = (key) => ({
  id: WEBVH,
  verificationMethod: [
    { id: `${WEBVH}#key-1`, type: "Multikey", controller: WEBVH, publicKeyMultibase: key.kid.split("#")[1] },
  ],
  assertionMethod: [`${WEBVH}#key-1`],
});
async function signedBy(signer, extra = {}) {
  const doc = { ...AT, author: signer.did, body: "Hello", ...extra };
  await signTrustTask({ envelope: doc, signing: signer, proofPurpose: "assertionMethod" });
  return new TextEncoder().encode(JSON.stringify(doc));
}
const STORED = "2026-10-01T00:00:00Z";

test("a body verifies against the author's document as it stood at bodyStoredAt", async () => {
  // Signed with a key the author has since rotated away.
  const bytes = await signedBy(webvhSigner(KEY_THEN));
  const asked = [];
  const verified = await verifyRecordBody(bytes, AT, undefined, {
    bodyStoredAt: STORED,
    resolveDidAt: async (did, at) => {
      asked.push([did, at]);
      return documentWith(KEY_THEN);
    },
    resolveDid: async () => documentWith(KEY_NOW),
  });
  assert.equal(verified.author, WEBVH);
  assert.deepEqual(asked, [[WEBVH, STORED]]);
});

test("a proof failing against the document as of bodyStoredAt is refused", async () => {
  const bytes = await signedBy(webvhSigner(KEY_NOW));
  await assert.rejects(
    verifyRecordBody(bytes, AT, undefined, {
      bodyStoredAt: STORED,
      resolveDidAt: async () => documentWith(KEY_THEN),
    }),
    (e) => e instanceof RecordBodyError && e.kind === "signature" && !e.placeholder,
  );
});

test("without bodyStoredAt a proof failing against the current document is a placeholder, not a refusal", async () => {
  const bytes = await signedBy(webvhSigner(KEY_THEN));
  await assert.rejects(
    verifyRecordBody(bytes, AT, undefined, { resolveDid: async () => documentWith(KEY_NOW) }),
    (e) => e instanceof RecordBodyError && e.kind === "authorUnverifiable" && e.placeholder,
  );
});

test("where the document as of bodyStoredAt cannot be had, the current one is used and a failure is a placeholder", async () => {
  const bytes = await signedBy(webvhSigner(KEY_THEN));
  await assert.rejects(
    verifyRecordBody(bytes, AT, undefined, {
      bodyStoredAt: STORED,
      resolveDidAt: async () => undefined,
      resolveDid: async () => documentWith(KEY_NOW),
    }),
    (e) => e instanceof RecordBodyError && e.kind === "authorUnverifiable",
  );
  // And one that holds against the current document reads.
  const ok = await verifyRecordBody(await signedBy(webvhSigner(KEY_NOW)), AT, undefined, {
    bodyStoredAt: STORED,
    resolveDidAt: async () => undefined,
    resolveDid: async () => documentWith(KEY_NOW),
  });
  assert.equal(ok.body, "Hello");
});

test("an author whose DID does not resolve is a placeholder", async () => {
  const bytes = await signedBy(webvhSigner(KEY_NOW));
  await assert.rejects(
    verifyRecordBody(bytes, AT, undefined, {
      resolveDid: async () => {
        throw new Error("404");
      },
    }),
    (e) => e instanceof RecordBodyError && e.kind === "authorUnresolvable" && e.placeholder,
  );
});

test("a did:key document never changes, so its failing proof is refused, not a placeholder", async () => {
  const signed = JSON.parse(new TextDecoder().decode(await signedWith({ body: "Original" })));
  signed.body = "Altered";
  await assert.rejects(
    verifyRecordBody(new TextEncoder().encode(JSON.stringify(signed)), AT, undefined),
    (e) => e instanceof RecordBodyError && e.kind === "signature" && !e.placeholder,
  );
});

test("a proof made with another DID's key is refused before anything is resolved", async () => {
  // Signed by SIGNER, naming the webvh author.
  const doc = { ...AT, author: WEBVH, body: "Hello" };
  await signTrustTask({ envelope: doc, signing: SIGNER, proofPurpose: "assertionMethod" });
  let resolved = false;
  await assert.rejects(
    verifyRecordBody(new TextEncoder().encode(JSON.stringify(doc)), AT, undefined, {
      resolveDid: async () => {
        resolved = true;
        return documentWith(KEY_NOW);
      },
    }),
    (e) => e instanceof RecordBodyError && e.kind === "signature",
  );
  assert.equal(resolved, false);
});

// ── An author's history, through `resolveDidDocumentAt` ─────────────────────
//
// The author's log as `@openvtc/vti-didcomm-js` reads it with `versionTime`:
// created with KEY_THEN, rotated to KEY_NOW. The reader resolves through the
// wallet's own `resolveDidDocumentAt` (host guard, `versionTime`, the library's
// `E_DID_VERSION_NOT_FOUND` read by its code) and one memo per batch.

const HISTORIC = "did:webvh:QmHistoric:people.example.org";
const CREATED = "2026-09-01T00:00:00Z";
const ROTATED = "2026-10-15T00:00:00Z";
const BEFORE_ROTATION = "2026-10-01T00:00:00Z";
const historicSigner = (key) => ({ ...key, did: HISTORIC, kid: `${HISTORIC}#key-1` });
const historicDocument = (key) => ({ ...documentWith(key), id: HISTORIC,
  verificationMethod: [{ id: `${HISTORIC}#key-1`, type: "Multikey", controller: HISTORIC, publicKeyMultibase: key.kid.split("#")[1] }],
  assertionMethod: [`${HISTORIC}#key-1`] });
const LOG = [
  { versionTime: CREATED, key: KEY_THEN },
  { versionTime: ROTATED, key: KEY_NOW },
];

/** The library's answer as of a time: the last entry in force, else `DidVersionNotFoundError`. */
function historyResolver() {
  const asked = [];
  const resolve = async (did, { versionTime }) => {
    asked.push([did, versionTime]);
    const inForce = LOG.filter((e) => Date.parse(e.versionTime) <= Date.parse(versionTime)).at(-1);
    if (!inForce) throw new DidVersionNotFoundError(`${did} has no version at ${versionTime}`, { did, versionTime, created: CREATED });
    return { didDocument: historicDocument(inForce.key) };
  };
  return { asked, resolveDidAt: memoResolveDidDocumentAt({ resolve }) };
}
const currentDocument = async () => historicDocument(KEY_NOW);

test("a key rotated away since: a proof made before the rotation verifies as of its bodyStoredAt", async () => {
  const { resolveDidAt } = historyResolver();
  const bytes = await signedBy(historicSigner(KEY_THEN));
  const verified = await verifyRecordBody(bytes, AT, undefined, {
    bodyStoredAt: BEFORE_ROTATION,
    resolveDidAt,
    resolveDid: currentDocument,
  });
  assert.equal(verified.author, HISTORIC);
  // The same body stored after the rotation is not the author's.
  await assert.rejects(
    verifyRecordBody(bytes, AT, undefined, { bodyStoredAt: ROTATED, resolveDidAt: historyResolver().resolveDidAt, resolveDid: currentDocument }),
    (e) => e instanceof RecordBodyError && e.kind === "signature" && !e.placeholder,
  );
});

test("a proof made with a key not yet active at bodyStoredAt is refused, though the current document lists it", async () => {
  const { resolveDidAt } = historyResolver();
  const bytes = await signedBy(historicSigner(KEY_NOW));
  await assert.rejects(
    verifyRecordBody(bytes, AT, undefined, { bodyStoredAt: BEFORE_ROTATION, resolveDidAt, resolveDid: currentDocument }),
    (e) => e instanceof RecordBodyError && e.kind === "signature" && !e.placeholder,
  );
});

test("a bodyStoredAt before the author's DID existed is refused, not a placeholder", async () => {
  const { resolveDidAt } = historyResolver();
  let resolvedNow = false;
  await assert.rejects(
    verifyRecordBody(await signedBy(historicSigner(KEY_THEN)), AT, undefined, {
      bodyStoredAt: "2026-08-01T00:00:00Z",
      resolveDidAt,
      resolveDid: async () => {
        resolvedNow = true;
        return historicDocument(KEY_THEN);
      },
    }),
    (e) => e instanceof RecordBodyError && e.kind === "signature" && !e.placeholder,
  );
  assert.equal(resolvedNow, false, "the current document cannot excuse a body older than the DID");

  // A resolveDidAt that throws the library's code, rather than answering null, is read the same way.
  const coded = Object.assign(new Error("whatever it says"), { code: "E_DID_VERSION_NOT_FOUND" });
  await assert.rejects(
    verifyRecordBody(await signedBy(historicSigner(KEY_THEN)), AT, undefined, {
      bodyStoredAt: "2026-08-01T00:00:00Z",
      resolveDidAt: async () => Promise.reject(coded),
    }),
    (e) => e instanceof RecordBodyError && e.kind === "signature" && !e.placeholder,
  );
  // Matched on the code, never the words: the same words without it are a resolution failure.
  await assert.rejects(
    verifyRecordBody(await signedBy(historicSigner(KEY_THEN)), AT, undefined, {
      bodyStoredAt: "2026-08-01T00:00:00Z",
      resolveDidAt: async () => Promise.reject(new Error("E_DID_VERSION_NOT_FOUND")),
    }),
    (e) => e instanceof RecordBodyError && e.kind === "authorUnresolvable" && e.placeholder,
  );
});

test("one batch resolves each author's history once per instant", async () => {
  const { asked, resolveDidAt } = historyResolver();
  const bodies = await Promise.all(["a", "b", "c"].map((body) => signedBy(historicSigner(KEY_THEN), { body })));
  const read = await Promise.all(
    bodies.map((bytes) => verifyRecordBody(bytes, AT, undefined, { bodyStoredAt: BEFORE_ROTATION, resolveDidAt })),
  );
  assert.deepEqual(read.map((b) => b.body), ["a", "b", "c"]);
  assert.deepEqual(asked, [[HISTORIC, BEFORE_ROTATION]]);
});
