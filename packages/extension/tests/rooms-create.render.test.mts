// Making a room, rendered.
//
// Two writes, both to the agent — the second asks it to reach a host, because
// this console cannot. The interesting tests are all about the seam between
// them: the DID is minted first and **that is not undoable**. So what happens
// when the registration fails is the property worth pinning, not the happy path
// — an operator who loses the `signingKeyId` has a room nothing can ever issue
// in the name of, and no way to get it back.
//
// The screen asks for the host first and the room second; the wire still mints
// the room before telling any host. Both orders are pinned, separately, because
// a change to one is exactly what could quietly change the other.
//
// Fields are found by their accessible name, never by position. The form is a
// sequence of steps whose fields appear and disappear with the choices above
// them, so "the second input" names a different field depending on which way
// through a step a test took.

import { test } from "node:test";
import assert from "node:assert/strict";
import { agent, h, render, PARTIES } from "./harness/dom.mjs";
import { CreateRoom } from "../src/manager/panes/rooms-create.js";

const SERVERS = "vta/webvh/servers/list/1.0";
const SERVICES = "vta/services/list/1.0";
const DIDS_CREATE = "vta/webvh/dids/create/1.0";
// `rooms/owner/register`, not `rooms/create`. The console cannot address a host
// at all — its bridge carries a type and a payload and addresses everything to
// the wallet's own VTA — so the registration is asked of the agent, which can
// make the call. A test naming `rooms/create` here would be pinning a call that
// lands at a party that does not serve it.
const REGISTER = "rooms/owner/register/0.1";

const HOST_DID = "did:webvh:QmHost:host.example";
const AGENT_MEDIATOR = "did:web:mediator.example";

const CONTEXTS = [
  { id: "openvtc", name: "OpenVTC", basePath: "/openvtc", createdAt: "2026-09-07T09:00:00Z" },
];

// DIDComm and TSP through one mediator, and REST beside them — the shape a
// deployed agent actually reports.
const AGENT_SERVICES = {
  services: [
    { kind: "didcomm", enabled: true, mediatorDid: AGENT_MEDIATOR },
    { kind: "tsp", enabled: true, mediatorDid: AGENT_MEDIATOR },
    { kind: "rest", enabled: true, url: "https://agent.example" },
  ],
};

const MINTED = {
  did: "did:webvh:QmRoom:rooms.example",
  contextId: "openvtc",
  scid: "QmRoom",
  portable: true,
  signingKeyId: "room-northwind-signing",
  kaKeyId: "room-northwind-ka",
  preRotationKeyCount: 2,
  createdAt: "2026-09-08T10:00:00Z",
};

const HOST_MINTED = {
  did: "did:webvh:QmNewHost:hosts.example",
  contextId: "openvtc",
  scid: "QmNewHost",
  portable: true,
  signingKeyId: "host-signing",
  kaKeyId: "host-ka",
  preRotationKeyCount: 0,
  createdAt: "2026-09-10T10:00:00Z",
};

/** One `dids/create` answer for both mints, told apart by template. */
const MINT_EITHER = (payload: { template?: string }) =>
  payload.template === "room-host" ? HOST_MINTED : MINTED;

const REGISTERED = { roomId: MINTED.did, host: HOST_DID, epoch: 1 };

const mount = async (answers: Record<string, unknown>) => {
  const a = agent({
    [SERVERS]: { servers: [{ id: "webvh-1", did: "did:webvh:QmHost:host.example", label: "Primary", createdAt: "x", updatedAt: "x" }] },
    [SERVICES]: AGENT_SERVICES,
    ...answers,
  });
  const screen = await render(
    h(CreateRoom, { parties: PARTIES, contexts: CONTEXTS, onCreated: () => {} } as never),
    { chrome: { runtime: { sendMessage: a.sendMessage } } },
  );
  return { a, screen };
};

type Screen = Awaited<ReturnType<typeof mount>>["screen"];

/** A field by its accessible name. Throws when absent, so a test that meant to
 *  fill something says so rather than passing. */
const field = (screen: Screen, name: string) => {
  const el = screen.all(`[aria-label="${name}"]`)[0];
  if (!el) throw new Error(`no field named “${name}”`);
  return el;
};

/** A radio by its value. `at` picks among repeats: the host's mediator and path
 *  pickers render in step one, so while a host is being minted its `other` and
 *  `path-named` come first and the room's come last. */
const radio = (screen: Screen, value: string, at = 0) => {
  const el = screen.all(`input[type="radio"][value="${value}"]`).at(at);
  if (!el) throw new Error(`no radio with value “${value}”`);
  return el;
};

