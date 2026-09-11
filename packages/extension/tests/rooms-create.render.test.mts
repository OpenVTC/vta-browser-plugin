// Making a room, rendered.
//
// Two writes, both to the agent — the second asks it to reach a host, because
// this console cannot. The interesting tests are about the seams: which DID in
// the context is the host's and which are rooms', what the operator must finish
// before a room can be registered, and what survives a registration that fails
// after a DID was minted.
//
// The screen asks context → host → room; the wire still mints the room before
// telling any host. Both orders are pinned, separately.
//
// Fields are found by their accessible name, never by position: steps open and
// close, and fields appear with the choices above them.

import { test } from "node:test";
import assert from "node:assert/strict";
import { agent, h, render, PARTIES } from "./harness/dom.mjs";
import { CreateRoom } from "../src/manager/panes/rooms-create.js";

const SERVERS = "vta/webvh/servers/list/1.0";
const SERVICES = "vta/services/list/1.0";
const DIDS_LIST = "vta/webvh/dids/list/1.0";
const KEYS_LIST = "keys/list/0.1";
const DIDS_CREATE = "vta/webvh/dids/create/1.0";
const UPDATE_DID = "vta/contexts/update-did/1.0";
// `rooms/owner/register`, not `rooms/create`: the console cannot address a host,
// so the registration is asked of the agent, which can make the call.
const REGISTER = "rooms/owner/register/0.1";

const HOST_DID = "did:webvh:QmHost:host.example";
const AGENT_MEDIATOR = "did:web:mediator.example";
const AT = "2026-09-07T09:00:00Z";

// `openvtc` acts as the host already; `empty` has no DID yet.
const CONTEXTS = [
  { id: "openvtc", name: "OpenVTC", did: HOST_DID, basePath: "/openvtc", createdAt: AT },
  { id: "empty", name: "Empty", basePath: "/empty", createdAt: AT },
];

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
  signingKeyId: "did:webvh:QmRoom:rooms.example#key-0",
  kaKeyId: "did:webvh:QmRoom:rooms.example#key-1",
  preRotationKeyCount: 2,
  createdAt: "2026-09-08T10:00:00Z",
};

const HOST_MINTED = {
  did: "did:webvh:QmNewHost:hosts.example",
  contextId: "empty",
  scid: "QmNewHost",
  portable: true,
  signingKeyId: "did:webvh:QmNewHost:hosts.example#key-0",
  kaKeyId: "did:webvh:QmNewHost:hosts.example#key-1",
  preRotationKeyCount: 0,
  createdAt: "2026-09-10T10:00:00Z",
};

/** One `dids/create` answer for both mints, told apart by template. */
const MINT_EITHER = (payload: { template?: string }) =>
  payload.template === "room-host" ? HOST_MINTED : MINTED;

const REGISTERED = { roomId: MINTED.did, host: HOST_DID, epoch: 1 };

const didRecord = (did: string, contextId = "openvtc") => ({
  did, serverId: "webvh-1", mnemonic: did.split(":").pop(), scid: "Qm", contextId,
  portable: true, logEntryCount: 1, createdAt: AT, updatedAt: AT,
});
const keyRecord = (keyId: string, keyType = "ed25519") => ({
  keyId, keyType, status: "active", publicKey: "z6Mk", createdAt: AT,
});

const mount = async (answers: Record<string, unknown>, contexts: unknown[] = CONTEXTS) => {
  const a = agent({
    [SERVERS]: { servers: [{ id: "webvh-1", did: "did:webvh:QmS:webvh.example", label: "Primary", createdAt: "x", updatedAt: "x" }] },
    [SERVICES]: AGENT_SERVICES,
    [DIDS_LIST]: { dids: [] },
    [KEYS_LIST]: { keys: [], total: 0, offset: 0, limit: 0 },
    ...answers,
  });
  const screen = await render(
    h(CreateRoom, { parties: PARTIES, contexts, onCreated: () => {} } as never),
    { chrome: { runtime: { sendMessage: a.sendMessage } } },
  );
  return { a, screen };
};

type Screen = Awaited<ReturnType<typeof mount>>["screen"];

const field = (screen: Screen, name: string) => {
  const el = screen.all(`[aria-label="${name}"]`)[0];
  if (!el) throw new Error(`no field named “${name}”`);
  return el;
};

const hasField = (screen: Screen, name: string) => screen.all(`[aria-label="${name}"]`).length > 0;

