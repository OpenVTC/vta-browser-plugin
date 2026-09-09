// Editors open where you clicked — the regression this redesign exists for.
//
// The bug, in the live console: pressing "+ Add an attribute" on the identity
// map appeared to do nothing. The form *was* rendered — at the very end of the
// JSX, after the attributes band, the faces, the divider, the contexts and the
// selection strip, which on a populated wallet is roughly 1700px down a 2450px
// scroller whose `scrollTop` never moved. Focus stayed on the button. Every
// visible signal said the click was ignored.
//
// A layout assertion cannot catch that here — happy-dom has no layout, so every
// box measures zero and any coordinate check would pass against the broken
// version too. So these assert the three things that are true of a popover and
// false of a form appended to the page, none of which need a layout engine:
//
//   1. it is a `dialog`, mounted as an overlay rather than as the last band
//   2. focus MOVES INTO it — the keyboard half of "nothing happened"
//   3. Escape closes it and gives focus back to the control that opened it
//
// Together those are what "it opened where I clicked" decomposes into for
// anything that is not a screenshot.

import { test } from "node:test";
import assert from "node:assert/strict";
import { agent, h, render, PARTIES } from "./harness/dom.mjs";
import { IdentityMap } from "../src/manager/panes/persona-map.js";
import { buildGraph } from "../src/manager/identity-graph.js";

const HOLDER = { session: { id: "s" }, roles: ["admin"], scopes: [] };
const REGISTRY = {
  registryVersion: "0.1",
  entries: [{ type: "name.legal", sensitivity: "normal", release: "consent", mask: "none" }],
  unregistered: { sensitivity: "high", release: "consent", mask: "full" },
  strictness: {
    sensitivity: ["high", "normal"],
    release: ["stepUp", "consent"],
    mask: ["full", "last2", "last4", "emailLocal", "none"],
  },
} as never;
const ATTRS = [{
  attributeId: "a1", type: "name.legal", valueType: "string" as const, value: "Glenn Gore",
  provenance: { kind: "selfAsserted" as const }, version: 1, updatedAt: "x",
}];
const FACES = [{
  profileId: "p1", name: "Work", entries: [{ ref: "a1" }], version: 1, updatedAt: "x",
}] as never[];

const mapScreen = () =>
  render(
    h(IdentityMap, {
      registry: REGISTRY,
      parties: PARTIES,
      authority: HOLDER,
      graph: buildGraph(ATTRS, [], []),
      attributes: ATTRS,
      profiles: [],
      worlds: [],
      records: [],
      history: [],
      onReveal: async () => ({}),
      onChanged: () => {},
    }),
    { chrome: { runtime: { sendMessage: agent({}).sendMessage } } },
  );

test("adding an attribute opens a dialog, not a band at the foot of the page", async () => {
  const ui = await mapScreen();
  assert.equal(ui.all('[role="dialog"]').length, 0, "nothing is open before the press");

  await ui.click(ui.button("Add an attribute"));
  const dialogs = ui.all('[role="dialog"]');
  assert.equal(dialogs.length, 1, "the form must be an overlay — appended to the page it is off screen");
  assert.match(dialogs[0]!.textContent ?? "", /TYPE/, "and it is the attribute form that opened");
  await ui.unmount();
});

test("focus moves into the form, so the keyboard is not told nothing happened either", async () => {
  const ui = await mapScreen();
  await ui.click(ui.button("Add an attribute"));

  const active = ui.container.ownerDocument.activeElement;
  assert.ok(active, "something must hold focus");
  assert.equal(active!.tagName, "INPUT", `focus stayed on ${active!.tagName}`);
  const dialog = ui.all('[role="dialog"]')[0]!;
  assert.ok(dialog.contains(active!), "focus must be inside the form, not left on the button");
  await ui.unmount();
});

