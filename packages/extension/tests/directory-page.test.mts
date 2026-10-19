// A portal page's `window.vtaWallet.directory.publishCard`.
//
// The gates run here as they run in the background, against fakes for the
// browser and the offscreen document: the page must be the community's portal
// by its DID document, the member must be one of the wallet's own identities
// there, and nothing is signed until the person approves every value in the
// wallet's window. Then the offscreen half: whose card it reads, and that it
// refuses to sign when the agent holds no key for the member.

import test from "node:test";
import assert from "node:assert/strict";

import {
  DirectoryPageGates,
  directoryPageParamsRefusal,
  type DirectoryPageDeps,
  type DirectoryPublishConsentView,
} from "../src/directory-page.ts";
import { identitiesAt, runDirectoryPageOp } from "../src/directory-page-offscreen.ts";
import type { OffscreenDirectoryPageOp } from "../src/bridge-protocol.ts";

const HOST = "did:webvh:QmHost:acme.example";
const PORTAL = "https://members.acme.example";
const ENDPOINT = "https://vtc.acme.example/v1/trust-tasks";
const MEMBER = "did:key:z6MkiTBz1ymuepAQ4HEHYSF1H8quG5GLVVQR3djdX3mDooWp";
const OTHER = "did:key:z6MkOtherOtherOtherOtherOtherOtherOtherOther";
const VTA = { vtaDid: "did:webvh:QmVta:vta.example" };

const CARD = { "@type": "Card", version: "1.0", uid: "urn:vtc-directory:dir_x", issuer: MEMBER, name: { full: "C" } };

function harness(opts: { members?: string[]; approve?: boolean; reach?: boolean } = {}) {
  const asked: OffscreenDirectoryPageOp[] = [];
  const prompts: DirectoryPublishConsentView[] = [];
  const deps: DirectoryPageDeps = {
    async active() {
      return { ok: true, vta: VTA };
    },
    async offscreen(_vta, op) {
      asked.push(op);
      switch (op.op) {
        case "portal":
          return { ok: true, result: { portalOrigin: PORTAL, endpoint: ENDPOINT } };
        case "members":
          return { ok: true, result: opts.members ?? [MEMBER] };
        case "prepare":
          return {
            ok: true,
            result: {
              card: CARD,
              revision: 4,
              communityName: "Acme Guild",
              said: { meaning: ["Anyone will be able to read it."], values: ["Name: C"], closing: "..." },
            },
          };
        case "publish":
          return { ok: true, result: { state: "published", cardDigest: "zQmX" } };
      }
    },
    async canReach() {
      return opts.reach ?? true;
    },
    async prompt(view) {
      prompts.push(view);
      return { approved: opts.approve ?? true };
    },
    now: () => 0,
  };
  return { gates: new DirectoryPageGates(deps), asked, prompts };
}

test("only publishCard, with a DID and nothing else, is a call", () => {
  assert.equal(directoryPageParamsRefusal({ op: "publishCard", hostDid: HOST }), null);
  assert.equal(directoryPageParamsRefusal({ op: "publishCard", hostDid: HOST, member: MEMBER }), null);
  assert.ok(directoryPageParamsRefusal({ op: "publishCard", hostDid: "acme" }));
  assert.ok(directoryPageParamsRefusal({ op: "publishCard", hostDid: HOST, card: CARD }), "no card from the page");
  assert.ok(directoryPageParamsRefusal({ op: "deleteCard", hostDid: HOST }));
  assert.ok(directoryPageParamsRefusal(null));
});

test("a page that is not the community's portal is refused before anything is read or shown", async () => {
  const h = harness();
  const res = await h.gates.handle("https://evil.example", { op: "publishCard", hostDid: HOST });
  assert.equal(res.ok, false);
  assert.match((res as { error: string }).error, /not .*portal/);
  assert.deepEqual(
    h.asked.map((o) => o.op),
    ["portal"],
  );
  assert.equal(h.prompts.length, 0);
});

test("an endpoint the wallet may not reach is refused before the card is read", async () => {
  const h = harness({ reach: false });
  const res = await h.gates.handle(PORTAL, { op: "publishCard", hostDid: HOST });
  assert.equal(res.ok, false);
  assert.ok(!h.asked.some((o) => o.op === "prepare"));
});

