// A portal page's `window.vtaWallet.directory.publishCard`.
//
// The gates run here as they run in the background, against fakes for the
// browser and the offscreen document: the page must be the community's portal
// by its DID document, the member must be one of the wallet's own identities
// there, and nothing is signed until the person approves every value in the
// wallet's window. Then the offscreen half: whose card it reads, and that it
// refuses to sign when the agent holds no key for the member. And
// `presentCredential`: the person picks the credential from those offered and
// sees every claim, and is asked again before a credential that cannot hide the
// rest is presented.

import test from "node:test";
import assert from "node:assert/strict";

import {
  DirectoryPageGates,
  directoryPageParamsRefusal,
  type DirectoryConsentView,
  type DirectoryPageDeps,
  type DirectoryPresentConsentView,
  type DirectoryPublishConsentView,
  type MarksGrant,
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

const FIELD = "org.example.employer";
const CRED = "cred-7f3a91c2";
const VERIFIED = {
  verified: {
    [FIELD]: { value: "Acme", issuer: "did:example:hr", credentialType: "EmploymentCredential", verifiedAt: "2026-10-22T09:00:00Z" },
  },
  revision: 5,
};

function harness(
  opts: {
    members?: string[];
    approve?: boolean;
    reach?: boolean;
    grant?: MarksGrant;
    /** Per prompt, in order: what the person answers. */
    answers?: Array<{ approved: boolean; selectedCredential?: string }>;
    /** Claims the credential cannot hide unless named. */
    undisclosed?: string[];
  } = {},
) {
  const asked: OffscreenDirectoryPageOp[] = [];
  const prompts: DirectoryConsentView[] = [];
  const grants = new Map<string, MarksGrant>(opts.grant ? [[opts.grant.hostDid, opts.grant]] : []);
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
        case "communityName":
          return { ok: true, result: "Acme Guild" };
        case "marks":
          return { ok: true, result: { entries: { dir_a: { starred: true } }, lists: [] } };
        case "mark":
          return { ok: true, result: { starred: op.starred ?? false } };
        case "putList":
          return { ok: true, result: { listId: "L1", name: op.name ?? "", order: 0, contactCount: 0 } };
        case "deleteList":
          return { ok: true, result: { deleted: true } };
        case "preparePresent":
          return {
            ok: true,
            result: {
              communityName: "Acme Guild",
              fields: [{ key: FIELD, label: "Employer" }],
              claims: ["employer"],
              candidates: [{ id: CRED, issuerDid: "did:example:hr", types: ["VerifiableCredential", "EmploymentCredential"] }],
            },
          };
        case "present": {
          const hidden = (opts.undisclosed ?? []).filter((c) => !op.claims.includes(c));
          return { ok: true, result: hidden.length > 0 ? { undisclosed: hidden } : VERIFIED };
        }
      }
    },
    async marksGrant(hostDid) {
      return grants.get(hostDid) ?? null;
    },
    async saveMarksGrant(g) {
      grants.set(g.hostDid, g);
    },
    async canReach() {
      return opts.reach ?? true;
    },
    async prompt(view) {
      prompts.push(view);
      const answer = opts.answers?.[prompts.length - 1];
      return answer ?? { approved: opts.approve ?? true };
    },
    now: () => 0,
  };
  return { gates: new DirectoryPageGates(deps), asked, prompts, grants };
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
  assert.equal((two.prompts[0] as DirectoryPublishConsentView).member, OTHER);

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
  const prompt = h.prompts[0] as DirectoryPublishConsentView;
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
  assert.deepEqual(sent, ["https://trusttasks.org/spec/keys/list/0.2"], "nothing was signed");
});

// ─── The member's own marks ────────────────────────────────────────────────

