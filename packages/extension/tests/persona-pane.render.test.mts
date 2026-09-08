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
const context = (id: string, name: string) => ({
  id,
  name,
  basePath: `/${id}`,
  createdAt: "2026-09-07T09:00:00Z",
});

// `name.legal` rather than a bare `name`: the claim-type registry has no
// entry for the latter, so it resolves to the conservative default and every
// assertion below that reads a name off the screen would be reading a mask.
// The fixture is a registered token because these tests are about something
// else; the masking of an unregistered one is asserted deliberately further
// down.
const FACTS = [attribute("f1", "name.legal", "Glenn Gore"), attribute("f2", "phone.mobile", "+65 8262 2325")];
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

  assert.match(ui.text(), /Make a face/, "the guide should be on step two with attributes and no face");
  assert.match(ui.text(), /What a stranger would receive/);

  // Ticking is what drove the loop: the scrape ran, set state, and re-rendered.
  const boxes = ui.all('input[type="checkbox"]');
  assert.ok(boxes.length >= 2, `expected a tick per attribute, saw ${boxes.length}`);
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
  // that shows every attribute regardless of the ticks.
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
  assert.doesNotMatch(ui.text(), /Glenn Gore/, "an unticked attribute must not appear on the card");
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
  const backToOne = ui.byText('[role="button"]', "Add an attribute or two");
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

// ── Values a shoulder should not collect (#185) ─────────────────────────────
//
// The console draws the holder's own attributes, so a passport number sits on screen
// for as long as the pane is open — through a screen share, a screenshot, and
// anyone walking past. Hiding it is worth doing and is worth being precise
// about what it is: the value was fetched before any of this ran, so this
// defends the *screen*. The read-path control that would defend the page
// (`includeSensitive` on `attribute/list`) does not exist yet.
//
// These are rendered rather than left to `manager-claim-sensitivity.test.mts`
// because the model being right is not the property — a masked model printed in
// full one surface over is the bug this whole change exists to prevent, and
// only a render sees it.

const SECRETS = [
  attribute("f1", "name.legal", "Glenn Gore"),
  attribute("f2", "phone.mobile", "+65 8262 2325"),
  attribute("f3", "gov.id.passport", "X1234567"),
  attribute("f4", "x:acme.badge", "BADGE-99"),
];

/** The map, mounted over `SECRETS` with nothing selected. */
const mapOverSecrets = async () =>
  render(
    h(IdentityMap, {
      parties: PARTIES,
      authority: HOLDER,
      graph: buildGraph(SECRETS, [], [{ id: "openvtc", label: "OpenVTC", bindings: { ok: true, personas: [] } }]),
      attributes: SECRETS,
      profiles: [],
      records: CONTEXTS,
      history: [],
      onChanged: () => {},
    }),
    { chrome: { runtime: { sendMessage: agent({}).sendMessage } } },
  );

/** The reveal controls, by exact label — `Show links` and `Show them` are
 *  neighbours on this screen and a substring match collects them. */
const shows = (ui: Awaited<ReturnType<typeof mapOverSecrets>>) =>
  ui.all("button").filter((b) => (b.textContent ?? "").trim() === "Show");

test("a sensitive value is not on the map until it is asked for", async () => {
  const ui = await mapOverSecrets();
  const screen = ui.text();

  assert.doesNotMatch(screen, /8262 2325/, "a mobile number must not be drawn in full");
  assert.doesNotMatch(screen, /X1234567/, "a passport number must not be drawn in full");
  // An `x:` token is one nobody has classified, which is the reason to hide it
  // rather than a reason to show it.
  assert.doesNotMatch(screen, /BADGE-99/, "an extension token resolves to the conservative default");
  // And the paired negative, which is the half that keeps this usable: a type
  // the registry calls normal is still a value on screen.
  assert.match(screen, /Glenn Gore/, "a legal name is not a sensitive value and must not be hidden");

  // A hidden value is drawn, not omitted. Rendering nothing — or rendering the
  // pane's phrase for a value the agent did not send — would say the holder
  // does not have an attribute they do have.
  assert.match(screen, /••••/, "a hidden value still occupies its row");
  assert.doesNotMatch(screen, /not requested/, "hidden is not the same state as absent");
  assert.match(screen, /•••• 25/, "the tail the holder recognises their own number by survives");

  await ui.unmount();
});

test("Show reveals one value, and only the one that was pressed", async () => {
  const ui = await mapOverSecrets();
  const controls = shows(ui);
  assert.equal(controls.length, 3, "one control per hidden attribute, and never a single global one");

  await ui.click(controls[0]!);
  const screen = ui.text();
  assert.match(screen, /8262 2325/, "the pressed control reveals its own value");
  assert.doesNotMatch(screen, /X1234567/, "and reveals nothing else");
  assert.doesNotMatch(screen, /BADGE-99/);

  // The card underneath is a click target — it selects the attribute and opens the
  // strip below the map. Revealing a value must not do that too: the operator
  // pressed Show, and the screen they were reading changing under them is the
  // symptom of a missing `stopPropagation`.
  assert.doesNotMatch(screen, /Last left/, "revealing a value must not also select the attribute");

  await ui.unmount();
});

