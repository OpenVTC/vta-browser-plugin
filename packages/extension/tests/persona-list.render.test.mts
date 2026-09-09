// The list view, rendered.
//
// The model under this screen (`attribute-list.ts`) is tested on its own and
// passes for every case here. These are the ones it cannot see: a third
// checkbox state that is a DOM property React will not set from JSX, a bulk bar
// that counts rows the agent has deleted, a delete that fires before anyone is
// told which faces stop presenting a value. Each is a thing a person would
// notice immediately and a type checker never will.

import { test } from "node:test";
import assert from "node:assert/strict";
import { agent, h, render, PARTIES } from "./harness/dom.mjs";
import { AttributeList } from "../src/manager/panes/persona-list.js";
import { buildGraph } from "../src/manager/identity-graph.js";

const attribute = (id: string, type: string, value: string) => ({
  attributeId: id,
  type,
  valueType: "string" as const,
  value,
  provenance: { kind: "selfAsserted" as const },
  version: 1,
  updatedAt: "2026-09-07T10:00:00Z",
});
const face = (id: string, name: string, refs: string[]) => ({
  profileId: id,
  name,
  entries: refs.map((ref) => ({ ref })),
  version: 1,
  updatedAt: "2026-09-07T10:00:00Z",
});

const REGISTRY = {
  registryVersion: "0.1",
  entries: [
    "name", "name.given", "name.family", "email", "email.personal", "phone", "phone.mobile",
  ].map((type) => ({ type, sensitivity: "normal", release: "consent", mask: "none" })),
  unregistered: { sensitivity: "high", release: "consent", mask: "full" },
  strictness: {
    sensitivity: ["high", "normal"],
    release: ["stepUp", "consent"],
    mask: ["full", "last2", "last4", "emailLocal", "none"],
  },
} as never;

function graphOf(faces: ReturnType<typeof face>[] = []) {
  return buildGraph(
    [
      attribute("a1", "name.given", "Ada"),
      attribute("a2", "name.family", "Lovelace"),
      attribute("a3", "email.personal", "ada@example.com"),
      attribute("a4", "phone.mobile", "+61 400 000 000"),
    ] as never,
    faces as never,
    [],
  );
}

function mount(graph: ReturnType<typeof graphOf>, extra: Record<string, unknown> = {}) {
  return h(AttributeList, {
    attributes: graph.attributes,
    faces: graph.faces,
    registry: REGISTRY,
    parties: PARTIES,
    reveal: async () => ({}),
    onChanged: () => {},
    onEdit: () => {},
    ...extra,
  });
}

test("every attribute is on screen under its family heading", async () => {
  const screen = await render(mount(graphOf()));
  const text = screen.text();
  assert.match(text, /Who you are/, "the identity family heading is missing");
  assert.match(text, /How to reach you/, "the contact family heading is missing");
  assert.match(text, /name\.given/);
  assert.match(text, /phone\.mobile/);
  assert.match(text, /4 attributes/, "the pane did not say how many it holds");
  await screen.unmount();
});

test("ticking a family heading selects everything under it", async () => {
  const screen = await render(mount(graphOf()));
  const boxes = screen.all('input[type="checkbox"]');
  // The first box in the first group is its heading.
  await screen.check(boxes[0]!);
  // `name.given` and `name.family` are both "Who you are".
  assert.match(screen.text(), /2 selected/, "a heading tick did not select the rows under it");
  await screen.unmount();
});

test("a partly selected heading draws the third state, not an empty box", async () => {
  // `indeterminate` is a DOM property, not an attribute, so React cannot set it
  // from JSX — it needs the ref callback. Without it a heading over four
  // selected rows draws an empty box, which says none of them are.
  const screen = await render(mount(graphOf()));
  const boxes = screen.all('input[type="checkbox"]');
  const heading = boxes[0]!;
  // Tick one row inside the first group, not the heading.
  await screen.check(boxes[1]!);
  assert.match(screen.text(), /1 selected/);
  assert.equal(
    (heading as unknown as { indeterminate: boolean }).indeterminate,
    true,
    "a partly selected family drew an empty checkbox",
  );
  assert.equal(heading.checked, false, "a partly selected family drew a full tick");
  await screen.unmount();
});

test("a shift-click selects the range that was on screen", async () => {
  const screen = await render(mount(graphOf()));
  // By aria-label, not by index: the checkbox list interleaves group headings
  // with rows, and an index that lands on a heading toggles a whole family
  // while the test believes it clicked one row.
  const row = (type: string) => screen.all(`input[aria-label="${type}"]`)[0]!;
  await screen.check(row("name.given"));
  // Shift-click a row two below it, across a family boundary. Grouping
  // reorders, so this must select what the person saw between them rather than
  // what the pool order would give.
  await screen.clickWith(row("email.personal"), { shiftKey: true });
  assert.match(screen.text(), /3 selected/, "a shift-click did not select the range on screen");
  await screen.unmount();
});

test("nothing is offered in bulk that would write a value", async () => {
  // The console lists without `includeSensitive`, so a bulk visibility change
  // would blank every sensitive attribute in the selection. The absence has to
  // be explained where someone would otherwise wonder.
  const screen = await render(mount(graphOf()));
  await screen.check(screen.all('input[type="checkbox"]')[1]!);
  assert.match(screen.text(), /one attribute at a time/, "the missing action was not explained");
  const labels = screen.all("button").map((b) => (b.textContent ?? "").toLowerCase());
  assert.ok(
    !labels.some((l) => l.includes("visib") || l.includes("hide") || l.includes("show all")),
    `a bulk value-writing action was offered: ${labels.join(", ")}`,
  );
  await screen.unmount();
});

test("the delete preview names the faces that would stop presenting a value", async () => {
  // The agent refuses while a face still names the attribute. A holder who is
  // not told that presses Delete, watches half of it succeed, and gets the rest
  // back as refusals one at a time.
  const screen = await render(mount(graphOf([face("f1", "Work", ["a1", "a3"])])));
  await screen.check(screen.all('input[type="checkbox"]')[1]!); // a1
  await screen.click(screen.button("Delete 1"));
  await screen.settle();
  const text = screen.text();
  assert.match(text, /still shown by Work/, "the face that would lose an entry was not named");
  assert.match(text, /Nothing already shared is affected/, "the vocabulary line is missing");
  await screen.unmount();
});

test("a delete of something no face uses does not ask the second question", async () => {
  const screen = await render(mount(graphOf([face("f1", "Work", ["a1"])])));
  const boxes = screen.all('input[type="checkbox"]');
  await screen.check(boxes[2]!); // a2 — in no face
  await screen.click(screen.button("Delete 1"));
  await screen.settle();
  assert.doesNotMatch(screen.text(), /still shown by/, "a face was named that loses nothing");
  await screen.unmount();
});

test("deleting sends cascade only when it was ticked", async () => {
  const fake = agent({ "persona/attribute/delete/1.0": { existed: true } });
  const screen = await render(mount(graphOf([face("f1", "Work", ["a1"])])), {
    chrome: { runtime: { sendMessage: fake.sendMessage } },
  });
  const boxes = screen.all('input[type="checkbox"]');
  await screen.check(boxes[2]!); // a2 — used by no face, so no force tick
  await screen.click(screen.button("Delete 1"));
  await screen.settle();
  await screen.click(screen.button("Delete"));
  await screen.settle();
  const sent = fake.of("attribute/delete");
  assert.equal(sent.length, 1, "the delete did not reach the agent");
  assert.equal(
    sent[0]!.payload.cascade,
    undefined,
    "cascade was sent for an attribute no face references",
  );
  await screen.unmount();
});
