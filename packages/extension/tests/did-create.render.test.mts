// Minting a DID from the console.
//
// These are rendered rather than unit tests because what they pin is the gap
// between a form and a payload, and every bug in that gap is one a person sees
// and a type checker does not: a checkbox that reaches the agent as the wrong
// member, a default that is `true` at the agent and blank on screen, a template
// variable the form never asked for.
//
// Two of the assertions here guard something irreversible. `setPrimary` defaults
// to **true at the agent**, so a form that says nothing replaces whatever the
// context acted as with every DID it mints — a room host reading its context's
// DID at startup would follow the new one. And a `preRotationCount` of 0 means a
// stolen key cannot be rotated away from, so a hint must never arrive at that
// value by coercion.

import { test } from "node:test";
import assert from "node:assert/strict";
import { agent, h, render, PARTIES } from "./harness/dom.mjs";
import { CreateDid } from "../src/manager/panes/did-create.js";

const CREATE = "vta/webvh/dids/create/1.0";
const SERVERS = "vta/webvh/servers/list/1.0";
const TEMPLATES = "vta/did-templates/list/2.0";
const SERVICES = "vta/services/list/1.0";
const KEYS = "keys/list/0.1";

const key = (over: Record<string, unknown> = {}) => ({
  keyId: "key-1",
  keyType: "ed25519",
  status: "active",
  publicKey: "z6MkOne",
  contextId: "ops",
  createdAt: "2026-09-01T00:00:00Z",
  ...over,
});

const SERVER_LIST = { servers: [{ id: "prod", label: "Production", domains: ["did.example"] }] };

const created = {
  did: "did:webvh:QmNew:did.example:billing",
  contextId: "ops",
  scid: "QmNew",
  portable: false,
  signingKeyId: "key-0",
  kaKeyId: "key-1",
  preRotationKeyCount: 2,
  createdAt: "2026-09-15T00:00:00Z",
};

const ROOM_TEMPLATE = {
  schemaVersion: 1,
  name: "room",
  kind: "app",
  description: "A data room's own identity.",
  requiredVars: ["WEBVH_SERVER", "MEDIATOR_DID"],
  document: { id: "{DID}" },
  scope: { type: "global" },
  createdAt: 0,
  updatedAt: 0,
  createdBy: "did:key:zAdmin",
};

const mount = async (answers: Record<string, unknown> = {}) => {
  const a = agent({
    [SERVERS]: SERVER_LIST,
    [TEMPLATES]: { templates: [] },
    [SERVICES]: [],
    [KEYS]: { keys: [], total: 0, offset: 0, limit: 200 },
    [CREATE]: created,
    ...answers,
  });
  const screen = await render(
    h(CreateDid, {
      parties: PARTIES,
      contextId: "ops",
      authority: null,
      onCreated: () => {},
    } as never),
    { chrome: { runtime: { sendMessage: a.sendMessage } } },
  );
  await screen.settle();
  return { a, screen };
};

/**
 * Choose a template card.
 *
 * By the radio's own value rather than by the card's text: the form's prose
 * mentions a room host, so matching a label on "room" finds the wrong control —
 * which is how the first draft of these tests passed a click to a checkbox and
 * asserted against a screen nothing had happened on.
 */
const pickTemplate = async (
  screen: { container: { querySelector: (s: string) => Element | null }; click: (e: Element) => Promise<void> },
  name: string,
) => {
  const radio = screen.container.querySelector(`input[name="template"][value="${name}"]`);
  assert.ok(radio, `no template card for ${name}`);
  await screen.click(radio);
};

/** The payload of the one mint that was sent. */
const mintPayload = (a: ReturnType<typeof agent>) => {
  const calls = a.of("dids/create");
  assert.equal(calls.length, 1, `expected exactly one mint, saw ${calls.length}`);
  return calls[0]!.payload as Record<string, unknown>;
};

test("the quiet path through the form does not replace the context's identity", async () => {
  const { a, screen } = await mount();
  await screen.click(screen.button("Create DID"));
  await screen.settle();
  // Said rather than omitted. The agent's default is `true`, so an omitted
  // member and an explicit `false` are opposite outcomes.
  assert.equal(mintPayload(a)["setPrimary"], false);
  await screen.unmount();
});

test("a named path is sent as an explicit pathMode, never as a bare path", async () => {
  const { a, screen } = await mount();
  await screen.click(screen.byText("label", "Choose a name")!.querySelector("input")!);
  await screen.type(screen.container.querySelector('input[aria-label="DID path"]')!, "services/billing");
  await screen.click(screen.button("Create DID"));
  await screen.settle();
  // `path` and `pathMode` together are an error at the agent, so there is one
  // way to say this and the form must use it.
  const payload = mintPayload(a);
  assert.deepEqual(payload["pathMode"], { mode: "explicit", path: "services/billing" });
  assert.equal(payload["path"], undefined);
  await screen.unmount();
});

