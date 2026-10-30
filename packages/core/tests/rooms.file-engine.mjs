// The room-file engine, end to end against the real cipher.
//
// `@openvtc/vti-rooms-wasm` is the build the extension ships, so these runs seal
// and open with the same code a member's browser does. The VTA and the host are
// in-memory fakes that answer the way the Rust ones do; the host fake can be
// told to misbehave in the ways the engine has to catch.

import { test } from "node:test";
import assert from "node:assert/strict";

import * as cipher from "@openvtc/vti-rooms-wasm";

import {
  getRoomFile,
  putRoomFile,
  RoomFileError,
  RoomHostChannel,
  ROOM_FILE_MAX_BYTES,
} from "../dist/rooms/files.js";
import { signingIdentityFromSecret } from "../dist/siop/index.js";
import { signTrustTask } from "../dist/trust-tasks/sign.js";
import { base58btcEncode, jcsCanonicalize, sha256 } from "../dist/trust-tasks/canonical.js";

const ROOM = "did:webvh:QmRoom:rooms.example";
const SIGNER = signingIdentityFromSecret(new Uint8Array(32).fill(9));
/** The member's persona: a key the VTA holds. The wallet (SIGNER) holds none of it. */
const PERSONA = signingIdentityFromSecret(new Uint8Array(32).fill(11));
const VTA_DID = "did:webvh:QmAgent:agent.example";
const HOST_DID = "did:webvh:QmHost:host.example";
const FILE_KEY = Buffer.alloc(32, 7).toString("base64url");
const EPOCH = 2;

const b64u = (bytes) => Buffer.from(bytes).toString("base64url");
const fromB64u = (s) => new Uint8Array(Buffer.from(s, "base64url"));
const slug = (type) => type.replace("https://trusttasks.org/spec/", "");

/** `rooms/keys/act`'s table, as much of it as these flows use. */
const ACTION = {
  "rooms/info/0.3": "read",
  "rooms/records/list/0.5": "read",
  "rooms/records/get/0.2": "read",
  "rooms/records/put/0.3": "write",
  "rooms/records/put/0.4": "write",
  "rooms/blobs/upload/begin/0.2": "write",
  "rooms/blobs/get/0.2": "read",
  "rooms/blobs/chunk/0.1": "read",
};
/** Documents that carry no presentation: their authority is the transfer. */
const NO_PRESENTATION = new Set(["rooms/blobs/chunk/0.1"]);

/** A BlobRef, as the host computes it: the digest of the canonical manifest. */
async function blobRefOf(manifest) {
  const hash = await sha256(jcsCanonicalize(manifest));
  return `z${base58btcEncode(Uint8Array.from([0x12, 0x20, ...hash]))}`;
}

/** The member's VTA: completing as the persona, the file key, and sealing that binds the version. */
function fakeVta() {
  const asked = [];
  return {
    asked,
    sender: {
      async send(envelope) {
        const p = envelope.payload;
        asked.push(slug(envelope.type));
        assert.equal(envelope.issuer, SIGNER.did, "the wallet asks its own VTA");
        switch (slug(envelope.type)) {
          case "rooms/keys/act/0.8":
          case "rooms/keys/act/0.9": {
            const doc = structuredClone(p.document);
            // 0.8's table names put only to 0.3 (Recipient item 1).
            if (slug(envelope.type) === "rooms/keys/act/0.8" && slug(doc.type) === "rooms/records/put/0.4") {
              throw new Error(`rooms/keys/act:typeNotActable ${doc.type}`);
            }
            assert.equal(doc.proof, undefined, "act takes an unsigned document");
            assert.equal(doc.payload.presentation, undefined, "and no presentation");
            const action = ACTION[slug(doc.type)];
            if (!action) throw new Error(`rooms/keys/act:typeNotActable ${doc.type}`);
            if (doc.issuer !== undefined && doc.issuer !== PERSONA.did) throw new Error("rooms/keys/act:issuerNotPrincipal");
            doc.issuer = PERSONA.did;
            if (!NO_PRESENTATION.has(slug(doc.type))) {
              doc.payload.presentation = { membership: "vmc", authority: [`leaf-${action}`, "root"] };
            }
            await signTrustTask({ envelope: doc, signing: PERSONA, proofPurpose: "authentication" });
            return { principal: PERSONA.did, document: doc };
          }
          case "rooms/keys/file-key/0.2":
            return { key: FILE_KEY, epoch: EPOCH };
          // A stand-in for the record AEAD: the version is bound in, so a body
          // sealed for one version does not open at another — the property the
          // re-seal loop exists for. The body is signed as its author, the persona.
          case "rooms/keys/seal/0.2": {
            assert.equal(p.signAsPrincipal, true);
            const body = JSON.parse(Buffer.from(p.plaintext, "base64url").toString());
            assert.equal(body.author, PERSONA.did, "the body names the persona as its author");
            assert.equal(body.proof, undefined);
            await signTrustTask({ envelope: body, signing: PERSONA, proofPurpose: "assertionMethod" });
            return { sealed: { ciphertext: b64u(Buffer.from(JSON.stringify(body))), nonce: `v${p.version}`, epoch: EPOCH } };
          }
          case "rooms/keys/open/0.2":
            if (p.sealed.nonce !== `v${p.version}`) throw new Error("sealed for another version");
            return { plaintext: p.sealed.ciphertext };
          default:
            throw new Error(`the VTA does not serve ${envelope.type}`);
        }
      },
    },
  };
}

