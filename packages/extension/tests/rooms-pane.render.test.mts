// The rooms pane, rendered.
//
// The whole screen turns on one thing being said out loud, and it is the thing
// a type checker cannot see: **a member who can read less than they expected
// needs to know WHICH of two unrelated failures they are looking at.**
//
// `epoch` behind the room's own means a commit was not delivered. `earliest`
// equal to `epoch` means the epoch key chain has not arrived. The repairs are
// different, and a pane that renders both as "you can't read this" tells a
// member their history was lost when it is sitting on a host waiting to be
// fetched. So each of the three standings is asserted against the words on
// screen rather than against `standing()`, which is a pure function and would
// pass while the pane drew none of it.
//
// The second thing asserted here is a refusal: this list is key custody, and
// the pane must never present it as membership or as permission to write.

import { test } from "node:test";
import assert from "node:assert/strict";
import { agent, h, render, PARTIES } from "./harness/dom.mjs";
import { RoomsPane } from "../src/manager/panes/rooms.js";

const LIST = "rooms/keys/list/0.2";

const MEMBER = "did:key:z6MkMember";

const room = (roomId: string, epoch: number, earliestReadableEpoch: number, member = MEMBER) => ({
  roomId,
  member,
  epoch,
  earliestReadableEpoch,
});

// The pane also carries the create form, which reads the agent's hosting
// servers and its transports (for the mediator it offers) on mount. Named here
// so the fake agent answers them rather than throwing — these tests are about
// the listing, and `rooms-create.render` covers the form.
const SERVERS = "vta/webvh/servers/list/1.0";
const SERVICES = "vta/services/list/1.1";

const mount = async (rooms: unknown[]) => {
  const a = agent({ [LIST]: { rooms }, [SERVERS]: { servers: [] }, [SERVICES]: { services: [] } });
  const screen = await render(h(RoomsPane, { parties: PARTIES, contexts: [] } as never), {
    chrome: { runtime: { sendMessage: a.sendMessage } },
  });
  return { a, screen };
};

/** Open the only room on screen, then one of its tabs. */
const openTab = async (screen: Awaited<ReturnType<typeof mount>>["screen"], tab: string, room = "Unnamed room") => {
  await screen.click(screen.button(room));
  await screen.click(screen.button(tab));
};

/** Calls to the rooms family, which is what these tests are about. */
const roomsCalls = (a: { calls: { type: string }[] }) =>
  a.calls.filter((call) => call.type.includes("/rooms/"));

// ── The three standings ─────────────────────────────────────────────────────

// The card carries the pill; what it means is said where the repair is, in the
// room's Access tab.
test("a chain walked to the room's first epoch reads as the whole history", async () => {
  const { screen } = await mount([room("did:webvh:example.com:rooms:northwind", 7, 1)]);
  assert.match(screen.text(), /whole history/);
  await openTab(screen, "Access");
  assert.match(screen.text(), /Every record this room retains can be opened/);
  assert.equal(screen.all("button").filter((b) => /Fetch the history/.test(b.textContent ?? "")).length, 0,
    "nothing to repair, so nothing offered");
});

// The case a member misreads as loss. Nothing is missing — a delivery has not
// happened — so the words have to name the delivery.
test("no chain at all says the history is undelivered, not gone", async () => {
  const { screen } = await mount([room("did:webvh:example.com:rooms:northwind", 7, 7)]);
  assert.match(screen.text(), /from joining/);
  await openTab(screen, "Access");
  assert.match(screen.text(), /has not been delivered/);
  assert.ok(screen.button("Fetch the history"), "the repair is offered beside the words");
});

// Partly delivered is its own answer and must not round to either neighbour:
// rounding up promises history the member cannot read, rounding down hides
// history they can.
test("a partial chain names the epoch the walk stopped at", async () => {
  const { screen } = await mount([room("did:webvh:example.com:rooms:northwind", 7, 4)]);
  assert.match(screen.text(), /back to epoch 4/);
  assert.doesNotMatch(screen.text(), /whole history/);
});

test("the three standings are distinguishable on one screen", async () => {
  const { screen } = await mount([
    room("did:webvh:example.com:rooms:a", 7, 1),
    room("did:webvh:example.com:rooms:b", 7, 7),
    room("did:webvh:example.com:rooms:c", 7, 4),
  ]);
  const text = screen.text();
  for (const label of ["whole history", "from joining", "back to epoch 4"]) {
    assert.match(text, new RegExp(label), `${label} is missing — three rooms, three answers`);
  }
});

// ── Custody is not membership ───────────────────────────────────────────────

// The pane's central refusal. A room listed here may still refuse a write, and
// a room the principal belongs to may not be listed at all; a screen that
// implies otherwise is telling the member they have authority the host will not
// honour, which they find out at the point of use.
test("the screen says custody is not permission, and not membership", async () => {
  const { screen } = await mount([room("did:webvh:example.com:rooms:northwind", 3, 1)]);
  const text = screen.text();
  assert.match(text, /Holding keys is not permission to act/);
  assert.match(text, /credentials the room issued/);
  assert.match(text, /Welcome never arrived/);
});