/** Writes only: the two listings the form reads on mount are not the subject. */
const writes = (a: { calls: { type: string }[] }) =>
  a.calls.map((c) => c.type.replace("https://trusttasks.org/spec/", "")).filter((t) => !t.includes("/list/"));

const mintOf = (a: { calls: { type: string; payload: any }[] }, template: string) =>
  a.calls.find((c) => c.type.includes("dids/create") && c.payload.template === template)!;

/** Fill the host and the mint path, which is every field the form needs. The
 *  mediator is not typed: the agent's own is already chosen. */
const fillAll = async (screen: Screen) => {
  await screen.type(field(screen, "Host DID"), HOST_DID);
  await screen.select(field(screen, "Room context"), "openvtc");
  await screen.select(field(screen, "Room hosting server"), "webvh-1");
};

/** Choose to mint a host and fill its fields. Leaves the room half untouched. */
const mintAHost = async (screen: Screen, before?: () => Promise<void>) => {
  await screen.click(radio(screen, "mint-host"));
  await screen.select(field(screen, "Host context"), "openvtc");
  await screen.select(field(screen, "Host hosting server"), "webvh-1");
  await screen.type(field(screen, "Host URL"), "https://host.example");
  if (before) await before();
  await screen.click(screen.button("Mint host DID"));
};

// ── The two orders ──────────────────────────────────────────────────────────

test("the screen asks for the host before the room", async () => {
  const { screen } = await mount({});
  const text = screen.text();
  const host = text.indexOf("Choose a host for the room's records");
  const room = text.indexOf("Give the room its own identity");
  assert.ok(host >= 0 && room >= 0, "both steps are on screen");
  assert.ok(host < room, "the host step comes first");
});

// The screen order moved; this one must not. A room minted after the host was
// told about it would be a room whose existence began at its host.
test("the wire still mints the room before any host is told about it", async () => {
  const { a, screen } = await mount({ [DIDS_CREATE]: MINTED, [REGISTER]: REGISTERED });
  await fillAll(screen);
  await screen.click(screen.button("Create room"));

  assert.deepEqual(
    writes(a),
    [`${DIDS_CREATE}`, `${REGISTER}`],
    "the DID must exist before a host is told about the room",
  );
});

test("the room is minted from the room template, addressable and hosted", async () => {
  const { a, screen } = await mount({ [DIDS_CREATE]: MINTED, [REGISTER]: REGISTERED });
  await fillAll(screen);
  await screen.click(screen.button("Create room"));

  const mint = mintOf(a, "room");
  // Both, and they are not redundant: `serverId` decides hosting, the var only
  // satisfies the template's own requiredVars check.
  assert.equal(mint.payload.serverId, "webvh-1");
  assert.equal(mint.payload.templateVars.WEBVH_SERVER, "webvh-1");
  assert.equal(mint.payload.templateVars.MEDIATOR_DID, AGENT_MEDIATOR);
});

// The room's identifier is the DID that was just minted, and the owner is the
// caller. A form that sent anything else here would register a room somebody
// else controls, or one nobody does.
test("the agent is told the minted DID, the host, and who owns it", async () => {
  const { a, screen } = await mount({ [DIDS_CREATE]: MINTED, [REGISTER]: REGISTERED });
  await fillAll(screen);
  await screen.click(screen.button("Create room"));

  const register = a.calls.find((c) => c.type.includes("owner/register"))!;
  assert.equal(register.payload.roomId, MINTED.did);
  assert.equal(register.payload.ownerDid, PARTIES.holder.did);
  assert.equal(register.payload.visibility, "private", "private is the default a room should start at");
  // The host rides in the payload, because it cannot ride in the recipient.
  assert.equal(register.payload.host, HOST_DID);
});

// ── The failure that costs something ────────────────────────────────────────

test("a minted identity survives a failed registration, both halves on screen", async () => {
  const { screen } = await mount({
    [DIDS_CREATE]: MINTED,
    [REGISTER]: () => {
      throw new Error("host unreachable");
    },
  });
  await fillAll(screen);
  await screen.click(screen.button("Create room"));

  const text = screen.text();
  assert.match(text, new RegExp(MINTED.did), "the minted DID must not disappear with the error");
  assert.match(text, new RegExp(MINTED.signingKeyId), "the key identifier is the half nothing can recover");
});

