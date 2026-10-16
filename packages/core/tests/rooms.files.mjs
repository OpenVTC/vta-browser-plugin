// Room files: the host's blob tasks, one file's key from the member's VTA, and
// the signed record body a file's manifest lives in.
//
// The body tests are the ones that matter most. A file's manifest is believed
// only through its author's signature, and the same body is written and read
// by the Rust clients (`vtc-client::rooms::body`) — so a body signed there is
// verified here, from a fixture, and one signed here was verified there when
// the fixture was made.

import { test } from "node:test";
import assert from "node:assert/strict";

import {
  readChunkReply,
  roomsBlobsUploadChunk,
  roomsKeysFileKey,
  sameDigest,
  signRecordBody,
  verifyRecordBody,
  RecordBodyError,
} from "../dist/rooms/files.js";
import { signingIdentityFromSecret } from "../dist/siop/index.js";
import { signTrustTask } from "../dist/trust-tasks/sign.js";

const HOLDER = { did: "did:key:zMember" };
const AGENT = { did: "did:webvh:QmAgent:agent.example" };
const HOST = { did: "did:webvh:QmHost:host.example" };
const ROOM = "did:webvh:QmRoom:rooms.example";

const b64url = (bytes) => Buffer.from(bytes).toString("base64url");

/** Captures the envelope instead of sending it, and replies with `reply`. */
function recorder(reply) {
  const sent = [];
  return {
    sent,
    send(envelope, opts) {
      sent.push({ envelope, opts });
      return Promise.resolve(typeof reply === "function" ? reply(envelope) : reply);
    },
  };
}

// ── file-key ────────────────────────────────────────────────────────────────

test("file-key goes to the member's own VTA, and `seal` names no epoch", async () => {
  const channel = recorder({ key: b64url(new Uint8Array(32).fill(1)), epoch: 4 });
  const got = await roomsKeysFileKey(channel, {
    holder: HOLDER, service: AGENT, roomId: ROOM, fileId: "f", purpose: "seal",
  });
  const { envelope } = channel.sent[0];
  assert.equal(envelope.recipient, AGENT.did);
  assert.deepEqual(envelope.payload, { roomId: ROOM, fileId: "f", purpose: "seal" });
  assert.equal(got.epoch, 4, "the uploader writes the epoch the VTA sealed under");
});

test("a file key that is not 32 bytes is named as the VTA's", async () => {
  const channel = recorder({ key: b64url(new Uint8Array(16)), epoch: 1 });
  await assert.rejects(
    roomsKeysFileKey(channel, { holder: HOLDER, service: AGENT, roomId: ROOM, fileId: "f", purpose: "seal" }),
    /did:webvh:QmAgent.*16 bytes/,
  );
});

// A key for another epoch would open nothing, and the failure would surface as
// a corrupt file rather than as the VTA answering the wrong question.
test("opening refuses a key released for a different epoch", async () => {
  const channel = recorder({ key: b64url(new Uint8Array(32)), epoch: 5 });
  await assert.rejects(
    roomsKeysFileKey(channel, {
      holder: HOLDER, service: AGENT, roomId: ROOM, fileId: "f", purpose: "open", epoch: 3,
    }),
    /epoch 5 to open a file sealed under 3/,
  );
});

// ── the host ────────────────────────────────────────────────────────────────

test("an upload chunk travels as base64url, under 0.2, signed by whoever the channel signs as", async () => {
  const data = new Uint8Array([0, 1, 2, 250, 251, 252]);
  const up = recorder({ uploadId: "u", index: 0, stored: true, remainingCount: 0, expiresAt: "x" });
  await roomsBlobsUploadChunk(up, {
    holder: HOLDER, service: HOST, uploadId: "u", index: 0, digestMultibase: "zD", data,
  });
  assert.equal(up.sent[0].envelope.payload.data, b64url(data));
  assert.equal(up.sent[0].envelope.recipient, HOST.did);
  assert.match(up.sent[0].envelope.type, /rooms\/blobs\/upload\/chunk\/0\.2$/);
});

test("a download chunk comes back as bytes, and one answered for another index is refused", () => {
  const data = new Uint8Array([0, 1, 2, 250, 251, 252]);
  const got = readChunkReply(HOST.did, 2, { index: 2, digestMultibase: "zD", data: b64url(data) });
  assert.deepEqual([...got.data], [...data]);
  assert.throws(() => readChunkReply(HOST.did, 0, { index: 1, digestMultibase: "zD", data: "" }), /chunk 1 to a request for 0/);
});

// One digest has two conforming spellings; comparing strings would refuse a
// host that answered in the other one.
test("digests compare as bytes, not spellings", () => {
  const bytes = Buffer.from("1220" + "ab".repeat(32), "hex");
  const base58 = "z" + toBase58(bytes);
  const base64 = "u" + bytes.toString("base64url");
  assert.ok(sameDigest(base58, base64));
  assert.ok(!sameDigest(base58, "u" + Buffer.from("1220" + "cd".repeat(32), "hex").toString("base64url")));
  assert.ok(!sameDigest(base58, "not multibase"));
});

function toBase58(bytes) {
  const alphabet = "123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz";
  let n = BigInt("0x" + Buffer.from(bytes).toString("hex"));
  let out = "";
  while (n > 0n) {
    out = alphabet[Number(n % 58n)] + out;
    n /= 58n;
  }
  for (const b of bytes) {
    if (b !== 0) break;
    out = "1" + out;
  }
  return out;
}

