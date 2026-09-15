// Authoring DID templates from the console.
//
// A template is a document that will be published under someone's identity,
// authored once and then used without being read again — so the three things
// pinned here are the ones whose failure is silent:
//
//   - **update is a REPLACE.** Anything the editor omits is omitted from the
//     stored record, and the agent reports success either way. The editor draws
//     four fields and a document; `optionalVars` and `defaults` are drawn
//     nowhere, so they have to survive a save by being carried.
//   - **built-ins are not writable.** The agent refuses; a button that refuses
//     first is the difference between a disabled control and a refusal after the
//     form was filled in.
//   - **scope is part of the address.** The same name globally and in a context
//     is two documents, and the wrong selector edits the wrong one.

import { test } from "node:test";
import assert from "node:assert/strict";
import { agent, h, render, PARTIES } from "./harness/dom.mjs";
import { DidTemplatesPane } from "../src/manager/panes/did-templates.js";

const LIST = "vta/did-templates/list/2.0";
const CREATE = "vta/did-templates/create/2.0";
const UPDATE = "vta/did-templates/update/2.0";
const RENDER = "vta/did-templates/render/2.0";

const tpl = (over: Record<string, unknown> = {}) => ({
  schemaVersion: 1,
  name: "mediator",
  kind: "mediator",
  description: "A DIDComm mediator's identity.",
  requiredVars: ["MEDIATOR_URL"],
  optionalVars: { LABEL: "a mediator" },
  defaults: { portable: true },
  document: { id: "{DID}", service: [] },
  scope: { type: "global" },
  createdAt: 0,
  updatedAt: 0,
  createdBy: "did:key:zAdmin",
  ...over,
});

const mount = async (answers: Record<string, unknown> = {}, contextId: string | null = "ops") => {
  const a = agent({ [LIST]: { templates: [tpl()] }, ...answers });
  const screen = await render(
    h(DidTemplatesPane, {
      parties: PARTIES,
      authority: null,
      contextId,
      contextHeading: "Ops",
    } as never),
    { chrome: { runtime: { sendMessage: a.sendMessage } } },
  );
  await screen.settle();
  return { a, screen };
};