/** A room host, honest unless told otherwise. */
function fakeHost(opts = {}) {
  const state = {
    asked: [],
    uploads: new Map(),
    blobs: new Map(),
    records: new Map(),
    version: opts.head ?? 0,
    aborted: [],
    racesLeft: opts.races ?? 0,
    signers: [],
  };
  const presented = (p, action) => {
    assert.equal(p.presentation.authority[0], `leaf-${action}`, `a ${action} presentation`);
  };
  const answer = async (envelope) => {
    const p = envelope.payload;
    const s = slug(envelope.type);
    state.asked.push(s);
    state.signers.push(envelope.issuer);
    assert.equal(envelope.recipient, HOST_DID);
    assert.notEqual(envelope.issuer, SIGNER.did, "the wallet's own DID reaches no host");
    switch (s) {
      case "rooms/info/0.3":
        presented(p, "read");
        return {
          roomId: ROOM,
          visibility: opts.visibility ?? "attributed",
          epoch: EPOCH,
          limits: { filesEnabled: opts.filesEnabled ?? true },
          usage: { room: { files: 0, bytes: 0, reservedBytes: 0 } },
        };
      case "rooms/blobs/upload/begin/0.2": {
        presented(p, "write");
        assert.equal(envelope.issuer, PERSONA.did);
        assert.equal(p.directParts, undefined, "a browser asks for proxied transfer");
        const ref = await blobRefOf(p.manifest);
        if (state.blobs.has(ref)) return { uploadId: "u0", mode: "proxied", missing: [], alreadyCommitted: true, expiresAt: "x" };
        const id = `u${state.uploads.size + 1}`;
        state.uploads.set(id, { manifest: p.manifest, ref, chunks: [], key: p.uploadKey });
        return { uploadId: id, mode: "proxied", missing: p.manifest.chunks.chunkDigests.map((_, i) => i), expiresAt: "x" };
      }
      case "rooms/blobs/upload/chunk/0.2": {
        if (opts.failChunk === p.index) throw new Error("connection reset");
        const u = state.uploads.get(p.uploadId);
        assert.equal(envelope.issuer, u.key, "a chunk is signed by its upload's key");
        u.chunks[p.index] = fromB64u(p.data);
        return { uploadId: p.uploadId, index: p.index, stored: true, remainingCount: 0, expiresAt: "x" };
      }
      case "rooms/blobs/upload/abort/0.2":
        assert.equal(envelope.issuer, state.uploads.get(p.uploadId).key);
        state.aborted.push(p.uploadId);
        return { uploadId: p.uploadId, aborted: true };
      case "rooms/blobs/upload/commit/0.2": {
        const u = state.uploads.get(p.uploadId);
        assert.equal(envelope.issuer, u.key);
        state.blobs.set(u.ref, u);
        return { blobRef: opts.commitAs ?? u.ref, size: u.manifest.size };
      }
      case "rooms/records/list/0.5":
        presented(p, "read");
        return { records: [], headVersion: state.version };
      case "rooms/records/put/0.3": {
        presented(p, "write");
        // Another member's write lands between this one's seal and its put.
        if (state.racesLeft > 0) {
          state.racesLeft--;
          state.version++;
        }
        if (p.expectedVersion !== undefined && p.expectedVersion !== 0) {
          assert.equal(p.expectedVersion, state.records.get(p.key)?.version, "a rewrite names what landed");
        }
        const version = ++state.version;
        state.records.set(p.key, { version, sealed: p.sealed, blobs: p.blobs, author: envelope.issuer });
        return { key: p.key, version };
      }
      // put/0.4 Host item 12: an open record's blobs are exactly its file's.
      case "rooms/records/put/0.4": {
        presented(p, "write");
        const file = p.cleartext?.file;
        assert.ok(file, "a 0.4 put here carries a file");
        assert.deepEqual(p.blobs, [file.blobRef], "an open record names exactly its file's blob");
        assert.match(file.fileKey, /^[A-Za-z0-9_-]{43}$/, "and carries its key");
        const version = ++state.version;
        state.records.set(p.key, { version, cleartext: p.cleartext, blobs: p.blobs, author: envelope.issuer });
        return { key: p.key, version };
      }
      case "rooms/records/get/0.2": {
        presented(p, "read");
        const r = state.records.get(p.key);
        return {
          roomId: ROOM,
          key: p.key,
          version: r.version,
          author: opts.dropAuthor ? undefined : r.author,
          ...(r.sealed ? { sealed: r.sealed } : {}),
          ...(r.cleartext ? { cleartext: opts.rewriteCleartext?.(r.cleartext) ?? r.cleartext } : {}),
          blobs: r.blobs,
        };
      }
      case "rooms/blobs/get/0.2": {
        presented(p, "read");
        assert.equal(p.direct, false, "a browser asks for a proxied download");
        const blob = state.blobs.get(p.blobRef);
        return { mode: "proxied", manifest: blob.manifest, downloadId: `d:${blob.ref}`, expiresAt: "x" };
      }
      case "rooms/blobs/chunk/0.1": {
        assert.equal(envelope.issuer, PERSONA.did, "a download chunk is asked for as the member");
        const blob = state.blobs.get(p.downloadId.slice(2));
        return {
          index: p.index,
          digestMultibase: blob.manifest.chunks.chunkDigests[p.index],
          data: b64u(blob.chunks[p.index]),
        };
      }
      default:
        throw new Error(`the host does not serve ${envelope.type}`);
    }
  };
  state.sender = {
    async sendCompleted(doc) {
      assert.ok(doc.proof, "a completed document carries its proof");
      return answer(doc);
    },
  };
  // A channel signed by the upload key, as `RoomHostChannel` is in the offscreen document.
  state.uploadChannel = (key) => ({
    async send(envelope) {
      await signTrustTask({ envelope, signing: key, proofPurpose: "authentication" });
      return answer(envelope);
    },
  });
  return state;
}

