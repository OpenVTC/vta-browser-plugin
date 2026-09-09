// The starter form, rendered.
//
// The set itself is tested in `manager-starter-set.test.mts`. These are the
// things only a mounted form can be wrong about: a blank row that gets written
// anyway, a partial failure reported as a total one, a value the agent will
// mask with nothing on screen to warn anybody first.

import { test } from "node:test";
import assert from "node:assert/strict";
import { agent, h, render, PARTIES, UNSCOPED_HOLDER } from "./harness/dom.mjs";
import { StarterForm } from "../src/manager/panes/persona-starter.js";

const REGISTRY = {
  registryVersion: "0.1",
  entries: [
    "name.given", "name.family", "name.display", "email.personal",
    "address.country", "person.locale", "phone.mobile", "org.name",
  ].map((type) => ({ type, sensitivity: "normal", release: "consent", mask: "none" })),
  unregistered: { sensitivity: "high", release: "consent", mask: "full" },
  strictness: {
    sensitivity: ["high", "normal"],
    release: ["stepUp", "consent"],
    mask: ["full", "last2", "last4", "emailLocal", "none"],
  },
} as never;

function mount(fake: ReturnType<typeof agent>, extra: Record<string, unknown> = {}) {
  return {
    element: h(StarterForm, {
      parties: PARTIES,
      authority: UNSCOPED_HOLDER,
      registry: REGISTRY,
      onDone: () => {},
      onManual: () => {},
      ...extra,
    }),
    options: { chrome: { runtime: { sendMessage: fake.sendMessage } } },
  };
}

const put = () => agent({ "persona/attribute/put/1.0": { attributeId: "a1", version: 1, created: true, updatedAt: "2026-09-09T00:00:00Z" } });

test("the ordinary things are on screen and the rest are folded away", async () => {
  const fake = put();
  const m = mount(fake);
  const screen = await render(m.element, m.options);
  const text = screen.text();
  assert.match(text, /First name/);
  assert.match(text, /Personal email/);
  // `often` is offered, not insisted on.
  assert.doesNotMatch(text, /Mobile number/, "a high-sensitivity row was put in front of someone");
  await screen.click(screen.button("More things sites often ask for"));
  assert.match(screen.text(), /Mobile number/);
  assert.match(screen.text(), /Where you work/, "the workplace question is missing");
  await screen.unmount();
});

test("no identity document is asked for, and the screen says why", async () => {
  const fake = put();
  const m = mount(fake);
  const screen = await render(m.element, m.options);
  const text = screen.text();
  assert.doesNotMatch(text, /passport/i);
  assert.doesNotMatch(text, /card number/i);
  assert.match(text, /you said so/, "the reason they are absent is not given");
  await screen.unmount();
});

test("nothing is written until something is typed", async () => {
  const fake = put();
  const m = mount(fake);
  const screen = await render(m.element, m.options);
  assert.equal(screen.button("Add these").disabled, true, "an empty form offered to write");
  await screen.unmount();
});

test("only the rows somebody filled in are written", async () => {
  const fake = put();
  const m = mount(fake);
  const screen = await render(m.element, m.options);
  await screen.type(screen.all('input[aria-label="First name"]')[0]!, "Ada");
  await screen.type(screen.all('input[aria-label="Last name"]')[0]!, "   ");
  await screen.click(screen.button("Add 1 attribute"));
  await screen.settle();
  const sent = fake.of("attribute/put");
  assert.equal(sent.length, 1, `wrote ${sent.length} attributes for one filled row`);
  assert.equal(sent[0]!.payload.type, "name.given");
  assert.equal(sent[0]!.payload.value, "Ada");
  assert.equal(sent[0]!.payload.provenance.kind, "selfAsserted");
  await screen.unmount();
});

test("a create is a create, so a retry cannot duplicate it", async () => {
  const fake = put();
  const m = mount(fake);
  const screen = await render(m.element, m.options);
  await screen.type(screen.all('input[aria-label="First name"]')[0]!, "Ada");
  await screen.click(screen.button("Add 1 attribute"));
  await screen.settle();
  assert.equal(fake.of("attribute/put")[0]!.payload.expectedVersion, 0);
  await screen.unmount();
});

test("a value the agent has not declared says so before anyone types", async () => {
  // `person.pronouns` is absent from this fixture's registry, so it resolves to
  // the most protective treatment and comes back masked. Saying that after the
  // fact is a surprise; saying it beside the field is a choice.
  const fake = put();
  const m = mount(fake);
  const screen = await render(m.element, m.options);
  assert.match(screen.text(), /has not said what kind of value this is/);
  await screen.unmount();
});

test("a partial failure says which half happened", async () => {
  // Sequential independent writes: the second can fail with the first stored.
  // Reporting only the error would leave someone believing none of it landed,
  // and a retry would then duplicate the one that did.
  let n = 0;
  const fake = agent({
    "persona/attribute/put/1.0": () => {
      n += 1;
      if (n === 2) throw new Error("agent said no");
      return { attributeId: `a${n}`, version: 1, created: true, updatedAt: "2026-09-09T00:00:00Z" };
    },
  });
  const m = mount(fake);
  const screen = await render(m.element, m.options);
  await screen.type(screen.all('input[aria-label="First name"]')[0]!, "Ada");
  await screen.type(screen.all('input[aria-label="Last name"]')[0]!, "Lovelace");
  await screen.click(screen.button("Add 2 attributes"));
  await screen.settle();
  assert.match(screen.text(), /1 of 2 were added/, "a partial write was reported as a total failure");
  await screen.unmount();
});
