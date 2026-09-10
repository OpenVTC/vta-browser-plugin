// The words on screen, checked against the table that fixes them.
//
// `design-docs/persona-vocabulary.md` says its only mechanical enforcement is a
// banned-word assertion in `manager-holder-gate.test.mts`. That assertion scans
// **one string** — `holderGate`'s caution — and not the panes, so a screen
// saying *facet* or *group* has always shipped green. The doc records the gap;
// this closes it for the persona family.
//
// ## Why the check is on rendered text and not on the source
//
// Grepping `.tsx` cannot work, and the reason is not effort. `facet` is the
// **wire** word and is supposed to be everywhere in the code: task URIs,
// `facetId`, `attributeIds`, imports, the `PoolFacet` type. Only the words a
// person *reads* are banned. A source scan has to guess which string literals
// reach a screen, and every guess is either a false positive on a task URI or a
// hole big enough to walk a pane through.
//
// Mounting the pane removes the guess. `screen.text()` is the rendered text
// content — precisely the thing the table governs — so a hit is a hit and there
// is nothing to whitelist.
//
// ## Why the list here is shorter than the table's
//
// The table retires words for *prose*. Some of them are also legitimate
// **type tokens** shown deliberately in mono: an attribute of type
// `profile.github` prints that token on the card, and it must. So this file
// bans the words that cannot be a token in these panes and are the live risk —
// `facet` above all, because the wire uses it on every call these screens make
// and it is one careless label away from the screen.
//
// A word that needs the prose/token distinction belongs in a check that can
// make it, not in a looser version of this one.

import { test } from "node:test";
import assert from "node:assert/strict";
import { agent, h, render, PARTIES, UNSCOPED_HOLDER } from "./harness/dom.mjs";
import { WorldEditor } from "../src/manager/panes/worlds.js";
import { IdentityMap } from "../src/manager/panes/persona-map.js";
import { AttributeList } from "../src/manager/panes/persona-list.js";
import { AttributeEditor } from "../src/manager/panes/persona-editors.js";
import { buildGraph } from "../src/manager/identity-graph.js";

/**
 * Words that are never a claim type and never an identifier, so any appearance
 * is prose. `group` is checked as a whole word: `groupRows` is code and
 * "grouped by family" is a heading about attribute families, which the table
 * does not govern — the ban is on `group` standing in for a **world**.
 */
const BANNED: readonly [RegExp, string][] = [
  [/\bfacets?\b/i, "facet — the wire word. On screen it is a world."],
  [/\bmaterialis[e|ed|ing]/i, "materialise — on screen a context gets a copy."],
  [/\bprojection\b/i, "projection — on screen a context gets a copy."],
  [/\bcorrelations?\b/i, "correlation — on screen it is a link."],
  [/\bself-asserted\b/i, "self-asserted — on screen it is “you said so”."],
  [/\bcredential-backed\b/i, "credential-backed — on screen it is “credential · issuer”."],
  // Added after the TUI's own guard caught a string this console had shipped:
  // the gated family's note read "a disclosure needs your approval each time".
  // `disclosure` is the wire and audit word; on screen the journey is *letting
  // it leave*, and what has already gone is *what has left*. It is never a
  // claim type, so any appearance in rendered text is prose.
  [/\bdisclosures?\b/i, "disclosure — on screen it is letting it leave, or what has left."],
  // `fact` for an attribute was retired twice over: it asserts a truth a
  // self-asserted value does not have, and `Facts` already names a *verified*
  // policy input in the VTC ceremony engine. The table's standing rule is to
  // change it on sight.
  [/\bfacts?\b/i, "fact — on screen an attribute is an attribute."],
];

function assertSpeaksTheTable(text: string, where: string) {
  for (const [pattern, why] of BANNED) {
    const hit = text.match(pattern);
    assert.equal(
      hit,
      null,
      `${where} says “${hit?.[0]}” on screen. ${why} ` +
        `See design-docs/persona-vocabulary.md.`,
    );
  }
}

const world = (id: string, name: string, faceIds: string[] = []) =>
  ({ facetId: id, name, colour: "teal", faceIds, attributeIds: [], version: 1, updatedAt: "x" }) as never;
const face = (id: string, name: string) =>
  ({ profileId: id, name, entries: [], version: 1, updatedAt: "x" }) as never;
const attribute = (id: string, type: string, value: string) => ({
  attributeId: id,
  type,
  valueType: "string" as const,
  value,
  provenance: { kind: "selfAsserted" as const },
  version: 1,
  updatedAt: "x",
});

