// An open room the member is in, rendered in the console's rooms pane.
//
// The agent holds no keys for an open room, so the key-custody cards never show
// it; the community's record is what says the member is in it. Asserted here:
// its detail says it is open and that its contents are readable by the host,
// and lists the records straight away from the community, as the member the
// community admitted — never asking for the host, never as the agent.

import { test } from "node:test";
import assert from "node:assert/strict";
import { agent, h, render, PARTIES } from "./harness/dom.mjs";
import { OpenRoomCard, OpenRoomDetail } from "../src/manager/panes/rooms-open.js";

const BROWSE = "rooms/keys/browse/0.3";
const COMMUNITY = "did:webvh:QmCommunity:first.example";
const ROOM = "did:webvh:QmOpen:first.example:room-dids:1";
const MEMBER = "did:webvh:QmMember:people.example";

const OPEN = { roomId: ROOM, member: MEMBER, actions: ["read", "write", "curate"], communityDid: COMMUNITY, label: "Public Data Room" };

test("an open room's card says it is open and has no keys", async () => {
  const screen = await render(h(OpenRoomCard, { room: OPEN, agentDid: PARTIES.service.did, names: {}, onOpen: () => {} } as never));
  assert.match(screen.text(), /Public Data Room/);
  assert.match(screen.text(), /open · no keys/);
  assert.match(screen.text(), /write/);
});

test("an open room's detail lists its records from the community, as the member, without asking for the host", async () => {
  const a = agent({ [BROWSE]: { roomId: ROOM, records: [], complete: true, verification: { count: "match" } } });
  const screen = await render(h(OpenRoomDetail, { parties: PARTIES, room: OPEN, names: {}, onBack: () => {} } as never), {
    chrome: { runtime: { sendMessage: a.sendMessage } },
  });
  assert.match(screen.text(), /This room is open/);
  assert.match(screen.text(), /readable by its host/);
  const listed = a.of(BROWSE);
  assert.equal(listed.length, 1, "listed straight away from the community");
  const p = listed[0]!.payload as { roomId: string; host: string; ext?: Record<string, { member?: string }> };
  assert.equal(p.roomId, ROOM);
  assert.equal(p.host, COMMUNITY);
  assert.equal(p.ext?.["org.openvtc.rooms"]?.member, MEMBER);
});