function context(vta, host, extra = {}) {
  return {
    roomId: ROOM,
    holder: { did: SIGNER.did },
    vta: { did: VTA_DID, sender: vta.sender },
    host: { did: HOST_DID, sender: host.sender },
    uploadChannel: host.uploadChannel,
    cipher,
    ...extra,
  };
}

/** Bytes that span three chunks: two full 256 KiB ones and a short last one. */
function sample(n = 600_000) {
  const out = new Uint8Array(n);
  for (let i = 0; i < n; i++) out[i] = (i * 31 + 7) & 0xff;
  return out;
}

async function getAll(ctx, key) {
  const parts = [];
  const got = await getRoomFile(ctx, key, (p) => parts.push(p));
  return { got, bytes: Buffer.concat(parts) };
}

test("a file put here comes back byte for byte, with its author's manifest", async () => {
  const vta = fakeVta();
  const host = fakeHost();
  const bytes = sample();
  const put = await putRoomFile(context(vta, host), {
    name: "term sheet.pdf",
    mediaType: "application/pdf",
    bytes,
    title: "Term sheet",
    tags: ["deal"],
  });
  assert.equal(put.version, 1);
  assert.equal(put.size, bytes.length);
  assert.equal(host.blobs.get(put.blobRef).chunks.length, 3, "two full chunks and a short one");

  const { got, bytes: back } = await getAll(context(vta, host), put.key);
  assert.deepEqual(new Uint8Array(back), bytes);
  assert.equal(got.author, PERSONA.did, "the persona wrote it, not the wallet");
  assert.equal(put.author, PERSONA.did);
  assert.equal(got.file.name, "term sheet.pdf");
  assert.equal(got.title, "Term sheet");
  assert.deepEqual(got.tags, ["deal"]);
});

