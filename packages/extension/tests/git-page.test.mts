// A portal page's `window.vtaWallet.git.linkAccount` / `unlinkAccount`.
//
// The gates run here as they run in the background, against fakes for the
// browser and the offscreen document: the page must be the community's portal
// by its DID document, the member must be one of the wallet's own identities
// there, and nothing is signed until the person approves in the wallet's
// window. A link's authorisation page and device code go to the wallet's tab
// and window, never back to the page. Then the core builders and the answer
// checks the offscreen half relies on.

import test from "node:test";
import assert from "node:assert/strict";

import {
  GitPageGates,
  gitPageParamsRefusal,
  type GitConsentView,
  type GitPageDeps,
} from "../src/git-page.ts";
import type { OffscreenGitPageOp } from "../src/bridge-protocol.ts";
import {
  ACCOUNT_LINK,
  ACCOUNT_UNLINK,
  buildAccountLink,
  buildAccountUnlink,
  linkStartedOf,
  unlinkedOf,
} from "@openvtc/pnm-core/vtc";

const HOST = "did:webvh:QmHost:acme.example";
const PORTAL = "https://members.acme.example";
const ENDPOINT = "https://vtc.acme.example/v1/trust-tasks";
const MEMBER = "did:key:z6MkiTBz1ymuepAQ4HEHYSF1H8quG5GLVVQR3djdX3mDooWp";
const OTHER = "did:key:z6MkOtherOtherOtherOtherOtherOtherOtherOther";
const VTA = { vtaDid: "did:webvh:QmVta:vta.example" };

const STARTED = {
  linkId: "lnk_4Tq9Xw2P",
  url: "https://github.com/login/device",
  userCode: "WDJB-MJHT",
  expiresAt: "2026-10-21T12:15:00Z",
};

function harness(opts: { members?: string[]; approve?: boolean; reach?: boolean } = {}) {
  const asked: OffscreenGitPageOp[] = [];
  const prompts: GitConsentView[] = [];
  const opened: string[] = [];
  const deps: GitPageDeps = {
    async active() {
      return { ok: true, vta: VTA };
    },
    async offscreen(_vta, op) {
      asked.push(op);
      switch (op.op) {
        case "portal":
          return { ok: true, result: { portalOrigin: PORTAL, endpoint: ENDPOINT } };
        case "members":
          return {
            ok: true,
            result: (opts.members ?? [MEMBER]).map((did) => ({ did, communityName: "Acme Guild" })),
          };
        case "link":
          return { ok: true, result: STARTED };
        case "unlink":
          return {
            ok: true,
            result: { unlinked: { forge: "github.com", id: "5550123", login: "member-dev" }, unlinkedAt: "2026-10-21T12:00:00Z" },
          };
      }
    },
    async canReach() {
      return opts.reach ?? true;
    },
    async prompt(view) {
      prompts.push(view);
      return { approved: view.kind === "authorise" ? true : (opts.approve ?? true) };
    },
    async openForge(url) {
      opened.push(url);
    },
    now: () => 0,
  };
  return { gates: new GitPageGates(deps), asked, prompts, opened };
}

test("only link and unlink, with a DID, a forge host and nothing else, are calls", () => {
  assert.equal(gitPageParamsRefusal({ op: "linkAccount", hostDid: HOST, forge: "github.com" }), null);
  assert.equal(
    gitPageParamsRefusal({ op: "unlinkAccount", hostDid: HOST, forge: "github.com", accountId: "5550123", member: MEMBER }),
    null,
  );
  assert.ok(gitPageParamsRefusal({ op: "linkAccount", hostDid: HOST, forge: "https://github.com" }), "a host, not a URL");
  assert.ok(gitPageParamsRefusal({ op: "linkAccount", hostDid: HOST, forge: "GitHub.com" }), "lowercase only");
  assert.ok(gitPageParamsRefusal({ op: "linkAccount", hostDid: HOST, forge: "github.com", accountId: "1" }), "link takes no account");
  assert.ok(gitPageParamsRefusal({ op: "linkAccount", hostDid: HOST, forge: "github.com", url: "https://evil" }));
  assert.ok(gitPageParamsRefusal({ op: "grant", hostDid: HOST, forge: "github.com" }));
  assert.ok(gitPageParamsRefusal({ op: "linkAccount", hostDid: "acme", forge: "github.com" }));
  assert.ok(gitPageParamsRefusal(null));
});

test("a page that is not the community's portal is refused before anything is shown or signed", async () => {
  const h = harness();
  const res = await h.gates.handle("https://evil.example", { op: "linkAccount", hostDid: HOST, forge: "github.com" });
  assert.equal(res.ok, false);
  assert.match((res as { error: string }).error, /not .*portal/);
  assert.deepEqual(
    h.asked.map((o) => o.op),
    ["portal"],
  );
  assert.equal(h.prompts.length, 0);
});

