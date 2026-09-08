// Asking the agent for one withheld value.
//
// The bug this closes was silent in the worst way: the console never sent
// `includeSensitive`, so the agent answered with metadata and no plaintext, and
// the pane drew a mask over the placeholder. Every sensitive attribute looked
// like a value being kept off the screen and was in fact a value that had never
// arrived. So the first assertion here is simply that the member is sent — that
// is the whole defect — and the rest is about not repeating it in a subtler way.

import { test } from "node:test";
import assert from "node:assert/strict";
import { revealAttributeValue } from "../src/manager/reveal-value.ts";

const PARTIES = {
  holder: { did: "did:key:holder" },
  service: { did: "did:web:agent" },
} as never;

/** A sender that records the envelope it was handed and answers with the given
 *  attributes. `send` resolves to the response *payload*, which is the contract
 *  `TrustTaskSender` declares. */
function sender(attributes: unknown[]) {
  const sent: { type: string; payload: Record<string, unknown> }[] = [];
  return {
    sent,
    send: async (envelope: { type: string; payload: Record<string, unknown> }) => {
      sent.push({ type: envelope.type, payload: envelope.payload });
      return { attributes } as never;
    },
  };
}

const attr = (over: Record<string, unknown> = {}) => ({
  attributeId: "a1",
  type: "phone.mobile",
  valueType: "string",
  provenance: { kind: "selfAsserted" },
  version: 1,
  updatedAt: "x",
  ...over,
});

test("the request asks for values AND for the sensitive ones", async () => {
  const s = sender([attr({ value: "+65 8262 2325" })]);
  const value = await revealAttributeValue(s as never, PARTIES, { attributeId: "a1", type: "phone.mobile" });
  assert.equal(value, "+65 8262 2325");
  const payload = s.sent[0]!.payload;
  assert.equal(payload.includeValues, true);
  assert.equal(payload.includeSensitive, true, "without this the agent answers with no plaintext at all");
});

test("the question is narrowed to the one type, not the whole pool", async () => {
  // `includeSensitive` over a bare listing would pull every passport and card
  // number the holder owns into the page because one button might be pressed.
  const s = sender([attr({ value: "x" })]);
  await revealAttributeValue(s as never, PARTIES, { attributeId: "a1", type: "phone.mobile" });
  assert.equal(s.sent[0]!.payload.typePrefix, "phone.mobile");
});

test("the answer is matched by id, because a type can have siblings", async () => {
  // Two phone numbers, and the one asked for is second. Taking the first would
  // show the holder the wrong value with no sign anything was wrong.
  const s = sender([
    attr({ attributeId: "a0", value: "the other one" }),
    attr({ attributeId: "a1", value: "the one asked for" }),
  ]);
  const value = await revealAttributeValue(s as never, PARTIES, { attributeId: "a1", type: "phone.mobile" });
  assert.equal(value, "the one asked for");
});

test("an agent that still withholds the value is an error, not another blank", async () => {
  // Returning `undefined` would redraw "with your agent" and the person would
  // press Show again, learning nothing about why.
  const s = sender([attr()]);
  await assert.rejects(
    () => revealAttributeValue(s as never, PARTIES, { attributeId: "a1", type: "phone.mobile" }),
    /held the value back/,
  );
});

test("a stale credential-backed attribute says that instead", async () => {
  // `stale` is the specification's own discriminator for an absent value, and
  // it is a different sentence: nothing is being withheld, the backing could
  // not be re-derived.
  const s = sender([attr({ stale: true, staleReason: "revoked", provenance: { kind: "credentialBacked" } })]);
  await assert.rejects(
    () => revealAttributeValue(s as never, PARTIES, { attributeId: "a1", type: "phone.mobile" }),
    /could not be re-derived \(revoked\)/,
  );
});

test("an attribute the agent no longer lists says so", async () => {
  const s = sender([]);
  await assert.rejects(
    () => revealAttributeValue(s as never, PARTIES, { attributeId: "a1", type: "phone.mobile" }),
    /no longer lists this attribute/,
  );
});