test("a marks call takes only its own members, well formed", () => {
  assert.equal(directoryPageParamsRefusal({ op: "marks", hostDid: HOST }), null);
  assert.equal(directoryPageParamsRefusal({ op: "mark", hostDid: HOST, entryId: "dir_a", starred: true }), null);
  assert.equal(directoryPageParamsRefusal({ op: "mark", hostDid: HOST, entryId: "dir_a", lists: [] }), null);
  assert.ok(directoryPageParamsRefusal({ op: "mark", hostDid: HOST, entryId: "dir_a" }), "a mark that changes nothing");
  assert.ok(directoryPageParamsRefusal({ op: "mark", hostDid: HOST, entryId: "../x", starred: true }));
  assert.ok(
    directoryPageParamsRefusal({ op: "mark", hostDid: HOST, entryId: "dir_a", petname: "a\nb" }),
    "a petname is one line",
  );
  assert.ok(
    directoryPageParamsRefusal({ op: "mark", hostDid: HOST, entryId: "dir_a", petname: "x", removePetname: true }),
  );
  assert.ok(directoryPageParamsRefusal({ op: "mark", hostDid: HOST, entryId: "dir_a", starred: true, subjectDid: MEMBER }));
  assert.ok(directoryPageParamsRefusal({ op: "putList", hostDid: HOST }), "a new list has a name");
  assert.ok(directoryPageParamsRefusal({ op: "putList", hostDid: HOST, name: "M", colour: "red" }));
  assert.equal(directoryPageParamsRefusal({ op: "putList", hostDid: HOST, name: "Mentors", colour: "#1f8a70" }), null);
  assert.ok(directoryPageParamsRefusal({ op: "deleteList", hostDid: HOST }));
});

test("the first marks call from a community asks once; the answer is kept for that portal", async () => {
  const h = harness();
  const first = await h.gates.handle(PORTAL, { op: "marks", hostDid: HOST });
  assert.deepEqual(first, { ok: true, result: { entries: { dir_a: { starred: true } }, lists: [] } });
  assert.equal(h.prompts.length, 1);
  assert.deepEqual(h.prompts[0], { kind: "marksAccess", origin: PORTAL, hostDid: HOST, communityName: "Acme Guild" });
  assert.equal(h.grants.get(HOST)?.portalOrigin, PORTAL);

  const again = await h.gates.handle(PORTAL, { op: "mark", hostDid: HOST, entryId: "dir_a", starred: false });
  assert.equal(again.ok, true);
  assert.equal(h.prompts.length, 1, "not asked again");
  assert.deepEqual(h.asked.at(-1), { op: "mark", hostDid: HOST, member: MEMBER, entryId: "dir_a", starred: false });
});

test("a declined ask hands the portal nothing, and keeps no answer", async () => {
  const h = harness({ approve: false });
  const res = await h.gates.handle(PORTAL, { op: "marks", hostDid: HOST });
  assert.equal(res.ok, false);
  assert.match((res as { error: string }).error, /did not let/);
  assert.ok(!h.asked.some((o) => o.op === "marks"));
  assert.equal(h.grants.size, 0);
});

test("leave given to one portal origin is asked afresh from another, and never from a page that is not the portal", async () => {
  const h = harness({ grant: { hostDid: HOST, portalOrigin: "https://old.acme.example", communityName: "Acme", grantedAt: 0 } });
  await h.gates.handle(PORTAL, { op: "marks", hostDid: HOST });
  assert.equal(h.prompts.length, 1, "a moved portal is asked again");

  const evil = harness({ grant: { hostDid: HOST, portalOrigin: PORTAL, communityName: "Acme", grantedAt: 0 } });
  const res = await evil.gates.handle("https://evil.example", { op: "marks", hostDid: HOST });
  assert.equal(res.ok, false);
  assert.ok(!evil.asked.some((o) => o.op === "marks"), "the grant is the portal's, not any page's");
});

/** A fake agent answering the marks tasks from a small in-memory store. */
function agentStore() {
  const contacts: Array<Record<string, unknown>> = [];
  const sent: Array<{ type: string; payload: Record<string, unknown> }> = [];
  const sender = {
    async send(envelope: { type: string; payload: Record<string, unknown> }) {
      sent.push(envelope);
      const p = envelope.payload;
      if (envelope.type.endsWith("persona/contact/list/1.1")) {
        return { contacts: contacts.filter((c) => (c.directoryRef as { vtcDid: string }).vtcDid === p.directoryVtcDid) };
      }
      if (envelope.type.endsWith("persona/contact/lists/list/1.0")) return { lists: [] };
      if (envelope.type.endsWith("persona/contact/put/1.2")) {
        let c = contacts.find((x) => x.contactId === p.contactId);
        if (!c) {
          c = { contactId: `c${contacts.length + 1}`, knownByPersona: p.knownByPersona, directoryRef: p.directoryRef, starred: false, rev: 1 };
          contacts.push(c);
        }
        if (p.starred !== undefined) c.starred = p.starred;
        if (p.petname !== undefined) c.petname = p.petname;
        return { contactId: c.contactId, rev: 1, wasCreated: false, annotationsChanged: true };
      }
      throw new Error(`unexpected ${envelope.type}`);
    },
  };
  const deps = {
    agent: async () => ({ sender: sender as never, holder: { did: "did:key:zHolder" } as never, service: { did: VTA.vtaDid } as never }),
    identities: async () => [{ id: "e1", label: "Acme Guild", principalDid: MEMBER, targets: [{ kind: "did", did: HOST }] }],
    contextOf: async () => "ctx-member",
  };
  return { deps, sent, contacts };
}