test("the host never sees the file's name or plaintext", async () => {
  const host = fakeHost();
  const marker = new TextEncoder().encode("CONFIDENTIAL-MARKER ".repeat(100));
  await putRoomFile(context(fakeVta(), host), { name: "secret-name.txt", bytes: marker });
  const [blob] = host.blobs.values();
  const stored = Buffer.concat(blob.chunks).toString("latin1");
  assert.ok(!stored.includes("CONFIDENTIAL-MARKER"));
  assert.ok(!JSON.stringify(blob.manifest).includes("secret-name"));
});

// Versions come from a room-wide counter, so a write that loses the race is
// stored sealed for the wrong version and does not open until it is rewritten.
test("a write that loses the version race is re-sealed for the version it got", async () => {
  const vta = fakeVta();
  const host = fakeHost({ head: 4, races: 1 });
  const put = await putRoomFile(context(vta, host), { name: "a.txt", bytes: sample(10) });
  assert.equal(put.version, 7, "predicted 5, landed 6 behind another write, rewritten at 7");
  const { bytes } = await getAll(context(vta, host), put.key);
  assert.deepEqual(new Uint8Array(bytes), sample(10));
});

test("a room whose writes never settle is reported, not written over blindly", async () => {
  const host = fakeHost({ races: 99 });
  await assert.rejects(
    putRoomFile(context(fakeVta(), host), { name: "a.txt", bytes: sample(10) }),
    (e) => e instanceof RoomFileError && e.code === "versionRace",
  );
});

test("the same file uploaded twice is stored once", async () => {
  const vta = fakeVta();
  const host = fakeHost();
  // The same fileId would be needed for the same ciphertext; instead put the
  // committed blob back and check `alreadyCommitted` sends no chunk.
  const first = await putRoomFile(context(vta, host), { name: "a.txt", bytes: sample(10) });
  const blob = host.blobs.get(first.blobRef);
  host.blobs.clear();
  const chunkCalls = () => host.asked.filter((s) => s === "rooms/blobs/upload/chunk/0.2").length;
  const before = chunkCalls();
  const realSend = host.sender.sendCompleted;
  host.sender.sendCompleted = async (env) => {
    if (slug(env.type) === "rooms/blobs/upload/begin/0.2") host.blobs.set(await blobRefOf(env.payload.manifest), blob);
    return realSend(env);
  };
  await putRoomFile(context(vta, host), { name: "a.txt", bytes: sample(10) });
  assert.equal(chunkCalls(), before, "no chunk is sent for a blob the room holds");
});

// An open room has no storage key: the file is sealed under a key minted for it
// alone, which the record carries in the clear (`rooms/records/put/0.4`).
test("an open room's file is sealed under its own key, written at put/0.4 through act/0.9, and comes back", async () => {
  const vta = fakeVta();
  const host = fakeHost({ visibility: "open" });
  const bytes = sample();
  const put = await putRoomFile(context(vta, host), {
    name: "brochure.pdf",
    mediaType: "application/pdf",
    bytes,
    title: "2026 brochure",
    tags: ["public"],
  });
  assert.ok(!vta.asked.includes("rooms/keys/file-key/0.2"), "no key is asked of the VTA");
  assert.ok(!vta.asked.includes("rooms/keys/seal/0.2"), "nothing is sealed as a record");
  assert.ok(vta.asked.includes("rooms/keys/act/0.9"), "the record is completed at act/0.9");
  assert.ok(host.asked.includes("rooms/records/put/0.4"));
  const stored = host.records.get(put.key);
  assert.equal(stored.cleartext.file.epoch, EPOCH, "written at the room's epoch");
  assert.notEqual(stored.cleartext.file.fileKey, FILE_KEY);
  assert.equal(stored.cleartext.title, "2026 brochure");

  const { got, bytes: back } = await getAll(context(vta, host), put.key);
  assert.deepEqual(new Uint8Array(back), bytes);
  assert.equal(got.signed, false, "an open room's record is the host's word, not a signed body");
  assert.equal(got.author, PERSONA.did);
  assert.equal(got.file.name, "brochure.pdf");
  assert.equal(got.file.fileKey, undefined, "the key is not handed back");
  assert.equal(got.title, "2026 brochure");
  assert.deepEqual(got.tags, ["public"]);
  assert.equal(vta.asked.filter((s) => s === "rooms/keys/file-key/0.2").length, 0, "nor asked for to open it");
});

