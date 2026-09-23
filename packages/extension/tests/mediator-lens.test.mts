// The Mediator Lens: which relay the console may look through, what it may run
// there, and how it reaches the offscreen document.
//
// The lens does not prompt per call, like the manager relay, so its limits are
// the whole boundary. Three are pinned here:
//
//  1. It only looks through a session the wallet already holds for its own
//     traffic. Authenticating to a mediator can create an account there, so a
//     console that could name any relay could establish this holder anywhere.
//  2. It runs an allow-list of tasks, and `config/patch` / `config/reload` are
//     not on it — changing a running mediator needs rootAdmin, which this
//     design never grants to a browser-held key.
//  3. Its bridge message is not page-facing and has no route from a page.

import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

import {
  isLensTask,
  knownRelays,
  LENS_TASK_TYPES,
  mayOperateMediator,
} from "../src/mediator-standing.ts";
import {
  ageText,
  bytesText,
  capTape,
  didLabel,
  isTrouble,
  lensHref,
  parseLensRoute,
  pressureOf,
  verificationModeOf,
} from "../src/manager/mediator-lens-model.ts";
import { pageTaskRefusal } from "../src/page-task-policy.ts";

const INBOX = "did:webvh:QmInbox:relay.example";
const OTHER = "did:webvh:QmOther:relay.elsewhere";
const AGENT = "did:webvh:QmAgent:agent.example";
const AGENT2 = "did:webvh:QmAgent2:agent2.example";

// ── standing ────────────────────────────────────────────────────────────────

test("an agent's inbox may be looked through, as that agent's holder", () => {
  const d = mayOperateMediator(
    { mediatorDid: INBOX, vtaDid: AGENT },
    { inboxes: { [AGENT]: { did: INBOX } }, pooled: [] },
  );
  assert.deepEqual(d, { ok: true, isInbox: true });
});

test("a relay the wallet dials for that agent may be looked through, as an outbound hop", () => {
  const d = mayOperateMediator(
    { mediatorDid: OTHER, vtaDid: AGENT },
    { inboxes: { [AGENT]: { did: INBOX } }, pooled: [{ mediatorDid: OTHER, vtaDid: AGENT }] },
  );
  assert.deepEqual(d, { ok: true, isInbox: false });
});

test("a relay the wallet does not use is refused — the lens never signs in somewhere new", () => {
  const d = mayOperateMediator(
    { mediatorDid: OTHER, vtaDid: AGENT },
    { inboxes: { [AGENT]: { did: INBOX } }, pooled: [] },
  );
  assert.equal(d.ok, false);
  assert.equal(!d.ok && d.code, "mediator/no-standing");
});

test("standing is per (relay, agent) pair — another agent's inbox is not this one's", () => {
  // The same mediator can be one agent's inbox and nothing to another; looking
  // through it as the second agent's holder would authenticate a holder that
  // has never been there.
  const d = mayOperateMediator(
    { mediatorDid: INBOX, vtaDid: AGENT2 },
    { inboxes: { [AGENT]: { did: INBOX } }, pooled: [{ mediatorDid: INBOX, vtaDid: AGENT }] },
  );
  assert.equal(d.ok, false);
});

test("known relays list each pair once, inboxes first", () => {
  const list = knownRelays(
    {
      inboxes: { [AGENT]: { did: INBOX } },
      pooled: [
        { mediatorDid: OTHER, vtaDid: AGENT },
        { mediatorDid: INBOX, vtaDid: AGENT },
      ],
    },
    (p) => (p.mediatorDid === INBOX ? "live" : undefined),
  );
  assert.deepEqual(
    list.map((r) => [r.mediatorDid, r.isInbox, r.state]),
    [
      [INBOX, true, "live"],
      [OTHER, false, "closed"],
    ],
  );
});

// ── what may run ────────────────────────────────────────────────────────────

test("the lens does not run anything that changes a running mediator", () => {
  assert.equal(isLensTask("https://trusttasks.org/spec/config/patch/0.1"), false);
  assert.equal(isLensTask("https://trusttasks.org/spec/config/reload/0.1"), false);
  assert.equal(isLensTask("https://trusttasks.org/spec/config/show/0.1"), true);
});

test("the lens does not fetch stored envelopes — the wallet's own mail arrives through its inbox", () => {
  assert.equal(isLensTask("https://trusttasks.org/spec/messaging/message/get/0.1"), false);
});

