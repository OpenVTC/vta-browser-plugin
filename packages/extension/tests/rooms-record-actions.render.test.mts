// Writing, editing and curating a room's records from the console, rendered.
//
// What is asserted is what goes to the offscreen document and what the person
// is shown: a new note is a `note` with no key; an edit names the record and
// the version that was read; a retraction cannot be sent without a reason and
// says it is not an erase; and an action the place's credentials do not carry
// is not offered as if it were.

import { test } from "node:test";
import assert from "node:assert/strict";
import { agent, h, render, PARTIES } from "./harness/dom.mjs";
import { RoomRecords } from "../src/manager/panes/rooms-records.js";
import { ROOM_FILES_PORT } from "../src/bridge-protocol.js";

const BROWSE = "rooms/keys/browse/0.3";
const READ = "rooms/keys/read/0.1";
const HOST = "did:webvh:QmHost:host.example";
const ROOM = "did:webvh:QmRoom:rooms.example";
const ME = "did:webvh:QmMe:people.example";
const PREPARED = { endpoint: "https://host.example/trust-tasks", granted: true, vtaDid: "did:webvh:QmAgent:agent.example" };

const b64 = (o: unknown) => Buffer.from(JSON.stringify(o)).toString("base64url");
const head = { dataCommitment: "zQm", recordCount: 1, headVersion: 5 };

/** A room with one note by `author`, an agent that reads it, and a port that answers writes. */
const mount = async ({ author = ME, actions, status = "active" }: { author?: string; actions?: string[]; status?: string } = {}) => {
  const a = agent({
    [BROWSE]: { roomId: ROOM, records: [{ key: "n1", version: 5, status }], complete: true, verification: { priorRoots: "agree", count: "agrees", head } },
    [READ]: {
      roomId: ROOM,
      key: "n1",
      version: 5,
      status,
      plaintext: b64({ title: "Mascot Name", body: "Settled on Trustie", author }),
      verification: { trace: "verified", priorRoots: "agree", head },
    },
  });
  const opened: Record<string, unknown>[] = [];
  const connect = () => {
    const listeners: ((m: unknown) => void)[] = [];
    return {
      name: ROOM_FILES_PORT,
      onMessage: { addListener: (f: (m: unknown) => void) => listeners.push(f) },
      onDisconnect: { addListener: () => undefined },
      disconnect: () => undefined,
      postMessage: (m: Record<string, unknown>) => {
        opened.push(m);
        const reply =
          m.kind === "note"
            ? { kind: "noted", key: (m.key as string) ?? "fresh", version: 6, author: ME }
            : { kind: "curated", key: m.key, version: 6, status: m.status ?? "active" };
        setTimeout(() => listeners.forEach((f) => f(reply)), 1);
      },
    };
  };
  const sendMessage = (m: { type?: string }) =>
    m?.type === "vta-wallet/room-files-prepare" ? Promise.resolve({ ok: true, result: PREPARED }) : a.sendMessage(m as never);
  const room = { roomId: ROOM, member: ME, epoch: 3, earliestReadableEpoch: 1, ...(actions ? { actions } : {}) };
  const screen = await render(h(RoomRecords, { parties: PARTIES, room, host: HOST } as never), {
    chrome: { runtime: { sendMessage, connect } } as never,
  });
  await screen.settle();
  await new Promise((r) => setTimeout(r, 10));
  await screen.settle();
  return { a, screen, opened };
};

const settle = async (screen: { settle: () => Promise<void> }) => {
  await new Promise((r) => setTimeout(r, 10));
  await screen.settle();
};

test("a new note is written as a note with no key, and the list is read again", async () => {
  const { a, screen, opened } = await mount();
  await screen.click(screen.button("Write a note"));
  await screen.type(screen.all('input[aria-label="Note title"]')[0]!, "Decision");
  await screen.type(screen.all('textarea[aria-label="Note text"]')[0]!, "We ship Friday");
  await screen.click(screen.button("Add the note"));
  await settle(screen);
  assert.equal(opened.length, 1);
  assert.equal(opened[0]!.kind, "note");
  assert.equal(opened[0]!.title, "Decision");
  assert.equal(opened[0]!.body, "We ship Friday");
  assert.equal("key" in opened[0]!, false, "a fresh key is chosen offscreen");
  assert.equal(opened[0]!.member, ME, "written as the place selected");
  assert.equal(a.of("keys/browse").length, 2, "listed again");
});