test("everything but an open room's file record stays on act/0.8", async () => {
  const vta = fakeVta();
  await putRoomFile(context(vta, fakeHost({ visibility: "open" })), { name: "a.txt", bytes: sample(10) });
  assert.deepEqual(
    vta.asked.filter((s) => s.startsWith("rooms/keys/act/")),
    ["rooms/keys/act/0.8", "rooms/keys/act/0.8", "rooms/keys/act/0.9"],
    "info and begin at 0.8, the put/0.4 record at 0.9",
  );
});

test("an open room's file whose manifest carries no key is refused, never opened", async () => {
  const vta = fakeVta();
  const host = fakeHost({
    visibility: "open",
    rewriteCleartext: (c) => {
      const { fileKey: _, ...file } = c.file;
      return { ...c, file };
    },
  });
  const put = await putRoomFile(context(vta, host), { name: "a.txt", bytes: sample(10) });
  await assert.rejects(
    getAll(context(vta, host), put.key),
    (e) => e instanceof RoomFileError && e.code === "hostMisbehaved",
  );
  assert.ok(!vta.asked.includes("rooms/keys/file-key/0.2"), "no derived key is asked for in its place");
});

test("an open room's file under the wrong key does not verify", async () => {
  const vta = fakeVta();
  const host = fakeHost({
    visibility: "open",
    rewriteCleartext: (c) => ({ ...c, file: { ...c.file, fileKey: Buffer.alloc(32, 1).toString("base64url") } }),
  });
  const put = await putRoomFile(context(vta, host), { name: "a.txt", bytes: sample(10) });
  await assert.rejects(getAll(context(vta, host), put.key));
});

test("a room that takes no files is refused before a file key is asked for", async () => {
  const vta = fakeVta();
  await assert.rejects(
    putRoomFile(context(vta, fakeHost({ filesEnabled: false })), { name: "a.txt", bytes: sample(10) }),
    (e) => e instanceof RoomFileError && e.code === "filesDisabled",
  );
  assert.ok(!vta.asked.includes("rooms/keys/file-key/0.2"));
});

test("a file over the in-memory ceiling is refused before anything is asked", async () => {
  const vta = fakeVta();
  await assert.rejects(
    putRoomFile(context(vta, fakeHost()), { name: "big", bytes: new Uint8Array(ROOM_FILE_MAX_BYTES + 1) }),
    (e) => e instanceof RoomFileError && e.code === "tooLarge",
  );
  assert.deepEqual(vta.asked, []);
});

test("an upload that fails part way releases what begin reserved", async () => {
  const host = fakeHost({ failChunk: 1 });
  await assert.rejects(putRoomFile(context(fakeVta(), host), { name: "a.bin", bytes: sample() }), /connection reset/);
  assert.deepEqual(host.aborted, ["u1"]);
  assert.ok(!host.asked.includes("rooms/records/put/0.3"), "no record names a blob that was never committed");
});

test("a host that commits some other blob is caught before the record is written", async () => {
  const host = fakeHost({ commitAs: "zQmYwAPJzv5CZsnA625s3Xf2nemtYgPpHdWEz79ojWnPbdG" });
  await assert.rejects(
    putRoomFile(context(fakeVta(), host), { name: "a.txt", bytes: sample(10) }),
    (e) => e instanceof RoomFileError && e.code === "hostMisbehaved",
  );
  assert.ok(!host.asked.includes("rooms/records/put/0.3"));
});

test("a chunk altered by the host is refused, and nothing is released", async () => {
  const vta = fakeVta();
  const host = fakeHost();
  const put = await putRoomFile(context(vta, host), { name: "a.bin", bytes: sample() });
  const ctx = context(vta, { ...host, sender: { sendCompleted: (env) => tamperingSend(env, host, 1) } });
  await assert.rejects(
    getRoomFile(ctx, put.key, () => undefined),
    (e) => e instanceof RoomFileError && e.code === "hostMisbehaved",
  );
});