// The expensive version of the same bug: pressing the button again mints a
// SECOND room and orphans the first, because nothing remembered the first
// succeeded. The retry must register, not mint.
test("retrying after a failed registration registers rather than minting again", async () => {
  let hostFails = true;
  const { a, screen } = await mount({
    [DIDS_CREATE]: MINTED,
    [REGISTER]: () => {
      if (hostFails) throw new Error("host unreachable");
      return REGISTERED;
    },
  });
  await fillAll(screen);
  await screen.click(screen.button("Create room"));

  hostFails = false;
  await screen.click(screen.button("Register with the host"));

  const mints = a.calls.filter((c) => c.type.includes("dids/create"));
  assert.equal(mints.length, 1, "a second press minted a second room and orphaned the first");
  assert.equal(a.calls.filter((c) => c.type.includes("owner/register")).length, 2);
});

// ── What the form refuses to do ─────────────────────────────────────────────

// An existing DID with no key identifier is a room that can never invite
// anyone. Discovering that at the first invitation is far worse than here.
test("an existing identity needs both halves before it can be used", async () => {
  const { screen } = await mount({});
  await screen.type(field(screen, "Host DID"), HOST_DID);
  await screen.click(radio(screen, "existing"));
  await screen.type(field(screen, "Room DID"), "did:webvh:QmRoom:rooms.example");
  assert.match(screen.text(), /DID and the identifier of the key that signs for it/);
});

// Nothing is written until every field the chosen path needs is there — a mint
// attempted with a missing template var fails at the agent, after the DID's
// keys have already been derived.
test("nothing is written while a required field is empty", async () => {
  const { a, screen } = await mount({});
  await screen.click(screen.button("Create room"));
  assert.deepEqual(writes(a), []);
});

// The hint names the earliest step that is not ready, so it reads top to bottom
// the way the form does.
test("the hint names the host step first, because it comes first", async () => {
  const { screen } = await mount({});
  assert.match(screen.text(), /Step 1: name the host/);
});

// `Number("two weeks")` is NaN, and NaN is what would have been sent.
test("a retention that is not a whole number of days holds the button", async () => {
  const { a, screen } = await mount({ [DIDS_CREATE]: MINTED });
  await fillAll(screen);
  await screen.type(field(screen, "Retention days"), "two weeks");
  await screen.click(screen.button("Create room"));
  assert.deepEqual(writes(a), []);
  assert.match(screen.text(), /retention is a whole number of days/);
});

// Step three is valid on arrival — its defaults are fine. Ticking it beside two
// unfinished steps reads as a form completed out of order.
test("a step is not marked ready before the steps above it are", async () => {
  const { screen } = await mount({});
  assert.equal(screen.all('[aria-label="Step 3, ready"]').length, 0);
  await fillAll(screen);
  assert.equal(screen.all('[aria-label="Step 3, ready"]').length, 1);
});

// `open` means the host reads every record. That is a legitimate choice and a
// surprising one, so the screen has to say it rather than leave "open" to be
// read as "not restricted yet".
test("choosing open says the host can read everything", async () => {
  const { screen } = await mount({});
  await screen.click(radio(screen, "open"));
  assert.match(screen.text(), /stores record bodies in the clear/);
});

// A hosting-server list that failed is not an agent with no servers registered.
test("a failed server listing says so rather than offering an empty menu", async () => {
  const a = agent({ [SERVICES]: AGENT_SERVICES });
  const screen = await render(
    h(CreateRoom, { parties: PARTIES, contexts: CONTEXTS, onCreated: () => {} } as never),
    {
      chrome: {
        runtime: {
          sendMessage: async (m: { params?: { type?: string } }) =>
            m.params?.type?.includes("servers/list")
              ? { ok: false, error: "agent unreachable" }
              : a.sendMessage(m),
        },
      },
    },
  );
  assert.match(screen.text(), /failure to ask, not an agent with none registered/);
});

// ── The mediator ────────────────────────────────────────────────────────────
//
// It used to be a blank field under "MEDIATOR DID", which asked an operator to
// go and find a DID their own agent already routes through. The agent says which
// one; the form offers it.

test("the agent's own mediator is offered and already chosen", async () => {
  const { screen } = await mount({});
  assert.match(screen.text(), new RegExp(AGENT_MEDIATOR));
  assert.equal(radio(screen, AGENT_MEDIATOR).checked, true);
  // DIDComm and TSP share it: one card naming both, not two cards that are the
  // same choice.
  assert.equal(screen.all(`input[type="radio"][value="${AGENT_MEDIATOR}"]`).length, 1);
  assert.match(screen.text(), /routes DIDComm and TSP through it/);
});

