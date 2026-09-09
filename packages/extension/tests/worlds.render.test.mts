// Worlds, rendered — the editor, and the bubbles on the map.
//
// This file used to drive a `WorldsPane`. That screen is gone: worlds are now
// the bubbles the faces sit inside on the identity map, because a grouping you
// cannot see beside the things it groups is a list of names. Every assertion
// here survived the move, pointed at whichever surface now carries it — which
// is the point of writing them against the *symptom a person sees* rather than
// against a component.

import { test } from "node:test";
import assert from "node:assert/strict";
import { agent, h, render, PARTIES, UNSCOPED_HOLDER } from "./harness/dom.mjs";
import { WorldEditor } from "../src/manager/panes/worlds.js";
import { IdentityMap } from "../src/manager/panes/persona-map.js";
import { buildGraph } from "../src/manager/identity-graph.js";

const world = (id: string, name: string, faceIds: string[], colour = "teal", attributeIds: string[] = []) =>
  ({ facetId: id, name, colour, faceIds, attributeIds, version: 1, updatedAt: "x" }) as never;
const face = (id: string, name: string) =>
  ({ profileId: id, name, entries: [], version: 1, updatedAt: "x" }) as never;

const FACES = [face("f1", "Acme"), face("f2", "LinkedIn"), face("f3", "Loose")];

const attribute = (id: string, type: string, value: string) => ({
  attributeId: id,
  type,
  valueType: "string" as const,
  value,
  provenance: { kind: "selfAsserted" as const },
  version: 1,
  updatedAt: "x",
});
const ATTRS = [
  attribute("a1", "email.work", "ada@acme.example"),
  attribute("a2", "phone.mobile", "+61 400 000 000"),
];
const REGISTRY = {
  registryVersion: "0.1",
  entries: ["email", "email.work", "phone", "phone.mobile"].map((type) => ({
    type,
    sensitivity: "normal",
    release: "consent",
    mask: "none",
  })),
  unregistered: { sensitivity: "high", release: "consent", mask: "full" },
  strictness: {
    sensitivity: ["high", "normal"],
    release: ["stepUp", "consent"],
    mask: ["full", "last2", "last4", "emailLocal", "none"],
  },
} as never;

const putOk = () =>
  agent({ "persona/facet/put/1.0": { facetId: "w9", version: 1, created: true, updatedAt: "x" } });

/** The editor on its own, as the popover mounts it. */
function editor(fake: ReturnType<typeof agent>, worlds: unknown[], existing?: unknown) {
  return {
    element: h(WorldEditor, {
      parties: PARTIES,
      authority: UNSCOPED_HOLDER,
      ...(existing ? { existing } : {}),
      faces: FACES,
      attributes: ATTRS,
      registry: REGISTRY,
      worlds,
      onDone: () => {},
      onCancel: () => {},
    }),
    options: { chrome: { runtime: { sendMessage: fake.sendMessage } } },
  };
}

/** The map, which is where worlds are now drawn. */
function map(fake: ReturnType<typeof agent>, worlds: unknown[]) {
  return {
    element: h(IdentityMap, {
      registry: REGISTRY,
      parties: PARTIES,
      authority: UNSCOPED_HOLDER,
      graph: buildGraph(ATTRS, FACES, []),
      attributes: ATTRS,
      profiles: FACES,
      worlds,
      records: [],
      history: [],
      onReveal: async () => ({}),
      onChanged: () => {},
    }),
    options: { chrome: { runtime: { sendMessage: fake.sendMessage } } },
  };
}

// ── The bubbles ─────────────────────────────────────────────────────────────

test("a world shows the faces that belong to it, and what belongs nowhere is drawn too", async () => {
  const m = map(putOk(), [world("w1", "Work", ["f1", "f2"])]);
  const screen = await render(m.element, m.options);
  const text = screen.text();
  assert.match(text, /Work/);
  assert.match(text, /Acme/);
  assert.match(text, /LinkedIn/);
  // Belonging nowhere is a real state, not an omission — and now it is a
  // bubble of its own rather than a sentence under the list.
  assert.match(text, /Belongs to no world/);
  assert.match(text, /Loose/);
  await screen.unmount();
});

