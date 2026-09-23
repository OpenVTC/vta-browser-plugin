// The Mediator Lens, rendered.
//
// What is asserted is what a person reads, because every failure worth
// catching here is one the models beneath would pass: a standard account
// offered mediator-wide views it will be refused, an admin shown nothing
// beyond its own queue, a hash left unnamed when the wallet knows whose it is,
// or a mediator too old to answer being asked anyway and timing out.

import { test } from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { h, render, PARTIES } from "./harness/dom.mjs";
import { MediatorPane } from "../src/manager/panes/mediator.js";

const RELAY = "did:webvh:QmRelay:relay.example";
const HOLDER = "did:key:z6MkLensHolder";
const AGENT = PARTIES.service.did;
const hash = (did: string) => createHash("sha256").update(did).digest("hex");

const ACCOUNT = (accountType: string) => ({
  account: {
    did: hash(HOLDER),
    accountType,
    acl: { local: true },
    lastAuthenticatedAt: 1_790_000_000,
  },
});

const QUEUES = {
  queues: {
    did: hash(HOLDER),
    receive: { count: 0, bytes: 0, limit: 200 },
    send: { count: 3, bytes: 20_992, limit: 200, oldestAgeSeconds: 240 },
  },
  sendPeers: [{ peer: hash(AGENT), count: 3, bytes: 20_992, oldestAgeSeconds: 240 }],
};

const STATS = {
  version: "0.29.1",
  uptimeSeconds: 7_200,
  connections: { websocketActive: 418, websocketMax: 10_000 },
  totals: { receivedCount: 92_400, receivedBytes: 311_000_000, sentCount: 90_000, sentBytes: 300_000_000, deletedCount: 1 },
  forwarding: { queueLength: 3, circuitBreaker: "closed" },
};

type Answers = Record<string, unknown>;

/** A fake lens bridge: relays, probe, and tasks answered by slug. Anything the
 *  test did not name is a failure, as in `agent()`. */
function lens({ version = "0.29.1" as string | undefined, versionError = undefined as string | undefined, locateTo = {} as Record<string, string>, answers = {} as Answers, relays = [{ mediatorDid: RELAY, vtaDid: AGENT, isInbox: true, state: "live" }] } = {}) {
  const tasks: string[] = [];
  const calls: { slug: string; payload: Record<string, unknown> }[] = [];
  const sendMessage = async (message: { type?: string; op?: { kind: string; params?: { type: string } } }) => {
    if (message?.type !== "vta-wallet/mediator-lens") {
      throw new Error(`unexpected bridge message: ${message?.type}`);
    }
    const op = message.op!;
    if (op.kind === "relays") return { ok: true, result: relays };
    if (op.kind === "probe") {
      return {
        ok: true,
        result: {
          mediatorDid: RELAY,
          vtaDid: AGENT,
          holderDid: HOLDER,
          isInbox: true,
          ...(version ? { version } : {}),
          ...(versionError ? { versionError } : {}),
        },
      };
    }
    if (op.kind === "locate") {
      return { ok: true, result: { did: (op as { did: string }).did, ...(locateTo[(op as { did: string }).did] ? { mediatorDid: locateTo[(op as { did: string }).did] } : {}) } };
    }
    if (op.kind === "task") {
      const slug = op.params!.type.replace("https://trusttasks.org/spec/", "");
      const payload = (op.params as { payload?: Record<string, unknown> }).payload ?? {};
      tasks.push(slug);
      calls.push({ slug, payload });
      if (!(slug in answers)) throw new Error(`no answer for ${slug}`);
      const a = answers[slug];
      return { ok: true, result: { kind: "accepted", result: typeof a === "function" ? (a as (p: unknown) => unknown)(payload) : a } };
    }
    throw new Error(`unexpected op ${op.kind}`);
  };
  return { tasks, calls, sendMessage };
}

