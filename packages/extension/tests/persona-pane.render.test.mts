// The persona pane, rendered.
//
// Every one of these is a bug that reached the live console today, and every
// one of them was invisible to the type checker and to the tested modules
// beneath the components. They are written against the *symptom a person saw*
// rather than the fix, so they keep meaning something if the fix is rewritten:
// a blank pane, a form that opens empty, a screen that never comes back, a
// field asking for something the holder does not have.
//
// The models under these screens were correct throughout — `identity-graph`,
// `profile-entries`, `persona-flow`, `persona-candidates` all passed while the
// screens were broken. That gap is what a renderer closes.

import { test } from "node:test";
import assert from "node:assert/strict";
import { agent, h, render, PARTIES } from "./harness/dom.mjs";
import { GuidedSetup } from "../src/manager/panes/persona-setup.js";
import { IdentityMap } from "../src/manager/panes/persona-map.js";
import { BindingForm } from "../src/manager/panes/persona-editors.js";
import { buildGraph } from "../src/manager/identity-graph.js";

const HOLDER = { session: { id: "s" }, roles: ["admin"], scopes: [] };

const fact = (id: string, type: string, value: string) => ({
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
const context = (id: string, name: string) => ({
  id,
  name,
  basePath: `/${id}`,
  createdAt: "2026-09-07T09:00:00Z",
});

const FACTS = [fact("f1", "name", "Glenn Gore"), fact("f2", "phone.mobile", "+65 8262 2325")];
const CONTEXTS = [context("openvtc", "OpenVTC"), context("vta", "Verifiable Trust Agent")];

// ── The blank pane (#179) ───────────────────────────────────────────────────

test("making a face does not loop the renderer", async () => {
  // React error #185, a blank pane, and a stack pointing at a `ref` callback
  // that scraped the editor's checkboxes and set state — which React re-invoked
  // on every commit. The symptom was total: nothing rendered at all.
  //
  // A loop surfaces here as `act` never settling or React throwing, so simply
  // reaching the assertions is most of the test.
  const a = agent({ "persona/profile/put/1.0": { profileId: "p1", version: 1, created: true, updatedAt: "x" } });
  const ui = await render(
    h(GuidedSetup, {
      parties: PARTIES,
      authority: HOLDER,
      records: CONTEXTS,
      attributes: FACTS,
      profiles: [],
      onChanged: () => {},
      onFinished: () => {},
      onSkip: () => {},
    }),
    { chrome: { runtime: { sendMessage: a.sendMessage } } },
  );

  assert.match(ui.text(), /Make a face/, "the guide should be on step two with facts and no face");
  assert.match(ui.text(), /What a stranger would receive/);

  // Ticking is what drove the loop: the scrape ran, set state, and re-rendered.
  const boxes = ui.all('input[type="checkbox"]');
  assert.ok(boxes.length >= 2, `expected a tick per fact, saw ${boxes.length}`);
  await ui.check(boxes[0]!);
  await ui.check(boxes[1]!);

  // Still alive, and the card followed the ticks — which is the whole point of
  // showing it. Asserting only "did not crash" would pass against a preview
  // that renders nothing.
  assert.match(ui.text(), /Glenn Gore/, "the stranger card should show what was ticked");
  await ui.unmount();
});

test("the stranger card starts empty and says so", async () => {
  // The paired negative: an empty card is a real state with its own sentence,
  // not a blank area. Without this, the assertion above is satisfied by a card
  // that shows every fact regardless of the ticks.
  const a = agent({});
  const ui = await render(
    h(GuidedSetup, {
      parties: PARTIES,
      authority: HOLDER,
      records: CONTEXTS,
      attributes: FACTS,
      profiles: [],
      onChanged: () => {},
      onFinished: () => {},
      onSkip: () => {},
    }),
    { chrome: { runtime: { sendMessage: a.sendMessage } } },
  );
  assert.match(ui.text(), /Nothing ticked/);
  assert.doesNotMatch(ui.text(), /Glenn Gore/, "an unticked fact must not appear on the card");
  await ui.unmount();
});

// ── Stepping back (#180) ────────────────────────────────────────────────────

test("a completed step in the stepper is a way back to it", async () => {
  // "Be good to go back a step to add more attributes." The ticked circle is
  // what a person clicks, and for a while it did nothing.
  const a = agent({});
  const ui = await render(
    h(GuidedSetup, {
      parties: PARTIES,
      authority: HOLDER,
      records: CONTEXTS,
      attributes: FACTS,
      profiles: [],
      onChanged: () => {},
      onFinished: () => {},
      onSkip: () => {},
    }),
    { chrome: { runtime: { sendMessage: a.sendMessage } } },
  );

  assert.match(ui.text(), /Make a face/);
  const backToOne = ui.byText('[role="button"]', "Add a fact or two");
  assert.ok(backToOne, "the completed first step should be pressable");
  await ui.click(backToOne!);
  assert.match(ui.text(), /Why start here/, "clicking step one should return to it");
  await ui.unmount();
});

// ── The empty persona field (#181) ──────────────────────────────────────────

test("a context that publishes no identifier offers to make one", async () => {
  // The dead end: an empty box, a `did:webvh:…` placeholder, and a pointer to
  // another pane. There was nothing to pick and no way forward.
  const a = agent({
    "vta/webvh/dids/list/1.0": { dids: [] },
    "persona/binding/list/1.0": { personas: [] },
    "vta/webvh/servers/list/1.0": { servers: [{ id: "srv1", did: "did:web:host.example", label: "storm.ws" }] },
  });
  const ui = await render(
    h(BindingForm, {
      parties: PARTIES,
      authority: HOLDER,
      contextId: "vta",
      contextLabel: "Verifiable Trust Agent",
      profiles: [face("p1", "Developer", ["f1"])],
      onDone: () => {},
    }),
    { chrome: { runtime: { sendMessage: a.sendMessage } } },
  );
  await ui.settle();

  assert.match(ui.text(), /This context publishes none yet/);
  assert.ok(ui.button("Create one here"), "a context with no identifier must offer to mint one");
  assert.match(ui.text(), /storm\.ws/, "and name the server it would publish through");
  await ui.unmount();
});

test("a context that publishes identifiers offers them as a list", async () => {
  // The pair. Without it, "offers to create" passes against a form that always
  // offers to create and never lists anything.
  const a = agent({
    "vta/webvh/dids/list/1.0": { dids: [{ did: "did:webvh:QmA:host:alpha", contextId: "vta" }] },
    "persona/binding/list/1.0": { personas: [] },
    "vta/webvh/servers/list/1.0": { servers: [] },
  });
  const ui = await render(
    h(BindingForm, {
      parties: PARTIES,
      authority: HOLDER,
      contextId: "vta",
      contextLabel: "Verifiable Trust Agent",
      profiles: [face("p1", "Developer", ["f1"])],
      onDone: () => {},
    }),
    { chrome: { runtime: { sendMessage: a.sendMessage } } },
  );
  await ui.settle();

  const options = ui.all("select option").map((o) => o.textContent ?? "");
  assert.ok(options.some((o) => o.includes("alpha")), `the published DID should be an option: ${options.join(" | ")}`);
  assert.match(ui.text(), /1 to choose from/);
  await ui.unmount();
});

test("the picker offers no identifier belonging to another context", async () => {
  // Reported live: switching contexts, the list carried other contexts' DIDs.
  // A binding is context-scoped, so offering one from elsewhere invites the
  // holder to be known in one place by a name another place already knows.
  const a = agent({
    "vta/webvh/dids/list/1.0": {
      dids: [
        { did: "did:webvh:QmA:host:mine", contextId: "vta" },
        { did: "did:webvh:QmB:host:elsewhere", contextId: "openvtc" },
      ],
    },
    "persona/binding/list/1.0": { personas: [] },
    "vta/webvh/servers/list/1.0": { servers: [] },
  });
  const ui = await render(
    h(BindingForm, {
      parties: PARTIES,
      authority: HOLDER,
      contextId: "vta",
      contextLabel: "Verifiable Trust Agent",
      profiles: [face("p1", "Developer", ["f1"])],
      onDone: () => {},
    }),
    { chrome: { runtime: { sendMessage: a.sendMessage } } },
  );
  await ui.settle();

  const text = ui.text();
  assert.match(text, /mine/, "this context's own identifier is offered");
  assert.doesNotMatch(text, /elsewhere/, "another context's identifier is not");
  await ui.unmount();
});

// ── The selection the form ignored (#182) ───────────────────────────────────

test("selecting a persona aims the context's button at it", async () => {
  // Selecting a persona and pressing the card's button opened an empty form
  // beside a highlighted row, which reads as the selection being ignored.
  const graph = buildGraph(FACTS, [face("p1", "Developer", ["f1", "f2"])], [
    {
      id: "openvtc",
      label: "OpenVTC",
      bindings: {
        ok: true,
        personas: [{ did: "did:webvh:QmZ:host:opinion-emotion", faceId: "p1", faceName: "Developer", claimCount: 2 }],
      },
    },
  ]);
  const a = agent({});
  const ui = await render(
    h(IdentityMap, {
      parties: PARTIES,
      authority: HOLDER,
      graph,
      attributes: FACTS,
      profiles: [face("p1", "Developer", ["f1", "f2"])],
      records: [context("openvtc", "OpenVTC")],
      history: [],
      onChanged: () => {},
    }),
    { chrome: { runtime: { sendMessage: a.sendMessage } } },
  );

  assert.ok(ui.button("Be known here as…"), "with nothing selected the button invites a new persona");

  const persona = ui.byText("div", "opinion-emotion");
  assert.ok(persona, "the persona should be on the map");
  await ui.click(persona!);

  assert.ok(
    ui.byText("button", "Change what opinion-emotion wears"),
    `selecting a persona should aim the button at it — buttons: ${ui.all("button").map((b) => b.textContent).join(" | ")}`,
  );
  await ui.unmount();
});

// ── What the map says before anything exists ────────────────────────────────

test("a holder known nowhere is told so, not shown an empty grid", async () => {
  const graph = buildGraph(FACTS, [face("p1", "Developer", ["f1"])], [
    { id: "openvtc", label: "OpenVTC", bindings: { ok: true, personas: [] } },
    { id: "vta", label: "Verifiable Trust Agent", bindings: { ok: true, personas: [] } },
  ]);
  const a = agent({});
  const ui = await render(
    h(IdentityMap, {
      parties: PARTIES,
      authority: HOLDER,
      graph,
      attributes: FACTS,
      profiles: [face("p1", "Developer", ["f1"])],
      records: CONTEXTS,
      history: [],
      onChanged: () => {},
    }),
    { chrome: { runtime: { sendMessage: a.sendMessage } } },
  );
  assert.match(ui.text(), /You are not known anywhere yet/);
  assert.match(ui.text(), /Not known in 2 other contexts/);
  await ui.unmount();
});

test("a context the agent would not answer for is not folded away as empty", async () => {
  // "Could not ask" is not "nobody is known here", and hiding it would draw a
  // picture that reads as complete when it is not.
  const graph = buildGraph(FACTS, [], [
    { id: "openvtc", label: "OpenVTC", bindings: { ok: false, error: "refused" } },
    { id: "vta", label: "Verifiable Trust Agent", bindings: { ok: true, personas: [] } },
  ]);
  const a = agent({});
  const ui = await render(
    h(IdentityMap, {
      parties: PARTIES,
      authority: HOLDER,
      graph,
      attributes: FACTS,
      profiles: [],
      records: CONTEXTS,
      history: [],
      onChanged: () => {},
    }),
    { chrome: { runtime: { sendMessage: a.sendMessage } } },
  );
  assert.match(ui.text(), /would not say who is known here/);
  assert.match(ui.text(), /Not known in 1 other context\b/, "only the genuinely empty one folds");
  await ui.unmount();
});
