// The access pane, rendered — the entry editor and the context grouping.
//
// **Editing sends only what moved.** `acl/update` is a partial update where an
// omitted member is left alone and `null` clears it. An editor that resends
// every field rewrites an untouched expiry at end-of-day precision and records
// label changes nobody made; one that omits an emptied field leaves the old
// value in place while the screen says it was cleared.
//
// **A context's list says which entries were granted in it.** `acl/list`
// filtered by scope rightly returns agent-wide entries too, and shown as one
// list under the context's name those read as granted there.

import { test } from "node:test";
import assert from "node:assert/strict";
import { agent, h, render, PARTIES } from "./harness/dom.mjs";
import { AccessPane, aclEditToSend, partitionByContext } from "../src/manager/panes/access.js";

const LIST = "acl/list/0.1";
const UPDATE = "acl/update/0.1";

const SCOPED = { subject: "did:key:zScoped", role: "initiator", scopes: ["browser-plugin"] };
const GLOBAL = { subject: "did:key:zGlobal", role: "admin", label: "Browser Plugin" };

const mount = async (entries: unknown[], contextId: string | null) => {
  const a = agent({
    [LIST]: { entries },
    [UPDATE]: (p: { subject: string }) => ({ entry: { subject: p.subject, role: "admin" } }),
  });
  const screen = await render(
    h(AccessPane, { parties: PARTIES, authority: null, contextId } as never),
    { chrome: { runtime: { sendMessage: a.sendMessage } } },
  );
  await screen.settle();
  return { a, screen };
};

const inputs = (screen: { all: (s: string) => Element[] }) =>
  screen.all("td[colspan] input") as (Element & { value: string; type: string })[];

// ── aclEditToSend ───────────────────────────────────────────────────────────

test("an unchanged form sends nothing", () => {
  const entry = { label: "Laptop", expiresAt: "2026-12-31T12:00:00Z" };
  const day = new Date(entry.expiresAt);
  const pad = (n: number) => String(n).padStart(2, "0");
  const expiresDay = `${day.getFullYear()}-${pad(day.getMonth() + 1)}-${pad(day.getDate())}`;
  assert.deepEqual(aclEditToSend(entry, { label: "Laptop", expiresDay }), {});
});

test("emptying a field that held something clears it with null", () => {
  const out = aclEditToSend(
    { label: "Laptop", expiresAt: "2026-12-31T12:00:00Z" },
    { label: "  ", expiresDay: "" },
  );
  assert.deepEqual(out, { label: null, expiresAt: null });
});

test("a field that was empty and stays empty is omitted, not nulled", () => {
  assert.deepEqual(aclEditToSend({}, { label: "", expiresDay: "" }), {});
});

// ── partitionByContext ─────────────────────────────────────────────────────

test("membership comes from the entry's scopes, not the filter that returned it", () => {
  const { granted, inherited } = partitionByContext(
    [SCOPED, GLOBAL, { subject: "did:key:zOther", role: "reader", scopes: ["parent"] }] as never,
    "browser-plugin",
  );
  assert.deepEqual(granted.map((e) => e.subject), ["did:key:zScoped"]);
  assert.deepEqual(inherited.map((e) => e.subject), ["did:key:zGlobal", "did:key:zOther"]);
});

// ── rendered ───────────────────────────────────────────────────────────────

test("a selected context separates what was granted in it from what reaches it", async () => {
  const { screen } = await mount([SCOPED, GLOBAL], "browser-plugin");
  const text = screen.text();
  assert.match(text, /Granted in browser-plugin \(1\)/);
  assert.match(text, /From outside this context \(1\)/);
  assert.match(text, /everywhere it applies/);
  // Scoped entry sits above the heading for the outside group; global below it.
  assert.ok(text.indexOf("zScoped") < text.indexOf("From outside"));
  assert.ok(text.indexOf("zGlobal") > text.indexOf("From outside"));
});

test("a context with only agent-wide entries says nobody was granted in it", async () => {
  const { screen } = await mount([GLOBAL], "browser-plugin");
  assert.match(screen.text(), /Nobody holds an entry scoped to browser-plugin/);
  assert.match(screen.text(), /From outside this context \(1\)/);
});

test("all contexts shows one list with no grouping", async () => {
  const { screen } = await mount([SCOPED, GLOBAL], null);
  assert.doesNotMatch(screen.text(), /Granted in|From outside/);
  assert.match(screen.text(), /zScoped/);
  assert.match(screen.text(), /zGlobal/);
});

test("the editor opens under the row, pre-filled, and Save is idle until something changes", async () => {
  const { screen } = await mount([GLOBAL], null);
  await screen.click(screen.button("Edit…"));
  const [label] = inputs(screen);
  assert.ok(label, "the editor did not open beneath the row");
  assert.equal(label.value, "Browser Plugin");
  assert.equal((screen.button("Save") as HTMLButtonElement).disabled, true);
});

test("renaming sends only the label", async () => {
  const { a, screen } = await mount([GLOBAL], null);
  await screen.click(screen.button("Edit…"));
  await screen.type(inputs(screen)[0]!, "Glenn's laptop");
  await screen.click(screen.button("Save"));
  await screen.settle();
  const sent = a.of(UPDATE);
  assert.equal(sent.length, 1);
  assert.deepEqual(sent[0]!.payload, { subject: "did:key:zGlobal", label: "Glenn's laptop" });
  // Closed and re-read.
  assert.equal(inputs(screen).length, 0);
  assert.equal(a.of(LIST).length, 2);
});

test("clearing the label sends null, and a new expiry warns nothing", async () => {
  const { a, screen } = await mount([GLOBAL], null);
  await screen.click(screen.button("Edit…"));
  const [label, expires] = inputs(screen);
  await screen.type(label!, "");
  await screen.type(expires!, "2027-01-31");
  assert.doesNotMatch(screen.text(), /Clearing the expiry makes this a standing grant/);
  await screen.click(screen.button("Save"));
  await screen.settle();
  const payload = a.of(UPDATE)[0]!.payload as Record<string, unknown>;
  assert.equal(payload.label, null);
  assert.equal(typeof payload.expiresAt, "string");
});

test("clearing an expiry warns that it becomes a standing grant", async () => {
  const { screen } = await mount([{ ...GLOBAL, expiresAt: "2027-01-31T12:00:00Z" }], null);
  await screen.click(screen.button("Edit…"));
  await screen.type(inputs(screen)[1]!, "");
  assert.match(screen.text(), /Clearing the expiry makes this a standing grant/);
});
