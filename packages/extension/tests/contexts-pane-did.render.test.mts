// The Identity panel, rendered.
//
// "— none —" was offered here before the agent could honour it. Choosing it
// sent `did: ""` on `vta/contexts/update-did/1.0`, whose schema requires a
// non-empty string, and the operator — who had just been told by a DID
// deletion to "reassign it first" — got a validation error instead of a
// context with no DID. 1.1 makes `did` nullable; `null` is the only spelling of
// "none" on the wire, and `""` is refused as not a DID.

import { test } from "node:test";
import assert from "node:assert/strict";
import { agent, h, render, PARTIES } from "./harness/dom.mjs";
import { ContextsPane } from "../src/manager/panes/contexts.js";

const UPDATE_DID = "vta/contexts/update-did/1.1";
const LIST_DIDS = "vta/webvh/dids/list/1.0";

const DID_A = "did:webvh:QmA:host.example:vtc";
const DID_B = "did:webvh:QmB:host.example:vtc-2";

const ctx = (did?: string) => ({
  id: "vtc",
  name: "vtc",
  createdAt: "2026-09-01T00:00:00Z",
  updatedAt: "2026-09-01T00:00:00Z",
  basePath: "m/26'/2'/0'",
  ...(did ? { did } : {}),
});

const mount = async (did?: string) => {
  const a = agent({
    [LIST_DIDS]: { dids: [{ did: DID_A }, { did: DID_B }] },
    [UPDATE_DID]: ctx(),
  });
  const screen = await render(
    h(ContextsPane, {
      parties: PARTIES,
      authority: null,
      records: [ctx(did)],
      selected: "vtc",
      onChanged: () => {},
    } as never),
    { chrome: { runtime: { sendMessage: a.sendMessage } } },
  );
  await screen.settle();
  const select = screen
    .all("select")
    .find((s) => [...(s as HTMLSelectElement).options].some((o) => o.value === DID_A)) as
    | HTMLSelectElement
    | undefined;
  assert.ok(select, "the Identity panel's DID picker is not on screen");
  return { a, screen, select };
};

test("choosing none clears the DID with did: null on update-did 1.1", async () => {
  const { a, screen, select } = await mount(DID_A);
  await screen.select(select, "");
  await screen.click(screen.button("Clear DID"));
  await screen.settle();
  const sent = a.of("update-did");
  assert.equal(sent.length, 1);
  assert.ok(sent[0]!.type.endsWith(UPDATE_DID), `sent ${sent[0]!.type}`);
  assert.deepEqual(sent[0]!.payload, { id: "vtc", did: null }, "none must be null, never \"\"");
});

test("reassigning sends the chosen DID", async () => {
  const { a, screen, select } = await mount(DID_A);
  await screen.select(select, DID_B);
  await screen.click(screen.button("Reassign DID"));
  await screen.settle();
  assert.deepEqual(a.of("update-did")[0]!.payload, { id: "vtc", did: DID_B });
});

test("the panel says clearing does not delete the DID", async () => {
  const { screen } = await mount(DID_A);
  assert.match(screen.text(), /The DID itself is not deleted/);
});

test("a context that already has no DID cannot 'save' none", async () => {
  const { a, screen } = await mount();
  const assign = screen.button("Assign DID") as HTMLButtonElement;
  assert.ok(assign.disabled, "Assign is enabled with nothing changed");
  await screen.click(assign);
  await screen.settle();
  assert.equal(a.of("update-did").length, 0);
});
