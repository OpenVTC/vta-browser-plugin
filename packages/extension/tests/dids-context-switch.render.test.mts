// Changing context blanks the DID list at once, and a reload does not.
//
// `useAsync` used to hold the previous answer until the next one arrived, for
// every re-fetch alike. After a delete that is right — the list the operator is
// reading should not jump. After a context switch it drew the old context's
// DIDs under the new context's heading until the agent replied, which read as
// the console answering the wrong question. Both halves are pinned, because
// the obvious fix for one breaks the other.

import { test } from "node:test";
import assert from "node:assert/strict";
import { agent, h, render, PARTIES, asSummary } from "./harness/dom.mjs";
import { DidsPane } from "../src/manager/panes/dids.js";

const LIST = "vta/dids/list/0.1";
const SERVERS = "vta/webvh/servers/list/1.0";

const record = (contextId: string, name: string) => ({
  did: `did:webvh:QmScid${name}:example.com:${name}`,
  serverId: "prod",
  scid: `QmScid${name}`,
  contextId,
  portable: false,
  logEntryCount: 1,
  preRotationCount: 0,
  createdAt: "2026-09-11T00:00:00Z",
  updatedAt: "2026-09-11T00:00:00Z",
});

/** A fake agent whose listing for `held` does not answer until released. */
const gatedAgent = (held: string) => {
  const a = agent({
    [LIST]: (p: { contextId?: string }) => ({
      dids: [record(p.contextId ?? "", p.contextId === "alpha" ? "alphadid" : "betadid")].map(asSummary),
    }),
    [SERVERS]: { servers: [] },
  });
  let release!: () => void;
  const gate = new Promise<void>((r) => (release = r));
  const sendMessage = async (m: { params?: { type?: string; payload?: { contextId?: string } } }) => {
    if (m.params?.type?.endsWith(LIST) && m.params.payload?.contextId === held) await gate;
    return a.sendMessage(m);
  };
  return { a, sendMessage, release };
};

const pane = (contextId: string) =>
  h(DidsPane, { parties: PARTIES, authority: null, contextId } as never);

test("switching context clears the previous context's DIDs while the new list loads", async () => {
  const g = gatedAgent("beta");
  const screen = await render(pane("alpha"), { chrome: { runtime: { sendMessage: g.sendMessage } } });
  await screen.settle();
  assert.match(screen.text(), /alphadid/);

  await screen.rerender(pane("beta"));
  assert.doesNotMatch(screen.text(), /alphadid/, "alpha's DIDs stayed on screen under beta");
  assert.match(screen.text(), /Reading DIDs/);

  g.release();
  await screen.settle();
  assert.match(screen.text(), /betadid/);
  assert.doesNotMatch(screen.text(), /Reading DIDs/);
  await screen.unmount();
});

test("a failed listing for the new context does not resurrect the old one as stale", async () => {
  const a = agent({ [LIST]: { dids: [record("alpha", "alphadid")].map(asSummary) }, [SERVERS]: { servers: [] } });
  const sendMessage = async (m: { params?: { type?: string; payload?: { contextId?: string } } }) => {
    if (m.params?.type?.endsWith(LIST) && m.params.payload?.contextId === "beta") {
      throw new Error("agent unreachable");
    }
    return a.sendMessage(m);
  };
  const screen = await render(pane("alpha"), { chrome: { runtime: { sendMessage } } });
  await screen.settle();
  await screen.rerender(pane("beta"));
  await screen.settle();
  assert.doesNotMatch(screen.text(), /alphadid/);
  await screen.unmount();
});

test("a did:webs, a did:key and a did:webvh are one table, told apart by method", async () => {
  // A KERI-enabled agent's identities are did:webs, which the webvh listing
  // does not hold; this pane used to say "No DIDs you can reach" over them.
  const a = agent({
    [LIST]: {
      dids: [
        {
          ...asSummary({ did: "did:webs:host.example:nodes:EKeriNode", contextId: "vta" }),
          primary: true,
          methodDetails: { webs: { aid: "EKeriNode", sequenceNumber: 0 } },
        },
        asSummary({ did: "did:key:z6MkHolder", contextId: "vta" }),
        asSummary(record("vta", "webvhone")),
      ],
    },
    [SERVERS]: { servers: [] },
  });
  const screen = await render(pane("vta"), { chrome: { runtime: { sendMessage: a.sendMessage } } });
  await screen.settle();
  const text = screen.text();
  assert.match(text, /EKeriNode/);
  assert.match(text, /webvhone/);
  assert.match(text, /context DID/);
  for (const m of ["webs", "key", "webvh"]) assert.match(text, new RegExp(`\\b${m}\\b`));
  // Only the did:webvh row offers the webvh family's actions.
  assert.equal(screen.all("button").filter((b) => b.textContent === "Delete").length, 1);
  await screen.unmount();
});
