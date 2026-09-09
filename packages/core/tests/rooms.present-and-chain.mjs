// The presentation oracle, and the delivery that repairs a member's history.
//
// `rooms/keys/present` is the load-bearing one and its absence was invisible:
// every host-served room task takes an authority presentation, and until this
// existed nothing in the library could produce one — so `records/{list,get,put}`
// and `epoch/mint` were exported, typechecked, and impossible to call.
//
// The tests below are about the two places that shape is easy to get wrong.

import { test } from "node:test";
import assert from "node:assert/strict";

import { roomsKeysPresent, roomsKeysChain } from "../dist/rooms/index.js";

const HOLDER = { did: "did:key:zMember" };
const AGENT = { did: "did:webvh:QmAgent:agent.example" };
const HOST = "did:webvh:QmHost:host.example";
const ROOM = "did:webvh:QmRoom:rooms.example";

const PRESENTATION = { membership: "eyJhbGciOiJFZERTQSJ9.vmc", authority: ["eyJ.vac"] };

/** Captures the envelope instead of sending it, and replies with `reply`. */
function recorder(reply) {
  const sent = [];
  return {
    sent,
    send(envelope, opts) {
      sent.push({ envelope, opts });
      return Promise.resolve(reply);
    },
  };
}

// ── present ─────────────────────────────────────────────────────────────────

// `0.2` removed `audience` and `nonce`, and this asserts their ABSENCE rather
// than nothing at all. Neither was doing what its name suggested: `audience` at
// the task layer names the document's destination — the agent being asked, not
// the host the presentation is later shown to — and a room presentation needs no
// nonce, because a host binds it to whoever signed the envelope. The payload is
// `additionalProperties: false`, so a caller that still sends either is refused
// by the agent, and the test that would have caught that is this one.
test("neither `audience` nor `nonce` is sent — 0.2 has no such members", async () => {
  const channel = recorder({ presentation: PRESENTATION });
  await roomsKeysPresent(channel, {
    holder: HOLDER, service: AGENT, roomId: ROOM, action: "read",
  });
  const { payload } = channel.sent[0].envelope;
  assert.ok(!("audience" in payload), "0.2 has no `audience`");
  assert.ok(!("nonce" in payload), "0.2 has no `nonce`");
  assert.ok(!("challenge" in payload), "and never had a `challenge`");
});

test("the presentation is scoped to one action and one room", async () => {
  const channel = recorder({ presentation: PRESENTATION });
  await roomsKeysPresent(channel, {
    holder: HOLDER, service: AGENT, roomId: ROOM, action: "read",
  });
  const { payload } = channel.sent[0].envelope;
  assert.equal(payload.action, "read");
  assert.equal(payload.roomId, ROOM);
});

// It goes to the member's OWN agent — the credentials never leave it, and a
// presentation asked of the host would be asking the verifier to vouch for the
// party it is about to check.
test("present is addressed to the agent, not the host", async () => {
  const channel = recorder({ presentation: PRESENTATION });
  await roomsKeysPresent(channel, {
    holder: HOLDER, service: AGENT, roomId: ROOM, action: "read",
  });
  assert.equal(channel.sent[0].envelope.recipient, AGENT.did);
  assert.equal(channel.sent[0].envelope.issuer, HOLDER.did);
});

// The published schemas type the two ends of this value differently — the
// response is a bare open object, every host task requires `membership` and
// `authority` — so an incomplete answer is representable. Caught here, it names
// the agent that produced it; passed on, the host refuses it in words that
// accuse the member of lacking authority.
test("an incomplete presentation is refused where it was produced", async () => {
  for (const [what, bad] of [
    ["no authority chain", { membership: "eyJ.vmc" }],
    ["no membership credential", { authority: ["eyJ.vac"] }],
    ["an empty object", {}],
  ]) {
    await assert.rejects(
      roomsKeysPresent(recorder({ presentation: bad }), {
        holder: HOLDER, service: AGENT, roomId: ROOM, action: "read",
      }),
      (e) => {
        assert.match(e.message, new RegExp(AGENT.did), `${what}: must name the agent`);
        assert.match(e.message, /membership credential or no authority chain/);
        return true;
      },
      `${what} should be refused`,
    );
  }
});

// An empty `authority` array is a chain of length zero, which a host refuses for
// the same reason as a missing one — but it IS an array, so a shape check that
// only tested `Array.isArray` would pass it through. This documents which side
// of that line the client sits on: it forwards, and the host is the authority on
// depth.
test("an empty authority array is forwarded, not judged here", async () => {
  const res = await roomsKeysPresent(recorder({ presentation: { membership: "m", authority: [] } }), {
    holder: HOLDER, service: AGENT, roomId: ROOM, action: "read",
  });
  assert.deepEqual(res.presentation.authority, []);
});

// ── keys/chain ──────────────────────────────────────────────────────────────

test("the rungs are delivered to the agent under the canonical type", async () => {
  const links = [{ epoch: 4, wrapped: "w4", nonce: "n4" }];
  const channel = recorder({ roomId: ROOM, earliestReadableEpoch: 1, stored: 1 });

  const res = await roomsKeysChain(channel, {
    holder: HOLDER, service: AGENT, roomId: ROOM, links,
  });

  const { envelope, opts } = channel.sent[0];
  assert.equal(envelope.type, "https://trusttasks.org/spec/rooms/keys/chain/0.1");
  assert.equal(opts.expectedResponseType, "https://trusttasks.org/spec/rooms/keys/chain/0.1#response");
  assert.equal(envelope.recipient, AGENT.did);
  assert.deepEqual(envelope.payload.links, links);
  assert.equal(res.earliestReadableEpoch, 1);
});

// `stored: 0` is a success and not a no-op — it is what a retry looks like — so
// the client must pass it through rather than treating it as a missing field.
test("zero stored is reported, not swallowed", async () => {
  const res = await roomsKeysChain(recorder({ roomId: ROOM, earliestReadableEpoch: 3, stored: 0 }), {
    holder: HOLDER, service: AGENT, roomId: ROOM, links: [{ epoch: 3, wrapped: "w", nonce: "n" }],
  });
  assert.equal(res.stored, 0);
  assert.equal(res.earliestReadableEpoch, 3);
});
