// Making a room, rendered.
//
// The form does two writes against two different parties, and the interesting
// tests are all about the seam between them: the DID is minted at the agent,
// the room is registered at a host, and **the first is not undoable**. So what
// happens when the second fails is the property worth pinning, not the happy
// path — an operator who loses the `signingKeyId` has a room nothing can ever
// issue in the name of, and no way to get it back.

import { test } from "node:test";
import assert from "node:assert/strict";
import { agent, h, render, PARTIES } from "./harness/dom.mjs";
import { CreateRoom } from "../src/manager/panes/rooms-create.js";

const SERVERS = "vta/webvh/servers/list/1.0";
const DIDS_CREATE = "vta/webvh/dids/create/1.0";
const ROOMS_CREATE = "rooms/create/0.1";

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
  await screen.type(inputs[1]!, "did:webvh:QmHost:host.example"); // host
};

// ── The seam ────────────────────────────────────────────────────────────────

test("both halves are written, identity first", async () => {
  const { a, screen } = await mount({ [DIDS_CREATE]: MINTED, [ROOMS_CREATE]: { roomId: MINTED.did, epoch: 1 } });
  await fillAll(screen);
  await screen.click(screen.button("Create room"));

  const writes = a.calls.map((c) => c.type).filter((t) => !t.includes("servers/list"));
  assert.deepEqual(
    writes.map((t) => t.replace("https://trusttasks.org/spec/", "")),
    [`${DIDS_CREATE}`, `${ROOMS_CREATE}`],
    "the DID must exist before a host is told about the room",
  );
});

test("the room is minted from the room template, addressable and hosted", async () => {
  const { a, screen } = await mount({ [DIDS_CREATE]: MINTED, [ROOMS_CREATE]: { roomId: MINTED.did, epoch: 1 } });
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
test("the host is told the minted DID and who owns it", async () => {
  const { a, screen } = await mount({ [DIDS_CREATE]: MINTED, [ROOMS_CREATE]: { roomId: MINTED.did, epoch: 1 } });
  await fillAll(screen);
  await screen.click(screen.button("Create room"));

  const create = a.calls.find((c) => c.type.includes("rooms/create"))!;
  assert.equal(create.payload.roomId, MINTED.did);
  assert.equal(create.payload.ownerDid, PARTIES.holder.did);
  assert.equal(create.payload.visibility, "private", "private is the default a room should start at");
});

// ── The failure that costs something ────────────────────────────────────────

test("a minted identity survives a failed registration, both halves on screen", async () => {
  const { screen } = await mount({
    [DIDS_CREATE]: MINTED,
    [ROOMS_CREATE]: () => {
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
    [ROOMS_CREATE]: () => {
      if (hostFails) throw new Error("host unreachable");
      return { roomId: MINTED.did, epoch: 1 };
    },
  });
  await fillAll(screen);
  await screen.click(screen.button("Create room"));

  hostFails = false;
  await screen.click(screen.button("Register with the host"));

  const mints = a.calls.filter((c) => c.type.includes("dids/create"));
  assert.equal(mints.length, 1, "a second press minted a second room and orphaned the first");
  assert.equal(a.calls.filter((c) => c.type.includes("rooms/create")).length, 2);
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
