// The inbound path resolves a sender per frame, serially, on the socket that
// also carries replies — so a burst that resolves per frame starves an
// in-flight request into a hard TSP timeout. These test the real cache, over
// an injected resolver, rather than a re-implementation of its policy.

import { test } from "node:test";
import assert from "node:assert/strict";

import {
  resolveTspEndpointCachedWith,
  clearTspEndpointCache,
  TSP_ENDPOINT_TTL_MS,
} from "../dist/vta/index.js";

/** A resolver that counts calls, so "did the cache work" is observable. */
function counting(endpointFor = (vid) => ({ vid })) {
  const state = { calls: 0 };
  return [
    async (vid) => {
      state.calls++;
      return endpointFor(vid);
    },
    state,
  ];
}

test("a burst of frames from one peer resolves that peer once", async () => {
  clearTspEndpointCache();
  const [resolve, state] = counting();
  // The shape of a redelivered backlog: many frames, one sender.
  for (let i = 0; i < 200; i++) {
    await resolveTspEndpointCachedWith("did:web:vta.example", resolve);
  }
  assert.equal(state.calls, 1, "200 frames must not be 200 DID resolutions");
});

test("an entry lapses, so a rotated key heals without explicit eviction", async () => {
  clearTspEndpointCache();
  let key = "old";
  const [resolve] = counting(() => ({ key }));
  let clock = 0;
  const now = () => clock;

  assert.equal((await resolveTspEndpointCachedWith("did:web:v.example", resolve, now)).key, "old");
  key = "new";
  // Inside the window the stale entry stands — and a frame refused against it
  // is redelivered rather than lost, which is what makes a TTL sufficient on
  // its own and eviction-on-failure unnecessary.
  clock = TSP_ENDPOINT_TTL_MS - 1;
  assert.equal((await resolveTspEndpointCachedWith("did:web:v.example", resolve, now)).key, "old");

  clock = TSP_ENDPOINT_TTL_MS;
  assert.equal((await resolveTspEndpointCachedWith("did:web:v.example", resolve, now)).key, "new");
});

test("clearing one peer leaves the others cached", async () => {
  clearTspEndpointCache();
  const [resolve, state] = counting();
  await resolveTspEndpointCachedWith("did:web:a.example", resolve);
  await resolveTspEndpointCachedWith("did:web:b.example", resolve);
  assert.equal(state.calls, 2);

  clearTspEndpointCache("did:web:a.example");
  await resolveTspEndpointCachedWith("did:web:b.example", resolve);
  assert.equal(state.calls, 2, "b must still be cached");
  await resolveTspEndpointCachedWith("did:web:a.example", resolve);
  assert.equal(state.calls, 3, "a must have been dropped");
});

test("the cache is bounded, so a chatty socket cannot grow it without limit", async () => {
  clearTspEndpointCache();
  const [resolve] = counting();
  for (let i = 0; i < 100; i++) {
    await resolveTspEndpointCachedWith(`did:web:peer-${i}.example`, resolve);
  }
  // Re-resolving the most recent peer must still be a hit; the oldest must have
  // been evicted. Asserted through behaviour rather than by reading the Map,
  // which is deliberately not exported.
  const [resolve2, state2] = counting();
  await resolveTspEndpointCachedWith("did:web:peer-99.example", resolve2);
  assert.equal(state2.calls, 0, "the newest entry must survive");
  await resolveTspEndpointCachedWith("did:web:peer-0.example", resolve2);
  assert.equal(state2.calls, 1, "the oldest entry must have been evicted");
});