test("an edit names the record and the version that was read", async () => {
  const { screen, opened } = await mount();
  await screen.click(screen.button("Mascot Name"));
  await screen.click(screen.button("Edit"));
  const title = screen.all('input[aria-label="Note title"]')[0] as HTMLInputElement;
  assert.equal(title.value, "Mascot Name", "the editor opens on what the note says");
  await screen.type(screen.all('textarea[aria-label="Note text"]')[0]!, "Settled on Trustie, finally");
  await screen.click(screen.button("Save changes"));
  await settle(screen);
  assert.equal(opened[0]!.kind, "note");
  assert.equal(opened[0]!.key, "n1");
  assert.equal(opened[0]!.replaces, 5);
});

// Replacing a note someone else wrote is not an edit: the button is not there.
test("another member's note offers no Edit", async () => {
  const { screen } = await mount({ author: "did:webvh:QmSomeoneElse:people.example" });
  await screen.click(screen.button("Mascot Name"));
  assert.equal(screen.all("button").some((b) => b.textContent === "Edit"), false);
  assert.ok(screen.button("Retract"), "curating is still a room action");
});

test("a retraction needs a reason, says it is not an erase, and sends the version read", async () => {
  const { screen, opened } = await mount();
  await screen.click(screen.button("Mascot Name"));
  await screen.click(screen.button("Retract…"));
  assert.match(screen.text(), /It is not an erase/);
  const go = screen.button("Retract it") as HTMLButtonElement;
  assert.equal(go.disabled, true, "no reason, no retraction");
  await screen.type(screen.all('textarea[aria-label="Why it is retracted"]')[0]!, "posted in the wrong room");
  await screen.click(screen.button("Retract it"));
  await settle(screen);
  assert.deepEqual(
    { kind: opened[0]!.kind, key: opened[0]!.key, status: opened[0]!.status, reason: opened[0]!.reason, expectedVersion: opened[0]!.expectedVersion },
    { kind: "curate", key: "n1", status: "retracted", reason: "posted in the wrong room", expectedVersion: 5 },
  );
});

// Archiving demotes a record and keeps its body; a sealed body stays readable
// because the host keeps the version it was sealed at (VTI #2185). One click
// each way, no reason asked: nothing is lost.
test("archive sends deprecated at the version read, with no confirmation", async () => {
  const { a, screen, opened } = await mount();
  await screen.click(screen.button("Mascot Name"));
  await screen.click(screen.button("Archive"));
  await settle(screen);
  assert.deepEqual(
    { kind: opened[0]!.kind, key: opened[0]!.key, status: opened[0]!.status, expectedVersion: opened[0]!.expectedVersion, reason: opened[0]!.reason },
    { kind: "curate", key: "n1", status: "deprecated", expectedVersion: 5, reason: undefined },
  );
  assert.equal(a.of("keys/browse").length, 2, "listed again");
});

test("an archived record offers Restore, which sends active", async () => {
  const { screen, opened } = await mount({ status: "deprecated" });
  await screen.click(screen.button("Mascot Name"));
  assert.equal(screen.all("button").some((b) => b.textContent === "Archive"), false);
  await screen.click(screen.button("Restore"));
  await settle(screen);
  assert.equal(opened[0]!.status, "active");
  assert.equal(opened[0]!.expectedVersion, 5);
});

test("pin is not offered", async () => {
  const { screen } = await mount();
  await screen.click(screen.button("Mascot Name"));
  assert.equal(screen.all("button").some((b) => /^(Pin|Unpin)/.test(b.textContent ?? "")), false);
});

// Where the agent said what the place holds, an action it lacks is shown as
// such — not offered, then refused by the host.
test("without the curate grant, archiving and retracting are not offered as if they were", async () => {
  const { screen } = await mount({ actions: ["read", "write"] });
  await screen.click(screen.button("Mascot Name"));
  assert.equal((screen.button("Retract…") as HTMLButtonElement).disabled, true);
  assert.equal((screen.button("Archive") as HTMLButtonElement).disabled, true);
  assert.match(screen.text(), /Archiving and retracting need the room's curate grant/);
  assert.equal((screen.button("Write a note") as HTMLButtonElement).disabled, false);
});

test("without the write grant, nothing new can be written", async () => {
  const { screen } = await mount({ actions: ["read"] });
  assert.equal((screen.button("Write a note") as HTMLButtonElement).disabled, true);
  assert.match(screen.text(), /do not include write/);
});