test("an agent-side task is not something the lens will carry to a mediator", () => {
  assert.equal(isLensTask("https://trusttasks.org/spec/acl/grant/0.1"), false);
});

test("the monitor is not on the task allow-list — its lease is owned by the offscreen port", () => {
  // A console that could subscribe through the task relay would hold a lease
  // nothing releases when the tab closes.
  assert.ok(!LENS_TASK_TYPES.some((u) => u.includes("/monitor/")));
});

test("a page may not request any messaging/* task", () => {
  for (const t of [
    "https://trusttasks.org/spec/messaging/monitor/subscribe/0.1",
    "https://trusttasks.org/spec/messaging/queue/list/0.1",
    "https://trusttasks.org/spec/messaging/account/get/0.1",
  ]) {
    assert.match(pageTaskRefusal(t) ?? "", /cannot be requested by a page/, t);
  }
});

// ── the bridge ──────────────────────────────────────────────────────────────

const src = (name: string) =>
  readFileSync(fileURLToPath(new URL(`../src/${name}`, import.meta.url)), "utf8");

test("the lens relay is neither page-facing nor routable from the content script", () => {
  const protocol = src("bridge-protocol.ts");
  assert.match(protocol, /export const RUNTIME_MEDIATOR = "vta-wallet\/mediator-lens"/);
  const m = /export const PAGE_FACING_RUNTIME_TYPES = \[([^\]]*)\]/.exec(protocol);
  assert.ok(m);
  assert.ok(!/\bRUNTIME_MEDIATOR\b(?!_)/.test(m[1]!), "RUNTIME_MEDIATOR is listed as page-facing");
  const content = src("content.ts");
  assert.ok(!content.includes("vta-wallet/mediator-lens"), "content.ts routes to the lens relay");
});

test("the background gates the lens relay on an extension-page sender before forwarding", () => {
  const background = src("background.ts");
  const branch = /type === RUNTIME_MEDIATOR\)\s*\{([\s\S]*?)OFFSCREEN_MEDIATOR/.exec(background);
  assert.ok(branch, "no dispatch branch for RUNTIME_MEDIATOR");
  assert.match(branch[1]!, /if \(!isExtensionPageSender\(sender\)\)/);
});

test("the offscreen document gates the monitor port on an extension-page sender", () => {
  const offscreen = src("offscreen.ts");
  assert.match(
    offscreen,
    /port\.name !== MEDIATOR_MONITOR_PORT\)[\s\S]{0,80}?if \(!isExtensionPagePort\(port\)\)/,
  );
  assert.match(offscreen, /function isExtensionPagePort[\s\S]{0,120}?isExtensionContextSender\(port\.sender/);
  assert.match(
    offscreen,
    /function isExtensionContextSender[\s\S]{0,200}?chrome\.runtime\.getURL\(""\)[\s\S]{0,120}?startsWith/,
  );
});

