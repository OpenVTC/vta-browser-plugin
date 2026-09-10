// Making a room, rendered.
//
// Two writes, both to the agent — the second asks it to reach a host, because
// this console cannot. The interesting tests are all about the seam between
// them: the DID is minted first and **that is not undoable**. So what happens
// when the registration fails is the property worth pinning, not the happy path
// — an operator who loses the `signingKeyId` has a room nothing can ever issue
// in the name of, and no way to get it back.

import { test } from "node:test";
import assert from "node:assert/strict";
import { agent, h, render, PARTIES } from "./harness/dom.mjs";
import { CreateRoom } from "../src/manager/panes/rooms-create.js";

const SERVERS = "vta/webvh/servers/list/1.0";
const DIDS_CREATE = "vta/webvh/dids/create/1.0";
// `rooms/owner/register`, not `rooms/create`. The console cannot address a host
// at all — its bridge carries a type and a payload and addresses everything to
// the wallet's own VTA — so the registration is asked of the agent, which can
// make the call. A test naming `rooms/create` here would be pinning a call that
// lands at a party that does not serve it.
const REGISTER = "rooms/owner/register/0.1";

const HOST_DID = "did:webvh:QmHost:host.example";

const CONTEXTS = [
  { id: "openvtc", name: "OpenVTC", basePath: "/openvtc", createdAt: "2026-09-07T09:00:00Z" },
];

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

const mount = async (answers: Record<string, unknown>) => {
  const a = agent({
    [SERVERS]: { servers: [{ id: "webvh-1", did: "did:webvh:QmHost:host.example", label: "Primary", createdAt: "x", updatedAt: "x" }] },
    ...answers,
  });
  const screen = await render(
    h(CreateRoom, { parties: PARTIES, contexts: CONTEXTS, onCreated: () => {} } as never),
    { chrome: { runtime: { sendMessage: a.sendMessage } } },
  );
  return { a, screen };
};

/** Fill the mint path and the host, which is every field the form needs. */
const fillAll = async (screen: Awaited<ReturnType<typeof mount>>["screen"]) => {
  const selects = screen.all("select");
  const inputs = screen.all("input").filter((el) => el.type !== "radio");
  await screen.select(selects[0]!, "openvtc"); // context
  await screen.select(selects[1]!, "webvh-1"); // hosting server
  await screen.type(inputs[0]!, "did:web:mediator.example"); // mediator
  await screen.type(inputs[1]!, HOST_DID); // host
};

// ── The seam ────────────────────────────────────────────────────────────────

test("both halves are written, identity first", async () => {
  const { a, screen } = await mount({ [DIDS_CREATE]: MINTED, [REGISTER]: { roomId: MINTED.did, host: HOST_DID, epoch: 1 } });
  await fillAll(screen);
  await screen.click(screen.button("Create room"));

  const writes = a.calls.map((c) => c.type).filter((t) => !t.includes("servers/list"));
  assert.deepEqual(
    writes.map((t) => t.replace("https://trusttasks.org/spec/", "")),
    [`${DIDS_CREATE}`, `${REGISTER}`],
    "the DID must exist before a host is told about the room",
  );
});

test("the room is minted from the room template, addressable and hosted", async () => {
  const { a, screen } = await mount({ [DIDS_CREATE]: MINTED, [REGISTER]: { roomId: MINTED.did, host: HOST_DID, epoch: 1 } });
  await fillAll(screen);
  await screen.click(screen.button("Create room"));

  const mint = a.calls.find((c) => c.type.includes("dids/create"))!;
  assert.equal(mint.payload.template, "room");
  // Both, and they are not redundant: `serverId` decides hosting, the var only
  // satisfies the template's own requiredVars check.
  assert.equal(mint.payload.serverId, "webvh-1");
  assert.equal(mint.payload.templateVars.WEBVH_SERVER, "webvh-1");
  assert.equal(mint.payload.templateVars.MEDIATOR_DID, "did:web:mediator.example");
});

// The room's identifier is the DID that was just minted, and the owner is the
// caller. A form that sent anything else here would register a room somebody
// else controls, or one nobody does.
test("the agent is told the minted DID, the host, and who owns it", async () => {
  const { a, screen } = await mount({ [DIDS_CREATE]: MINTED, [REGISTER]: { roomId: MINTED.did, host: HOST_DID, epoch: 1 } });
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
      return { roomId: MINTED.did, host: HOST_DID, epoch: 1 };
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
  await screen.click(screen.byText("label", "I already have one")!);
  const inputs = screen.all("input").filter((el) => el.type !== "radio");
  await screen.type(inputs[0]!, "did:webvh:QmRoom:rooms.example");
  assert.match(screen.text(), /DID and the identifier of the key that signs for it/);
});

