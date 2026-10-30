// Listing or removing a DID's did:scid alias from the console.
//
// What these pin is what a person sees and a type checker does not: that the
// state is read from the latest document (and that a stale locator is not
// "listed"), that the update-key rotation is said before anything is sent,
// that `false` reaches the agent as `false`, that the request never carries a
// DID URL the console built, and that the two refusals this action exists to
// meet are said in words, by code.

import { test } from "node:test";
import assert from "node:assert/strict";
import { agent, h, render, PARTIES } from "./harness/dom.mjs";
import { DidsPane } from "../src/manager/panes/dids.js";

const LIST = "vta/webvh/dids/list/1.0";
const GET = "vta/webvh/dids/get/1.0";
const UPDATE = "vta/webvh/dids/update/1.1";
const SERVERS = "vta/webvh/servers/list/1.0";
const TEMPLATES = "vta/did-templates/list/3.1";
const SERVICES = "vta/services/list/1.1";

const DID = "did:webvh:QmScid:example.com:rooms:northwind";
const HERE = "did:scid:vh:1:QmScid?src=example.com/rooms/northwind";
const OLD = "did:scid:vh:1:QmScid?src=old.example/northwind";

const record = {
  did: DID,
  serverId: "prod",
  mnemonic: "brave-otter",
  scid: "QmScid",
  contextId: "rooms",
  portable: true,
  logEntryCount: 2,
  preRotationCount: 2,
  createdAt: "2026-09-11T00:00:00Z",
  updatedAt: "2026-09-11T00:00:00Z",
};

const line = (versionId: string, alsoKnownAs?: string[]) =>
  JSON.stringify({
    versionId,
    versionTime: "2026-09-11T00:00:00Z",
    parameters: { method: "did:webvh:1.0", portable: true },
    state: { id: DID, ...(alsoKnownAs ? { alsoKnownAs } : {}) },
    proof: [{ type: "DataIntegrityProof" }],
  });

/** A two-entry log whose latest document lists `alsoKnownAs`. The first entry
 *  always lists the current alias, so a panel reading the wrong entry shows. */
const logWith = (alsoKnownAs?: string[]) =>
  [line("1-QmScid", [HERE]), line("2-QmNext", alsoKnownAs)].join("\n");

const published = {
  did: DID,
  newVersionId: "3-QmPublished",
  updateKeysCount: 1,
  preRotationKeyCount: 2,
  scidAlsoKnownAs: true,
  scidDidUrl: HERE,
};

type Reply = Record<string, unknown>;

const mount = async ({
  log = logWith(),
  answers = {},
  rec = record,
  update,
}: {
  log?: string;
  answers?: Record<string, unknown>;
  rec?: typeof record;
  /** Replaces the relay's reply to the update, for refusals and consent. */
  update?: Reply;
} = {}) => {
  const a = agent({
    [LIST]: { dids: [rec], total: 1 },
    [SERVERS]: { servers: [] },
    [TEMPLATES]: { templates: [] },
    [SERVICES]: [],
    [GET]: { record: rec, log },
    [UPDATE]: published,
    ...answers,
  });
  const sendMessage = async (m: { params?: { type?: string; payload?: unknown } }) => {
    if (update && m.params?.type?.endsWith("/dids/update/1.1")) {
      a.calls.push({ type: m.params.type, payload: m.params.payload });
      return update;
    }
    return a.sendMessage(m);
  };
  const screen = await render(
    h(DidsPane, { parties: PARTIES, authority: null, contextId: "rooms" } as never),
    { chrome: { runtime: { sendMessage } } },
  );
  await screen.settle();
  await screen.click(screen.button(rec.did));
  await screen.settle();
  return { a, screen };
};

type Screen = Awaited<ReturnType<typeof mount>>["screen"];

/** Press the action, read the preview, then confirm it. */
const confirm = async (screen: Screen, label: string) => {
  await screen.click(screen.button(label));
  await screen.settle();
  await screen.click(screen.button(label));
  await screen.settle();
};

const updates = (a: ReturnType<typeof agent>) =>
  a.of("dids/update").map((c) => c.payload as Record<string, unknown>);