test("a template is listed with what it provisions and what it asks for", async () => {
  const { screen } = await mount();
  const text = screen.text();
  assert.match(text, /mediator/);
  assert.match(text, /A DIDComm mediator's identity/);
  assert.match(text, /MEDIATOR_URL/);
  await screen.unmount();
});

// A context listing may answer with a global template of the same name — the
// fallback is in the specification — so asking both namespaces and
// concatenating shows every global template twice.
test("the two namespaces are merged, not concatenated", async () => {
  const { screen } = await mount();
  assert.equal(
    (screen.text().match(/A DIDComm mediator's identity/g) ?? []).length,
    1,
    "the same record came back from both listings and was drawn twice",
  );
  await screen.unmount();
});

test("a context template and a global one of the same name stay two rows", async () => {
  const { screen } = await mount({
    [LIST]: (payload: Record<string, unknown>) =>
      payload["contextId"]
        ? { templates: [tpl({ description: "Ops's own.", scope: { type: "context", contextId: "ops" } })] }
        : { templates: [tpl()] },
  });
  assert.match(screen.text(), /A DIDComm mediator's identity/);
  assert.match(screen.text(), /Ops's own/);
  assert.match(screen.text(), /in ops/);
  await screen.unmount();
});

// The editor draws four fields and a document. `optionalVars` and `defaults`
// appear nowhere — so a save that sent only what is on screen would clear them
// silently, with the agent reporting success.
test("a replace carries the members the editor never drew", async () => {
  const { a, screen } = await mount({ [UPDATE]: tpl() });
  await screen.click(screen.button("Edit"));
  await screen.click(screen.button("Replace template"));
  await screen.settle();
  const [call] = a.of("did-templates/update");
  assert.ok(call);
  const sent = (call.payload as { template: Record<string, unknown> }).template;
  assert.deepEqual(sent["optionalVars"], { LABEL: "a mediator" });
  assert.deepEqual(sent["defaults"], { portable: true });
  await screen.unmount();
});

test("an edit sends what was typed, as a whole template", async () => {
  const { a, screen } = await mount({ [UPDATE]: tpl() });
  await screen.click(screen.button("Edit"));
  await screen.type(screen.container.querySelector('input[aria-label="Description"]')!, "Changed.");
  await screen.click(screen.button("Replace template"));
  await screen.settle();
  const sent = (a.of("did-templates/update")[0]!.payload as { template: Record<string, unknown> }).template;
  assert.equal(sent["description"], "Changed.");
  assert.equal(sent["name"], "mediator");
  await screen.unmount();
});

// `room` and `room-host` ship with the agent and the rooms flow stamps from
// them. The agent refuses the write.
test("a built-in is inspectable and not writable", async () => {
  const { screen } = await mount({ [LIST]: { templates: [tpl({ scope: { type: "builtin" } })] } });
  assert.match(screen.text(), /built in/);
  await screen.click(screen.button("Inspect"));
  assert.match(screen.text(), /cannot be edited or deleted here/);
  assert.throws(() => screen.button("Replace template"), /no button/);
  await screen.unmount();
});

// The specification says requiredVars MUST NOT name an ambient variable, and
// the agent injects them regardless — so a template declaring one asks an
// operator for a value that is then thrown away.
test("an ambient variable cannot be declared as one to ask for", async () => {
  const { a, screen } = await mount({ [UPDATE]: tpl() });
  await screen.click(screen.button("Edit"));
  await screen.type(
    screen.container.querySelector('input[aria-label="Required variables"]')!,
    "VTA_URL, MEDIATOR_URL",
  );
  assert.match(screen.text(), /filled in by your agent/);
  await screen.click(screen.button("Replace template"));
  await screen.settle();
  assert.equal(a.of("did-templates/update").length, 0);
  await screen.unmount();
});

// `document.id` MUST contain `{DID}` — that is where the agent writes the DID
// it mints, and without it the template renders a document identifying nothing.
test("a document whose id has no DID placeholder is refused here", async () => {
  const { a, screen } = await mount({ [UPDATE]: tpl() });
  await screen.click(screen.button("Edit"));
  await screen.type(
    screen.container.querySelector('textarea[aria-label="Template document"]')!,
    '{"id":"did:webvh:fixed"}',
  );
  assert.match(screen.text(), /must contain `\{DID\}`/);
  await screen.click(screen.button("Replace template"));
  await screen.settle();
  assert.equal(a.of("did-templates/update").length, 0);
  await screen.unmount();
});

test("a document that is not JSON says which character broke it", async () => {
  const { screen } = await mount();
  await screen.click(screen.button("Edit"));
  await screen.type(screen.container.querySelector('textarea[aria-label="Template document"]')!, "{ nope");
  assert.match(screen.text(), /not valid JSON/);
  await screen.unmount();
});

// The one way to see what a template means is to have the agent perform its own
// substitution. A local preview would be this console's guess at the renderer.
test("rendering asks the agent, and says nothing was created", async () => {
  const { a, screen } = await mount({ [RENDER]: { document: { id: "did:webvh:QmX:example" } } });
  await screen.click(screen.button("Edit"));
  await screen.type(
    screen.container.querySelector('input[aria-label="Render variable MEDIATOR_URL"]')!,
    "https://m.example",
  );
  await screen.click(screen.button("Render the stored version"));
  await screen.settle();
  const [call] = a.of("did-templates/render");
  assert.ok(call);
  assert.deepEqual((call.payload as Record<string, unknown>)["vars"], {
    MEDIATOR_URL: "https://m.example",
  });
  assert.match(screen.text(), /Nothing was created/);
  assert.match(screen.text(), /did:webvh:QmX:example/);
  await screen.unmount();
});

// Sending a selector for a global template addresses a different namespace,
// which may hold a different template of the same name — or none.
test("a global template is addressed with no context selector", async () => {
  const { a, screen } = await mount({ [UPDATE]: tpl() });
  await screen.click(screen.button("Edit"));
  await screen.click(screen.button("Replace template"));
  await screen.settle();
  assert.equal(
    (a.of("did-templates/update")[0]!.payload as Record<string, unknown>)["contextId"],
    undefined,
  );
  await screen.unmount();
});

test("a context template is addressed with its own context", async () => {
  const { a, screen } = await mount({
    [LIST]: (payload: Record<string, unknown>) =>
      payload["contextId"]
        ? { templates: [tpl({ scope: { type: "context", contextId: "ops" } })] }
        : { templates: [] },
    [UPDATE]: tpl(),
  });
  await screen.click(screen.button("Edit"));
  await screen.click(screen.button("Replace template"));
  await screen.settle();
  assert.equal(
    (a.of("did-templates/update")[0]!.payload as Record<string, unknown>)["contextId"],
    "ops",
  );
  await screen.unmount();
});

test("a new template starts from a document whose id is the placeholder", async () => {
  const { a, screen } = await mount({ [CREATE]: tpl() });
  await screen.click(screen.button("New template"));
  await screen.type(screen.container.querySelector('input[aria-label="Template name"]')!, "app");
  await screen.type(screen.container.querySelector('input[aria-label="Template kind"]')!, "app");
  await screen.click(screen.button("Create template"));
  await screen.settle();
  const sent = (a.of("did-templates/create")[0]!.payload as { template: Record<string, unknown> }).template;
  assert.equal(sent["name"], "app");
  assert.equal((sent["document"] as Record<string, unknown>)["id"], "{DID}");
  await screen.unmount();
});

// A DID is a published log and does not refer back to the template it was
// stamped from, so this has to be said rather than left to be assumed either
// way.
test("deleting says what it does and does not reach", async () => {
  const { screen } = await mount();
  await screen.click(screen.button("Delete"));
  await screen.settle();
  assert.match(screen.text(), /Nothing already minted/);
  await screen.unmount();
});