test("a different mediator is one choice away, and it is what gets sent", async () => {
  const { a, screen } = await mount({ [DIDS_CREATE]: MINTED, [REGISTER]: REGISTERED });
  await fillAll(screen);
  await screen.click(radio(screen, "other", -1));
  await screen.type(field(screen, "Room mediator DID"), "did:web:elsewhere.example");
  await screen.click(screen.button("Create room"));

  assert.equal(mintOf(a, "room").payload.templateVars.MEDIATOR_DID, "did:web:elsewhere.example");
});

// `services/list` is admin-gated. A caller refused it is not looking at an agent
// without a mediator, and must still be able to make a room.
test("transports that cannot be read say so, and a typed mediator still works", async () => {
  const { a, screen } = await mount({
    [SERVICES]: () => {
      throw new Error("forbidden");
    },
    [DIDS_CREATE]: MINTED,
    [REGISTER]: REGISTERED,
  });
  assert.match(screen.text(), /could not be read \(forbidden\)/);
  assert.match(screen.text(), /failure to ask, not an agent without one/);

  await fillAll(screen);
  await screen.type(field(screen, "Room mediator DID"), "did:web:typed.example");
  await screen.click(screen.button("Create room"));
  assert.equal(mintOf(a, "room").payload.templateVars.MEDIATOR_DID, "did:web:typed.example");
});

// A switched-off transport's mediator is listed — it is still the agent's — but
// choosing it for the operator would be choosing a path the agent is not
// advertising.
test("a mediator the agent is not advertising is offered but not preselected", async () => {
  const { screen } = await mount({
    [SERVICES]: { services: [{ kind: "didcomm", enabled: false, mediatorDid: AGENT_MEDIATOR }] },
  });
  assert.equal(radio(screen, AGENT_MEDIATOR).checked, false);
  assert.match(screen.text(), /not advertising this one right now/);
});

// ── The DID's path ──────────────────────────────────────────────────────────
//
// Absent is the hosting server's choice. A name is sent as an explicit path and
// checked against the server's own rule first, because a refused mint may
// already have derived keys.

test("with no name chosen, the hosting server picks the room's path", async () => {
  const { a, screen } = await mount({ [DIDS_CREATE]: MINTED, [REGISTER]: REGISTERED });
  await fillAll(screen);
  await screen.click(screen.button("Create room"));
  assert.equal(mintOf(a, "room").payload.pathMode, undefined, "absent is autoAssign; nothing to send");
});

test("a chosen name is sent as an explicit path, and shown as it will read in the DID", async () => {
  const { a, screen } = await mount({ [DIDS_CREATE]: MINTED, [REGISTER]: REGISTERED });
  await fillAll(screen);
  await screen.click(radio(screen, "path-named", -1));
  await screen.type(field(screen, "Room DID path"), "rooms/northwind");
  assert.match(screen.text(), /:rooms:northwind/, "the preview shows the slash as the DID's colon");
  await screen.click(screen.button("Create room"));

  assert.deepEqual(mintOf(a, "room").payload.pathMode, { mode: "explicit", path: "rooms/northwind" });
});

test("a name the hosting server would refuse holds the button and says why", async () => {
  const { a, screen } = await mount({ [DIDS_CREATE]: MINTED });
  await fillAll(screen);
  await screen.click(radio(screen, "path-named", -1));
  await screen.type(field(screen, "Room DID path"), "Northwind");
  await screen.click(screen.button("Create room"));

  assert.deepEqual(writes(a), []);
  assert.match(screen.text(), /lowercase letters, digits and hyphens only/);
});

// The typed name survives the flip so a person exploring the choice loses
// nothing — but it must not ride along once the server's choice is selected.
test("switching back to the server's choice sends no path, whatever was typed", async () => {
  const { a, screen } = await mount({ [DIDS_CREATE]: MINTED, [REGISTER]: REGISTERED });
  await fillAll(screen);
  await screen.click(radio(screen, "path-named", -1));
  await screen.type(field(screen, "Room DID path"), "rooms/northwind");
  await screen.click(radio(screen, "path-auto", -1));
  await screen.click(screen.button("Create room"));

  assert.equal(mintOf(a, "room").payload.pathMode, undefined);
});

// ── The host ────────────────────────────────────────────────────────────────
//
// "Where do I get a host DID?" is the question this form provoked and did not
// answer, and the first answer — a quiet "Mint one" beside the field — was
// missed by the person it was built for. What matters is that minting is a
// choice in plain view, that it mints the *host* (a different template, a
// different service block), and that it does not quietly do the two things that
// are somebody's decision rather than a form's.

test("minting a host is offered beside pasting one, before anything is pressed", async () => {
  const { screen } = await mount({});
  assert.equal(radio(screen, "mint-host").checked, false);
  assert.match(screen.text(), /Mint a DID for a new host/);
});