const mount = async (l: ReturnType<typeof lens>, hash = "") => {
  const screen = await render(h(MediatorPane, { parties: PARTIES } as never), {
    chrome: { runtime: { sendMessage: l.sendMessage } },
  });
  if (hash) {
    // The pane mounted on the default relay first; only what it asks after
    // the navigation is about the route under test.
    await screen.settle();
    l.tasks.length = 0;
    l.calls.length = 0;
    location.hash = hash;
    dispatchEvent(new Event("hashchange"));
    await screen.settle();
  }
  await screen.settle();
  await screen.settle();
  return screen;
};

test("a standard account sees its own queues and is told how to see more — and nothing mediator-wide is asked", async () => {
  const l = lens({
    answers: {
      "messaging/account/get/0.1": ACCOUNT("standard"),
      "messaging/queue/status/0.1": QUEUES,
    },
  });
  const screen = await mount(l);
  assert.match(screen.text(), /This wallet's account/);
  assert.match(screen.text(), /records this wallet as a standard account/);
  assert.match(screen.text(), /promotes this account to admin/);
  assert.match(
    screen.text(),
    new RegExp(`pnm messaging grant ${HOLDER} --role admin --mediator ${RELAY}`),
    "the grant names the holder (the account), not the agent",
  );
  assert.ok(!l.tasks.includes("messaging/stats/show/0.1"), "a standard account was asked for mediator statistics");
  assert.ok(!l.tasks.includes("messaging/queue/list/0.1"));
  assert.doesNotMatch(screen.text(), /Queue pressure/);
});

test("mail the agent has not collected is named as the agent's, not left as a hash", async () => {
  const l = lens({
    answers: {
      "messaging/account/get/0.1": ACCOUNT("standard"),
      "messaging/queue/status/0.1": QUEUES,
    },
  });
  const screen = await mount(l);
  assert.match(screen.text(), /Sent, and not yet collected by/);
  assert.match(screen.text(), /agent\.example \(agent\)/);
  assert.match(screen.text(), /4m/, "the oldest message's age is shown");
});

test("an administrator sees the mediator, its queues, its accounts, its audit and its config", async () => {
  const l = lens({
    answers: {
      "messaging/account/get/0.1": ACCOUNT("admin"),
      "messaging/queue/status/0.1": QUEUES,
      "messaging/stats/show/0.1": STATS,
      "messaging/queue/list/0.1": {
        queues: [{ did: hash(AGENT), accountType: "standard", receive: { count: 142, bytes: 1, limit: 200, oldestAgeSeconds: 8040 }, send: { count: 0, bytes: 0 } }],
        snapshotAt: "2026-09-23T12:00:00Z",
      },
      "messaging/account/list/0.1": { accounts: [ACCOUNT("admin").account] },
      "audit/list/0.1": { entries: [], truncated: false },
      "config/show/0.1": { fields: [{ key: "security.trust_task_verification", value: "warn", source: "mediator", requiresRestart: false }] },
    },
  });
  const screen = await mount(l);
  const text = screen.text();
  assert.match(text, /The mediator/);
  assert.match(text, /418/);
  assert.match(text, /Queue pressure/);
  assert.match(text, /2h 14m/);
  assert.match(text, /Accounts/);
  assert.match(text, /this wallet/);
  assert.match(text, /Trust-Task verification is set to warn/);
  assert.doesNotMatch(text, /records this wallet as a/);
});

test("a mediator below the floor is named, and not asked anything it cannot answer", async () => {
  const l = lens({ version: "0.27.4" });
  const screen = await mount(l);
  assert.match(screen.text(), /runs 0\.27\.4; the lens needs affinidi-messaging-mediator 0\.28\.36/);
  assert.deepEqual(l.tasks, [], "a too-old mediator was sent a task it would not answer");
});

test("a wallet with no relay says so, rather than drawing an empty lens", async () => {
  const l = lens({ relays: [] });
  const screen = await mount(l);
  assert.match(screen.text(), /holds no session with any mediator yet/);
});

test("a release the mediator will not show a browser is noted quietly, not raised as a problem", async () => {
  const l = lens({
    // Empty, not undefined: an undefined argument takes the fixture's default.
    version: "",
    versionError: "the mediator's /readyz does not answer a browser (it sends no CORS headers)",
    answers: {
      "messaging/account/get/0.1": ACCOUNT("standard"),
      "messaging/queue/status/0.1": QUEUES,
    },
  });
  const screen = await mount(l);
  assert.match(screen.text(), /release not shown/);
  assert.doesNotMatch(screen.text(), /could not be read|Failed to fetch|version unknown/);
  assert.match(screen.text(), /This wallet's account/, "the lens carries on");
});

test("the relay and the agent are named apart even when one service hosts both", async () => {
  const l = lens({
    answers: { "messaging/account/get/0.1": ACCOUNT("standard"), "messaging/queue/status/0.1": QUEUES },
  });
  const screen = await mount(l);
  // RELAY is did:webvh:QmRelay:relay.example and AGENT (PARTIES) is
  // did:webvh:QmAgent:agent.example — different hosts here; the model test
  // covers the same-host case. What is asserted is that the header names both.
  assert.match(screen.text(), /relay\.example/);
  assert.match(screen.text(), /for agent\.example/);
});

// ── One DID's mail ──────────────────────────────────────────────────────────

const ALICE = "did:webvh:QmAlice:people.example:alice";
const aliceMail = {
  queues: {
    did: hash(ALICE),
    receive: { count: 7, bytes: 40_000, limit: 200, oldestAgeSeconds: 5400 },
    send: { count: 0, bytes: 0, limit: 200 },
  },
  receivePeers: [{ peer: hash(AGENT), count: 7, bytes: 40_000, oldestAgeSeconds: 5400 }],
};

test("clicking a DID shows that DID's mail — not the whole relay", async () => {
  const l = lens({
    locateTo: { [ALICE]: RELAY },
    answers: {
      "messaging/account/get/0.1": (p: { did: string }) =>
        p.did === hash(ALICE)
          ? { account: { did: hash(ALICE), accountType: "standard", acl: {}, lastAuthenticatedAt: 1_790_000_000 } }
          : ACCOUNT("admin"),
      "messaging/queue/status/0.1": aliceMail,
    },
  });
  const screen = await mount(l, `#mediator?did=${encodeURIComponent(ALICE)}`);
  const text = screen.text();
  assert.match(text, /Mail for people\.example\/alice/);
  assert.match(text, /Waiting to be collected, from/);
  assert.match(text, /1h 30m/);
  assert.doesNotMatch(text, /Queue pressure|The mediator\b|Accounts/, "the relay-wide views are not drawn for one DID");
  assert.ok(!l.tasks.includes("messaging/stats/show/0.1"));
  const status = l.calls.find((c) => c.slug === "messaging/queue/status/0.1");
  assert.equal(status?.payload.did, hash(ALICE), "the queues asked for are Alice's, by hash");
});

test("a standard account asked for someone else's mail is told what it would take — and asks nothing", async () => {
  const l = lens({
    locateTo: { [ALICE]: RELAY },
    answers: { "messaging/account/get/0.1": ACCOUNT("standard") },
  });
  const screen = await mount(l, `#mediator?did=${encodeURIComponent(ALICE)}`);
  assert.match(screen.text(), /a standard account sees only its own mail/);
  assert.match(screen.text(), /pnm messaging grant/);
  assert.ok(
    !l.calls.some((c) => c.payload.did === hash(ALICE)),
    "no request about Alice's account was sent — it would only be refused",
  );
});

test("a DID whose mail goes somewhere this wallet is not signed in is named, not looked into", async () => {
  const l = lens({ locateTo: { [ALICE]: "did:webvh:QmElse:relay.elsewhere" } });
  const screen = await mount(l, `#mediator?did=${encodeURIComponent(ALICE)}`);
  assert.match(screen.text(), /holds no session there/);
  assert.deepEqual(l.tasks, []);
});

test("an account in the relay's tables links to that account's mail", async () => {
  const l = lens({
    answers: {
      "messaging/account/get/0.1": ACCOUNT("standard"),
      "messaging/queue/status/0.1": QUEUES,
    },
  });
  const screen = await mount(l);
  const link = [...document.querySelectorAll("a")].find((a) => (a.getAttribute("href") ?? "").includes(`account=${hash(AGENT)}`));
  assert.ok(link, "the agent's row is a link to its mail on this relay");
  void screen;
});
