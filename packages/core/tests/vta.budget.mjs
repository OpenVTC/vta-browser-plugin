// The relay budget: a task the VTA answers by waiting on a third party must be
// given longer than the VTA can spend on it, or its real answer arrives after
// the wallet has stopped listening. Observed live: a did:webvh created from the
// manager "timed out" at 30s while the VTA's recovered answer (it had to
// re-form the TSP relationship with the hosting server) came back at 30.07s.

import { test } from "node:test";
import assert from "node:assert/strict";

import { ed25519 } from "@noble/curves/ed25519.js";

import {
  TspChannel,
  RELAYS_ONWARD,
  TSP_REPLY_TIMEOUT_MS,
  clientBudgetMs,
  minRelayBudgetMs,
  relayWorstCaseMs,
} from "../dist/index.js";

const DIDS_CREATE = "https://trusttasks.org/spec/vta/webvh/dids/create/1.0";
const LOCAL_TASK = "https://trusttasks.org/spec/vta/keys/list/0.1";

test("the budget outlasts the VTA's worst case: both TSP windows and the re-form", () => {
  assert.ok(relayWorstCaseMs() >= 2 * TSP_REPLY_TIMEOUT_MS);
  assert.ok(minRelayBudgetMs() > relayWorstCaseMs());
  // The numbers vta_sdk::budget derives; a drift here is a drift between the
  // two ends of the same conversation.
  assert.equal(minRelayBudgetMs(), 80_000);
});

test("the task that failed in the field now outlasts the VTA", () => {
  assert.ok(clientBudgetMs(DIDS_CREATE, 30_000) > relayWorstCaseMs());
});

test("every relaying task is raised, whatever it asked for", () => {
  // The Rust list less the three tasks this wallet never sends, and the two
  // console-only services tasks, which `admin/services.ts` budgets itself.
  assert.equal(RELAYS_ONWARD.size, 20);
  for (const type of RELAYS_ONWARD) {
    for (const requested of [1, 30_000, 60_000]) {
      assert.ok(
        clientBudgetMs(type, requested) > relayWorstCaseMs(),
        `${type} asked ${requested}ms and still cannot outlast the VTA`,
      );
    }
  }
});

test("the clamp never shortens a budget, and leaves local tasks alone", () => {
  const generous = minRelayBudgetMs() + 600_000;
  assert.equal(clientBudgetMs(DIDS_CREATE, generous), generous);
  assert.equal(clientBudgetMs(LOCAL_TASK, 30_000), 30_000);
});

// ── the channel applies it ──────────────────────────────────────────────────

const HOLDER = {
  vid: "did:key:zHolder",
  signingPrivateKey: new Uint8Array(32).fill(1),
  encryptionPrivateKey: new Uint8Array(32).fill(2),
  encryptionPublicKey: new Uint8Array(32).fill(3),
};
const SIGNING = (() => {
  const privateKey = ed25519.utils.randomSecretKey();
  return {
    did: HOLDER.vid,
    kid: `${HOLDER.vid}#key-2`,
    privateKey,
    publicKey: ed25519.getPublicKey(privateKey),
  };
})();
const VTA = {
  vid: "did:webvh:QmAgent:agent.example",
  encryptionPublicKey: new Uint8Array(32).fill(4),
  signingPublicKey: new Uint8Array(32).fill(5),
};

/** The timeout a TSP channel hands its transport for `type`. The transport
 *  records it and fails, which is all the send needs to get that far. */
async function tspTimeoutFor(type, channelTimeoutMs) {
  let seen;
  const transport = {
    async sendAndAwaitReply(_bytes, opts) {
      seen = opts.timeoutMs;
      throw new Error("recorded");
    },
  };
  const channel = new TspChannel({
    transport,
    holder: HOLDER,
    signing: SIGNING,
    vta: VTA,
    ...(channelTimeoutMs !== undefined ? { timeoutMs: channelTimeoutMs } : {}),
  });
  await channel.send({ id: "req-1", type, recipient: VTA.vid, payload: {} }).catch(() => {});
  return seen;
}

test("the TSP channel gives a relayed task the relay budget, not its 30s default", async () => {
  assert.equal(await tspTimeoutFor(DIDS_CREATE), minRelayBudgetMs());
});

test("the TSP channel keeps its default for a task the VTA serves itself", async () => {
  assert.equal(await tspTimeoutFor(LOCAL_TASK), 30_000);
});

test("a longer channel budget is kept for a relayed task", async () => {
  assert.equal(await tspTimeoutFor(DIDS_CREATE, 300_000), 300_000);
});