test("an endpoint the wallet may not reach is refused before the person is asked", async () => {
  const h = harness({ reach: false });
  const res = await h.gates.handle(PORTAL, { op: "linkAccount", hostDid: HOST, forge: "github.com" });
  assert.equal(res.ok, false);
  assert.equal(h.prompts.length, 0);
});

test("the member is the wallet's: a page cannot name one the wallet does not hold", async () => {
  const h = harness();
  const res = await h.gates.handle(PORTAL, { op: "linkAccount", hostDid: HOST, forge: "github.com", member: OTHER });
  assert.equal(res.ok, false);
  assert.ok(!h.asked.some((o) => o.op === "link"));

  const two = harness({ members: [MEMBER, OTHER] });
  assert.equal((await two.gates.handle(PORTAL, { op: "linkAccount", hostDid: HOST, forge: "github.com" })).ok, false);
  const picked = await two.gates.handle(PORTAL, { op: "linkAccount", hostDid: HOST, forge: "github.com", member: OTHER });
  assert.equal(picked.ok, true);
  assert.equal((two.prompts[0] as { member: string }).member, OTHER);
});

test("a declined prompt signs nothing", async () => {
  const h = harness({ approve: false });
  const link = await h.gates.handle(PORTAL, { op: "linkAccount", hostDid: HOST, forge: "github.com" });
  assert.equal(link.ok, false);
  const unlink = await h.gates.handle(PORTAL, { op: "unlinkAccount", hostDid: HOST, forge: "github.com" });
  assert.equal(unlink.ok, false);
  assert.ok(!h.asked.some((o) => o.op === "link" || o.op === "unlink"));
  assert.equal(h.opened.length, 0);
});

test("approved, a link opens the forge and shows the code in the wallet, and the page gets only the id", async () => {
  const h = harness();
  const res = await h.gates.handle(PORTAL, { op: "linkAccount", hostDid: HOST, forge: "github.com" });
  assert.deepEqual(res, { ok: true, result: { linkId: STARTED.linkId, expiresAt: STARTED.expiresAt } });
  assert.ok(!JSON.stringify(res).includes(STARTED.userCode), "the page never sees the code");
  assert.deepEqual(h.opened, [STARTED.url]);
  assert.deepEqual(
    h.prompts.map((p) => p.kind),
    ["linkAccount", "authorise"],
  );
  const shown = h.prompts[1] as Extract<GitConsentView, { kind: "authorise" }>;
  assert.equal(shown.userCode, STARTED.userCode);
  assert.deepEqual(h.asked.find((o) => o.op === "link"), { op: "link", hostDid: HOST, member: MEMBER, forge: "github.com" });
});

test("approved, an unlink sends the account the page last read", async () => {
  const h = harness();
  const res = await h.gates.handle(PORTAL, { op: "unlinkAccount", hostDid: HOST, forge: "github.com", accountId: "5550123" });
  assert.equal(res.ok, true);
  assert.deepEqual(h.asked.find((o) => o.op === "unlink"), {
    op: "unlink",
    hostDid: HOST,
    member: MEMBER,
    forge: "github.com",
    accountId: "5550123",
  });
});

test("the builders address the member's documents to the community", () => {
  const link = buildAccountLink(MEMBER, HOST, "github.com");
  assert.equal(link.type, ACCOUNT_LINK);
  assert.equal(link.issuer, MEMBER);
  assert.equal(link.recipient, HOST);
  assert.deepEqual(link.payload, { forge: "github.com" });
  assert.equal(buildAccountUnlink(MEMBER, HOST, "github.com").type, ACCOUNT_UNLINK);
  assert.deepEqual(buildAccountUnlink(MEMBER, HOST, "github.com", "7").payload, { forge: "github.com", accountId: "7" });
});

test("a link's answer must name a plain https page to authorise it", () => {
  assert.deepEqual(linkStartedOf(STARTED), STARTED);
  assert.throws(() => linkStartedOf({ ...STARTED, url: "http://github.com/login/device" }));
  assert.throws(() => linkStartedOf({ ...STARTED, url: "javascript:alert(1)" }));
  assert.throws(() => linkStartedOf({ ...STARTED, url: "https://user:pw@github.com/" }));
  assert.throws(() => linkStartedOf({ ...STARTED, linkId: "" }));
  assert.throws(() => unlinkedOf({ unlinkedAt: "2026-10-21T12:00:00Z" }));
});