test("Escape closes the form and gives focus back", async () => {
  const ui = await mapScreen();
  const opener = ui.button("Add an attribute");
  await ui.click(opener);
  assert.equal(ui.all('[role="dialog"]').length, 1);

  await ui.key("Escape");
  assert.equal(ui.all('[role="dialog"]').length, 0, "Escape must close it");
  assert.equal(
    ui.container.ownerDocument.activeElement,
    opener,
    "focus must return to the control that opened it, or the keyboard loses its place",
  );
  await ui.unmount();
});

test("a new world opens its own form from its own button", async () => {
  // The same mechanism, from the other band — worlds are edited on the map now,
  // so this is the path that replaced the deleted Worlds screen.
  const ui = await mapScreen();
  await ui.click(ui.button("New world"));
  const dialog = ui.all('[role="dialog"]')[0];
  assert.ok(dialog, "the world form must open as an overlay too");
  assert.match(dialog!.textContent ?? "", /What do you call it\?/);
  await ui.unmount();
});

test("selecting a face and pressing Edit opens the form, not a band below the fold", async () => {
  // Reported after the first round of this work: "editing a face still shows a
  // form at the bottom". The popover was fine — the *button that opens it* was
  // not reachable. Selecting anything renders the detail strip, and the strip
  // was the last element of a page two or three screens tall, so its Edit and
  // Delete sat below the fold. Clicking a face looked like it had only
  // highlighted something.
  //
  // The strip is pinned to the bottom of the pane now. That cannot be asserted
  // without layout, so this asserts the path it unblocked, end to end: select a
  // face, press Edit, get a dialog.
  const ui = await render(
    h(IdentityMap, {
      registry: REGISTRY,
      parties: PARTIES,
      authority: HOLDER,
      graph: buildGraph(ATTRS, FACES, []),
      attributes: ATTRS,
      profiles: FACES,
      worlds: [],
      records: [],
      history: [],
      onReveal: async () => ({}),
      onChanged: () => {},
    }),
    { chrome: { runtime: { sendMessage: agent({}).sendMessage } } },
  );

  const card = ui.byText("div", "Work");
  assert.ok(card, "the face card must be on the map");
  await ui.click(card!);
  // The strip is what carries the actions, and it must appear on selection.
  assert.match(ui.text(), /Worn by/, "selecting a face must open its detail strip");

  await ui.click(ui.button("Edit"));
  const dialog = ui.all('[role="dialog"]')[0];
  assert.ok(dialog, "Edit must open the face form as an overlay");
  assert.match(dialog!.textContent ?? "", /Shows|SHOWS/, "and it is the face editor");
  await ui.unmount();
});

test("the detail strip offers a way out of its own selection", async () => {
  // It is pinned now, so "click the card again" is no longer the only way to
  // dismiss it — and a panel that covers the bottom of the pane with no visible
  // close is a panel people fight.
  const ui = await render(
    h(IdentityMap, {
      registry: REGISTRY,
      parties: PARTIES,
      authority: HOLDER,
      graph: buildGraph(ATTRS, FACES, []),
      attributes: ATTRS,
      profiles: FACES,
      worlds: [],
      records: [],
      history: [],
      onReveal: async () => ({}),
      onChanged: () => {},
    }),
    { chrome: { runtime: { sendMessage: agent({}).sendMessage } } },
  );
  await ui.click(ui.byText("div", "Work")!);
  assert.match(ui.text(), /Worn by/);

  const clear = ui.all('button[aria-label="Clear selection"]')[0];
  assert.ok(clear, "the strip must carry a dismiss");
  await ui.click(clear!);
  assert.doesNotMatch(ui.text(), /Worn by/, "dismissing must clear the selection");
  await ui.unmount();
});

test("closing one form does not leave the page holding a scrim", async () => {
  // The overlay that catches an outside click is `position: fixed` over the
  // whole viewport. One left behind after close swallows every subsequent
  // click on the console, which reads as the whole screen going dead.
  const ui = await mapScreen();
  const before = ui.all("div").length;
  await ui.click(ui.button("Add an attribute"));
  await ui.key("Escape");
  assert.equal(ui.all("div").length, before, "the popover and its scrim must both be gone");
  await ui.unmount();
});
