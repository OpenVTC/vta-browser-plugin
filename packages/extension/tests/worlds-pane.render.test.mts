// The worlds screen, rendered.
//
// The model beneath it (`world-model.ts`) passes for every case here. These are
// the ones only a mounted screen can be wrong about, and the first is the one
// that matters most: a delete confirm that reads like a folder. The model
// cannot tell you what the confirm *said*.

import { test } from "node:test";
import assert from "node:assert/strict";
import { agent, h, render, PARTIES, UNSCOPED_HOLDER } from "./harness/dom.mjs";
import { WorldsPane } from "../src/manager/panes/worlds.js";

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

function mount(fake: ReturnType<typeof agent>, worlds: unknown[], extra = {}) {
  return {
    element: h(WorldsPane, {
      parties: PARTIES,
      authority: UNSCOPED_HOLDER,
      worlds,
      faces: FACES,
      attributes: ATTRS,
      registry: REGISTRY,
      onChanged: () => {},
      ...extra,
    }),
    options: { chrome: { runtime: { sendMessage: fake.sendMessage } } },
  };
}

const putOk = () =>
  agent({ "persona/facet/put/1.0": { facetId: "w9", version: 1, created: true, updatedAt: "x" } });

test("a world lists what belongs to it, and what belongs nowhere is said too", async () => {
  const m = mount(putOk(), [world("w1", "Work", ["f1", "f2"])]);
  const screen = await render(m.element, m.options);
  const text = screen.text();
  assert.match(text, /Work/);
  assert.match(text, /Acme · LinkedIn/);
  // Belonging nowhere is a real state, not an omission.
  assert.match(text, /One face belongs to no world: Loose/);
  await screen.unmount();
});

test("with no worlds the screen suggests rather than scolds", async () => {
  const m = mount(putOk(), []);
  const screen = await render(m.element, m.options);
  assert.match(screen.text(), /no worlds yet/);
  await screen.unmount();
});

test("deleting a world says what SURVIVES, not only what goes", async () => {
  // The assertion this file exists for. A grouping that looks like a folder is
  // assumed to behave like one, so the confirm has to deny it in words — a
  // holder who believes Delete takes the faces with it will not press it, and
  // one who believes it and is wrong has lost nothing but will never trust the
  // screen again.
  const m = mount(putOk(), [world("w1", "Work", ["f1", "f2"])]);
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
  const m = mount(putOk(), [world("w1", "Spare", [])]);
  const screen = await render(m.element, m.options);
  await screen.click(screen.button("Delete"));
  await screen.settle();
  assert.match(screen.text(), /No face belongs to it, and nothing else changes/);
  await screen.unmount();
});

test("no cascade is offered anywhere on the delete", async () => {
  // There is no cascading form of this call on the wire, and a screen that
  // implied one would be promising something the agent refuses to do.
  const m = mount(putOk(), [world("w1", "Work", ["f1"])]);
  const screen = await render(m.element, m.options);
  await screen.click(screen.button("Delete"));
  await screen.settle();
  assert.doesNotMatch(screen.text(), /also delete|including the faces|and its faces/i);
  await screen.unmount();
});

test("a face already in another world cannot be ticked, and says where it is", async () => {
  // Said before the save. A checkbox that looked available and then failed is a
  // refusal the holder had no way to anticipate.
  const m = mount(putOk(), [world("w1", "Work", ["f1"]), world("w2", "Home", [])]);
  const screen = await render(m.element, m.options);
  // The SECOND Edit — Home, which does not hold Acme. Editing Work would
  // correctly show no conflict, which is the next test.
  await screen.click(screen.all("button").filter((b) => b.textContent?.includes("Edit"))[1]!);
  await screen.settle();
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
  const m = mount(putOk(), [world("w1", "Work", ["f1"]), world("w2", "Home", [])]);
  const screen = await render(m.element, m.options);
  await screen.click(screen.all("button").filter((b) => b.textContent?.includes("Edit"))[0]!);
  await screen.settle();
  const acme = screen.all('input[aria-label="Acme"]')[0]!;
  assert.equal(acme.disabled, false, "a world's own member was blocked from its own editor");
  assert.equal(acme.checked, true);
  await screen.unmount();
});

test("an edit opens with the membership it will replace", async () => {
  // A put REPLACES both lists. An editor that opened with an empty selection
  // and saved would silently empty the world on an edit that meant to rename.
  const fake = putOk();
  const m = mount(fake, [world("w1", "Work", ["f1", "f2"])]);
  const screen = await render(m.element, m.options);
  await screen.click(screen.byText("button", "Edit")!);
  await screen.settle();
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
  const m = mount(fake, []);
  const screen = await render(m.element, m.options);
  await screen.click(screen.button("New world"));
  await screen.settle();
  await screen.type(screen.all('input[aria-label="What do you call it?"]')[0]!, "Play");
  await screen.click(screen.byText("button", "")!.ownerDocument.querySelector('[aria-label="Plum"]')!);
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
  const m = mount(fake, [world("w1", "Work", [])]);
  const screen = await render(m.element, m.options);
  await screen.click(screen.byText("button", "Edit")!);
  await screen.settle();
  await screen.check(screen.all('input[aria-label="Acme"]')[0]!);
  await screen.click(screen.button("Save"));
  await screen.settle();
  // Either shape is acceptable to a person; what must never appear is a bare
  // stack of wire text with no next step.
  assert.match(screen.text(), /belong to another world|already belong/);
  await screen.unmount();
});