// An empty list is ambiguous in a way that matters: it is what "no rooms" and
// "invited, not yet joined" both look like. Saying only "none" invites the
// member to conclude the invitation failed.
test("an empty list says what else it could mean", async () => {
  const { screen } = await mount([]);
  assert.match(screen.text(), /before an invitation has been accepted/);
});

// ── It asks the member's own VTA, and asks it once ──────────────────────────

// `rooms/keys/*` terminates at the member's own key holder; the room's host
// serves everything else and must never see this. A pane that sent it to the
// host would be asking a party that cannot answer to enumerate the member's
// rooms.
test("the listing goes to the agent, and asks the rooms family nothing else", async () => {
  const { a } = await mount([room("did:webvh:example.com:rooms:northwind", 2, 1)]);
  const calls = roomsCalls(a);
  assert.equal(calls.length, 1, `expected one rooms call, got: ${calls.map((c) => c.type).join(", ")}`);
  assert.match(calls[0]!.type, /rooms\/keys\/list\/0\.2$/);
  assert.deepEqual(calls[0]!.payload, { includePersonal: true }, "the member's own console asks for their labels");
});

// A failed listing must not render as an empty one — "this agent holds keys to
// no rooms" is a claim, and an agent that did not answer has made none.
test("a listing that failed is not drawn as a listing that was empty", async () => {
  const screen = await render(h(RoomsPane, { parties: PARTIES, contexts: [] } as never), {
    chrome: { runtime: { sendMessage: async () => ({ ok: false, error: "agent unreachable" }) } },
  });
  assert.doesNotMatch(screen.text(), /before an invitation has been accepted/);
});

// ── One room, two members ───────────────────────────────────────────────────