/** A radio by its value. `at` picks among repeats: pickers in step 2 render
 *  before the room's, so `-1` is the room's. */
const radio = (screen: Screen, value: string, at = 0) => {
  const el = screen.all(`input[type="radio"][value="${value}"]`).at(at);
  if (!el) throw new Error(`no radio with value “${value}”`);
  return el;
};

/** Writes only: the listings the form reads are not the subject. */
const writes = (a: { calls: { type: string }[] }) =>
  a.calls.map((c) => c.type.replace("https://trusttasks.org/spec/", "")).filter((t) => !t.includes("/list/"));

const mintOf = (a: { calls: { type: string; payload: any }[] }, template: string) =>
  a.calls.find((c) => c.type.includes("dids/create") && c.payload.template === template)!;

/** The context whose DID is the host, and a server for the room — every field
 *  the form needs. The mediator is not typed: the agent's own is chosen. */
const fillAll = async (screen: Screen) => {
  await screen.select(field(screen, "Context"), "openvtc");
  await screen.settle();
  await screen.select(field(screen, "Room hosting server"), "webvh-1");
};

/** In a context with no DID, mint a host's DID. Stops before confirming. */
const mintAHost = async (screen: Screen, before?: () => Promise<void>, url = "https://host.example") => {
  await screen.select(field(screen, "Context"), "empty");
  await screen.settle();
  await screen.select(field(screen, "Host hosting server"), "webvh-1");
  await screen.type(field(screen, "Host URL"), url);
  if (before) await before();
  await screen.click(screen.button("Mint host DID"));
  await screen.settle();
};

// ── The orders ──────────────────────────────────────────────────────────────

test("the form asks for the context, then the host, then the room", async () => {
  const { screen } = await mount({});
  const text = screen.text();
  const at = (s: string) => text.indexOf(s);
  assert.ok(at("Choose the context") >= 0);
  assert.ok(at("Choose the context") < at("Set up the host"));
  assert.ok(at("Set up the host") < at("Give the room its own identity"));
});

test("the room's steps stay closed until the host is ready", async () => {
  const { screen } = await mount({});
  await screen.select(field(screen, "Context"), "empty");
  await screen.settle();
  assert.match(screen.text(), /Finish step 2 first/);
  assert.equal(hasField(screen, "Room hosting server"), false);
});

test("the wire still mints the room before any host is told about it", async () => {
  const { a, screen } = await mount({ [DIDS_CREATE]: MINTED, [REGISTER]: REGISTERED });
  await fillAll(screen);
  await screen.click(screen.button("Create room"));
  assert.deepEqual(writes(a), [DIDS_CREATE, REGISTER]);
});

// ── The room beside the host ────────────────────────────────────────────────

// The defect this form shipped with: `dids/create` defaults setPrimary to true,
// so a room minted without saying otherwise became its context's DID — and a
// host enrolled there would serve as the room.
test("a room is minted beside the context's DID, never as it", async () => {
  const { a, screen } = await mount({ [DIDS_CREATE]: MINTED, [REGISTER]: REGISTERED });
  await fillAll(screen);
  await screen.click(screen.button("Create room"));

  const mint = mintOf(a, "room");
  assert.equal(mint.payload.setPrimary, false, "absent means true at the agent");
  assert.equal(mint.payload.contextId, "openvtc");
  assert.equal(mint.payload.serverId, "webvh-1");
  assert.equal(mint.payload.templateVars.WEBVH_SERVER, "webvh-1");
  assert.equal(mint.payload.templateVars.MEDIATOR_DID, AGENT_MEDIATOR);
});

test("the room is registered with the context's DID as its host, owned by the caller", async () => {
  const { a, screen } = await mount({ [DIDS_CREATE]: MINTED, [REGISTER]: REGISTERED });
  await fillAll(screen);
  await screen.click(screen.button("Create room"));

  const register = a.calls.find((c) => c.type.includes("owner/register"))!;
  assert.equal(register.payload.roomId, MINTED.did);
  assert.equal(register.payload.host, HOST_DID);
  assert.equal(register.payload.ownerDid, PARTIES.holder.did);
  assert.equal(register.payload.visibility, "private");
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
  await screen.settle();

  const text = screen.text();
  assert.match(text, new RegExp(MINTED.did));
  assert.match(text, new RegExp(MINTED.signingKeyId));
});

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
  await screen.settle();

  hostFails = false;
  await screen.click(screen.button("Register with the host"));

  assert.equal(a.calls.filter((c) => c.type.includes("dids/create")).length, 1);
  assert.equal(a.calls.filter((c) => c.type.includes("owner/register")).length, 2);
});