/** The honest host's answers, with one chunk's bytes flipped in transit. */
async function tamperingSend(envelope, honest, index) {
  const reply = await honest.sender.sendCompleted(envelope);
  if (slug(envelope.type) === "rooms/blobs/chunk/0.1" && reply.index === index) {
    const data = fromB64u(reply.data);
    data[0] ^= 1;
    return { ...reply, data: b64u(data) };
  }
  return reply;
}

// The host serves the blob manifest; only the author's signed file manifest
// says which blob is the file. A host serving another blob under this record
// is refused before a byte of it is opened.
test("a host serving another file's blob under this record is refused", async () => {
  const vta = fakeVta();
  const host = fakeHost();
  const mine = await putRoomFile(context(vta, host), { name: "mine.txt", bytes: sample(10) });
  const other = await putRoomFile(context(vta, host), { name: "other.txt", bytes: sample(20) });
  const swapped = { sendCompleted: async (env) => {
    if (slug(env.type) === "rooms/blobs/get/0.2") env = { ...env, payload: { ...env.payload, blobRef: other.blobRef } };
    return host.sender.sendCompleted(env);
  } };
  const opened = [];
  await assert.rejects(getRoomFile(context(vta, { ...host, sender: swapped }), mine.key, (p) => opened.push(p)));
  assert.deepEqual(opened, [], "nothing was opened under the wrong manifest");
});

test("a record that no longer names its blob is reported as released", async () => {
  const vta = fakeVta();
  const host = fakeHost();
  const put = await putRoomFile(context(vta, host), { name: "a.txt", bytes: sample(10) });
  const stripped = { sendCompleted: async (env) => {
    const r = await host.sender.sendCompleted(env);
    return slug(env.type) === "rooms/records/get/0.2" ? { ...r, blobs: undefined } : r;
  } };
  await assert.rejects(
    getRoomFile(context(vta, { ...host, sender: stripped }), put.key, () => undefined),
    (e) => e instanceof RoomFileError && e.code === "blobNotNamed",
  );
});

test("a body signed by someone other than the recorded author is refused before the blob is fetched", async () => {
  const vta = fakeVta();
  const host = fakeHost();
  const put = await putRoomFile(context(vta, host), { name: "a.txt", bytes: sample(10) });
  const misattributed = { sendCompleted: async (env) => {
    const r = await host.sender.sendCompleted(env);
    return slug(env.type) === "rooms/records/get/0.2" ? { ...r, author: "did:key:zSomeoneElse" } : r;
  } };
  const asked = host.asked.length;
  await assert.rejects(getRoomFile(context(vta, { ...host, sender: misattributed }), put.key, () => undefined), /host recorded/);
  assert.ok(!host.asked.slice(asked).includes("rooms/blobs/get/0.2"));
});

// ── The host channel ────────────────────────────────────────────────────────

const HOST_SIGNER = signingIdentityFromSecret(new Uint8Array(32).fill(5));
const ENDPOINT = "https://rooms.openvtc.org/v1/trust-tasks";

/** A fetch that answers as `replier` decides, after checking what was sent. */
function stubFetch(replier) {
  const sent = [];
  const impl = async (url, init) => {
    const doc = JSON.parse(init.body);
    sent.push({ url: String(url), doc, init });
    const reply = await replier(doc);
    return new Response(JSON.stringify(reply), { status: 200, headers: { "content-type": "application/json" } });
  };
  return { sent, impl };
}

async function signedReply(request, { signing = HOST_SIGNER, ...over } = {}) {
  const reply = {
    id: crypto.randomUUID(),
    type: `${request.type}#response`,
    issuer: HOST_SIGNER.did,
    recipient: request.issuer,
    threadId: request.id,
    issuedAt: new Date().toISOString(),
    payload: { roomId: ROOM },
    ...over,
  };
  await signTrustTask({ envelope: reply, signing, proofPurpose: "authentication" });
  return reply;
}

function hostChannel(fetchImpl) {
  return new RoomHostChannel({ hostDid: HOST_SIGNER.did, endpoint: ENDPOINT, signing: SIGNER, fetch: fetchImpl });
}