test("letting the server choose sends no path at all", async () => {
  const { a, screen } = await mount();
  await screen.click(screen.button("Create DID"));
  await screen.settle();
  const payload = mintPayload(a);
  assert.equal(payload["pathMode"], undefined);
  assert.equal(payload["path"], undefined);
  await screen.unmount();
});

test("the mediator and TSP ticks reach the agent as their own members", async () => {
  const { a, screen } = await mount({ [SERVICES]: [] });
  await screen.check(screen.container.querySelector('input[aria-label="Advertise a DIDComm mediator"]')!);
  await screen.check(screen.container.querySelector('input[aria-label="Also advertise TSP"]')!);
  await screen.click(screen.button("Create DID"));
  await screen.settle();
  const payload = mintPayload(a);
  assert.equal(payload["addMediatorService"], true);
  assert.equal(payload["addTspService"], true);
  await screen.unmount();
});

// TSP is advertised *at the mediator the document names for DIDComm*. Ticking
// it alone publishes a transport entry with no endpoint to sit beside, which is
// exactly the "advertised and unusable" state the agent's own posture avoids.
test("TSP without a mediator is called out before it is published", async () => {
  const { screen } = await mount();
  await screen.check(screen.container.querySelector('input[aria-label="Also advertise TSP"]')!);
  assert.match(screen.text(), /names none/);
  await screen.unmount();
});

test("an extra service entry is composed against the DID placeholder", async () => {
  const { a, screen } = await mount();
  await screen.click(screen.button("Add a service entry"));
  await screen.type(screen.container.querySelector('input[aria-label="Service name"]')!, "website");
  await screen.type(screen.container.querySelector('input[aria-label="Service type"]')!, "LinkedDomains");
  await screen.type(
    screen.container.querySelector('input[aria-label="Service endpoint"]')!,
    "https://example.com",
  );
  await screen.click(screen.button("Create DID"));
  await screen.settle();
  assert.deepEqual(mintPayload(a)["additionalServices"], [
    { id: "{DID}#website", type: "LinkedDomains", serviceEndpoint: "https://example.com" },
  ]);
  await screen.unmount();
});

