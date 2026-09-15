// Opening a DID to read its log.
//
// The pane used to show `logEntryCount` and no way to read one, which is a
// number with nothing behind it. What these tests pin is mostly what the panel
// must NOT say, because every wrong version of this screen is reassuring:
//
//   - a response that carried no log drawn as "no entries"  (it was not asked
//     for, or the agent declined — never that the DID has no history)
//   - one unreadable line taking out the whole history
//   - the log fetched with the listing rather than on open
//
// `includeLog` is opt-in at the agent because the log is the DID's whole
// history and can be large; a listing that pulled every one would be the whole
// history of every identifier, to draw a table.

import { test } from "node:test";
import assert from "node:assert/strict";
import { agent, h, render, PARTIES } from "./harness/dom.mjs";
import { DidsPane } from "../src/manager/panes/dids.js";

const LIST = "vta/webvh/dids/list/1.0";
const GET = "vta/webvh/dids/get/1.0";
const SERVERS = "vta/webvh/servers/list/1.0";
const TEMPLATES = "vta/did-templates/list/2.0";
const SERVICES = "vta/services/list/1.0";

const DID = "did:webvh:QmScid:example.com:rooms:northwind";

const record = {
  did: DID,
  serverId: "prod",
  mnemonic: "brave-otter",
  scid: "QmScid",
  contextId: "rooms",
  portable: false,
  logEntryCount: 2,
  preRotationCount: 2,
  createdAt: "2026-09-11T00:00:00Z",
  updatedAt: "2026-09-11T00:00:00Z",
};

const line = (over: Record<string, unknown> = {}) =>
  JSON.stringify({
    versionId: "1-QmScid",
    versionTime: "2026-09-11T00:00:00Z",
    parameters: { method: "did:webvh:1.0", portable: false },
    state: {
      id: DID,
      verificationMethod: [{ id: `${DID}#key-1` }],
      service: [
        { id: `${DID}#didcomm`, type: "DIDCommMessaging", serviceEndpoint: "did:web:mediator.example" },
      ],
    },
    proof: [{ type: "DataIntegrityProof" }],
    ...over,
  });

const LOG = [line(), line({ versionId: "2-QmNext" })].join("\n");

const mount = async (answers: Record<string, unknown> = {}) => {
  const a = agent({
    [LIST]: { dids: [record], total: 1 },
    [SERVERS]: { servers: [] },
    [TEMPLATES]: { templates: [] },
    [SERVICES]: [],
    [GET]: { record, log: LOG },
    ...answers,
  });
  const screen = await render(
    h(DidsPane, { parties: PARTIES, authority: null, contextId: "rooms" } as never),
    { chrome: { runtime: { sendMessage: a.sendMessage } } },
  );
  await screen.settle();
  return { a, screen };
};

/** Click the DID itself, which is what opens the row. */
const open = async (screen: Awaited<ReturnType<typeof mount>>["screen"]) => {
  await screen.click(screen.button(DID));
  await screen.settle();
};

test("the listing does not ask for anybody's log", async () => {
  const { a } = await mount();
  assert.equal(a.of("dids/get").length, 0, "a listing that pulled every log pulls every history");
  await mount();
});

test("opening a DID asks for its log, and says so on the wire", async () => {
  const { a, screen } = await mount();
  await open(screen);
  const [call] = a.of("dids/get");
  assert.ok(call, "opening the row must fetch the log");
  assert.equal((call.payload as Record<string, unknown>)["did"], DID);
  assert.equal((call.payload as Record<string, unknown>)["includeLog"], true);
  await screen.unmount();
});

test("the entries are listed, numbered and copyable", async () => {
  const { screen } = await mount();
  await open(screen);
  assert.match(screen.text(), /2 log entries/);
  assert.match(screen.text(), /1-QmScid/);
  assert.match(screen.text(), /2-QmNext/);
  assert.ok(screen.button("Copy the whole log"));
  await screen.unmount();
});

test("an entry opens to its parameters, methods, services and raw line", async () => {
  const { screen } = await mount();
  await open(screen);
  await screen.click(screen.button("1-QmScid"));
  const text = screen.text();
  assert.match(text, /did:webvh:1\.0/, "parameters");
  assert.match(text, new RegExp(`${DID}#key-1`), "verification methods");
  assert.match(text, /DIDCommMessaging/, "services");
  assert.match(text, /did:web:mediator\.example/, "the endpoint itself");
  await screen.unmount();
});

// A response with no `log` means it was not asked for or the agent declined.
// Drawing it as an empty list is a claim about the DID that nobody checked —
// the same error as reporting an unreadable context as an empty one.
test("a response carrying no log is a refusal to read, not an absence of history", async () => {
  const { screen } = await mount({ [GET]: { record } });
  await open(screen);
  assert.match(screen.text(), /answered without the log/);
  assert.doesNotMatch(screen.text(), /0 log entries/);
  await screen.unmount();
});

test("an agent that will not answer at all says so", async () => {
  const { screen } = await mount({
    [GET]: () => {
      throw new Error("forbidden");
    },
  });
  await open(screen);
  assert.match(screen.text(), /forbidden/);
  await screen.unmount();
});

// One line the console cannot read must not take out a history that is
// otherwise perfectly readable — and the line itself still has to be copyable,
// because whatever can read it is elsewhere.
test("one unreadable line is one unreadable entry", async () => {
  const { screen } = await mount({
    [GET]: { record, log: [line(), "{ truncated", line({ versionId: "3-QmThird" })].join("\n") },
  });
  await open(screen);
  assert.match(screen.text(), /3 log entries/);
  assert.match(screen.text(), /unreadable/);
  assert.match(screen.text(), /3-QmThird/, "the entries after it still render");
  await screen.unmount();
});

// The log's whole guarantee is that each entry is signed by a key the previous
// one authorised, so an unsigned entry is the thing to notice.
test("an unsigned entry is flagged", async () => {
  const { screen } = await mount({ [GET]: { record, log: line({ proof: undefined }) } });
  await open(screen);
  assert.match(screen.text(), /unsigned/);
  await screen.unmount();
});

// The two numbers come from different places — the agent's record and the log
// it served — and they disagree only when the record is stale. A reader
// comparing them is the only way anyone finds out.
test("a count that disagrees with the log is said out loud", async () => {
  const { screen } = await mount({ [GET]: { record, log: line() } });
  await open(screen);
  assert.match(screen.text(), /record says 2/);
  await screen.unmount();
});

test("clicking the DID again closes it", async () => {
  const { screen } = await mount();
  await open(screen);
  assert.match(screen.text(), /2 log entries/);
  await screen.click(screen.button(DID));
  await screen.settle();
  assert.doesNotMatch(screen.text(), /2 log entries/);
  await screen.unmount();
});