test("the offscreen document checks the allow-list and the standing before any mediator is asked", () => {
  const offscreen = src("offscreen.ts");
  const task = /case "task": \{([\s\S]*?)channel\.send/.exec(offscreen);
  assert.ok(task);
  assert.match(task[1]!, /isLensTask\(op\.params\.type\)/);
  assert.match(task[1]!, /lensSession\(/);
  assert.match(
    /async function lensSession[\s\S]*?getWarmSession/.exec(offscreen)?.[0] ?? "",
    /mayOperateMediator\([\s\S]*?if \(!decision\.ok\) throw/,
    "a session is opened before the standing is decided",
  );
});

test("monitor batches never touch the inbound pending store", () => {
  // They are live-only telemetry the mediator never stores, so there is nothing
  // for persist-before-ack to protect — and writing one to IndexedDB every
  // second is the cost it would have. They arrive through `onMediatorFrame`.
  const offscreen = src("offscreen.ts");
  const run = /async function runMonitor[\s\S]*?\n\}/.exec(offscreen)?.[0] ?? "";
  assert.match(run, /conn\.onMediatorFrame\(/);
  assert.ok(!/putPendingInbound|onInboundMessage/.test(run));
});

// ── the model ───────────────────────────────────────────────────────────────

test("a lens route round-trips through the hash, DIDs and all", () => {
  const route = { mediatorDid: INBOX, vtaDid: AGENT };
  assert.deepEqual(parseLensRoute(lensHref(route)), route);
  assert.deepEqual(parseLensRoute(lensHref({ did: "did:key:z6Mk?x=1" })), { did: "did:key:z6Mk?x=1" });
  const account = "a".repeat(64);
  assert.deepEqual(parseLensRoute(lensHref({ ...route, account })), { ...route, account });
  // Only a hash is an account: anything else in that slot is dropped, not sent.
  assert.deepEqual(parseLensRoute("#mediator?account=did:key:x"), {});
  assert.deepEqual(parseLensRoute("#mediator"), {});
});

test("ages and sizes read the way a person says them", () => {
  assert.equal(ageText(40), "40s");
  assert.equal(ageText(18 * 60), "18m");
  assert.equal(ageText(2 * 3600 + 14 * 60), "2h 14m");
  assert.equal(ageText(5 * 86400), "5d");
  assert.equal(ageText(undefined), "—");
  assert.equal(bytesText(512), "512 B");
  assert.equal(bytesText(20_992), "20.5 KB");
});

test("an unlimited queue has its own pressure — not ok, not empty", () => {
  assert.equal(pressureOf(undefined), "unlimited");
  assert.equal(pressureOf(0.2), "ok");
  assert.equal(pressureOf(0.71), "warn");
  assert.equal(pressureOf(0.95), "danger");
});

test("refused, expired and anything with an outcome is trouble", () => {
  assert.equal(isTrouble({ stage: "refused" }), true);
  assert.equal(isTrouble({ stage: "expired" }), true);
  assert.equal(isTrouble({ stage: "delivered", outcome: { code: "x" } }), true);
  assert.equal(isTrouble({ stage: "delivered" }), false);
});

test("the tape keeps the newest lines", () => {
  assert.deepEqual(capTape([1, 2, 3], [4, 5], 3), [3, 4, 5]);
});

test("verification mode is read from config, and anything else is unknown", () => {
  assert.equal(verificationModeOf([{ key: "security.trust_task_verification", value: "warn" }]), "warn");
  assert.equal(verificationModeOf([{ key: "security.trust_task_verification", value: "enforce" }]), "enforce");
  assert.equal(verificationModeOf([]), "unknown");
  assert.equal(verificationModeOf(undefined), "unknown");
});

test("the offscreen document re-checks the sender for a lens op — a content script reaches it directly", () => {
  const offscreen = src("offscreen.ts");
  const branch = /msg\.type === OFFSCREEN_MEDIATOR\)\s*\{([\s\S]*?)doMediatorOp/.exec(offscreen);
  assert.ok(branch);
  assert.match(branch[1]!, /if \(!isExtensionContextSender\(sender\)\)/);
});

test("a monitor port's disconnect is heard before the session handshake, not after it", () => {
  // Chrome does not replay a disconnect to a listener added later; a console
  // closed during the handshake would otherwise leave a lease renewing forever.
  const offscreen = src("offscreen.ts");
  const onConnect = /port\.name !== MEDIATOR_MONITOR_PORT[\s\S]*?void runMonitor/.exec(offscreen)?.[0] ?? "";
  assert.match(onConnect, /port\.onDisconnect\.addListener/);
});

test("a purge commits the plan the person was shown, not a fresh preview", () => {
  const pane = src("manager/panes/mediator.tsx");
  const commit = /commit=\{async \(\) => \{([\s\S]*?)\}\}/.exec(pane)?.[1] ?? "";
  assert.match(commit, /shown\.current/);
  assert.doesNotMatch(commit, /purgePreview\(/, "re-previewing in commit compares two fresh counts and always passes");
});

test("a DID is named by host AND path, so a relay and an agent on one host read differently", () => {
  assert.equal(didLabel("did:webvh:QmA:webvh.storm.ws:mediator"), "webvh.storm.ws/mediator");
  assert.equal(didLabel("did:webvh:QmB:webvh.storm.ws:agents:keyring"), "webvh.storm.ws/agents/keyring");
  assert.equal(didLabel("did:webvh:QmC:localhost%3A8080"), "localhost:8080");
  assert.notEqual(
    didLabel("did:webvh:QmA:webvh.storm.ws:mediator"),
    didLabel("did:webvh:QmB:webvh.storm.ws:agent"),
  );
  assert.match(didLabel("did:key:z6MkhaXgBZDvotDkL5257faiztiGiC2QtKLGpbnnEGta2doK"), /^did:key:z6Mkha\w*…\w*a2doK$/);
});