test("the member is the wallet's: a page cannot name one the wallet does not hold", async () => {
  const h = harness();
  const res = await h.gates.handle(PORTAL, { op: "publishCard", hostDid: HOST, member: OTHER });
  assert.equal(res.ok, false);
  assert.ok(!h.asked.some((o) => o.op === "prepare"));

  const two = harness({ members: [MEMBER, OTHER] });
  const ambiguous = await two.gates.handle(PORTAL, { op: "publishCard", hostDid: HOST });
  assert.equal(ambiguous.ok, false, "with two identities and no hint, nothing is chosen for the person");
  const picked = await two.gates.handle(PORTAL, { op: "publishCard", hostDid: HOST, member: OTHER });
  assert.equal(picked.ok, true);
  assert.equal(two.prompts[0]?.member, OTHER);

  const none = harness({ members: [] });
  assert.equal((await none.gates.handle(PORTAL, { op: "publishCard", hostDid: HOST })).ok, false);
});

test("a declined prompt publishes nothing", async () => {
  const h = harness({ approve: false });
  const res = await h.gates.handle(PORTAL, { op: "publishCard", hostDid: HOST });
  assert.equal(res.ok, false);
  assert.equal(h.prompts.length, 1);
  assert.ok(!h.asked.some((o) => o.op === "publish"));
});

test("approved, the card the wallet built is published, never one from the page", async () => {
  const h = harness();
  const res = await h.gates.handle(PORTAL, { op: "publishCard", hostDid: HOST });
  assert.deepEqual(res, { ok: true, result: { state: "published", cardDigest: "zQmX" } });
  const prompt = h.prompts[0]!;
  assert.equal(prompt.origin, PORTAL);
  assert.equal(prompt.communityName, "Acme Guild");
  assert.deepEqual(prompt.values, ["Name: C"]);
  const publish = h.asked.find((o) => o.op === "publish");
  assert.deepEqual(publish, { op: "publish", hostDid: HOST, member: MEMBER, card: CARD, revision: 4 });
});

test("the identities at a community are the wallet's entries for it, never the community itself", () => {
  const entries = [
    { id: "e1", principalDid: MEMBER, targets: [{ kind: "did", did: HOST }] },
    { id: "e2", principalDid: OTHER, targets: [{ kind: "did", did: "did:example:elsewhere" }] },
    { id: "e3", principalDid: HOST, targets: [{ kind: "did", did: HOST }] },
    { id: "e4", targets: [{ kind: "did", did: HOST }] },
  ];
  assert.deepEqual(
    identitiesAt(entries, HOST).map((e) => e.id),
    ["e1"],
  );
});

test("the offscreen half refuses to sign when the agent holds no key the member's DID lists", async () => {
  const sent: string[] = [];
  const sender = {
    async send(envelope: { type: string }) {
      sent.push(envelope.type);
      // keys/list: one active key, not the member's.
      return {
        keys: [
          {
            keyId: "k1",
            keyType: "ed25519",
            status: "active",
            publicKey: "z6MkhaXgBZDvotDkL5257faiztiGiC2QtKLGpbnnEGta2doK",
            createdAt: "2026-01-01T00:00:00Z",
          },
        ],
        total: 1,
      };
    },
  };
  await assert.rejects(
    runDirectoryPageOp(
      {
        agent: async () => ({ sender: sender as never, holder: { did: "did:key:zHolder" } as never, service: { did: VTA.vtaDid } as never }),
        identities: async () => [{ id: "e1", label: "Acme Guild", principalDid: MEMBER, targets: [{ kind: "did", did: HOST }] }],
        community: async () => ({ portalOrigin: PORTAL, endpoint: ENDPOINT, document: {} }),
      },
      VTA,
      { op: "publish", hostDid: HOST, member: MEMBER, card: CARD, revision: 4 },
    ),
    /doesn't hold the key/,
  );
  assert.deepEqual(sent, ["https://trusttasks.org/spec/keys/list/0.1"], "nothing was signed");
});