test("the editor offers attributes grouped the way the rest of the console groups them", async () => {
  const fake = putOk();
  const m = mount(fake, []);
  const screen = await render(m.element, m.options);
  await screen.click(screen.button("New world"));
  await screen.settle();
  const text = screen.text();
  assert.match(text, /Which attributes belong to it\?/);
  assert.match(text, /How to reach you/, "attributes were not grouped by family");
  assert.match(text, /more than one/, "the no-exclusivity rule is not said");
  assert.match(text, /email\.work/);
  await screen.unmount();
});

test("an attribute checkbox is never disabled — several worlds is legal", async () => {
  const m = mount(putOk(), [world("w1", "Work", [], "teal", ["a1"])]);
  const screen = await render(m.element, m.options);
  await screen.click(screen.all("button").filter((b) => b.textContent?.includes("Edit"))[0]!);
  await screen.settle();
  for (const box of screen.all('input[aria-label="email.work"], input[aria-label="phone.mobile"]')) {
    assert.equal(box.disabled, false, "an attribute was blocked from a second world");
  }
  await screen.unmount();
});

test("an edit opens with the attribute membership it will replace, and sends it", async () => {
  const fake = putOk();
  const m = mount(fake, [world("w1", "Work", ["f1"], "teal", ["a1"])]);
  const screen = await render(m.element, m.options);
  await screen.click(screen.all("button").filter((b) => b.textContent?.includes("Edit"))[0]!);
  await screen.settle();
  assert.equal(screen.all('input[aria-label="email.work"]')[0]!.checked, true);
  assert.equal(screen.all('input[aria-label="phone.mobile"]')[0]!.checked, false);

  // Add the mobile — the "work email + work number together" case.
  await screen.check(screen.all('input[aria-label="phone.mobile"]')[0]!);
  await screen.click(screen.button("Save"));
  await screen.settle();
  const sent = fake.of("facet/put")[0]!;
  assert.deepEqual(sent.payload.attributeIds.sort(), ["a1", "a2"]);
  assert.deepEqual(sent.payload.faceIds, ["f1"], "face membership was lost by an attribute edit");
});

test("a world card says how many attributes belong to it", async () => {
  const m = mount(putOk(), [world("w1", "Work", [], "teal", ["a1", "a2"])]);
  const screen = await render(m.element, m.options);
  assert.match(screen.text(), /2 attributes belong to it/);
  await screen.unmount();
});

test("a world naming deleted records opens editable, and offers the repair", async () => {
  // Reported from the live console: "facet references 1 face(s) and 8
  // attribute(s) that do not exist", listing ULIDs with no row to untick. The
  // world could not be saved by the only screen that edits it.
  const stale = {
    facetId: "w1",
    name: "Work",
    colour: "teal",
    faceIds: ["f1", "01M22H8CAHEA3M3DTNB5SPNNK4"],
    attributeIds: ["a1", "01M22GP4VDH19GRJW3BG8NYPQX"],
    version: 3,
    updatedAt: "x",
  } as never;
  const fake = putOk();
  const m = mount(fake, [stale]);
  const screen = await render(m.element, m.options);
  await screen.click(screen.all("button").filter((b) => b.textContent?.includes("Edit"))[0]!);
  await screen.settle();

  assert.match(screen.text(), /still named 1 face and 1 attribute you have since deleted/);

  await screen.click(screen.button("Save"));
  await screen.settle();
  const sent = fake.of("facet/put")[0]!;
  assert.deepEqual(sent.payload.faceIds, ["f1"], "a deleted face was sent back to the agent");
  assert.deepEqual(sent.payload.attributeIds, ["a1"], "a deleted attribute was sent back");
});

test("picking a mark sends it, and pressing it again clears it", async () => {
  const fake = putOk();
  const m = mount(fake, []);
  const screen = await render(m.element, m.options);
  await screen.click(screen.button("New world"));
  await screen.settle();
  await screen.type(screen.all('input[aria-label="What do you call it?"]')[0]!, "Play");

  const controller = screen.all('button[aria-label="Mark 🎮"]')[0]!;
  await screen.click(controller);
  assert.equal(screen.all('input[aria-label="A mark (optional)"]')[0]!.value, "🎮");

  // A picker with no way back forces a mark on anyone who tries one.
  await screen.click(controller);
  assert.equal(screen.all('input[aria-label="A mark (optional)"]')[0]!.value, "");

  await screen.click(controller);
  await screen.click(screen.button("Create"));
  await screen.settle();
  assert.equal(fake.of("facet/put")[0]!.payload.icon, "🎮");
});

test("a mark too long for the wire is refused here, not after Save", async () => {
  const fake = putOk();
  const m = mount(fake, []);
  const screen = await render(m.element, m.options);
  await screen.click(screen.button("New world"));
  await screen.settle();
  await screen.type(screen.all('input[aria-label="What do you call it?"]')[0]!, "Family");
  await screen.type(
    screen.all('input[aria-label="A mark (optional)"]')[0]!,
    "\u{1F468}‍\u{1F469}‍\u{1F467}‍\u{1F466}",
  );
  assert.match(screen.text(), /too long for your agent to store/);
  assert.equal(screen.button("Create").disabled, true, "an over-long mark could still be saved");
});