test("the tray for unplaced faces is drawn even when it is empty", async () => {
  // A band that listed only arranged faces would under-report what the holder
  // has. Empty, it says so in its own words rather than disappearing.
  const m = map(putOk(), [world("w1", "Work", ["f1", "f2", "f3"])]);
  const screen = await render(m.element, m.options);
  assert.match(screen.text(), /Belongs to no world/);
  assert.match(screen.text(), /Every face belongs somewhere/);
  await screen.unmount();
});

test("with no worlds the map still offers to make one", async () => {
  const m = map(putOk(), []);
  const screen = await render(m.element, m.options);
  assert.match(screen.text(), /New world/);
  await screen.unmount();
});

test("deleting a world says what SURVIVES, not only what goes", async () => {
  // The assertion this file exists for, and it moved intact. A grouping that
  // looks like a folder is assumed to behave like one — more so now that it is
  // literally a container with cards inside it — so the confirm has to deny it
  // in words.
  const m = map(putOk(), [world("w1", "Work", ["f1", "f2"])]);
  const screen = await render(m.element, m.options);
  await screen.click(screen.button("Delete"));
  await screen.settle();
  const text = screen.text();
  assert.match(text, /All 2 faces in it — Acme, LinkedIn — stay exactly as they are/);
  assert.match(text, /belong to no world/);
  assert.match(text, /Nothing already shared is affected/);
  await screen.unmount();
});

test("an empty world's delete still says nothing else changes", async () => {
  const m = map(putOk(), [world("w1", "Spare", [])]);
  const screen = await render(m.element, m.options);
  await screen.click(screen.button("Delete"));
  await screen.settle();
  assert.match(screen.text(), /No face belongs to it, and nothing else changes/);
  await screen.unmount();
});

test("no cascade is offered anywhere on the delete", async () => {
  // There is no cascading form of this call on the wire, and a screen that
  // implied one would be promising something the agent refuses to do.
  const m = map(putOk(), [world("w1", "Work", ["f1"])]);
  const screen = await render(m.element, m.options);
  await screen.click(screen.button("Delete"));
  await screen.settle();
  assert.doesNotMatch(screen.text(), /also delete|including the faces|and its faces/i);
  await screen.unmount();
});

test("a bubble says how many attributes belong to it", async () => {
  const m = map(putOk(), [world("w1", "Work", ["f1"], "teal", ["a1", "a2"])]);
  const screen = await render(m.element, m.options);
  assert.match(screen.text(), /2 attributes/);
  await screen.unmount();
});

// ── The editor ──────────────────────────────────────────────────────────────

test("a face already in another world cannot be ticked, and says where it is", async () => {
  // Said before the save. A checkbox that looked available and then failed is a
  // refusal the holder had no way to anticipate.
  const m = editor(putOk(), [world("w1", "Work", ["f1"]), world("w2", "Home", [])], world("w2", "Home", []));
  const screen = await render(m.element, m.options);
  assert.match(screen.text(), /already belongs to Work/);
  assert.equal(
    screen.all('input[aria-label="Acme"]')[0]!.disabled,
    true,
    "a face held by another world was offered as available",
  );
  await screen.unmount();
});

test("a world's own members are not conflicts with itself", async () => {
  // Without the exclusion every checkbox in an edit is disabled the moment the
  // world holds anything, and the world becomes uneditable.
  const m = editor(putOk(), [world("w1", "Work", ["f1"]), world("w2", "Home", [])], world("w1", "Work", ["f1"]));
  const screen = await render(m.element, m.options);
  const acme = screen.all('input[aria-label="Acme"]')[0]!;
  assert.equal(acme.disabled, false, "a world's own member was blocked from its own editor");
  assert.equal(acme.checked, true);
  await screen.unmount();
});

