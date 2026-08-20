// `vtaListDids` — the send path, which drifted from its own schema.
//
// This sent `{ context_id }` until `vta/webvh/dids/list/1.0` was specified.
// The schema names `contextId` and sets `additionalProperties: false`, so the
// old spelling was never a tolerated synonym: it made the whole payload
// malformed, and a conforming agent refuses it as `malformedRequest`.
//
// The failure mode before the schema existed is the reason this has a test of
// its own. Nothing rejected the payload, so the filter was simply ignored — an
// unfiltered list looks exactly like a working one until you count the rows.
// A test that only checked "does it return DIDs" would have passed throughout.

import { test } from "node:test";
import assert from "node:assert/strict";

import { vtaListDids } from "../dist/vta/index.js";

const HOLDER = { did: "did:key:zHolder" };
const SERVICE = { did: "did:webvh:QmAgent:agent.example" };

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

test("the context filter is sent as contextId, the name the schema gives it", async () => {
  const ch = recorder({ dids: [] });
  await vtaListDids(ch, { holder: HOLDER, service: SERVICE, contextId: "personal" });

  const { payload } = ch.sent[0].envelope;
  assert.deepEqual(payload, { contextId: "personal" });
  assert.ok(
    !("context_id" in payload),
    "context_id is not a synonym — additionalProperties:false makes it malformed",
  );
});

test("no filter sends an empty payload rather than an absent key set to undefined", async () => {
  const ch = recorder({ dids: [] });
  await vtaListDids(ch, { holder: HOLDER, service: SERVICE });
  assert.deepEqual(ch.sent[0].envelope.payload, {});
});

test("the read path still folds a legacy record, because agents migrate later", async () => {
  // Emitting the canonical spelling and accepting both are separate moves. An
  // agent that has not taken the fold still answers `context_id`, and dropping
  // the fold here would leave `contextId` undefined against it.
  const ch = recorder({
    dids: [{ did: "did:webvh:QmA:h.example", context_id: "personal", server_id: "prod" }],
  });
  const [rec] = await vtaListDids(ch, { holder: HOLDER, service: SERVICE });
  assert.equal(rec.contextId, "personal");
  assert.equal(rec.serverId, "prod");
});