// The honest answer to "does a host need a URL": yes, today. The room-host
// service serves HTTP only and the agent can only initiate REST to a host. A
// screen that described the mediator as a way in would send an operator off to
// deploy a host nothing can reach.
test("the host step says the URL is required and why, and does not offer the mediator as a way in", async () => {
  const { screen } = await mount({});
  assert.match(screen.text(), /only way your agent can reach a host today/);
  await screen.click(radio(screen, "mint-host"));
  assert.match(screen.text(), /The URL is what carries everything today/);
  assert.match(screen.text(), /does not listen there yet/);
  assert.doesNotMatch(screen.text(), /no reachable URL/);
});

test("the host is minted from the room-host template, not the room one", async () => {
  const { a, screen } = await mount({ [DIDS_CREATE]: HOST_MINTED });
  await mintAHost(screen);

  const mint = mintOf(a, "room-host");
  assert.equal(mint.payload.contextId, "openvtc");
  assert.equal(mint.payload.serverId, "webvh-1");
  // All three of the template's requiredVars.
  assert.equal(mint.payload.templateVars.WEBVH_SERVER, "webvh-1");
  assert.equal(mint.payload.templateVars.URL, "https://host.example");
  assert.equal(mint.payload.templateVars.MEDIATOR_DID, AGENT_MEDIATOR);
  assert.equal(mint.payload.pathMode, undefined);
});

test("a host's DID can be given a name too", async () => {
  const { a, screen } = await mount({ [DIDS_CREATE]: HOST_MINTED });
  await mintAHost(screen, async () => {
    await screen.click(radio(screen, "path-named", 0));
    await screen.type(field(screen, "Host DID path"), "hosts/primary");
  });
  assert.deepEqual(mintOf(a, "room-host").payload.pathMode, { mode: "explicit", path: "hosts/primary" });
});

test("the minted host DID lands in the field, so the room can be created with it", async () => {
  const { screen } = await mount({ [DIDS_CREATE]: HOST_MINTED });
  await mintAHost(screen);

  assert.equal(
    field(screen, "Host DID").value,
    HOST_MINTED.did,
    "minting that left the operator to copy the DID by hand would not have removed the step",
  );
  // And it says what is still to do, because a minted identity is not a host.
  assert.match(screen.text(), /Host DID minted/);
  assert.match(screen.text(), /application/);
});

// The host comes first now, so the seeding runs the other way: a room usually
// lives where its host does.
test("the room is seeded from the host just minted", async () => {
  const { a, screen } = await mount({ [DIDS_CREATE]: MINT_EITHER, [REGISTER]: REGISTERED });
  await mintAHost(screen, async () => {
    await screen.click(radio(screen, "other", 0));
    await screen.type(field(screen, "Host mediator DID"), "did:web:hosts-mediator.example");
  });

  assert.equal(field(screen, "Room context").value, "openvtc");
  assert.equal(field(screen, "Room hosting server").value, "webvh-1");
  assert.equal(field(screen, "Room mediator DID").value, "did:web:hosts-mediator.example");

  await screen.click(screen.button("Create room"));
  assert.equal(mintOf(a, "room").payload.templateVars.MEDIATOR_DID, "did:web:hosts-mediator.example");
});

// Seeded, never overwritten: a mediator the operator picked for the room is a
// decision, and minting a host afterwards is not permission to undo it.
test("a mediator chosen for the room is not replaced by minting a host", async () => {
  const { a, screen } = await mount({ [DIDS_CREATE]: MINT_EITHER, [REGISTER]: REGISTERED });
  await screen.click(radio(screen, "other", -1));
  await screen.type(field(screen, "Room mediator DID"), "did:web:rooms-own.example");
  await mintAHost(screen);
  await screen.select(field(screen, "Room context"), "openvtc");
  await screen.select(field(screen, "Room hosting server"), "webvh-1");
  await screen.click(screen.button("Create room"));

  assert.equal(mintOf(a, "room").payload.templateVars.MEDIATOR_DID, "did:web:rooms-own.example");
});

// The button mints an identity. It does not enrol the host and does not grant
// it anything — the host enrols itself, and the grant is a person deciding this
// host may act in their context. A form that did either silently would be
// making that decision on the operator's behalf.
test("minting a host writes exactly one task, and it is not a grant", async () => {
  const { a, screen } = await mount({ [DIDS_CREATE]: HOST_MINTED });
  await mintAHost(screen);

  assert.deepEqual(writes(a), [DIDS_CREATE], "one mint, no acl/grant, no rooms/owner/register");
});
