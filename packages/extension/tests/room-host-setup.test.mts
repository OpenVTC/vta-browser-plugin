// The commands the New room form prints for bringing a room host up.
//
// Each is pasted into a terminal that can reach the agent, so each assertion is
// about what the host comes up as and what it is allowed to do.

import { strict as assert } from "node:assert";
import { test } from "node:test";

import {
  coveringWildcard,
  hostGrantCommand,
  hostnameOf,
  roomHostCommand,
} from "../src/manager/room-host-setup.js";

const AGENT = "did:webvh:QmAgent:agent.example:vta";
const MEDIATOR = "did:webvh:QmMediator:mediator.example";

test("the host is started against this agent and the host's own context", () => {
  const cmd = roomHostCommand({ agentDid: AGENT, context: "vdr-host" });
  assert.match(cmd, new RegExp(`--vta-did ${AGENT}`));
  // Left to its default, room-host enrols into `rooms` and serves as whatever
  // DID that context carries — not the one just minted.
  assert.match(cmd, /--vta-context vdr-host/);
});

// Off by default in room-host, and a host without it serves almost nothing: a
// room's credentials are issued by a did:webvh room.
test("network DID resolution is on, because a room's issuer is a did:webvh", () => {
  assert.match(roomHostCommand({ agentDid: AGENT, context: "c" }), /--resolve-dids/);
});

test("a mediator is named when there is one, and left out when there is not", () => {
  assert.match(
    roomHostCommand({ agentDid: AGENT, context: "c", mediatorDid: MEDIATOR }),
    new RegExp(`--mediator-did ${MEDIATOR}`),
  );
  assert.doesNotMatch(roomHostCommand({ agentDid: AGENT, context: "c" }), /--mediator-did/);
});

test("the command is one pasteable line per flag", () => {
  const lines = roomHostCommand({ agentDid: AGENT, context: "c" }).split("\n");
  assert.equal(lines[0], "room-host \\");
  assert.ok(lines.slice(1, -1).every((l) => l.endsWith(" \\")), "every line but the last continues");
});

// Omitting `--contexts` grants every context; `admin` grants authority the host
// has no use for. Either is a silent over-grant.
test("the grant is application on exactly the host's context", () => {
  const grant = hostGrantCommand("vdr-host");
  assert.match(grant, /--role application/);
  assert.match(grant, /--contexts vdr-host$/);
  assert.doesNotMatch(grant, /admin/);
});

test("a value a shell would split is quoted", () => {
  assert.match(hostGrantCommand("my rooms"), /--contexts 'my rooms'$/);
  assert.match(roomHostCommand({ agentDid: AGENT, context: "it's" }), /--vta-context 'it'\\''s'/);
});

test("the hostname comes from the URL, and a URL that does not parse has none", () => {
  assert.equal(hostnameOf("https://rooms.vdr.example.net/"), "rooms.vdr.example.net");
  assert.equal(hostnameOf("not a url"), null);
});

// The failure that prompted this: a certificate for *.example.net presented at
// rooms.vdr.example.net. A wildcard matches one label.
test("the only wildcard covering a name is one label up", () => {
  assert.equal(coveringWildcard("rooms.vdr.example.net"), "*.vdr.example.net");
  assert.equal(coveringWildcard("rooms.example.net"), "*.example.net");
  assert.equal(coveringWildcard("example.net"), null);
});