const request = () => ({
  id: crypto.randomUUID(),
  type: "https://trusttasks.org/spec/rooms/info/0.3",
  issuer: SIGNER.did,
  recipient: HOST_SIGNER.did,
  issuedAt: new Date().toISOString(),
  payload: { roomId: ROOM },
});

test("a room request is signed by the caller and carries no bearer", async () => {
  const f = stubFetch((doc) => signedReply(doc));
  const got = await hostChannel(f.impl).send(request(), { expectedResponseType: "https://trusttasks.org/spec/rooms/info/0.3#response" });
  assert.deepEqual(got, { roomId: ROOM });
  const { doc, init } = f.sent[0];
  assert.equal(doc.proof.verificationMethod.split("#")[0], SIGNER.did);
  assert.ok(!("authorization" in init.headers));
  assert.equal(init.credentials, "omit");
});

test("a reply signed by anyone but the host is refused", async () => {
  const stranger = signingIdentityFromSecret(new Uint8Array(32).fill(6));
  const f = stubFetch((doc) => signedReply(doc, { issuer: stranger.did, signing: stranger }));
  await assert.rejects(hostChannel(f.impl).send(request()), /signed by/);
});

test("a reply threaded to another request is refused", async () => {
  const f = stubFetch((doc) => signedReply(doc, { threadId: "someone-else" }));
  await assert.rejects(hostChannel(f.impl).send(request()), /threaded/);
});

test("a document addressed to another party is not signed or sent", async () => {
  const f = stubFetch((doc) => signedReply(doc));
  await assert.rejects(hostChannel(f.impl).send({ ...request(), recipient: "did:key:zElsewhere" }), /addressed to/);
  assert.equal(f.sent.length, 0);
});

test("a completed document goes out unchanged, and its reply must be the host's, to the member", async () => {
  const PERSONA_KEY = signingIdentityFromSecret(new Uint8Array(32).fill(12));
  const f = stubFetch((doc) => signedReply(doc));
  const channel = new RoomHostChannel({ hostDid: HOST_SIGNER.did, endpoint: ENDPOINT, fetch: f.impl });
  const doc = { ...request(), issuer: PERSONA_KEY.did };
  await signTrustTask({ envelope: doc, signing: PERSONA_KEY, proofPurpose: "authentication" });
  const before = JSON.stringify(doc);
  await channel.sendCompleted(doc, { expectedResponseType: "https://trusttasks.org/spec/rooms/info/0.3#response" });
  assert.equal(JSON.stringify(f.sent[0].doc), before, "sent exactly as the VTA completed it");
  await assert.rejects(channel.send(request()), /signs nothing/, "a channel with no key signs nothing");
});

test("a document with no proof is not sent as a completed one", async () => {
  const f = stubFetch((doc) => signedReply(doc));
  const channel = new RoomHostChannel({ hostDid: HOST_SIGNER.did, endpoint: ENDPOINT, fetch: f.impl });
  await assert.rejects(channel.sendCompleted(request()), /without an issuer or a proof/);
  assert.equal(f.sent.length, 0);
});

// ── A record curated since it was written ───────────────────────────────────
//
// A curation moves a record to a new version and keeps its body, which stays
// bound to the version it was sealed at (`SealedRecord.version`). A file
// record archived or pinned since it was uploaded must still download.

/** The host, with its record moved `by` versions past its body, `told` whether it says where the body was sealed. */
function curated(host, by, told) {
  return {
    ...host,
    sender: {
      sendCompleted: async (env) => {
        const r = await host.sender.sendCompleted(env);
        if (slug(env.type) !== "rooms/records/get/0.2") return r;
        return {
          ...r,
          version: r.version + by,
          sealed: told ? { ...r.sealed, version: r.version } : r.sealed,
        };
      },
    },
  };
}

/**
 * The VTA, refusing `task` once with `unknownEpoch` and `reason` — as an agent
 * that missed a commit, or holds nothing from before its member joined, does —
 * until a `rooms/keys/read` of the record lets it repair from the host.
 */
function behindVta(vta, task, reason, reads) {
  let repaired = false;
  return {
    ...vta,
    sender: {
      async send(envelope) {
        const s = slug(envelope.type);
        if (s === "rooms/keys/read/0.1") {
          reads.push(structuredClone(envelope.payload));
          repaired = true;
          return {};
        }
        if (s === task && !repaired) {
          const name = task.split("/")[2];
          throw Object.assign(new Error(`the record is sealed under an epoch this agent does not hold (${reason})`), {
            details: { code: `rooms/keys/${name}:unknownEpoch`, details: { reason } },
          });
        }
        return vta.sender.send(envelope);
      },
    },
  };
}