// ── the record body ─────────────────────────────────────────────────────────

const SIGNER = signingIdentityFromSecret(new Uint8Array(32).fill(9));
const AT = { roomId: ROOM, key: "k1", version: 3 };
const FILE = {
  fileId: "AwMDAwMDAwMDAwMDAwMDAwMDAwMDAwMDAwMDAwMDAwM",
  name: "term sheet.pdf",
  mediaType: "application/pdf",
  size: 5,
  digest: "zQmYwAPJzv5CZsnA625s3Xf2nemtYgPpHdWEz79ojWnPbdG",
  epoch: 2,
  segmentSize: 16368,
  blobRef: "zQmYwAPJzv5CZsnA625s3Xf2nemtYgPpHdWEz79ojWnPbdG",
};

const body = (over = {}) => ({ ...AT, author: SIGNER.did, title: "Term sheet", tags: ["deal"], file: FILE, ...over });

test("a body signed here verifies here, and keeps its file manifest", async () => {
  const bytes = await signRecordBody(body(), SIGNER);
  const verified = await verifyRecordBody(bytes, AT, SIGNER.did);
  assert.equal(verified.author, SIGNER.did);
  assert.deepEqual(verified.file, FILE);
});

/** Sign, then let `mutate` change the signed JSON. */
async function tampered(mutate) {
  const signed = JSON.parse(new TextDecoder().decode(await signRecordBody(body(), SIGNER)));
  mutate(signed);
  return new TextEncoder().encode(JSON.stringify(signed));
}

const refusedAs = (kind) => (e) => e instanceof RecordBodyError && e.kind === kind;

// The file manifest is inside the signature, so a host — or another member —
// swapping in a different blob or digest produces a body that does not verify.
test("a changed file manifest breaks the signature", async () => {
  const bytes = await tampered((b) => { b.file.blobRef = "zQmOther"; });
  await assert.rejects(verifyRecordBody(bytes, AT, undefined), refusedAs("signature"));
});

test("a body read from another location is refused as relocated", async () => {
  const bytes = await signRecordBody(body(), SIGNER);
  await assert.rejects(verifyRecordBody(bytes, { ...AT, version: 4 }, undefined), refusedAs("relocated"));
  await assert.rejects(verifyRecordBody(bytes, { ...AT, key: "k2" }, undefined), refusedAs("relocated"));
});

test("on an attributed room the signer must be the author the host recorded", async () => {
  const bytes = await signRecordBody(body(), SIGNER);
  await assert.rejects(verifyRecordBody(bytes, AT, "did:key:zSomeoneElse"), refusedAs("authorMismatch"));
});

test("an unknown member is refused, not ignored", async () => {
  // Signed directly, so the signature holds and only the shape is wrong:
  // `signRecordBody` never writes a member the schema does not have.
  const doc = { ...AT, author: SIGNER.did, extra: "x" };
  await signTrustTask({ envelope: doc, signing: SIGNER, proofPurpose: "assertionMethod" });
  const bytes = new TextEncoder().encode(JSON.stringify(doc));
  await assert.rejects(verifyRecordBody(bytes, AT, undefined), refusedAs("malformed"));
});

test("a body is signed only by its author", async () => {
  const other = signingIdentityFromSecret(new Uint8Array(32).fill(3));
  await assert.rejects(signRecordBody(body(), other), refusedAs("signing"));
});

// Signed by `vtc-client::rooms::body::SealedRecordBody::sign` with a did:key
// from seed [7; 32]. If this stops verifying, the two implementations disagree
// about the body's shape or its proof, and a file written by `pnm rooms file
// put` would not open in the extension.
const RUST_SIGNED =
  '{"author":"did:key:z6MkvDqGT54cXesYGvABpF1UapVNwjCqRcafi4Px6Thv5T3Z","file":{"blobRef":"zQmYwAPJzv5CZsnA625s3Xf2nemtYgPpHdWEz79ojWnPbdG","digest":"zQmYwAPJzv5CZsnA625s3Xf2nemtYgPpHdWEz79ojWnPbdG","epoch":2,"fileId":"AwMDAwMDAwMDAwMDAwMDAwMDAwMDAwMDAwMDAwMDAwM","mediaType":"application/pdf","name":"term sheet.pdf","segmentSize":16368,"size":5},"key":"k1","proof":{"created":"2026-10-13T13:38:13Z","cryptosuite":"eddsa-jcs-2022","proofPurpose":"assertionMethod","proofValue":"zJXQ5Kva6yzEz3iHU2N9C3dpNoD2oiMJs4TAqvZ5DVYaiwTTcfBvhcAtH9iRYvtB2iVGMHidZkqX1pME76sGXSwo","type":"DataIntegrityProof","verificationMethod":"did:key:z6MkvDqGT54cXesYGvABpF1UapVNwjCqRcafi4Px6Thv5T3Z#z6MkvDqGT54cXesYGvABpF1UapVNwjCqRcafi4Px6Thv5T3Z"},"roomId":"did:webvh:QmRoom:rooms.example","tags":["deal"],"title":"Term sheet","version":3}';

test("a body the Rust client signed verifies here", async () => {
  const verified = await verifyRecordBody(new TextEncoder().encode(RUST_SIGNED), AT, undefined);
  assert.equal(verified.author, "did:key:z6MkvDqGT54cXesYGvABpF1UapVNwjCqRcafi4Px6Thv5T3Z");
  assert.equal(verified.file.name, "term sheet.pdf");
});