// One agent can hold two members of a room: the community's own place in a room
// the community owns, and an administrator's own membership in it. The agent
// lists the room twice. The pane draws one card that says it is held twice,
// and the detail acts as one place at a time — each labelled with its member
// and the place it holds — or the member reads one room with two different
// histories as a fault.
test("two members of one room are one card, and the detail acts as one place at a time", async () => {
  const ROOM = "did:webvh:example.com:rooms:northwind";
  const COMMUNITY = "did:webvh:QmCommunity:community.example";
  const a = agent({
    [LIST]: {
      rooms: [room(ROOM, 7, 1, COMMUNITY), room(ROOM, 7, 7, PARTIES.service.did)],
      ext: {
        "org.openvtc.rooms": {
          held: [
            { member: COMMUNITY, context: "vtc-test", actions: ["read", "write", "curate", "admin"] },
            { member: PARTIES.service.did, context: "default", actions: ["read", "write"] },
          ],
        },
      },
    },
    [SERVERS]: { servers: [] },
    [SERVICES]: { services: [] },
  });
  const screen = await render(h(RoomsPane, { parties: PARTIES, contexts: [] } as never), {
    chrome: { runtime: { sendMessage: a.sendMessage } },
  });
  assert.equal(screen.all("button[aria-label^='Open ']").length, 1, "one card for one room");
  assert.match(screen.text(), /Held as 2 identities/);
  assert.match(screen.text(), /this agent's own DID/, "the member who is the agent itself says so");

  await screen.click(screen.button("Unnamed room"));
  await screen.click(screen.button("Access"));
  let text = screen.text();
  assert.match(text, /This agent holds 2 places in this room/);
  assert.match(text, /administers the room · context vtc-test/);
  assert.match(text, /whole history/);

  await screen.click(screen.button("this agent's own DID"));
  text = screen.text();
  assert.match(text, /member · context default/);
  assert.match(text, /from joining/);
  assert.doesNotMatch(text, /context vtc-test/, "the other place's detail is gone, not mixed in");
});

// ── Where a room was last found ─────────────────────────────────────────────

const HOST = "did:webvh:QmCommunity:community.example";
const BROWSE = "rooms/keys/browse/0.3";
const PROFILE = "rooms/keys/profile/read/0.1";

// The host used to be asked for twice per room on every visit. A room a
// community offered is known to live there: the card sits under that
// community, and its records list straight away from it — through the agent,
// naming the member.
test("a room the wallet has found before groups under its host and lists from it", async () => {
  const ROOM = "did:webvh:example.com:rooms:northwind";
  const a = agent({
    [LIST]: { rooms: [room(ROOM, 3, 1)] },
    [BROWSE]: { roomId: ROOM, records: [], complete: true, verification: { priorRoots: "noneHeld" } },
    [PROFILE]: { roomId: ROOM, status: "absent" },
    [SERVERS]: { servers: [] },
    [SERVICES]: { services: [] },
  });
  const screen = await render(h(RoomsPane, { parties: PARTIES, contexts: [] } as never), {
    chrome: {
      runtime: { sendMessage: a.sendMessage },
      storage: {
        local: {
          get: async () => ({
            [`room-names:${PARTIES.service.did}|${HOST}`]: { [ROOM]: { label: "Northwind", seenAt: 1 } },
          }),
        },
      },
    } as never,
  });
  await screen.settle();
  assert.match(screen.text(), /community\.example/);
  assert.match(screen.text(), /community/);
  assert.doesNotMatch(screen.text(), /Host not known yet/);

  await screen.click(screen.button("Northwind"));
  await screen.settle();
  const browsed = a.of("keys/browse");
  assert.equal(browsed.length, 1, "listed without being asked for a host");
  assert.equal(browsed[0]!.payload.host, HOST);
  assert.deepEqual(browsed[0]!.payload.ext, { "org.openvtc.rooms": { member: MEMBER } });
  assert.equal(screen.all("input").length, 0, "no host field to fill in");
  assert.ok(screen.button("Change"), "and a way to say the room has moved");
});

// A host the member names, and that answers, is remembered — and a room with
// none sits under its own heading rather than under a guess.
test("a host that answers a listing is remembered for next time", async () => {
  const ROOM = "did:webvh:example.com:rooms:northwind";
  const writes: Record<string, unknown>[] = [];
  const a = agent({
    [LIST]: { rooms: [room(ROOM, 3, 1)] },
    [BROWSE]: { roomId: ROOM, records: [], complete: true, verification: { priorRoots: "noneHeld" } },
    [PROFILE]: { roomId: ROOM, status: "absent" },
    [SERVERS]: { servers: [] },
    [SERVICES]: { services: [] },
  });
  const screen = await render(h(RoomsPane, { parties: PARTIES, contexts: [] } as never), {
    chrome: {
      runtime: { sendMessage: a.sendMessage },
      storage: { local: { get: async () => ({}), set: async (v: Record<string, unknown>) => void writes.push(v) } },
    } as never,
  });
  await screen.settle();
  assert.match(screen.text(), /Host not known yet/);
  await screen.click(screen.button("Unnamed room"));
  await screen.type(screen.all("input")[0]!, HOST);
  await screen.click(screen.button("List the records"));
  await screen.settle();
  assert.equal(writes.length, 1);
  assert.deepEqual(Object.values(writes[0]!)[0], {
    [ROOM]: { host: HOST, source: "used", seenAt: (Object.values(writes[0]!)[0] as Record<string, { seenAt: number }>)[ROOM]!.seenAt },
  });
  await screen.click(screen.button("All rooms"));
  assert.doesNotMatch(screen.text(), /Host not known yet/, "the card has moved under its host");
});

// Grouping by context needs no hint at all, and a room held in two contexts
// appears under each, holding that context's place only.
test("grouped by context, a room held in two contexts is under each", async () => {
  const ROOM = "did:webvh:example.com:rooms:northwind";
  const a = agent({
    [LIST]: {
      rooms: [room(ROOM, 7, 1, HOST), room(ROOM, 7, 7, PARTIES.service.did)],
      ext: {
        "org.openvtc.rooms": {
          held: [
            { member: HOST, context: "vtc-test", actions: ["read", "admin"] },
            { member: PARTIES.service.did, context: "default", actions: ["read"] },
          ],
        },
      },
    },
    [SERVERS]: { servers: [] },
    [SERVICES]: { services: [] },
  });
  const screen = await render(h(RoomsPane, { parties: PARTIES, contexts: [] } as never), {
    chrome: { runtime: { sendMessage: a.sendMessage } },
  });
  await screen.click(screen.button("Context"));
  const text = screen.text();
  assert.match(text, /context vtc-test/);
  assert.match(text, /context default/);
  assert.equal(screen.all("button[aria-label^='Open ']").length, 2);
});

// ── Your own name for a room ────────────────────────────────────────────────

// rooms/keys/label's display order: the member's own name first, then the
// community's, then the DID — and the personal name never hides the others, so
// a member can see a room was renamed after they named it.
test("your own name comes first, and the room's other names stay beside it", async () => {
  const ROOM = "did:webvh:example.com:rooms:northwind";
  const a = agent({
    [LIST]: {
      rooms: [
        {
          ...room(ROOM, 7, 1),
          personal: {
            label: "Northwind tender",
            description: "Pricing room.",
            tags: ["work", "bids"],
            updatedAt: "2026-10-16T09:00:00Z",
          },
        },
      ],
    },
    [SERVERS]: { servers: [] },
    [SERVICES]: { services: [] },
  });
  const screen = await render(h(RoomsPane, { parties: PARTIES, contexts: [] } as never), {
    chrome: {
      runtime: { sendMessage: a.sendMessage },
      storage: {
        local: {
          get: async () => ({
            [`room-names:${PARTIES.service.did}|did:webvh:QmCommunity:community.example`]: {
              [ROOM]: { label: "Community pricing", seenAt: 1 },
            },
          }),
        },
      },
    } as never,
  });
  await screen.settle();
  const text = screen.text();
  assert.match(text, /Northwind tender · your name for it/);
  assert.match(text, /community's name: Community pricing/, "the community's name stays reachable");
  assert.ok(text.indexOf("Northwind tender") < text.indexOf("Community pricing"), "yours first");
  assert.match(text, /work · bids/);
  assert.match(text, /Pricing room\./);
  assert.ok(text.includes(ROOM), "the DID stays on the row");
  assert.ok(text.indexOf("Northwind tender") < text.indexOf(ROOM), "your name before the DID");
});