test("an edit opens with the membership it will replace", async () => {
  // A put REPLACES both lists. An editor that opened with an empty selection
  // and saved would silently empty the world on an edit that meant to rename.
  const fake = putOk();
  const m = editor(fake, [world("w1", "Work", ["f1", "f2"])], world("w1", "Work", ["f1", "f2"]));
  const screen = await render(m.element, m.options);
  assert.equal(screen.all('input[aria-label="Acme"]')[0]!.checked, true);
  assert.equal(screen.all('input[aria-label="LinkedIn"]')[0]!.checked, true);
  assert.equal(screen.all('input[aria-label="Loose"]')[0]!.checked, false);

  await screen.click(screen.button("Save"));
  await screen.settle();
  const sent = fake.of("facet/put")[0]!;
  assert.deepEqual(sent.payload.faceIds.sort(), ["f1", "f2"]);
  assert.equal(sent.payload.expectedVersion, 1, "an edit did not carry the version it read");
  await screen.unmount();
});

test("creating sends the colour that was picked", async () => {
  const fake = putOk();
  const m = editor(fake, []);
  const screen = await render(m.element, m.options);
  await screen.type(screen.all('input[aria-label="What do you call it?"]')[0]!, "Play");
  await screen.click(screen.container.querySelector('[aria-label="Plum"]')!);
  await screen.click(screen.button("Create"));
  await screen.settle();
  const sent = fake.of("facet/put")[0]!;
  assert.equal(sent.payload.name, "Play");
  assert.equal(sent.payload.colour, "plum");
  await screen.unmount();
});

test("a placement refusal offers a way out instead of a raw error", async () => {
  const fake = agent({
    "persona/facet/put/1.0": () => {
      const e = new Error("one or more faces already belong to another facet") as Error & {
        trustTaskError?: unknown;
      };
      e.trustTaskError = {
        code: "persona/facet/put:faceAlreadyPlaced",
        details: { placed: [{ faceId: "f1", facetId: "w2" }] },
      };
      throw e;
    },
  });
  const m = editor(fake, [world("w1", "Work", [])], world("w1", "Work", []));
  const screen = await render(m.element, m.options);
  await screen.check(screen.all('input[aria-label="Acme"]')[0]!);
  await screen.click(screen.button("Save"));
  await screen.settle();
  // Either shape is acceptable to a person; what must never appear is a bare
  // stack of wire text with no next step.
  assert.match(screen.text(), /belong to another world|already belong/);
  await screen.unmount();
});

test("the editor offers attributes grouped the way the rest of the console groups them", async () => {
  const m = editor(putOk(), []);
  const screen = await render(m.element, m.options);
  const text = screen.text();
  assert.match(text, /Which attributes belong to it\?/);
  assert.match(text, /How to reach you/, "attributes were not grouped by family");
  assert.match(text, /more than one/, "the no-exclusivity rule is not said");
  assert.match(text, /email\.work/);
  await screen.unmount();
});

test("an attribute checkbox is never disabled — several worlds is legal", async () => {
  const m = editor(putOk(), [world("w1", "Work", [], "teal", ["a1"])], world("w1", "Work", [], "teal", ["a1"]));
  const screen = await render(m.element, m.options);
  for (const box of screen.all('input[aria-label="email.work"], input[aria-label="phone.mobile"]')) {
    assert.equal(box.disabled, false, "an attribute was blocked from a second world");
  }
  await screen.unmount();
});

test("an edit opens with the attribute membership it will replace, and sends it", async () => {
  const fake = putOk();
  const existing = world("w1", "Work", ["f1"], "teal", ["a1"]);
  const m = editor(fake, [existing], existing);
  const screen = await render(m.element, m.options);
  assert.equal(screen.all('input[aria-label="email.work"]')[0]!.checked, true);
  assert.equal(screen.all('input[aria-label="phone.mobile"]')[0]!.checked, false);

  // Add the mobile — the "work email + work number together" case.
  await screen.check(screen.all('input[aria-label="phone.mobile"]')[0]!);
  await screen.click(screen.button("Save"));
  await screen.settle();
  const sent = fake.of("facet/put")[0]!;
  assert.deepEqual(sent.payload.attributeIds.sort(), ["a1", "a2"]);
  assert.deepEqual(sent.payload.faceIds, ["f1"], "face membership was lost by an attribute edit");
  await screen.unmount();
});