// Nothing is written until every field the chosen path needs is there — a mint
// attempted with a missing template var fails at the agent, after the DID's
// keys have already been derived.
test("nothing is written while a required field is empty", async () => {
  const { a, screen } = await mount({});
  await screen.click(screen.button("Create room"));
  assert.deepEqual(a.calls.filter((c) => !c.type.includes("servers/list")), []);
});

// `open` means the host reads every record. That is a legitimate choice and a
// surprising one, so the screen has to say it rather than leave "open" to be
// read as "not restricted yet".
test("choosing open says the host can read everything", async () => {
  const { screen } = await mount({});
  const selects = screen.all("select");
  await screen.select(selects[2]!, "open");
  assert.match(screen.text(), /stores record bodies in the clear/);
});

// A hosting-server list that failed is not an agent with no servers registered.
test("a failed server listing says so rather than offering an empty menu", async () => {
  const a = agent({});
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

// ── Minting the host ────────────────────────────────────────────────────────
//
// "Where do I get a host DID?" is the question this form provoked and did not
// answer: it asks for one without saying that somebody has to mint it first.
// The button answers it. What matters is that it mints the *host* — a different
// template, a different service block — and that it does not quietly do the two
// things that are somebody's decision rather than a form's.

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

/** Open the host panel and fill it. Leaves the room half untouched. */
const mintAHost = async (screen: Awaited<ReturnType<typeof mount>>["screen"]) => {
  await screen.click(screen.button("Mint one"));
  const selects = screen.all("select");
  const inputs = screen.all("input").filter((el) => el.type !== "radio");
  // Indexed from the end: the panel renders last, and counting forwards would
  // pin this test to how many fields the room half happens to have.
  await screen.select(selects.at(-2)!, "openvtc"); // host context
  await screen.select(selects.at(-1)!, "webvh-1"); // hosting server
  await screen.type(inputs.at(-2)!, "https://host.example"); // host url
  await screen.type(inputs.at(-1)!, "did:web:mediator.example"); // host mediator
  await screen.click(screen.button("Mint host DID"));
};

test("the host is minted from the room-host template, not the room one", async () => {
  const { a, screen } = await mount({ [DIDS_CREATE]: HOST_MINTED });
  await mintAHost(screen);

  const mint = a.calls.find((c) => c.type.includes("dids/create"))!;
  assert.equal(mint.payload.template, "room-host");
  assert.equal(mint.payload.contextId, "openvtc");
  assert.equal(mint.payload.serverId, "webvh-1");
  // All three of the template's requiredVars. A host DID that advertises no
  // service block is one no member can reach, and the failure surfaces much
  // later as "the room does not work".
  assert.equal(mint.payload.templateVars.WEBVH_SERVER, "webvh-1");
  assert.equal(mint.payload.templateVars.URL, "https://host.example");
  assert.equal(mint.payload.templateVars.MEDIATOR_DID, "did:web:mediator.example");
});

test("the minted host DID lands in the field, so the room can be created with it", async () => {
  const { screen } = await mount({ [DIDS_CREATE]: HOST_MINTED });
  await mintAHost(screen);

  const inputs = screen.all("input").filter((el) => el.type !== "radio");
  assert.equal(
    inputs[1]!.value,
    HOST_MINTED.did,
    "minting that left the operator to copy the DID by hand would not have removed the step",
  );
});

// The button mints an identity. It does not enrol the host and does not grant
// it anything — the host enrols itself, and the grant is a person deciding this
// host may act in their context. A form that did either silently would be
// making that decision on the operator's behalf.
test("minting a host writes exactly one task, and it is not a grant", async () => {
  const { a, screen } = await mount({ [DIDS_CREATE]: HOST_MINTED });
  await mintAHost(screen);

  const writes = a.calls.map((c) => c.type).filter((t) => !t.includes("servers/list"));
  assert.deepEqual(
    writes.map((t) => t.replace("https://trusttasks.org/spec/", "")),
    [DIDS_CREATE],
    "one mint, no acl/grant, no rooms/owner/register",
  );
});
