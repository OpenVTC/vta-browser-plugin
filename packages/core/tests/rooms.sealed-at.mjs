// Where a sealed body opens: `sealedAt` reads the host's `sealed.version`, and
// `roomsKeysOpenAt` believes the VTA's "opened at" only where it is no later
// than the version it was asked for.

import { test } from "node:test";
import assert from "node:assert/strict";

import { roomsKeysOpenAt, sealedAt } from "../dist/rooms/index.js";

test("the sealed-at version is the host's where it gives one, else the record's", () => {
  assert.equal(sealedAt({}, 7), 7);
  assert.equal(sealedAt({ version: 3 }, 7), 3);
  assert.equal(sealedAt({ version: 7 }, 7), 7);
  assert.throws(() => sealedAt({ version: 8 }, 7), /not a version at or before the record's 7/);
  assert.throws(() => sealedAt({ version: 0 }, 7));
});

const parties = { holder: { did: "did:key:zWallet" }, service: { did: "did:webvh:QmAgent:agent.example" } };
const answering = (reply) => ({ async send() { return reply; } });
const params = { ...parties, roomId: "did:webvh:QmRoom:rooms.example", key: "k", version: 5, sealed: { ciphertext: "c", nonce: "n", epoch: 1, version: 3 } };

test("the VTA's answer says where the body opened, and nothing later than asked is believed", async () => {
  assert.deepEqual(await roomsKeysOpenAt(answering({ plaintext: "p" }), params), { plaintext: "p", sealedAt: 5 });
  assert.deepEqual(
    await roomsKeysOpenAt(answering({ plaintext: "p", ext: { "org.openvtc.rooms": { sealedAt: 2 } } }), params),
    { plaintext: "p", sealedAt: 2 },
  );
  await assert.rejects(
    roomsKeysOpenAt(answering({ plaintext: "p", ext: { "org.openvtc.rooms": { sealedAt: 6 } } }), params),
    /not at or before the 5 it was asked for/,
  );
});

test("only the three members keys/open takes are sent of `sealed`", async () => {
  let sent;
  await roomsKeysOpenAt({ async send(env) { sent = env.payload; return { plaintext: "p" }; } }, params);
  assert.deepEqual(sent.sealed, { ciphertext: "c", nonce: "n", epoch: 1 });
  assert.equal(sent.version, 5);
});