test("the offscreen half links an entry the first time, then annotates the contact it made — only at the member's agent", async () => {
  const a = agentStore();
  const first = await runDirectoryPageOp(a.deps, VTA, { op: "mark", hostDid: HOST, member: MEMBER, entryId: "dir_a", starred: true });
  assert.deepEqual(first, { starred: true });
  const link = a.sent.find((e) => e.type.endsWith("contact/put/1.2"))!;
  assert.deepEqual(link.payload, {
    contextId: "ctx-member",
    knownByPersona: MEMBER,
    directoryRef: { vtcDid: HOST, entryId: "dir_a" },
    starred: true,
  });

  await runDirectoryPageOp(a.deps, VTA, { op: "mark", hostDid: HOST, member: MEMBER, entryId: "dir_a", petname: "Sam" });
  const annotate = a.sent.filter((e) => e.type.endsWith("contact/put/1.2"))[1]!;
  assert.deepEqual(annotate.payload, { contextId: "ctx-member", contactId: "c1", petname: "Sam" });
  assert.equal(a.contacts.length, 1, "the same entry is the same contact");

  const view = await runDirectoryPageOp(a.deps, VTA, { op: "marks", hostDid: HOST, member: MEMBER });
  assert.deepEqual(view, { entries: { dir_a: { starred: true, petname: "Sam" } }, lists: [] });
  const list = a.sent.find((e) => e.type.endsWith("contact/list/1.1"))!;
  assert.equal(list.payload.directoryVtcDid, HOST, "only this community's contacts are read");
  for (const e of a.sent) assert.equal(e.payload.contextId, "ctx-member");
});

test("with no context for the member's identity, nothing is asked of the agent", async () => {
  const a = agentStore();
  await assert.rejects(
    runDirectoryPageOp({ ...a.deps, contextOf: async () => null }, VTA, { op: "marks", hostDid: HOST, member: MEMBER }),
    /nowhere to keep/,
  );
  assert.equal(a.sent.length, 0);
});

// ─── Verifying fields with a credential ────────────────────────────────────

test("a presentCredential call names 1 to 16 distinct field keys and nothing else", () => {
  assert.equal(directoryPageParamsRefusal({ op: "presentCredential", hostDid: HOST, fields: [FIELD] }), null);
  assert.ok(directoryPageParamsRefusal({ op: "presentCredential", hostDid: HOST, fields: [] }));
  assert.ok(directoryPageParamsRefusal({ op: "presentCredential", hostDid: HOST }));
  assert.ok(directoryPageParamsRefusal({ op: "presentCredential", hostDid: HOST, fields: [FIELD, FIELD] }));
  assert.ok(directoryPageParamsRefusal({ op: "presentCredential", hostDid: HOST, fields: ["Not A Key"] }));
  assert.ok(directoryPageParamsRefusal({ op: "presentCredential", hostDid: HOST, fields: Array.from({ length: 17 }, (_, i) => `org.x.f${i}`) }));
  assert.ok(
    directoryPageParamsRefusal({ op: "presentCredential", hostDid: HOST, fields: [FIELD], claims: ["ssn"] }),
    "the page never names the claims",
  );
  assert.ok(directoryPageParamsRefusal({ op: "presentCredential", hostDid: HOST, fields: [FIELD], credentialId: CRED }));
});

test("a page that is not the portal finds out nothing about the member's credentials", async () => {
  const h = harness({ answers: [{ approved: true, selectedCredential: CRED }] });
  const res = await h.gates.handle("https://evil.example", { op: "presentCredential", hostDid: HOST, fields: [FIELD] });
  assert.equal(res.ok, false);
  assert.ok(!h.asked.some((o) => o.op === "preparePresent"));
  assert.equal(h.prompts.length, 0);
});

test("the person picks the credential, sees every claim, and only then is it presented", async () => {
  const h = harness({ answers: [{ approved: true, selectedCredential: CRED }] });
  const res = await h.gates.handle(PORTAL, { op: "presentCredential", hostDid: HOST, fields: [FIELD] });
  assert.deepEqual(res, { ok: true, result: VERIFIED });
  const prompt = h.prompts[0] as DirectoryPresentConsentView;
  assert.equal(prompt.kind, "presentCredential");
  assert.equal(prompt.member, MEMBER);
  assert.deepEqual(prompt.claims, ["employer"]);
  assert.deepEqual(prompt.candidates.map((c) => c.id), [CRED]);
  assert.deepEqual(h.asked.find((o) => o.op === "present"), {
    op: "present",
    hostDid: HOST,
    member: MEMBER,
    fields: [FIELD],
    credentialId: CRED,
    claims: ["employer"],
  });
});