test("an unlisted alias is said, and listing it says the key rotates before anything is sent", async () => {
  const { a, screen } = await mount();
  assert.match(screen.text(), /Not listed\. This log also verifies did:scid:vh:1:QmScid/);

  await screen.click(screen.button("List the did:scid alias"));
  await screen.settle();
  // The consequence nobody asked for, on screen, with nothing sent yet.
  assert.match(screen.text(), /rotates this DID's update key/);
  assert.match(screen.text(), /stops being able to authorise changes/);
  assert.equal(updates(a).length, 0);

  await screen.click(screen.button("List the did:scid alias"));
  await screen.settle();
  // A flag and the version it was read at — never a DID URL the console built.
  assert.deepEqual(updates(a), [
    { did: DID, scidAlsoKnownAs: true, expectedVersionId: "2-QmNext", label: "list the did:scid alias" },
  ]);
  await screen.unmount();
});

test("after publishing, the did:scid DID URL the agent reported is shown and copyable", async () => {
  const { a, screen } = await mount();
  await confirm(screen, "List the did:scid alias");
  assert.match(screen.text(), /Published 3-QmPublished\. The update key has rotated\./);
  assert.match(screen.text(), /listed in alsoKnownAs/);
  assert.ok(screen.container.querySelector('button[title="Copy the did:scid DID URL"]'));
  // The log is read again: the one on screen is no longer the latest.
  assert.equal(a.of("dids/get").length, 2);
  await screen.unmount();
});

test("a listed alias offers removal, and false reaches the agent as false", async () => {
  const { a, screen } = await mount({ log: logWith(["did:web:example.com", HERE]) });
  assert.match(screen.text(), /Listed\. The document names this log's did:scid DID/);
  assert.equal(screen.all("button").some((b) => b.textContent === "List the did:scid alias"), false);

  await confirm(screen, "Remove the did:scid alias");
  assert.equal(updates(a)[0]!["scidAlsoKnownAs"], false);
  await screen.unmount();
});

test("an alias for an old location is not called listed, and can be listed here", async () => {
  const { a, screen } = await mount({ log: logWith([OLD]) });
  assert.match(screen.text(), /Listed for an old location/);
  assert.match(screen.text(), /old\.example\/northwind/);
  screen.button("Remove the did:scid alias");

  await confirm(screen, "List it for this location");
  assert.equal(updates(a)[0]!["scidAlsoKnownAs"], true);
  await screen.unmount();
});

test("noChange is an answer: nothing published, the key did not rotate", async () => {
  const { screen } = await mount({
    update: { ok: false, error: "nothing to change", code: "vta/webvh/dids/update:noChange" },
  });
  await confirm(screen, "List the did:scid alias");
  assert.match(screen.text(), /Nothing published\./);
  assert.match(screen.text(), /the update key did not rotate/);
  assert.doesNotMatch(screen.text(), /nothing to change/);
  await screen.unmount();
});

test("scidAliasRequired is said in words, by its code", async () => {
  const { screen } = await mount({
    log: logWith([HERE]),
    update: { ok: false, error: "refused", code: "vta/webvh/dids/update:scidAliasRequired" },
  });
  await confirm(screen, "Remove the did:scid alias");
  assert.match(screen.text(), /Not removed\. Your agent gives this identity out as did:scid/);
  assert.match(screen.text(), /Nothing was published\./);
  await screen.unmount();
});

test("an identity the agent gives out as did:scid is not offered removal", async () => {
  const scidRecord = { ...record, did: "did:scid:vh:1:QmScid" };
  const { a, screen } = await mount({ rec: scidRecord, log: logWith([HERE]) });
  assert.equal(screen.all("button").some((b) => b.textContent === "Remove the did:scid alias"), false);
  assert.match(screen.text(), /so it cannot be removed/);
  assert.equal(updates(a).length, 0);
  await screen.unmount();
});

test("an agent asking for approval gets the match-code ceremony, not an error", async () => {
  const { screen } = await mount({
    update: {
      ok: true,
      result: { kind: "consentRequired", payloadDigest: "abcdef0123456789", challenge: "c", minApprovals: 1 },
    },
  });
  await confirm(screen, "List the did:scid alias");
  assert.match(screen.text(), /will not run this until a human approves it/);
  assert.match(screen.text(), /ABCDEF01/);
  await screen.unmount();
});