const REGISTRY = {
  registryVersion: "0.1",
  entries: ["name", "name.given", "email", "email.personal"].map((type) => ({
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

const ATTRS = [attribute("a1", "name.given", "Ada"), attribute("a2", "email.personal", "a@b.c")];
const FACES = [face("f1", "Acme"), face("f2", "LinkedIn")];

const quiet = () => agent({});

/** The map, which is where worlds are drawn now that the pane is gone. */
const mapWith = (worlds: unknown[]) =>
  h(IdentityMap, {
    parties: PARTIES,
    authority: UNSCOPED_HOLDER,
    registry: REGISTRY,
    graph: buildGraph(ATTRS, FACES, []),
    attributes: ATTRS,
    profiles: FACES,
    worlds,
    records: [],
    history: [],
    onReveal: async () => ({}),
    onChanged: () => {},
  });

/** The editor, as the popover mounts it. */
const editorWith = (worlds: unknown[], existing?: unknown) =>
  h(WorldEditor, {
    parties: PARTIES,
    authority: UNSCOPED_HOLDER,
    ...(existing ? { existing } : {}),
    faces: FACES,
    attributes: ATTRS,
    registry: REGISTRY,
    worlds,
    onDone: () => {},
    onCancel: () => {},
  });

test("the worlds on the map speak the table", async () => {
  const fake = quiet();
  const screen = await render(mapWith([world("w1", "Work", ["f1"])]), {
    chrome: { runtime: { sendMessage: fake.sendMessage } },
  });
  assertSpeaksTheTable(screen.text(), "the worlds band on the map");
  await screen.unmount();
});

test("the world editor speaks the table", async () => {
  // The screen with the most copy, and the one whose every control is named
  // after a wire member.
  const fake = quiet();
  const screen = await render(
    editorWith([world("w1", "Work", ["f1"])], world("w1", "Work", ["f1"])),
    { chrome: { runtime: { sendMessage: fake.sendMessage } } },
  );
  assertSpeaksTheTable(screen.text(), "the world editor");
  await screen.unmount();
});

test("an empty worlds screen speaks the table", async () => {
  // Empty states are written last and read first.
  const fake = quiet();
  const screen = await render(mapWith([]), {
    chrome: { runtime: { sendMessage: fake.sendMessage } },
  });
  assertSpeaksTheTable(screen.text(), "a map with no worlds yet");
  await screen.unmount();
});

test("the delete confirm speaks the table", async () => {
  // Destructive copy is where a wire word is most likely to be reached for,
  // because it is written while thinking about the record rather than the
  // person.
  const fake = quiet();
  const screen = await render(mapWith([world("w1", "Work", ["f1"])]), {
    chrome: { runtime: { sendMessage: fake.sendMessage } },
  });
  await screen.click(screen.button("Delete"));
  await screen.settle();
  assertSpeaksTheTable(screen.text(), "the world delete confirm");
  await screen.unmount();
});

test("the attribute list speaks the table, selection and all", async () => {
  const graph = buildGraph(ATTRS as never, [] as never, []);
  const fake = quiet();
  const screen = await render(
    h(AttributeList, {
      attributes: graph.attributes,
      faces: graph.faces,
      worlds: [world("w1", "Work")],
      registry: REGISTRY,
      parties: PARTIES,
      reveal: async () => ({}),
      onChanged: () => {},
      onEdit: () => {},
    }),
    { chrome: { runtime: { sendMessage: fake.sendMessage } } },
  );
  assertSpeaksTheTable(screen.text(), "the attribute list");
  // The bulk bar only exists with a selection, and carries its own copy.
  await screen.check(screen.all('input[type="checkbox"]')[1]!);
  assertSpeaksTheTable(screen.text(), "the attribute list with a selection");
  await screen.unmount();
});

test("the attribute editor speaks the table", async () => {
  // The editor is mounted here as well as in `persona-pane.render.test.mts`,
  // because it carries the longest stretch of prose in the persona family —
  // the two Decision explainers — and prose is where a retired word survives.
  // One of them said "binds the approval to that one disclosure" until the TUI
  // borrowed the string and refused it.
  const fake = quiet();
  const screen = await render(
    h(AttributeEditor, {
      registry: REGISTRY,
      parties: PARTIES,
      authority: UNSCOPED_HOLDER,
      onDone: () => {},
      onCancel: () => {},
    }),
    { chrome: { runtime: { sendMessage: fake.sendMessage } } },
  );
  assertSpeaksTheTable(screen.text(), "the attribute editor");
  await screen.unmount();
});

test("the guard is non-vacuous", () => {
  // A rendered-text check passes trivially if the render is empty, so the
  // matcher itself is exercised on a string that should fail.
  assert.throws(
    () => assertSpeaksTheTable("This facet groups your faces.", "a fixture"),
    /says “facet” on screen/,
  );
  assert.throws(
    () => assertSpeaksTheTable("A materialised copy goes down.", "a fixture"),
    /materialise/,
  );
  assert.throws(
    () => assertSpeaksTheTable("A disclosure needs your approval.", "a fixture"),
    /says “disclosure” on screen/,
  );
  assert.throws(
    () => assertSpeaksTheTable("3 facts about you.", "a fixture"),
    /says “facts” on screen/,
  );
  // And a legitimate token is not a false positive.
  assertSpeaksTheTable("profile.github  name.given", "a fixture");
});