test("declined, or answered with a credential the prompt did not offer, nothing is presented", async () => {
  for (const answer of [{ approved: false }, { approved: true }, { approved: true, selectedCredential: "cred-other" }]) {
    const h = harness({ answers: [answer] });
    const res = await h.gates.handle(PORTAL, { op: "presentCredential", hostDid: HOST, fields: [FIELD] });
    assert.equal(res.ok, false);
    assert.ok(!h.asked.some((o) => o.op === "present"), JSON.stringify(answer));
  }
});

test("a credential that cannot hide the rest is asked about again, naming what else it shows", async () => {
  const h = harness({ answers: [{ approved: true, selectedCredential: CRED }, { approved: true }], undisclosed: ["salary"] });
  const res = await h.gates.handle(PORTAL, { op: "presentCredential", hostDid: HOST, fields: [FIELD] });
  assert.deepEqual(res, { ok: true, result: VERIFIED });
  assert.deepEqual(h.prompts[1], {
    kind: "presentOverDisclose",
    origin: PORTAL,
    hostDid: HOST,
    communityName: "Acme Guild",
    undisclosed: ["salary"],
    claims: ["employer"],
  });
  const presents = h.asked.filter((o) => o.op === "present") as Array<{ claims: string[] }>;
  assert.deepEqual(presents.map((p) => p.claims), [["employer"], ["employer", "salary"]]);
});

test("declining the second question presents nothing more", async () => {
  const h = harness({ answers: [{ approved: true, selectedCredential: CRED }, { approved: false }], undisclosed: ["salary"] });
  const res = await h.gates.handle(PORTAL, { op: "presentCredential", hostDid: HOST, fields: [FIELD] });
  assert.equal(res.ok, false);
  assert.equal(h.asked.filter((o) => o.op === "present").length, 1, "only the refused attempt");
});

test("the offscreen half hands back what the credential cannot hide, matched on the agent's code", async () => {
  const sent: Array<{ type: string; payload: Record<string, unknown> }> = [];
  const refusal = (code: string, details?: Record<string, unknown>) =>
    Object.assign(new Error("refused"), { details: { code, message: "refused", ...(details ? { details } : {}) } });
  const deps = (err: Error) => ({
    agent: async () => ({
      sender: {
        async send(envelope: { type: string; payload: Record<string, unknown> }) {
          sent.push(envelope);
          throw err;
        },
      } as never,
      holder: { did: "did:key:zHolder" } as never,
      service: { did: VTA.vtaDid } as never,
    }),
    identities: async () => [{ id: "e1", label: "Acme Guild", principalDid: MEMBER, targets: [{ kind: "did", did: HOST }] }],
    community: async () => ({ portalOrigin: PORTAL, endpoint: ENDPOINT, document: {} }),
  });
  const op = { op: "present" as const, hostDid: HOST, member: MEMBER, fields: [FIELD], credentialId: CRED, claims: ["employer"] };

  const over = await runDirectoryPageOp(
    deps(refusal("vault/credentials/present:wouldOverDisclose", { undisclosed: ["salary"] })),
    VTA,
    op,
  );
  assert.deepEqual(over, { undisclosed: ["salary"] });
  const p = sent[0]!.payload;
  assert.equal(sent[0]!.type, "https://trusttasks.org/spec/vault/credentials/present/0.1");
  assert.equal(p.audience, HOST, "bound to the community");
  assert.equal(p.id, CRED);
  assert.deepEqual(p.claims, ["employer"]);
  assert.equal(typeof p.nonce, "string");

  await assert.rejects(
    runDirectoryPageOp(deps(refusal("vault/credentials/present:notPresentable")), VTA, op),
    /expired, been revoked/,
  );
  await assert.rejects(
    runDirectoryPageOp(deps(Object.assign(new Error("wouldOverDisclose"), {})), VTA, op),
    /wouldOverDisclose/,
    "a message is never read as the code",
  );
  const nonces = sent.map((e) => e.payload.nonce);
  assert.equal(new Set(nonces).size, nonces.length, "every attempt is a fresh nonce");
});
