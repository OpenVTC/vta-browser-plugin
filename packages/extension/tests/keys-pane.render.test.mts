// The keys pane, rendered — and specifically the rename editor.
//
// Both bugs this pins were on screen in the live console and invisible to the
// type checker and to `key-name.ts`'s own tests.
//
// **The field was pre-filled with the key's id**, which for every DID-bound key
// is a DID URL: `:` and `#` the agent's identifier gate refuses, at 86 bytes
// against a 64-byte cap. The only thing pressing Save could produce was
// `keys/rename/0.1 failed: … new_key_id is 86 bytes; maximum is 64`, and
// nothing on screen said what would have worked.
//
// **And it rendered inside the actions column**, the narrowest in the table, so
// the field showed about eight characters of the value being edited. It belongs
// under the row, where the width is the pane's.

import { test } from "node:test";
import assert from "node:assert/strict";
import { agent, h, render, PARTIES } from "./harness/dom.mjs";
import { KeysPane } from "../src/manager/panes/keys.js";

const LIST = "keys/list/0.1";
const RENAME = "keys/rename/0.1";

const DID = "did:webvh:QmRqxWCVUE6Y474EPdNZmR9m3giTRyDgmXSdidvEy7iSwq:webvh.storm.ws:vdr-host";
const DID_KEY = `${DID}#key-0`;

const key = (keyId: string, keyType = "ed25519") => ({
  keyId,
  keyType,
  status: "active",
  origin: "derived",
  createdAt: "2026-09-11T00:00:00Z",
  contextId: "vdr",
});

const mount = async (keys: unknown[]) => {
  const a = agent({
    [LIST]: { keys, total: keys.length, offset: 0, limit: 50 },
    [RENAME]: { keyId: "renamed", updatedAt: "2026-09-14T00:00:00Z" },
  });
  const screen = await render(
    h(KeysPane, { parties: PARTIES, authority: null, contextId: "vdr" } as never),
    { chrome: { runtime: { sendMessage: a.sendMessage } } },
  );
  return { a, screen };
};

/** The rename field — the only text input inside the table. */
const field = (screen: { all: (s: string) => Element[] }) =>
  screen.all("td input[type='text'], td input:not([type])")[0] as
    | (Element & { value: string })
    | undefined;

test("the editor opens beneath the key, not inside the actions column", async () => {
  const { screen } = await mount([key(DID_KEY)]);
  await screen.click(screen.button("Rename"));
  const input = field(screen);
  assert.ok(input, "no field appeared");
  // The full-width detail row is a `<td colspan>`; a field in the actions
  // column has no such ancestor and is as wide as "Rename" is.
  const cell = input.closest("td");
  assert.ok(cell?.hasAttribute("colspan"), "the editor is not in the table's full-width row");
});

test("a DID-bound key opens with an empty field, and offers a name that would work", async () => {
  const { screen } = await mount([key(DID_KEY)]);
  await screen.click(screen.button("Rename"));
  const input = field(screen)!;
  assert.equal(input.value, "", "the field is pre-filled with a value the agent always refuses");
  assert.equal(input.getAttribute("placeholder"), "vdr-host-key-0");
  // Nothing typed: there is nothing to save, and the button says so rather
  // than sending a refusal the operator has to read as an error.
  assert.ok((screen.button("Save") as HTMLButtonElement).disabled);
});

test("the rule is on screen before it is broken", async () => {
  const { screen } = await mount([key(DID_KEY)]);
  await screen.click(screen.button("Rename"));
  const text = screen.text();
  assert.match(text, /up to 64 characters/);
  // And the one-way door: the agent cannot be given a DID URL back.
  assert.match(text, /will not accept the old id back/);
});

test("pasting the id back is refused here, with the reason, and nothing is sent", async () => {
  const { a, screen } = await mount([key(DID_KEY)]);
  await screen.click(screen.button("Rename"));
  await screen.type(field(screen)!, DID_KEY);
  assert.match(screen.text(), /not a DID URL/);
  assert.ok((screen.button("Save") as HTMLButtonElement).disabled);
  assert.equal(
    a.calls.filter((c: { type: string }) => c.type.endsWith(RENAME)).length,
    0,
    "a name the agent would refuse was sent anyway",
  );
});

test("a valid name is sent as typed, against the id the key has today", async () => {
  const { a, screen } = await mount([key(DID_KEY)]);
  await screen.click(screen.button("Rename"));
  await screen.type(field(screen)!, "vdr-host-signing");
  await screen.click(screen.button("Save"));
  await screen.settle();
  const call = a.calls.find((c: { type: string }) => c.type.endsWith(RENAME));
  assert.ok(call, "nothing was sent");
  assert.deepEqual(call.payload, { keyId: DID_KEY, newKeyId: "vdr-host-signing" });
});

test("a key that already has a name opens on it, and Save waits for a change", async () => {
  const { screen } = await mount([key("app-signing-key")]);
  await screen.click(screen.button("Rename"));
  assert.equal(field(screen)!.value, "app-signing-key");
  assert.ok(
    (screen.button("Save") as HTMLButtonElement).disabled,
    "renaming a key to the name it has is a write with nothing in it",
  );
});
