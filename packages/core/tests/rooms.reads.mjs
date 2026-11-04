// Reading a room's records through the member's own agent, at the versions that
// carry the host's `createdAt`, `createdBy` and `bodyStoredAt`
// (`rooms/keys/browse/0.4`, `rooms/keys/read/0.2`), and a batch of keys at once.

import { test } from "node:test";
import assert from "node:assert/strict";

import {
  readSealedVersion,
  roomsKeysBrowse,
  roomsKeysRead,
  roomsKeysReadMany,
  roomsRecordsGet,
  roomsRecordsList,
  ROOMS_KEYS_READ_MAX_KEYS,
} from "../dist/rooms/index.js";

const parties = { holder: { did: "did:key:zWallet" }, service: { did: "did:webvh:QmAgent:agent.example" } };
const ROOM = "did:webvh:QmRoom:rooms.example";
const HOST = "did:webvh:QmHost:host.example";
const slug = (t) => t.replace("https://trusttasks.org/spec/", "");

/** An agent answering with `answer`, recording what it was asked. */
function agent(answer) {
  const asked = [];
  return {
    asked,
    async send(envelope) {
      const s = slug(envelope.type);
      asked.push({ type: s, payload: envelope.payload });
      return answer(s, envelope.payload);
    },
  };
}

test("browse asks 0.4 and a single read 0.2, which pass the host's times through", async () => {
  const a = agent((s) =>
    s === "rooms/keys/browse/0.4"
      ? { roomId: ROOM, records: [], complete: true, verification: { priorRoots: "noneHeld" } }
      : { roomId: ROOM, key: "k", version: 2, bodyStoredAt: "2026-11-01T00:00:00Z", verification: { priorRoots: "noneHeld" } },
  );
  await roomsKeysBrowse(a, { ...parties, roomId: ROOM, host: HOST });
  const got = await roomsKeysRead(a, { ...parties, roomId: ROOM, host: HOST, key: "k" });
  assert.deepEqual(a.asked.map((x) => x.type), ["rooms/keys/browse/0.4", "rooms/keys/read/0.2"]);
  assert.equal(got.bodyStoredAt, "2026-11-01T00:00:00Z");
  assert.equal(a.asked[1].payload.key, "k");
  assert.equal(a.asked[1].payload.keys, undefined, "a single read names `key`, never `keys`");
});

test("a batch read names up to 32 keys a request, and answers in the order asked", async () => {
  const keys = Array.from({ length: 40 }, (_, i) => `k${i}`);
  const a = agent((_s, p) => ({
    roomId: ROOM,
    results: p.keys.map((key) => ({ key, version: 1, verification: { priorRoots: "noneHeld" } })),
  }));
  const results = await roomsKeysReadMany(a, { ...parties, roomId: ROOM, host: HOST, keys });
  assert.deepEqual(results.map((r) => r.key), keys);
  assert.deepEqual(a.asked.map((x) => x.payload.keys.length), [ROOMS_KEYS_READ_MAX_KEYS, 8]);
  assert.ok(a.asked.every((x) => x.type === "rooms/keys/read/0.2" && x.payload.key === undefined));
});

test("a batch read gives each key its own answer, and the version a curated body opened at", async () => {
  const a = agent(() => ({
    roomId: ROOM,
    results: [
      { key: "a", version: 9, verification: { priorRoots: "noneHeld" } },
      { key: "b", error: { code: "rooms/keys/read:hostRefused", retryable: false } },
    ],
    ext: { "org.openvtc.rooms": { sealedAt: { a: 4 } } },
  }));
  const [ra, rb] = await roomsKeysReadMany(a, { ...parties, roomId: ROOM, host: HOST, keys: ["a", "b"] });
  assert.equal(readSealedVersion(ra), 4);
  assert.equal(rb.error.code, "rooms/keys/read:hostRefused");
});

test("a batch answered for other keys, or out of order, is refused", async () => {
  const a = agent((_s, p) => ({ roomId: ROOM, results: [...p.keys].reverse().map((key) => ({ key, version: 1 })) }));
  await assert.rejects(roomsKeysReadMany(a, { ...parties, roomId: ROOM, host: HOST, keys: ["a", "b"] }), /in order/);
});

test("keys the agent did not come to are asked again, and an agent that reads none stops the loop", async () => {
  let round = 0;
  const a = agent((_s, p) => {
    round += 1;
    return {
      roomId: ROOM,
      results: p.keys.map((key, i) =>
        round === 1 && i > 0
          ? { key, error: { code: "rooms/keys/read:notAttempted", retryable: true } }
          : { key, version: 1, verification: { priorRoots: "noneHeld" } },
      ),
    };
  });
  const results = await roomsKeysReadMany(a, { ...parties, roomId: ROOM, host: HOST, keys: ["a", "b", "c"] });
  assert.ok(results.every((r) => r.error === undefined));
  assert.deepEqual(a.asked.map((x) => x.payload.keys), [["a", "b", "c"], ["b", "c"]]);

  const stuck = agent((_s, p) => ({
    roomId: ROOM,
    results: p.keys.map((key) => ({ key, error: { code: "rooms/keys/read:notAttempted", retryable: true } })),
  }));
  const none = await roomsKeysReadMany(stuck, { ...parties, roomId: ROOM, host: HOST, keys: ["a"] });
  assert.equal(none[0].error.code, "notAttempted");
  assert.equal(stuck.asked.length, 1);
});

test("a host is asked list/0.6 and get/0.3", async () => {
  const call = { ...parties, roomId: ROOM, presentation: { membership: "vmc", authority: ["leaf"] } };
  const a = agent((s) => (s.includes("/list/") ? { records: [] } : { key: "k", version: 1 }));
  await roomsRecordsList(a, call);
  await roomsRecordsGet(a, { ...call, key: "k" });
  assert.deepEqual(a.asked.map((x) => x.type), ["rooms/records/list/0.6", "rooms/records/get/0.3"]);
});
