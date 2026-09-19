// The delete-a-context panel, rendered.
//
// Deleting a context deletes its whole subtree. The panel used to say nothing
// about that, and the omission was not cosmetic in either direction:
//
// **A parent holding nothing of its own read as harmless.** The preview showed
// "no keys and no DIDs", `needsForce` was false, so the panel sent
// `force: false` — and the agent refused, because sub-contexts exist. The
// operator saw a refusal for a deletion the screen had just described as
// destroying nothing.
//
// **A parent holding one key of its own read as almost harmless.** `force`
// went true on the strength of that one key, the confirmation listed it, and
// the agent destroyed every context below it and everything they held. The
// checkbox said "destroying the keys and DIDs listed above"; the list was one
// key, and the deletion was a subtree.
//
// Both are the same missing fact, so both are pinned here.

import { test } from "node:test";
import assert from "node:assert/strict";
import { agent, h, render, PARTIES } from "./harness/dom.mjs";
import { ContextsPane } from "../src/manager/panes/contexts.js";

const PREVIEW = "vta/contexts/preview-delete/1.0";
const DELETE = "vta/contexts/delete/1.0";
const LIST_DIDS = "vta/webvh/dids/list/1.0";

const ctx = (id: string) => ({
  id,
  name: id,
  createdAt: "2026-09-01T00:00:00Z",
  updatedAt: "2026-09-01T00:00:00Z",
  basePath: "m/26'/2'/0'",
});

/** A subtree: `acme` over `acme/eng` over `acme/eng/ci`, plus an unrelated
 *  `acme-corp`. The agent decides what the cascade reaches and says so in
 *  `subContexts`; the console no longer derives it, so `acme-corp`'s absence
 *  here is the agent's answer rather than the console's path matching. */
const RECORDS = [ctx("acme"), ctx("acme/eng"), ctx("acme/eng/ci"), ctx("acme-corp")];
const SUBTREE = ["acme/eng/ci", "acme/eng"];

const mount = async (preview: Record<string, unknown>, records = RECORDS) => {
  const a = agent({
    [PREVIEW]: { id: "acme", keys: [], webvhDids: [], subContexts: SUBTREE, ...preview },
    [DELETE]: { id: "acme", deleted: true },
    [LIST_DIDS]: { dids: [] },
  });
  const screen = await render(
    h(ContextsPane, {
      parties: PARTIES,
      authority: null,
      records,
      selected: "acme",
      onChanged: () => {},
    } as never),
    { chrome: { runtime: { sendMessage: a.sendMessage } } },
  );
  return { a, screen };
};

/** Open the delete panel's preview step. */
const openPreview = async (screen: { button: (s: string) => Element; click: (e: Element) => Promise<void>; settle: () => Promise<void> }) => {
  await screen.click(screen.button("Delete context"));
  await screen.settle();
};

test("the sub-contexts that go with it are named, not merely implied", async () => {
  const { screen } = await mount({});
  await openPreview(screen as never);
  const text = (screen as never as { text: () => string }).text();
  assert.match(text, /acme\/eng\/ci/, "the deepest sub-context is not on screen");
  assert.match(text, /acme\/eng(?!\/)/, "the intermediate sub-context is not on screen");
  assert.doesNotMatch(
    text,
    /acme-corp/,
    "only what the agent named is shown — the console does not add to it",
  );
});

test("a context holding nothing itself still asks, because its children go too", async () => {
  // The agent reports no keys and no DIDs — the exact answer that used to
  // produce "holds nothing" and a `force: false` the agent then refused.
  const { screen } = await mount({});
  await openPreview(screen as never);
  assert.doesNotMatch(
    (screen as never as { text: () => string }).text(),
    /holds nothing, and has no sub-contexts/,
    "a context with three sub-contexts was described as holding nothing",
  );
  // The force control is offered, which is what makes the deletion possible
  // at all: the agent refuses this subtree without it.
  assert.match((screen as never as { text: () => string }).text(), /Delete anyway/);
});

test("a leaf holding nothing says so, and does not ask for force", async () => {
  const { screen } = await mount({ subContexts: [] }, [ctx("acme"), ctx("acme-corp")]);
  await openPreview(screen as never);
  const text = (screen as never as { text: () => string }).text();
  assert.match(text, /holds nothing, and has no sub-contexts/);
  assert.doesNotMatch(text, /Delete anyway/, "an empty leaf must not need force");
});

test("grants and templates count as contents, not only keys and DIDs", async () => {
  // A context whose only contents are a grant used to render empty and skip
  // the force control entirely.
  const { screen } = await mount(
    {
      subContexts: [],
      aclEntriesRemoved: ["did:key:z6MkBankBot"],
      didTemplates: ["bank-persona"],
    },
    [ctx("acme"), ctx("acme-corp")],
  );
  await openPreview(screen as never);
  const text = (screen as never as { text: () => string }).text();
  assert.match(text, /losing access entirely/, "the subject losing all authority is not shown");
  assert.match(text, /z6MkBankBot|z6MkB/, "the subject is not named");
  assert.match(text, /bank-persona/, "the template is not named");
  assert.match(text, /Delete anyway/, "a context holding a grant must need force");
});