for (const [task, reason] of [
  ["rooms/keys/open/0.2", "beyondChain"],
  ["rooms/keys/open/0.2", "notDelivered"],
  ["rooms/keys/file-key/0.2", "beyondChain"],
  ["rooms/keys/file-key/0.2", "notDelivered"],
]) {
  test(`a file whose ${task.split("/")[2]} is refused ${reason} opens after one read lets the agent repair`, async () => {
    const vta = fakeVta();
    const host = fakeHost();
    const put = await putRoomFile(context(vta, host), { name: "a.txt", bytes: sample(10) });
    const reads = [];
    const { got } = await getAll(context(behindVta(vta, task, reason, reads), host), put.key);
    assert.equal(got.file.name, "a.txt");
    assert.equal(reads.length, 1, "one read, naming the host, is the repair");
    assert.equal(reads[0].host, HOST_DID);
    assert.equal(reads[0].key, put.key);
  });
}

test("a member removed from the room is not repaired: the refusal stands", async () => {
  const vta = fakeVta();
  const host = fakeHost();
  const put = await putRoomFile(context(vta, host), { name: "a.txt", bytes: sample(10) });
  const reads = [];
  await assert.rejects(
    getAll(context(behindVta(vta, "rooms/keys/open/0.2", "removed", reads), host), put.key),
    /removed/,
  );
  assert.equal(reads.length, 0, "nothing to repair, so nothing asked");
});

/** The VTA, opening a body only where it was sealed — and, asked at a later version, searching back and saying where. */
function searchingVta(vta, opened) {
  return {
    ...vta,
    sender: {
      async send(envelope) {
        if (slug(envelope.type) !== "rooms/keys/open/0.2") return vta.sender.send(envelope);
        const p = envelope.payload;
        opened.push(structuredClone(p));
        assert.equal(p.sealed.version, undefined, "keys/open takes no `version` in `sealed`");
        const at = Number(p.sealed.nonce.slice(1));
        if (at > p.version) throw new Error("sealed for a later version");
        return at === p.version
          ? { plaintext: p.sealed.ciphertext }
          : { plaintext: p.sealed.ciphertext, ext: { "org.openvtc.rooms": { sealedAt: at } } };
      },
    },
  };
}

test("a file record curated since its upload opens where the host says its body was sealed", async () => {
  const vta = fakeVta();
  const host = fakeHost();
  const put = await putRoomFile(context(vta, host), { name: "a.txt", bytes: sample(10) });
  const opened = [];
  const { got } = await getAll(context(searchingVta(vta, opened), curated(host, 4, true)), put.key);
  assert.equal(got.file.name, "a.txt");
  assert.equal(opened[0].version, put.version, "asked at the sealed-at version, not the record's");
});

test("a file record curated before hosts kept the sealed-at version is found, and checked where it opened", async () => {
  const vta = fakeVta();
  const host = fakeHost();
  const put = await putRoomFile(context(vta, host), { name: "a.txt", bytes: sample(10) });
  const opened = [];
  const { got } = await getAll(context(searchingVta(vta, opened), curated(host, 4, false)), put.key);
  assert.equal(got.file.name, "a.txt");
  assert.equal(opened[0].version, put.version + 4, "asked at the record's version, having nothing better");
});

test("a sealed-at version after the record's own is refused before anything is opened", async () => {
  const vta = fakeVta();
  const host = fakeHost();
  const put = await putRoomFile(context(vta, host), { name: "a.txt", bytes: sample(10) });
  const lying = { ...host, sender: { sendCompleted: async (env) => {
    const r = await host.sender.sendCompleted(env);
    return slug(env.type) === "rooms/records/get/0.2" ? { ...r, sealed: { ...r.sealed, version: r.version + 1 } } : r;
  } } };
  const opened = [];
  await assert.rejects(
    getRoomFile(context(searchingVta(vta, opened), lying), put.key, () => undefined),
    /not a version at or before the record's/,
  );
  assert.equal(opened.length, 0);
});