test("a revealed value does not survive leaving the pane", async () => {
  const first = await mapOverSecrets();
  await first.click(shows(first)[1]!);
  assert.match(first.text(), /X1234567/);
  await first.unmount();

  // A fresh mount is what navigating away and back does. This passes trivially
  // for component state and fails for every way of making reveal "sticky" —
  // a module-level set, `localStorage`, a store the pane outlives — which is
  // the whole reason it is asserted rather than assumed.
  const second = await mapOverSecrets();
  assert.doesNotMatch(second.text(), /X1234567/, "coming back must not come back revealed");
  await second.unmount();
});

// ── The context that was denied and drawn at once ───────────────────────────
//
// The live console showed a card for a context holding an unbound persona,
// under a band captioned "where you are known", while the header counted it as
// nowhere and the fold row forgot it entirely: one of twelve, ten folded, two
// drawn. Whichever number a reader trusted, one of the others was lying to
// them, and the state underneath — a context that knows an identifier and
// holds no attributes — had no words anywhere on the screen.

const identified = (id: string, label: string, did: string) => ({
  id,
  label,
  bindings: { ok: true as const, personas: [{ did, faceId: null, claimCount: 0 }] },
});
const knownAs = (id: string, label: string) => ({
  id,
  label,
  bindings: {
    ok: true as const,
    personas: [{ did: "did:a", faceId: "p1", faceName: "Developer", claimCount: 1 }],
  },
});
const DEV = face("p1", "Developer", ["f1"]);

const map = (graph: ReturnType<typeof buildGraph>, profiles = [DEV]) =>
  h(IdentityMap, {
    parties: PARTIES,
    authority: HOLDER,
    graph,
    attributes: FACTS,
    profiles,
    records: CONTEXTS,
    history: [],
    onChanged: () => {},
  });

test("a context holding an unbound persona is drawn as an identifier, not as knowing you", async () => {
  const graph = buildGraph(FACTS, [DEV], [
    knownAs("openvtc", "OpenVTC"),
    identified("vta", "Verifiable Trust Agent", "did:webvh:x:webvh.storm.ws:glenn-vta"),
  ]);
  const a = agent({});
  const ui = await render(map(graph), { chrome: { runtime: { sendMessage: a.sendMessage } } });
  const text = ui.text();
  assert.match(text, /An identifier only/, "the third state has words of its own");
  assert.match(text, /Known here as/, "and the context that does know the holder keeps its own");
  assert.match(text, /can address that identifier/);
  await ui.unmount();
});

test("the header counts every context once, so its numbers close", async () => {
  const graph = buildGraph(FACTS, [DEV], [
    knownAs("openvtc", "OpenVTC"),
    identified("vta", "Verifiable Trust Agent", "did:b"),
    { id: "webvh", label: "webvh", bindings: { ok: true, personas: [] } },
  ]);
  const a = agent({});
  const ui = await render(map(graph), { chrome: { runtime: { sendMessage: a.sendMessage } } });
  const text = ui.text();
  assert.match(text, /known in 1/);
  assert.match(text, /an identifier in 1/);
  assert.match(text, /absent from 1(?!\d)/);
  // The header used to say one thing and the band another. The fold is the
  // third voice, and it must agree with both.
  assert.match(text, /Not known in 1 other context\b/);
  assert.doesNotMatch(text, /known in 1 of 3/, "the old single-test count is what came apart");
  await ui.unmount();
});

// ── Colour that says which way a copy went ──────────────────────────────────

test("the direction key appears only once something is selected", async () => {
  const graph = buildGraph(FACTS, [DEV], [knownAs("openvtc", "OpenVTC")]);
  const a = agent({});
  const ui = await render(map(graph), { chrome: { runtime: { sendMessage: a.sendMessage } } });
  assert.doesNotMatch(ui.text(), /goes down/, "a key for colours nothing is wearing yet is noise");

  // Selecting an attribute is what puts the two hues on screen.
  const card = ui.byText("div", "name.legal");
  assert.ok(card, "the attribute card is on the map");
  await ui.click(card);
  const text = ui.text();
  assert.match(text, /goes down/);
  assert.match(text, /comes up/);
  await ui.unmount();
});

test("attributes are grouped under the family their claim type comes from", async () => {
  // `name.legal` and `phone.mobile` are two different registry vocabularies and
  // must not end up under one heading; the group's words come from the registry
  // rather than from the spelling of the token.
  const graph = buildGraph(FACTS, [], []);
  const a = agent({});
  const ui = await render(map(graph, []), { chrome: { runtime: { sendMessage: a.sendMessage } } });
  const text = ui.text();
  assert.match(text, /Who you are/);
  assert.match(text, /How to reach you/);
  assert.doesNotMatch(text, /Not in the registry/, "no unregistered attribute here, so no heading for one");
  await ui.unmount();
});
