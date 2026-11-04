// A refusal, end to end through the page bridge: the background's answer, the
// content script's relay, and the page-world provider's rejection
// (docs/page-bridge-errors.md).
//
// The content script and the provider run here as they run in a tab — one
// window, `window.postMessage` between them — with `chrome.*` played by the
// test. Every `window.vtaWallet.*` rejection is an `Error` named
// `VtaWalletError` with the wallet's message unchanged and a `code`, on every
// channel and on the room-file transfers.

import { test } from "node:test";
import assert from "node:assert/strict";
import { Window } from "happy-dom";

const win = new Window({ url: "https://members.acme.example/elections" });
// A browser window has `origin`; happy-dom's does not, and the content script
// drops any message whose origin is not its window's.
Object.defineProperty(win, "origin", { value: win.location.origin, configurable: true });
for (const [k, v] of Object.entries({ window: win, document: win.document, CustomEvent: win.CustomEvent })) {
  Object.defineProperty(globalThis, k, { value: v, writable: true, configurable: true });
}

/** What the background answers the next `sendMessage`, or throws. */
let answer: () => Promise<unknown> = async () => ({ ok: true, result: null });
const sent: { type: string; params: unknown }[] = [];
/** The background's side of each room-file port the content script opens. */
const ports: { post: (m: unknown) => void; close: () => void; received: unknown[] }[] = [];

Object.defineProperty(globalThis, "chrome", {
  configurable: true,
  value: {
    runtime: {
      getURL: (p: string) => `chrome-extension://wallet/${p}`,
      async sendMessage(m: { type: string; params: unknown }) {
        sent.push(m);
        return answer();
      },
      onMessage: { addListener() {} },
      connect() {
        const listeners: ((m: unknown) => void)[] = [];
        const closers: (() => void)[] = [];
        const port = {
          post: (m: unknown) => listeners.forEach((l) => l(m)),
          close: () => closers.forEach((l) => l()),
          received: [] as unknown[],
        };
        ports.push(port);
        return {
          postMessage: (m: unknown) => port.received.push(m),
          disconnect() {},
          onMessage: { addListener: (l: (m: unknown) => void) => listeners.push(l) },
          onDisconnect: { addListener: (l: () => void) => closers.push(l) },
        };
      },
      lastError: undefined,
    },
    storage: { local: { get: async () => ({}) }, onChanged: { addListener() {} } },
  },
});

await import("../src/content.ts");
await import("../src/provider.ts");

type Rejection = Error & { code?: unknown };
const wallet = () => (win as unknown as { vtaWallet: Record<string, any> }).vtaWallet;

async function rejection(run: () => Promise<unknown>): Promise<Rejection> {
  try {
    await run();
  } catch (e) {
    return e as Rejection;
  }
  throw new Error("expected the call to reject");
}

test("a refusal reaches the page as a VtaWalletError: the message unchanged, the code beside it", async () => {
  answer = async () => ({
    ok: false,
    error: "Acme Guild shows you no such election — it may not be open to you.",
    code: "electionUnknown",
  });
  const e = await rejection(() => wallet().elections.show({ hostDid: "did:webvh:QmHost:acme.example", electionId: "agm-2027" }));
  assert.ok(e instanceof Error);
  assert.equal(e.name, "VtaWalletError");
  assert.equal(e.message, "Acme Guild shows you no such election — it may not be open to you.");
  assert.equal(e.code, "electionUnknown");
});

test("every page channel carries the code the same way", async () => {
  const calls: [string, () => Promise<unknown>][] = [
    ["elections", () => wallet().elections.takeTicket({ hostDid: "did:x:h", electionId: "e1" })],
    ["rooms", () => wallet().rooms.list({ hostDid: "did:x:h" })],
    ["directory", () => wallet().directory.publishCard({ hostDid: "did:x:h" })],
    ["git", () => wallet().git.linkAccount({ hostDid: "did:x:h", forge: "github.com" })],
  ];
  for (const [channel, call] of calls) {
    answer = async () => ({ ok: false, error: "You did not.", code: "declined" });
    const e = await rejection(call);
    assert.equal(e.code, "declined", channel);
    assert.equal(e.message, "You did not.", channel);
  }
});

test("a refusal with no code, or one that is not a single name, is unclassified at the page", async () => {
  for (const code of [undefined, "e.p.msg.forbidden", "eyJhbGciOi.eyJ2YyI6e319.sig", 3]) {
    answer = async () => ({ ok: false, error: "refused", ...(code !== undefined ? { code } : {}) });
    const e = await rejection(() => wallet().elections.list({ hostDid: "did:x:h" }));
    assert.equal(e.code, "unclassified", String(code));
  }
});

test("a worker that does not answer is walletUnavailable", async () => {
  answer = async () => {
    throw new Error("Extension context invalidated.");
  };
  const gone = await rejection(() => wallet().elections.list({ hostDid: "did:x:h" }));
  assert.equal(gone.code, "walletUnavailable");
  assert.equal(gone.message, "Extension context invalidated.");

  answer = async () => undefined;
  assert.equal((await rejection(() => wallet().elections.list({ hostDid: "did:x:h" }))).code, "walletUnavailable");
});

test("a room-file transfer's failure carries its code; a closed port is walletUnavailable", async () => {
  const getting = rejection(() => wallet().rooms.getFile({ hostDid: "did:x:h", roomId: "r1", key: "k" }));
  await new Promise((r) => setTimeout(r, 10));
  ports.at(-1)!.post({ kind: "failed", error: "the file did not verify against the digest its author signed", code: "notVerified" });
  const e = await getting;
  assert.equal(e.name, "VtaWalletError");
  assert.equal(e.code, "notVerified");
  assert.equal(e.message, "the file did not verify against the digest its author signed");

  const putting = rejection(() =>
    wallet().rooms.putFile({ hostDid: "did:x:h", roomId: "r1", name: "a.txt", file: new win.Blob(["x"]) as unknown as Blob }),
  );
  await new Promise((r) => setTimeout(r, 10));
  ports.at(-1)!.close();
  const closed = await putting;
  assert.equal(closed.code, "walletUnavailable");
});
