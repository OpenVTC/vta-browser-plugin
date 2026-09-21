// The connection store across extension pages.
//
// Every page (popup, setup tab, console) holds its own copy of the persisted
// connection map, and every write replaces the whole blob. A page loaded before
// another page added a VTA used to write its stale map back on its next action,
// and the new VTA vanished from the list. These pin the two halves of the fix:
// a page re-reads when another page writes, and the popup's transport refresh
// no longer drops what the agent said about the wallet.
//
// `chrome` is installed before the dynamic import because `store.ts` wires its
// `storage.onChanged` listener, and reaches `chrome.storage.local`, at module
// scope.

import { strict as assert } from "node:assert";
import { test } from "node:test";

const KEY = "pnm-connection/v3";
const A = "did:key:z6MkjExampleAgentAlphaUsedOnlyInThisTest";
const B = "did:key:z6MkjExampleAgentBetaUsedOnlyInThisTest";

const area: Record<string, unknown> = {};
const listeners: Array<(changes: Record<string, { newValue?: unknown }>, areaName: string) => void> = [];

/** A write by some other extension page: storage changes, then Chrome
 *  notifies every page's listener. */
function writeFromAnotherPage(value: string) {
  area[KEY] = value;
  for (const l of listeners) l({ [KEY]: { newValue: value } }, "local");
}

Object.defineProperty(globalThis, "chrome", {
  value: {
    storage: {
      local: {
        get: (k: string, cb: (i: Record<string, unknown>) => void) => cb({ [k]: area[k] }),
        set: (v: Record<string, unknown>, cb: () => void) => {
          Object.assign(area, v);
          for (const [k, newValue] of Object.entries(v)) for (const l of listeners) l({ [k]: { newValue } }, "local");
          cb();
        },
        remove: (k: string, cb: () => void) => {
          delete area[k];
          cb();
        },
      },
      onChanged: { addListener: (l: (typeof listeners)[number]) => listeners.push(l) },
    },
  },
  writable: true,
  configurable: true,
});

const { useConnectionStore, withRefreshedTransports } = await import("../src/store.js");
const flush = () => new Promise((r) => setTimeout(r, 0));

function conn(vtaDid: string) {
  return { vtaDid, holderDid: `did:key:z6MkjHolderFor${vtaDid.length}`, role: "admin", connectedAt: 1 };
}

test("a page picks up a VTA another page added, and does not write over it", async () => {
  useConnectionStore.getState().setConnection(conn(A));
  await flush();

  // Another page (the setup tab) adds B. This page's in-memory map still
  // holds only A until it re-reads.
  writeFromAnotherPage(
    JSON.stringify({ state: { connections: { activeVtaDid: B, vtas: { [A]: conn(A), [B]: conn(B) } } }, version: 3 }),
  );
  await flush();
  assert.deepEqual(Object.keys(useConnectionStore.getState().connections.vtas).sort(), [A, B].sort());

  // This page's next write — the popup's transport refresh is the real one —
  // must carry B, not replace the map with its old copy.
  useConnectionStore.getState().activateVta(A);
  await flush();
  const persisted = JSON.parse(area[KEY] as string);
  assert.deepEqual(Object.keys(persisted.state.connections.vtas).sort(), [A, B].sort());
});

test("a transport refresh keeps what the agent said about the wallet", () => {
  const current = {
    ...conn(A),
    homeContext: "alpha",
    agentScope: "unrestricted" as const,
    restBaseUrl: "https://old.example/api",
    mediatorDid: "did:web:old-mediator.example",
  };
  const updated = withRefreshedTransports(current, { restBaseUrl: "https://new.example/api" });
  assert.equal(updated.homeContext, "alpha");
  assert.equal(updated.agentScope, "unrestricted");
  assert.equal(updated.restBaseUrl, "https://new.example/api");
  // A transport the VTA stopped advertising is cleared, not kept by a spread.
  assert.equal("mediatorDid" in updated, false);
});