// The whole point of validating in the console: `additionalServices` is written
// into an append-only log verbatim, so a bad entry is published rather than
// refused.
test("a cleartext endpoint holds the mint rather than being published", async () => {
  const { a, screen } = await mount();
  await screen.click(screen.button("Add a service entry"));
  await screen.type(screen.container.querySelector('input[aria-label="Service name"]')!, "website");
  await screen.type(screen.container.querySelector('input[aria-label="Service type"]')!, "LinkedDomains");
  await screen.type(
    screen.container.querySelector('input[aria-label="Service endpoint"]')!,
    "http://example.com",
  );
  assert.match(screen.text(), /https:\/\/ or wss:\/\//);
  await screen.click(screen.button("Create DID"));
  await screen.settle();
  assert.equal(a.of("dids/create").length, 0, "a refused entry must not reach the agent");
  await screen.unmount();
});

test("a template's required variables get a field each", async () => {
  const { screen } = await mount({ [TEMPLATES]: { templates: [ROOM_TEMPLATE] } });
  await pickTemplate(screen, "room");
  assert.ok(screen.container.querySelector('input[aria-label="WEBVH_SERVER"]'));
  assert.ok(screen.container.querySelector('input[aria-label="MEDIATOR_DID"]'));
  await screen.unmount();
});

// The agent checks `requiredVars` *after* it derives the DID's keys, so a
// refusal there is not free — it can leave key material behind. The form has to
// be the thing that stops.
test("a template variable left empty stops the mint here, not at the agent", async () => {
  const { a, screen } = await mount({ [TEMPLATES]: { templates: [ROOM_TEMPLATE] } });
  await pickTemplate(screen, "room");
  await screen.type(screen.container.querySelector('input[aria-label="MEDIATOR_DID"]')!, "");
  await screen.click(screen.button("Create DID"));
  await screen.settle();
  assert.equal(a.of("dids/create").length, 0);
  assert.match(screen.text(), /MEDIATOR_DID/);
  await screen.unmount();
});

// `room` wants WEBVH_SERVER and the form already asked for a hosting server.
// Making the operator retype it is how the two answers come to disagree.
test("a variable the form already answered is seeded from that answer", async () => {
  const { screen } = await mount({ [TEMPLATES]: { templates: [ROOM_TEMPLATE] } });
  await screen.select(screen.container.querySelector('select[aria-label="Hosting server"]')!, "prod");
  await pickTemplate(screen, "room");
  const field = screen.container.querySelector('input[aria-label="WEBVH_SERVER"]') as { value: string };
  assert.equal(field.value, "prod");
  await screen.unmount();
});

test("choosing a template sends its name and its variables", async () => {
  const { a, screen } = await mount({ [TEMPLATES]: { templates: [ROOM_TEMPLATE] } });
  await screen.select(screen.container.querySelector('select[aria-label="Hosting server"]')!, "prod");
  await pickTemplate(screen, "room");
  await screen.type(screen.container.querySelector('input[aria-label="MEDIATOR_DID"]')!, "did:web:m");
  await screen.click(screen.button("Create DID"));
  await screen.settle();
  const payload = mintPayload(a);
  assert.equal(payload["template"], "room");
  assert.deepEqual(payload["templateVars"], { WEBVH_SERVER: "prod", MEDIATOR_DID: "did:web:m" });
  // A global template is addressed with no selector. Sending the context here
  // would render a different template, or none.
  assert.equal(payload["templateContext"], undefined);
  await screen.unmount();
});

test("a blank pre-rotation field leaves the agent's default alone", async () => {
  const { a, screen } = await mount();
  await screen.click(screen.button("Create DID"));
  await screen.settle();
  assert.equal(mintPayload(a)["preRotationCount"], undefined);
  await screen.unmount();
});

// 0 is a real answer and must survive to the agent — but it is the one that
// makes a compromise unrecoverable, so the form says so before it is sent.
test("switching pre-rotation off is sent, and is spelled out first", async () => {
  const { a, screen } = await mount();
  await screen.type(screen.container.querySelector('input[aria-label="Pre-rotation keys"]')!, "0");
  assert.match(screen.text(), /cannot be recovered from/);
  await screen.click(screen.button("Create DID"));
  await screen.settle();
  assert.equal(mintPayload(a)["preRotationCount"], 0);
  await screen.unmount();
});

// For a serverless mint the log entry is not a receipt — it is the only copy of
// the thing that has to be served, and the DID does not resolve until someone
// serves it. A form that cleared itself on success would throw it away.
test("a serverless mint keeps the log entry on screen to be copied", async () => {
  const { screen } = await mount({
    [CREATE]: { ...created, logEntry: '{"versionId":"1-QmNew"}' },
  });
  await screen.click(screen.button("Create DID"));
  await screen.settle();
  assert.match(screen.text(), /does not resolve until you serve its log/);
  assert.ok(screen.button("Copy the log entry"));
  await screen.unmount();
});

// An empty picker and an unaskable agent look the same on screen, and only one
// of them means "register a hosting server first".
test("an agent that will not list its servers says so rather than showing none", async () => {
  const a = agent({ [TEMPLATES]: { templates: [] }, [SERVICES]: [], [CREATE]: created });
  const screen = await render(
    h(CreateDid, {
      parties: PARTIES,
      contextId: "ops",
      authority: null,
      onCreated: () => {},
    } as never),
    { chrome: { runtime: { sendMessage: a.sendMessage } } },
  );
  await screen.settle();
  assert.match(screen.text(), /would not list its hosting servers/);
  await screen.unmount();
});

// ── Building on a key the agent already holds ──

// Absent is what mints a fresh key, and it is what a form nobody touched must
// send. A picker that defaulted to the first key would silently correlate every
// DID in a context.
test("a form nobody touched names no key, so both are minted fresh", async () => {
  const { a, screen } = await mount({
    [KEYS]: { keys: [key(), key({ keyId: "ka-1", keyType: "x25519" })], total: 2, offset: 0, limit: 200 },
  });
  await screen.click(screen.button("Create DID"));
  await screen.settle();
  const payload = mintPayload(a);
  assert.equal(payload["signingKeyId"], undefined);
  assert.equal(payload["kaKeyId"], undefined);
  await screen.unmount();
});

test("a chosen key is sent under the member for its role", async () => {
  const { a, screen } = await mount({
    [KEYS]: { keys: [key(), key({ keyId: "ka-1", keyType: "x25519" })], total: 2, offset: 0, limit: 200 },
  });
  await screen.select(screen.container.querySelector('select[aria-label="Signing key"]')!, "key-1");
  await screen.select(screen.container.querySelector('select[aria-label="Key-agreement key"]')!, "ka-1");
  await screen.click(screen.button("Create DID"));
  await screen.settle();
  const payload = mintPayload(a);
  assert.equal(payload["signingKeyId"], "key-1");
  assert.equal(payload["kaKeyId"], "ka-1");
  await screen.unmount();
});

// x25519 does not sign, so a DID given one as its signing method could never
// update its own log — starting with the first entry, written at mint time.
test("a key-agreement key is not in the signing picker", async () => {
  const { screen } = await mount({
    [KEYS]: { keys: [key({ keyId: "ka-1", keyType: "x25519" })], total: 1, offset: 0, limit: 200 },
  });
  const signing = screen.container.querySelector('select[aria-label="Signing key"]');
  // With nothing usable the picker is replaced by the reason, which is a
  // different statement from an empty dropdown.
  assert.equal(signing, null);
  assert.match(screen.text(), /No key of this kind here yet/);
  const ka = screen.container.querySelector('select[aria-label="Key-agreement key"]') as { value: string } | null;
  assert.ok(ka, "the same key is still offered for the role it can fill");
  await screen.unmount();
});

test("a revoked key is not offered", async () => {
  const { screen } = await mount({
    [KEYS]: { keys: [key({ keyId: "gone", status: "revoked" })], total: 1, offset: 0, limit: 200 },
  });
  assert.doesNotMatch(screen.text(), /gone/);
  await screen.unmount();
});

// Reuse links two DIDs to one holder, provably and permanently. That is a
// decision, so it has to be visible at the moment it is taken.
test("choosing a key says what reusing one discloses", async () => {
  const { screen } = await mount({ [KEYS]: { keys: [key()], total: 1, offset: 0, limit: 200 } });
  assert.doesNotMatch(screen.text(), /held by you/);
  await screen.select(screen.container.querySelector('select[aria-label="Signing key"]')!, "key-1");
  assert.match(screen.text(), /held by you/);
  await screen.unmount();
});

// An agent that will not list keys and a context with none look the same in an
// empty picker, and only one of them means "mint a key first".
test("an agent that will not list keys says so, and minting still works", async () => {
  const { a, screen } = await mount({
    [KEYS]: () => {
      throw new Error("forbidden");
    },
  });
  assert.match(screen.text(), /would not list this context's keys/);
  await screen.click(screen.button("Create DID"));
  await screen.settle();
  assert.equal(mintPayload(a)["signingKeyId"], undefined);
  await screen.unmount();
});

// Leaving it set would build the NEXT DID on the same key without anyone
// touching the control — the correlation above, arrived at by inaction.
test("a mint clears the key choice, unlike the hosting server", async () => {
  const { screen } = await mount({ [KEYS]: { keys: [key()], total: 1, offset: 0, limit: 200 } });
  await screen.select(screen.container.querySelector('select[aria-label="Signing key"]')!, "key-1");
  await screen.click(screen.button("Create DID"));
  await screen.settle();
  const signing = screen.container.querySelector('select[aria-label="Signing key"]') as { value: string };
  assert.equal(signing.value, "");
  await screen.unmount();
});

// The keys are asked for per context because a key's own context is part of
// what makes it usable — a listing filtered client-side would mean asking for
// every key in the agent to draw one dropdown.
test("the keys asked for are this context's active ones", async () => {
  const { a, screen } = await mount({ [KEYS]: { keys: [key()], total: 1, offset: 0, limit: 200 } });
  const [call] = a.of("keys/list");
  assert.ok(call);
  assert.equal((call.payload as Record<string, unknown>)["contextId"], "ops");
  assert.equal((call.payload as Record<string, unknown>)["status"], "active");
  await screen.unmount();
});

// Nothing is being read when no context is chosen, so the pickers must not say
// they are. Same class of false claim as an empty list standing in for a failed
// one, one notch quieter — and this one was on screen.
test("with no context the key pickers say why, rather than Reading", async () => {
  const a = agent({
    [SERVERS]: SERVER_LIST,
    [TEMPLATES]: { templates: [] },
    [SERVICES]: [],
    [CREATE]: created,
  });
  const screen = await render(
    h(CreateDid, {
      parties: PARTIES,
      contextId: null,
      authority: null,
      onCreated: () => {},
    } as never),
    { chrome: { runtime: { sendMessage: a.sendMessage } } },
  );
  await screen.settle();
  assert.match(screen.text(), /Keys belong to a context/);
  assert.doesNotMatch(screen.text(), /Reading…/);
  assert.equal(a.of("keys/list").length, 0, "nothing to ask for, so nothing is asked");
  await screen.unmount();
});
