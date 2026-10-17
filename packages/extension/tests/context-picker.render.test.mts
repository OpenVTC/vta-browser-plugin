// The context picker, rendered.
//
// Contexts nest, and a flat list made a sub-context read as a sibling of its
// parent. What is asserted is what a person sees: the roots first with what is
// inside them counted, a parent opening to show its children, a search that
// finds a child wherever it sits, and a parent the caller cannot reach drawn
// but not choosable.

import { test } from "node:test";
import assert from "node:assert/strict";
import { h, render } from "./harness/dom.mjs";
import { ContextPicker, contextName } from "../src/manager/context-picker.js";

const CONTEXTS = [
  { id: "openvtc", name: "OpenVTC" },
  { id: "openvtc-bob", name: "OpenVTC BOB" },
  { id: "openvtc-bob/first", name: "did:webvh:Qme5:webvh.storm.ws:first-vtc", parent: "openvtc-bob" },
  { id: "work/eng", name: "Engineering", parent: "work" },
];

const mount = async (value = "") => {
  const picked: string[] = [];
  const screen = await render(
    h(ContextPicker, { name: "Context", options: CONTEXTS, value, onChange: (id: string) => picked.push(id) } as never),
  );
  return { screen, picked };
};

test("roots first, with what is inside a collapsed one counted", async () => {
  const { screen } = await mount();
  assert.equal(screen.all('[data-context-id="openvtc-bob/first"]').length, 0, "children start folded");
  assert.match(screen.text(), /1 inside/);
  await screen.click(screen.all("[aria-expanded]").find((el) => (el.getAttribute("aria-label") ?? "").includes("BOB"))!);
  assert.equal(screen.all('[data-context-id="openvtc-bob/first"]').length, 1);
});

test("a search finds a child wherever it sits", async () => {
  const { screen } = await mount();
  await screen.type(screen.all("input")[0]!, "first");
  assert.equal(screen.all('[data-context-id="openvtc-bob/first"]').length, 1);
  assert.equal(screen.all('[data-context-id="openvtc"]').length, 0);
});

test("choosing one folds the picker to the choice, and Change reopens it", async () => {
  const { screen, picked } = await mount();
  await screen.click(screen.all('[data-context-id="openvtc"]')[0]!);
  assert.deepEqual(picked, ["openvtc"]);
  await screen.rerender(h(ContextPicker, { name: "Context", options: CONTEXTS, value: "openvtc", onChange: () => {} } as never));
  assert.equal(screen.all('[role="radio"]').length, 0);
  await screen.click(screen.button("Change"));
  assert.ok(screen.all('[role="radio"]').length > 0);
});

test("a parent the caller cannot reach is drawn but cannot be chosen", async () => {
  const { screen, picked } = await mount();
  const work = screen.all('[role="radio"]').find((el) => (el.textContent ?? "").includes("work"))!;
  assert.ok(work, "the unreachable parent is on screen");
  assert.equal((work as HTMLButtonElement).disabled, true);
  await screen.click(work);
  assert.deepEqual(picked, []);
});

test("a context named by a DID reads as its host and name", () => {
  assert.equal(contextName(CONTEXTS[2] as never), "webvh.storm.ws/first-vtc");
  assert.equal(contextName(CONTEXTS[0] as never), "OpenVTC");
});