// ── Step 2: which DID is the host ───────────────────────────────────────────

test("the context's own DID is offered as the host, with a check to make", async () => {
  const { screen } = await mount({});
  await screen.select(field(screen, "Context"), "openvtc");
  await screen.settle();
  assert.equal(radio(screen, "host-context").checked, true);
  assert.match(screen.text(), new RegExp(HOST_DID));
  // Rooms minted before the fix became their context's DID, so the one on
  // offer may be a room. The screen says so rather than assume.
  assert.match(screen.text(), /Check this is your host's DID/);
});

// The repair for a context whose DID a room took: make the host's DID the
// context's again. One explicit write, and only that one.
test("another DID in the context can be made the host, with one write", async () => {
  const OLD_HOST = "did:webvh:QmOldHost:host.example:vdr-host";
  const contexts = [{ id: "openvtc", name: "OpenVTC", did: MINTED.did, basePath: "/openvtc", createdAt: AT }];
  const { a, screen } = await mount(
    {
      [DIDS_LIST]: { dids: [didRecord(MINTED.did), didRecord(OLD_HOST)] },
      [UPDATE_DID]: { id: "openvtc", name: "OpenVTC", did: OLD_HOST, basePath: "/openvtc", createdAt: AT },
      [DIDS_CREATE]: MINTED,
      [REGISTER]: REGISTERED,
    },
    contexts,
  );
  await screen.select(field(screen, "Context"), "openvtc");
  await screen.settle();
  await screen.click(radio(screen, "host-pick"));
  await screen.select(field(screen, "Host DID in context"), OLD_HOST);
  await screen.click(screen.button("Make it this context's DID"));
  await screen.settle();

  assert.deepEqual(writes(a), [UPDATE_DID]);
  assert.deepEqual(a.of("update-did")[0]!.payload, { id: "openvtc", did: OLD_HOST });
  assert.match(screen.text(), /is now OpenVTC/);

  await screen.select(field(screen, "Room hosting server"), "webvh-1");
  await screen.click(screen.button("Create room"));
  assert.equal(a.of("owner/register")[0]!.payload.host, OLD_HOST);
});

test("a host run outside this agent can be pasted", async () => {
  const OUTSIDE = "did:webvh:QmOutside:rooms.elsewhere.example";
  const { a, screen } = await mount({ [DIDS_CREATE]: MINTED, [REGISTER]: REGISTERED });
  await fillAll(screen);
  await screen.click(radio(screen, "host-paste"));
  await screen.type(field(screen, "Host DID"), OUTSIDE);
  await screen.click(screen.button("Create room"));
  assert.equal(a.of("owner/register")[0]!.payload.host, OUTSIDE);
});

// ── Step 2: a new host ──────────────────────────────────────────────────────

test("a context with no DID starts on minting the host's", async () => {
  const { screen } = await mount({});
  await screen.select(field(screen, "Context"), "empty");
  await screen.settle();
  assert.equal(radio(screen, "host-mint").checked, true);
  assert.equal(screen.all('input[type="radio"][value="host-context"]').length, 0);
});

test("the host's DID is minted as the context's own, from the room-host template", async () => {
  const { a, screen } = await mount({ [DIDS_CREATE]: HOST_MINTED });
  await mintAHost(screen);

  const mint = mintOf(a, "room-host");
  assert.equal(mint.payload.contextId, "empty");
  assert.equal(mint.payload.setPrimary, true, "said, not left to the agent's default");
  assert.equal(mint.payload.serverId, "webvh-1");
  assert.equal(mint.payload.templateVars.WEBVH_SERVER, "webvh-1");
  assert.equal(mint.payload.templateVars.URL, "https://host.example");
  assert.equal(mint.payload.templateVars.MEDIATOR_DID, AGENT_MEDIATOR);
  assert.equal(mint.payload.pathMode, undefined);
});

test("minting a host where the context already has a DID says it replaces it", async () => {
  const { screen } = await mount({});
  await screen.select(field(screen, "Context"), "openvtc");
  await screen.settle();
  await screen.click(radio(screen, "host-mint"));
  assert.match(screen.text(), /already acts as/);
  assert.match(screen.text(), /changes identity when it next starts/);
});

// The step the operator asked for: a minted DID is not a running host, and the
// room is not registrable until someone says it is.
test("after minting, the room waits until the operator confirms the host is running", async () => {
  const { a, screen } = await mount({ [DIDS_CREATE]: MINT_EITHER, [REGISTER]: REGISTERED });
  await mintAHost(screen);

  assert.match(screen.text(), /Host DID minted/);
  assert.match(screen.text(), /finish setting up the host/);
  assert.equal(hasField(screen, "Room hosting server"), false, "the room step is still closed");
  assert.deepEqual(writes(a), [DIDS_CREATE], "minting a host enrols and grants nothing");

  await screen.click(screen.button("The host is running"));
  // Seeded from the host: same server, same mediator.
  assert.equal(field(screen, "Room hosting server").value, "webvh-1");
  await screen.click(screen.button("Create room"));

  assert.equal(a.of("owner/register")[0]!.payload.host, HOST_MINTED.did);
  assert.equal(mintOf(a, "room").payload.setPrimary, false);
});

test("the setup names this agent, this context, and a grant of application on it", async () => {
  const { screen } = await mount({ [DIDS_CREATE]: HOST_MINTED });
  await mintAHost(screen);
  const text = screen.text();
  assert.match(text, new RegExp(`--vta-did ${PARTIES.service.did}`));
  assert.match(text, /--vta-context empty/);
  assert.match(text, new RegExp(`--mediator-did ${AGENT_MEDIATOR}`));
  assert.match(text, /--role application --contexts empty/);
});

// The failure that prompted the setup panel: a certificate for *.openvtc.net
// presented at rooms.vdr.openvtc.net.
test("the setup names the certificate the host's hostname needs", async () => {
  const { screen } = await mount({ [DIDS_CREATE]: HOST_MINTED });
  await mintAHost(screen, undefined, "https://rooms.vdr.example.net");
  assert.match(screen.text(), /rooms\.vdr\.example\.net/);
  assert.match(screen.text(), /\*\.vdr\.example\.net/);
  assert.match(screen.text(), /A wildcard covers one label only/);
});

test("a host's DID can be given a name", async () => {
  const { a, screen } = await mount({ [DIDS_CREATE]: HOST_MINTED });
  await mintAHost(screen, async () => {
    await screen.click(radio(screen, "path-named", 0));
    await screen.type(field(screen, "Host DID path"), "hosts/primary");
  });
  assert.deepEqual(mintOf(a, "room-host").payload.pathMode, { mode: "explicit", path: "hosts/primary" });
});

test("a mediator chosen for the host is the one the room is seeded with", async () => {
  const { a, screen } = await mount({ [DIDS_CREATE]: MINT_EITHER, [REGISTER]: REGISTERED });
  await mintAHost(screen, async () => {
    await screen.click(radio(screen, "other", 0));
    await screen.type(field(screen, "Host mediator DID"), "did:web:hosts-mediator.example");
  });
  await screen.click(screen.button("The host is running"));
  assert.equal(field(screen, "Room mediator DID").value, "did:web:hosts-mediator.example");
  await screen.click(screen.button("Create room"));
  assert.equal(mintOf(a, "room").payload.templateVars.MEDIATOR_DID, "did:web:hosts-mediator.example");
});

// The honest answer to "does a host need a URL, or can it be TSP only": the
// agent calls hosts over REST only. The mediator is for members.
test("the host step says the URL is for the agent and the mediator is for members", async () => {
  const { screen } = await mount({});
  await screen.select(field(screen, "Context"), "empty");
  await screen.settle();
  const text = screen.text();
  assert.match(text, /your agent calls hosts over REST only/);
  assert.match(text, /answers DIDComm and TSP there/);
  assert.doesNotMatch(text, /does not listen there yet/);
});

// ── Step 3: an existing room ────────────────────────────────────────────────

const ROOM_KEYS = [
  keyRecord(`${MINTED.did}#key-0`),
  keyRecord(`${MINTED.did}#key-1`, "x25519"),
  keyRecord(`${HOST_DID}#key-0`),
];

test("an existing room is picked from the context, and its one signing key filled in", async () => {
  const { a, screen } = await mount({
    [DIDS_LIST]: { dids: [didRecord(HOST_DID), didRecord(MINTED.did)] },
    [KEYS_LIST]: { keys: ROOM_KEYS, total: 3, offset: 0, limit: 100 },
    [REGISTER]: REGISTERED,
  });
  await screen.select(field(screen, "Context"), "openvtc");
  await screen.settle();
  await screen.click(radio(screen, "existing"));

  // The host's DID is not offered as a room.
  const offered = [...field(screen, "Existing room DID").querySelectorAll("option")].map((o: any) => o.value);
  assert.ok(!offered.includes(HOST_DID), "the host's DID must not be offered as a room");

  await screen.select(field(screen, "Existing room DID"), MINTED.did);
  assert.equal(field(screen, "Signing key").value, `${MINTED.did}#key-0`, "the key-agreement key is not a signing key");
  await screen.click(screen.button("Create room"));

  assert.deepEqual(writes(a), [REGISTER], "nothing is minted for an existing room");
  assert.equal(a.of("owner/register")[0]!.payload.roomId, MINTED.did);
});

test("with several signing keys, none is chosen for the operator", async () => {
  const { screen } = await mount({
    [DIDS_LIST]: { dids: [didRecord(MINTED.did)] },
    [KEYS_LIST]: { keys: [keyRecord(`${MINTED.did}#key-0`), keyRecord(`${MINTED.did}#key-2`)], total: 2, offset: 0, limit: 100 },
  });
  await screen.select(field(screen, "Context"), "openvtc");
  await screen.settle();
  await screen.click(radio(screen, "existing"));
  await screen.select(field(screen, "Existing room DID"), MINTED.did);
  assert.equal(field(screen, "Signing key").value, "");
});

test("a DID not in the list can be entered, and needs both halves", async () => {
  const { screen } = await mount({});
  await screen.select(field(screen, "Context"), "openvtc");
  await screen.settle();
  await screen.click(radio(screen, "existing"));
  await screen.select(field(screen, "Existing room DID"), "__other__");
  await screen.type(field(screen, "Room DID"), "did:webvh:QmRoom:rooms.example");
  assert.match(screen.text(), /DID and the identifier of the key that signs for it/);
});

test("a room cannot use the host's DID", async () => {
  const { screen } = await mount({});
  await screen.select(field(screen, "Context"), "openvtc");
  await screen.settle();
  await screen.click(radio(screen, "existing"));
  await screen.select(field(screen, "Existing room DID"), "__other__");
  await screen.type(field(screen, "Room DID"), HOST_DID);
  await screen.type(field(screen, "Signing key ID"), `${HOST_DID}#key-0`);
  assert.match(screen.text(), /A room needs a DID of its own/);
});

test("a listing that cannot be read falls back to typing, and says why", async () => {
  const { screen } = await mount({
    [DIDS_LIST]: () => {
      throw new Error("forbidden");
    },
  });
  await screen.select(field(screen, "Context"), "openvtc");
  await screen.settle();
  await screen.click(radio(screen, "existing"));
  assert.match(screen.text(), /could not be read \(forbidden\)/);
  assert.equal(hasField(screen, "Room DID"), true);
});

// ── What the form refuses to do ─────────────────────────────────────────────

test("nothing is written while a required field is empty, and the hint starts at step 1", async () => {
  const { a, screen } = await mount({});
  await screen.click(screen.button("Create room"));
  assert.deepEqual(writes(a), []);
  assert.match(screen.text(), /Step 1: choose the context/);
});

test("a retention that is not a whole number of days holds the button", async () => {
  const { a, screen } = await mount({ [DIDS_CREATE]: MINTED });
  await fillAll(screen);
  await screen.type(field(screen, "Retention days"), "two weeks");
  await screen.click(screen.button("Create room"));
  assert.deepEqual(writes(a), []);
  assert.match(screen.text(), /retention is a whole number of days/);
});

test("a step is not marked ready before the steps above it are", async () => {
  const { screen } = await mount({});
  assert.equal(screen.all('[aria-label="Step 4, ready"]').length, 0);
  await fillAll(screen);
  assert.equal(screen.all('[aria-label="Step 4, ready"]').length, 1);
});

test("choosing open says the host can read everything", async () => {
  const { screen } = await mount({});
  await fillAll(screen);
  await screen.click(radio(screen, "open"));
  assert.match(screen.text(), /stores record bodies in the clear/);
});

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

test("the agent's own mediator is offered and already chosen", async () => {
  const { screen } = await mount({});
  await fillAll(screen);
  assert.equal(radio(screen, AGENT_MEDIATOR, -1).checked, true);
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

test("transports that cannot be read say so, and a typed mediator still works", async () => {
  const { a, screen } = await mount({
    [SERVICES]: () => {
      throw new Error("forbidden");
    },
    [DIDS_CREATE]: MINTED,
    [REGISTER]: REGISTERED,
  });
  await fillAll(screen);
  assert.match(screen.text(), /failure to ask, not an agent without one/);
  await screen.type(field(screen, "Room mediator DID"), "did:web:typed.example");
  await screen.click(screen.button("Create room"));
  assert.equal(mintOf(a, "room").payload.templateVars.MEDIATOR_DID, "did:web:typed.example");
});

test("a mediator the agent is not advertising is offered but not preselected", async () => {
  const { screen } = await mount({
    [SERVICES]: { services: [{ kind: "didcomm", enabled: false, mediatorDid: AGENT_MEDIATOR }] },
  });
  await fillAll(screen);
  assert.equal(radio(screen, AGENT_MEDIATOR, -1).checked, false);
  assert.match(screen.text(), /not advertising this one right now/);
});

// ── The DID's path ──────────────────────────────────────────────────────────

test("with no name chosen, the hosting server picks the room's path", async () => {
  const { a, screen } = await mount({ [DIDS_CREATE]: MINTED, [REGISTER]: REGISTERED });
  await fillAll(screen);
  await screen.click(screen.button("Create room"));
  assert.equal(mintOf(a, "room").payload.pathMode, undefined);
});

test("a chosen name is sent as an explicit path, and shown as it will read in the DID", async () => {
  const { a, screen } = await mount({ [DIDS_CREATE]: MINTED, [REGISTER]: REGISTERED });
  await fillAll(screen);
  await screen.click(radio(screen, "path-named", -1));
  await screen.type(field(screen, "Room DID path"), "rooms/northwind");
  assert.match(screen.text(), /:rooms:northwind/);
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

test("switching back to the server's choice sends no path, whatever was typed", async () => {
  const { a, screen } = await mount({ [DIDS_CREATE]: MINTED, [REGISTER]: REGISTERED });
  await fillAll(screen);
  await screen.click(radio(screen, "path-named", -1));
  await screen.type(field(screen, "Room DID path"), "rooms/northwind");
  await screen.click(radio(screen, "path-auto", -1));
  await screen.click(screen.button("Create room"));
  assert.equal(mintOf(a, "room").payload.pathMode, undefined);
});

// ── TSP ─────────────────────────────────────────────────────────────────────
//
// Off by default on both mints, the agent's own posture: advertising a
// transport nothing behind the DID decodes gives clients a route they will
// choose and cannot use.

test("a room advertises TSP only when asked", async () => {
  const { a, screen } = await mount({ [DIDS_CREATE]: MINTED, [REGISTER]: REGISTERED });
  await fillAll(screen);
  await screen.click(screen.button("Create room"));
  assert.equal(mintOf(a, "room").payload.addTspService, undefined);
});

test("ticking TSP for the room sends addTspService on the room's mint", async () => {
  const { a, screen } = await mount({ [DIDS_CREATE]: MINTED, [REGISTER]: REGISTERED });
  await fillAll(screen);
  await screen.check(field(screen, "Room advertises TSP"));
  assert.match(screen.text(), /advertising TSP beside DIDComm/);
  await screen.click(screen.button("Create room"));
  assert.equal(mintOf(a, "room").payload.addTspService, true);
});

// The room's box says who answers, and the honest answer today is nobody: the
// agent listens at its mediator as its own DID.
test("the room's TSP choice says nothing answers as a room's DID yet", async () => {
  const { screen } = await mount({});
  await fillAll(screen);
  assert.match(screen.text(), /nothing answers as a room's DID yet/);
});

// Two different holders — room-host for the host, nothing yet for the room — so
// one answer is no evidence for the other.
test("ticking TSP for a new host sends it on the host's mint, not the room's", async () => {
  const { a, screen } = await mount({ [DIDS_CREATE]: MINT_EITHER, [REGISTER]: REGISTERED });
  await mintAHost(screen, async () => {
    await screen.check(field(screen, "Host advertises TSP"));
  });
  assert.equal(mintOf(a, "room-host").payload.addTspService, true);

  await screen.click(screen.button("The host is running"));
  await screen.click(screen.button("Create room"));
  assert.equal(mintOf(a, "room").payload.addTspService, undefined);
});

test("a new host advertises TSP only when asked", async () => {
  const { a, screen } = await mount({ [DIDS_CREATE]: HOST_MINTED });
  await mintAHost(screen);
  assert.equal(mintOf(a, "room-host").payload.addTspService, undefined);
});
