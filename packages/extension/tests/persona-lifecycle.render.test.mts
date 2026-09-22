// The face lifecycle in the console, rendered: an end date that survives a
// face change, a delete that says it does not un-tell, a history with no
// values in it, and a compose that keeps a typed value local.

import { test } from "node:test";
import assert from "node:assert/strict";
import { agent, h, render, PARTIES } from "./harness/dom.mjs";
import {
  BindingForm,
  ComposeFace,
  DeleteProfile,
  FaceHistory,
} from "../src/manager/panes/persona-editors.js";

const HOLDER = { session: { id: "s" }, roles: ["admin"], scopes: [] };
const face = { profileId: "p1", name: "Conference", entries: [{ ref: "f1" }], version: 3, updatedAt: "2026-09-07T10:00:00Z" };
const sent = (a: { calls: { type: string; payload: Record<string, unknown> }[] }, slug: string) =>
  a.calls.filter((c) => c.type.endsWith(`/${slug}`)).map((c) => c.payload);

test("changing a face keeps the end its binding already had", async () => {
  const until = "2030-10-05T18:00:00.000Z";
  const a = agent({
    "persona/binding/get/1.0": { contextId: "conf", personaDid: "did:key:zP", bound: true, profileId: "p1", label: "Ada", until, claimCount: 1 },
    "persona/binding/list/1.0": { personas: [] },
    "vta/webvh/dids/list/1.0": { dids: [] },
    "vta/webvh/servers/list/1.0": { servers: [] },
    "persona/binding/set/1.0": { contextId: "conf", personaDid: "did:key:zP", version: 4, boundAt: "2026-09-07T10:00:00Z" },
  });
  const ui = await render(
    h(BindingForm, {
      parties: PARTIES,
      authority: HOLDER,
      contextId: "conf",
      contextLabel: "Conference",
      profiles: [face],
      personaDid: "did:key:zP",
      onDone: () => {},
    }),
    { chrome: { runtime: { sendMessage: a.sendMessage } } },
  );
  await ui.settle();
  assert.match(ui.text(), /ENDS/);
  await ui.click(ui.button("Change face"));
  await ui.settle();
  const [payload] = sent(a, "persona/binding/set/1.0");
  assert.ok(payload, "the binding was written");
  assert.equal(
    new Date(String(payload.until)).getTime(),
    new Date(until).getTime(),
    "a face change must not turn a weekend into forever",
  );
  await ui.unmount();
});

test("a delete says it does not un-tell anyone, and offers to retire instead", async () => {
  const a = agent({
    "persona/profile/get/1.0": { profile: face, disclosedTo: { partyCount: 2, contextCount: 1 } },
    "persona/profile/retire/1.0": { profileId: "p1", version: 4, retiredAt: "2026-09-07T10:00:00Z", unbound: [] },
  });
  let done = false;
  const ui = await render(
    h(DeleteProfile, { parties: PARTIES, profile: face, onDone: () => (done = true) }),
    { chrome: { runtime: { sendMessage: a.sendMessage } } },
  );
  await ui.click(ui.button("Delete"));
  await ui.settle();
  assert.match(ui.text(), /disclosed to 2 parties across 1 context/);
  assert.match(ui.text(), /does not un-tell/);
  await ui.click(ui.button("Retire instead"));
  await ui.settle();
  assert.equal(sent(a, "persona/profile/retire/1.0").length, 1);
  assert.equal(sent(a, "persona/profile/delete/1.0").length, 0, "retiring deletes nothing");
  assert.ok(done);
  await ui.unmount();
});

test("a face's history names where and what, never a value", async () => {
  const a = agent({
    "persona/profile/usage/1.0": {
      profileId: "p1",
      reach: { kind: "only", contextIds: ["conf"] },
      usage: [{ contextId: "conf", personaDid: "did:key:zP", boundAt: "2026-09-07T10:00:00Z" }],
    },
    "persona/profile/timeline/1.0": {
      profileId: "p1",
      events: [
        { at: "2026-09-07T10:00:00Z", kind: "composed" },
        { at: "2026-09-07T10:01:00Z", kind: "disclosed", contextId: "conf", verifierDid: "did:web:v", claimTypes: ["name.display"] },
      ],
    },
  });
  const ui = await render(
    h(FaceHistory, { parties: PARTIES, profileId: "p1", contextName: (id: string) => (id === "conf" ? "Conference" : id) }),
    { chrome: { runtime: { sendMessage: a.sendMessage } } },
  );
  await ui.settle();
  const text = ui.text();
  assert.match(text, /may be worn only in one context/);
  assert.match(text, /in Conference/);
  assert.match(text, /Told did:web:v name\.display in Conference/);
  assert.match(text, /never holds a value/);
  await ui.unmount();
});

test("a typed value stays in the face unless the holder shares it", async () => {
  const a = agent({
    "persona/correlation/analyze/1.0": { findings: [] },
    "persona/profile/compose/1.0": { profileId: "p9", scope: "local", version: 1 },
  });
  let outcome = "";
  const ui = await render(
    h(ComposeFace, {
      parties: PARTIES,
      authority: HOLDER,
      contextId: "coop",
      contextLabel: "Co-op",
      attributes: [],
      personas: [],
      onDone: (o: string) => (outcome = o),
      onCancel: () => {},
    }),
    { chrome: { runtime: { sendMessage: a.sendMessage } } },
  );
  const [name, , value] = ui.all("input");
  await ui.type(name!, "Co-op");
  await ui.type(value!, "Ada");
  await ui.click(ui.button("Make this face"));
  await ui.settle();
  const [payload] = sent(a, "persona/profile/compose/1.0");
  assert.deepEqual(payload?.claims, [{ type: "name.display", valueType: "string", value: "Ada" }]);
  assert.match(outcome, /Made here/);
  await ui.unmount();
});
