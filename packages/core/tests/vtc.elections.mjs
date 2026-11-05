// A member's side of a community election: the VTA tasks the wallet asks, the
// ballot rules checked in the member's own window, and the cast's post to the
// ballot box, whose receipt is believed only once it is the ballot box's.

import { test } from "node:test";
import assert from "node:assert/strict";

import {
  CastRefusedError,
  MAX_CAST_DELAY_MS,
  ballotOf,
  ballotRefusal,
  castDelayMs,
  closingCheckpoint,
  fetchInclusion,
  pcsVoterReceipt,
  pcsVoterReceiptsList,
  pcsCast,
  pcsVoterRead,
  pcsVoterRegister,
  postCast,
  membershipCredentialFor,
  readPresentationWarning,
  rollCredentialOf,
  rollCredentialWarning,
  TEXT_RELEASE_THRESHOLD_ADVISED,
  textReleaseWarning,
} from "../dist/vtc/index.js";
import { signingIdentityFromSecret } from "../dist/siop/index.js";
import { signTrustTask } from "../dist/trust-tasks/sign.js";

const WALLET = { did: "did:key:zWallet" };
const VTA = { did: "did:webvh:QmAgent:agent.example" };
const COMMUNITY = "did:webvh:QmCommunity:community.example";
const MEMBER = "did:webvh:QmAlice:people.example";
const TARGET = { contextId: "vtc-community", community: COMMUNITY, member: MEMBER };
const BOX = signingIdentityFromSecret(new Uint8Array(32).fill(5));
const VOTER_KEY = signingIdentityFromSecret(new Uint8Array(32).fill(7));
const ENDPOINT = "https://ballots.example.net/trust-tasks";
const DIGEST = "uEiDigest";

const manifest = {
  electionId: "agm-2027",
  community: COMMUNITY,
  questions: [
    { key: "chair", type: "choice", text: "Chair", options: [{ key: "ana" }, { key: "bo" }], minSelections: 1, maxSelections: 1, optional: false },
    { key: "order", type: "ranking", options: [{ key: "a" }, { key: "b" }, { key: "c" }], partial: false, optional: true },
    { key: "fit", type: "score", options: [{ key: "x" }, { key: "y" }], min: 0, max: 5, optional: true },
    { key: "note", type: "text", maxLength: 4, optional: true },
  ],
  secrecy: "open",
  ballotBox: BOX.did,
};

function recordingSender(reply) {
  const sent = [];
  return {
    sent,
    async send(envelope, opts) {
      sent.push({ envelope, opts });
      return reply;
    },
  };
}

test("a read is asked of the member's VTA as the member, never sent to the community by the wallet's own key", async () => {
  const s = recordingSender({ document: { id: "x" } });
  await pcsVoterRead(s, { holder: WALLET, service: VTA }, TARGET, "show", { electionId: "agm-2027" });
  const { envelope, opts } = s.sent[0];
  assert.equal(envelope.type, "https://trusttasks.org/spec/vta/pcs/voter/read/0.6");
  assert.equal(envelope.recipient, VTA.did);
  assert.deepEqual(envelope.payload, { ...TARGET, read: "show", payload: { electionId: "agm-2027" } });
  assert.equal(opts.expectedResponseType, "https://trusttasks.org/spec/vta/pcs/voter/read/0.6#response");
});

test("the ticket request names the member, so the VTA returns it signed as them", async () => {
  const s = recordingSender({});
  await pcsVoterRegister(s, { holder: WALLET, service: VTA }, TARGET, { parameters: { p: 1 }, manifest });
  assert.equal(s.sent[0].envelope.payload.member, MEMBER);
  assert.deepEqual(s.sent[0].envelope.payload.manifest, manifest);
});

test("an open election casts with vote/0.4; an encrypted one needs the trustees' ceremony", async () => {
  const s = recordingSender({ castDocument: { id: "c" }, tag: "t" });
  const ballot = ballotOf(manifest, DIGEST, { chair: { choice: ["ana"] } });
  await pcsCast(s, { holder: WALLET, service: VTA }, TARGET, { manifest, parameters: {}, manifestDigest: DIGEST }, ballot);
  assert.equal(s.sent[0].envelope.type, "https://trusttasks.org/spec/vta/pcs/vote/0.4");

  const sealed = { ...manifest, secrecy: "sealed" };
  await assert.rejects(
    pcsCast(s, { holder: WALLET, service: VTA }, TARGET, { manifest: sealed, parameters: {}, manifestDigest: DIGEST }, ballot),
    /trustees have not formed/,
  );
  await pcsCast(s, { holder: WALLET, service: VTA }, TARGET, { manifest: sealed, parameters: {}, manifestDigest: DIGEST, ceremony: { steps: [] } }, ballot);
  assert.equal(s.sent[1].envelope.type, "https://trusttasks.org/spec/vta/pcs/vote-encrypted/0.5");
  assert.deepEqual(s.sent[1].envelope.payload.ceremony, { steps: [] });
});

test("an unanswered optional question is abstained, and a complete ballot passes", () => {
  const ballot = ballotOf(manifest, DIGEST, { chair: { choice: ["bo"] } });
  assert.deepEqual(ballot.answers.map((a) => Object.keys(a).sort().join()), [
    "choice,question",
    "abstain,question",
    "abstain,question",
    "abstain,question",
  ]);
  assert.equal(ballotRefusal(manifest, DIGEST, ballot), null);
  const full = ballotOf(manifest, DIGEST, {
    chair: { choice: ["ana"] },
    order: { ranking: ["c", "a", "b"] },
    fit: { scores: { x: 0, y: 5 } },
    note: { text: "👍🏽ok" },
  });
  assert.equal(ballotRefusal(manifest, DIGEST, full), null, "text is counted in characters, not UTF-16 units");
});

test("the ballot rules are the ballot box's", () => {
  const with_ = (answers) => ballotOf(manifest, DIGEST, { chair: { choice: ["ana"] }, ...answers });
  assert.match(ballotRefusal(manifest, DIGEST, ballotOf(manifest, DIGEST, {})), /must be answered/);
  assert.match(ballotRefusal(manifest, DIGEST, with_({ chair: { choice: [] } })), /Choose 1/);
  assert.match(ballotRefusal(manifest, DIGEST, with_({ chair: { choice: ["zed"] } })), /unknown or repeated/);
  assert.match(ballotRefusal(manifest, DIGEST, with_({ order: { ranking: ["a"] } })), /Rank every option/);
  assert.match(ballotRefusal(manifest, DIGEST, with_({ fit: { scores: { x: 1 } } })), /Score every option/);
  assert.match(ballotRefusal(manifest, DIGEST, with_({ fit: { scores: { x: 1, y: 9 } } })), /from 0 to 5/);
  assert.match(ballotRefusal(manifest, DIGEST, with_({ note: { text: "toolong" } })), /at most 4/);
  assert.match(ballotRefusal(manifest, "uEiOther", with_({})), /another election/);
});

test("the pause before a cast stays under its bound", () => {
  assert.equal(castDelayMs(() => 0), 0);
  assert.ok(castDelayMs(() => 0.999999) < MAX_CAST_DELAY_MS);
});

const cast = () => ({
  id: crypto.randomUUID(),
  type: "https://trusttasks.org/spec/voting/ballot/cast/0.1#request",
  issuer: VOTER_KEY.did,
  recipient: BOX.did,
  issuedAt: new Date().toISOString(),
  payload: {},
  proof: { type: "DataIntegrityProof" },
});

async function receipt(c, { signing = BOX, ...over } = {}) {
  const r = {
    id: crypto.randomUUID(),
    type: "https://trusttasks.org/spec/voting/ballot/cast/0.1#response",
    issuer: signing.did,
    recipient: c.issuer,
    threadId: c.id,
    issuedAt: new Date().toISOString(),
    payload: { outcome: "counted", leafIndex: 3 },
    ...over,
  };
  await signTrustTask({ envelope: r, signing, proofPurpose: "assertionMethod" });
  return r;
}

const answering = (status, body, seen = []) => async (url, init) => {
  seen.push({ url, init });
  return new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
};

test("a cast goes out unchanged, and comes back with the ballot box's whole signed receipt", async () => {
  const c = cast();
  const r = await receipt(c);
  const seen = [];
  const got = await postCast(c, { ballotBox: BOX.did, endpoint: ENDPOINT, fetch: answering(200, r, seen) });
  assert.deepEqual(got, r);
  assert.equal(seen[0].url, ENDPOINT);
  assert.deepEqual(JSON.parse(seen[0].init.body), c);
  assert.equal(seen[0].init.credentials, "omit");
});

test("a receipt signed by anyone else, or for another cast, is refused", async () => {
  const c = cast();
  const other = signingIdentityFromSecret(new Uint8Array(32).fill(6));
  await assert.rejects(postCast(c, { ballotBox: BOX.did, endpoint: ENDPOINT, fetch: answering(200, await receipt(c, { signing: other })) }));
  await assert.rejects(
    postCast(c, { ballotBox: BOX.did, endpoint: ENDPOINT, fetch: answering(200, await receipt(c, { threadId: "urn:uuid:other" })) }),
    /another cast/,
  );
  await assert.rejects(
    postCast({ ...c, recipient: other.did }, { ballotBox: BOX.did, endpoint: ENDPOINT, fetch: answering(200, {}) }),
    /another ballot box/,
  );
});

test("a refusal is the ballot box's code, in words", async () => {
  const c = cast();
  const err = {
    type: "https://trusttasks.org/spec/trust-task-error/0.1",
    threadId: c.id,
    payload: { code: "https://trusttasks.org/spec/voting/ballot/cast/0.1#voting/ballot/cast:notOpen" },
  };
  await assert.rejects(postCast(c, { ballotBox: BOX.did, endpoint: ENDPOINT, fetch: answering(409, err) }), (e) => {
    assert.ok(e instanceof CastRefusedError);
    assert.match(e.message, /not open/);
    return true;
  });
});

test("a release threshold below 10 is warned of, in the words VTI-VOT-090 asks for; 10 and above is not", () => {
  assert.equal(TEXT_RELEASE_THRESHOLD_ADVISED, 10);
  assert.equal(
    textReleaseWarning(3),
    "Written answers are released once 3 ballots are counted. Below 10, a written answer may identify who wrote it.",
  );
  assert.match(textReleaseWarning(1), /released once 1 ballot is counted/);
  assert.match(textReleaseWarning(9), /once 9 ballots/);
  for (const t of [10, 25, undefined]) assert.equal(textReleaseWarning(t), null);
});

test("a manifest releasing written answers after one ballot is a manifest the wallet votes in", async () => {
  const low = { ...manifest, textReleaseThreshold: 1 };
  const ballot = ballotOf(low, DIGEST, { chair: { choice: ["ana"] }, note: { text: "hi" } });
  assert.equal(ballotRefusal(low, DIGEST, ballot), null);
  const s = recordingSender({ castDocument: { id: "c" }, tag: "t" });
  await pcsCast(s, { holder: WALLET, service: VTA }, TARGET, { manifest: low, parameters: {}, manifestDigest: DIGEST }, ballot);
  assert.equal(s.sent[0].envelope.payload.manifest.textReleaseThreshold, 1);
});

// ── Credential rolls (VTI-VOT-015, 016, 025, 090) ───────────────────────────

const PARTY = "did:webvh:QmParty:party.example";

test("vti_vot_015: a show can present the member's credential, naming memberOf; a list cannot", async () => {
  const s = recordingSender({ document: { id: "x" } });
  const presenting = { membershipCredential: "cred-1", memberOf: PARTY };
  await pcsVoterRead(s, { holder: WALLET, service: VTA }, TARGET, "show", { electionId: "agm-2027" }, presenting);
  assert.deepEqual(s.sent[0].envelope.payload, {
    ...TARGET,
    read: "show",
    payload: { electionId: "agm-2027" },
    membershipCredential: "cred-1",
    memberOf: PARTY,
  });
  await assert.rejects(
    pcsVoterRead(s, { holder: WALLET, service: VTA }, TARGET, "list", {}, presenting),
    /Only a show presents/,
  );
  assert.equal(s.sent.length, 1);
});

test("vti_vot_025: register/0.5 carries the membership credential only when given one", async () => {
  const s = recordingSender({});
  await pcsVoterRegister(s, { holder: WALLET, service: VTA }, TARGET, { parameters: {}, manifest }, "cred-1");
  assert.equal(s.sent[0].envelope.type, "https://trusttasks.org/spec/vta/pcs/voter/register/0.5");
  assert.equal(s.sent[0].envelope.payload.membershipCredential, "cred-1");
  await pcsVoterRegister(s, { holder: WALLET, service: VTA }, TARGET, { parameters: {}, manifest });
  assert.equal("membershipCredential" in s.sent[1].envelope.payload, false);
});

test("a credential roll is the manifest's memberOf, with the disclosure's kind and name only when they agree", () => {
  const roll = { rule: "credential", memberOf: PARTY };
  const d = { rollCredential: { memberOf: PARTY, memberOfKind: "memberParty", memberOfName: "Party Co-op", presenterDisclosed: true } };
  assert.deepEqual(rollCredentialOf({ manifest: { ...manifest, roll }, disclosure: d }), {
    memberOf: PARTY,
    memberOfKind: "memberParty",
    memberOfName: "Party Co-op",
  });
  const other = { rollCredential: { ...d.rollCredential, memberOf: "did:webvh:QmElse:else.example" } };
  assert.deepEqual(rollCredentialOf({ manifest: { ...manifest, roll }, disclosure: other }), { memberOf: PARTY });
  assert.equal(rollCredentialOf({ manifest: { ...manifest, roll: { rule: "members" } }, disclosure: {} }), null);
});

test("vti_vot_016: only an active, valid credential issued by exactly memberOf is chosen, the longest-lived first", () => {
  const now = Date.parse("2026-11-03T00:00:00Z");
  const held = [
    { id: "group", issuerDid: `${PARTY}:groups:g1`, status: "valid" },
    { id: "revoked", issuerDid: PARTY, status: "revoked" },
    { id: "archived", issuerDid: PARTY, status: "valid", lifecycle: "archived" },
    { id: "expired", issuerDid: PARTY, status: "valid", validUntil: "2026-10-01T00:00:00Z" },
    { id: "short", issuerDid: PARTY, status: "valid", validUntil: "2026-12-01T00:00:00Z" },
    { id: "long", issuerDid: PARTY, status: "valid", validUntil: "2027-06-01T00:00:00Z" },
  ];
  assert.equal(membershipCredentialFor(held, PARTY, now), "long");
  assert.equal(membershipCredentialFor(held.slice(0, 4), PARTY, now), null);
  assert.equal(membershipCredentialFor(held, "did:webvh:QmNone:none.example", now), null);
});

test("vti_vot_090: the member is told whose credential counts, and that presenting it shows the membership", () => {
  assert.equal(
    rollCredentialWarning({ memberOf: PARTY, memberOfKind: "communityGroup", memberOfName: "Engineering" }, "Acme"),
    "Only holders of a membership credential issued by the group Engineering take a ticket. Taking one presents yours to Acme, so Acme learns that you are a member of that party.",
  );
  assert.match(rollCredentialWarning({ memberOf: PARTY, memberOfKind: "thisCommunity" }, "Acme"), /a member of it\.$/);
  assert.match(readPresentationWarning(PARTY, "Acme"), /before you have seen what the election asks/);
});

// ── VTI-VOT-053: checking a vote after close ─────────────────────────────────

const cp = (at, size = 9) => ({ head: { treeSize: size, issuedAt: at }, document: { at } });

test("vti_vot_053: the head checked against is the newest, from the close on", () => {
  const kept = { state: "voting", manifest: { votingClosesAt: "2026-11-10T00:00:00Z" }, checkpoints: [cp("2026-11-09T00:00:00Z")] };
  assert.throws(() => closingCheckpoint(kept, false), /not closed/);
  kept.state = "closed";
  assert.throws(() => closingCheckpoint(kept, false), /from the close/);
  kept.checkpoints.push(cp("2026-11-10T00:00:05Z", 12));
  assert.deepEqual(closingCheckpoint(kept, false), { document: { at: "2026-11-10T00:00:05Z" }, treeSize: 12 });
  assert.throws(() => closingCheckpoint({ ...kept, state: "cancelled" }, false), /cancelled/);
  // A tombstone has no state or manifest: its newest head.
  assert.deepEqual(closingCheckpoint({ checkpoints: [cp("a", 3), cp("b", 4)] }, true), { document: { at: "b" }, treeSize: 4 });
  assert.throws(() => closingCheckpoint({ checkpoints: [] }, true), /not kept a head/);
});

test("vti_vot_053: a tombstone read goes as voter/read 0.7; list and show stay on 0.6", async () => {
  const sender = recordingSender({ document: {} });
  await pcsVoterRead(sender, { holder: WALLET, service: VTA }, TARGET, "tombstone", { electionId: "agm-2027" });
  await pcsVoterRead(sender, { holder: WALLET, service: VTA }, TARGET, "show", { electionId: "agm-2027" });
  assert.equal(sender.sent[0].envelope.type, "https://trusttasks.org/spec/vta/pcs/voter/read/0.7");
  assert.equal(sender.sent[0].envelope.payload.read, "tombstone");
  assert.equal(sender.sent[1].envelope.type, "https://trusttasks.org/spec/vta/pcs/voter/read/0.6");
  await assert.rejects(
    pcsVoterRead(sender, { holder: WALLET, service: VTA }, TARGET, "tombstone", {}, { membershipCredential: "h", memberOf: COMMUNITY }),
    /Only a show/,
  );
});

test("vti_vot_053: the receipts and the evidence go to the member's VTA, the receipt unchanged", async () => {
  const sender = recordingSender({ electionId: "agm-2027", ballotBox: BOX.did, receipts: [] });
  await pcsVoterReceiptsList(sender, { holder: WALLET, service: VTA }, TARGET, "agm-2027");
  assert.equal(sender.sent[0].envelope.type, "https://trusttasks.org/spec/vta/pcs/voter/receipts/list/0.1");
  assert.deepEqual(sender.sent[0].envelope.payload, { contextId: TARGET.contextId, community: COMMUNITY, electionId: "agm-2027" });
  const r = { type: "receipt", payload: { leafIndex: 3 } };
  const inclusion = { leafIndex: 3, treeSize: 9, entryHash: "zE", path: ["zP"] };
  await pcsVoterReceipt(sender, { holder: WALLET, service: VTA }, TARGET, "agm-2027", r, { checkpoint: { at: 1 }, inclusion });
  assert.deepEqual(sender.sent[1].envelope.payload.receipt, r);
  assert.deepEqual(sender.sent[1].envelope.payload.checkpoint, { at: 1 });
  assert.deepEqual(sender.sent[1].envelope.payload.inclusion, inclusion);
});

const kept = { payload: { electionId: "agm-2027", leafIndex: 3, entryHash: "zEntry", receiptToken: "zToken" } };

test("vti_vot_053: the inclusion proof is asked of the ballot box, unsigned, with the receipt's token", async () => {
  const seen = [];
  const fetch = async (url, init) => {
    seen.push({ url, init });
    const req = JSON.parse(init.body);
    const reply = {
      id: crypto.randomUUID(),
      type: "https://trusttasks.org/spec/voting/board/inclusion/0.1#response",
      issuer: BOX.did,
      threadId: req.id,
      issuedAt: new Date().toISOString(),
      payload: { leafIndex: 3, treeSize: 9, entryHash: "zEntry", path: ["zA", "zB"] },
    };
    await signTrustTask({ envelope: reply, signing: BOX, proofPurpose: "assertionMethod" });
    return new Response(JSON.stringify(reply), { status: 200, headers: { "content-type": "application/json" } });
  };
  const got = await fetchInclusion(kept, COMMUNITY, 9, { ballotBox: BOX.did, endpoint: ENDPOINT, fetch });
  assert.deepEqual(got, { leafIndex: 3, treeSize: 9, entryHash: "zEntry", path: ["zA", "zB"] });
  const req = JSON.parse(seen[0].init.body);
  assert.equal(seen[0].url, ENDPOINT);
  assert.equal(seen[0].init.credentials, "omit");
  assert.equal(req.issuer, undefined, "nothing names the member");
  assert.equal(req.proof, undefined);
  assert.deepEqual(req.payload, { community: COMMUNITY, electionId: "agm-2027", leafIndex: 3, treeSize: 9, receiptToken: "zToken" });
});

test("vti_vot_053: a head too small to hold the cast is not asked about; a refusal or a stray answer is an error", async () => {
  let asked = 0;
  const never = async () => {
    asked++;
    throw new Error("asked");
  };
  assert.deepEqual(await fetchInclusion(kept, COMMUNITY, 3, { ballotBox: BOX.did, endpoint: ENDPOINT, fetch: never }), {
    leafIndex: 3,
    treeSize: 3,
    entryHash: "zEntry",
    path: [],
  });
  assert.equal(asked, 0);
  const err = { type: "https://trusttasks.org/spec/trust-task-error/0.1", payload: { code: "voting/board/inclusion:electionUnknown" } };
  await assert.rejects(fetchInclusion(kept, COMMUNITY, 9, { ballotBox: BOX.did, endpoint: ENDPOINT, fetch: answering(404, err) }), /would not show/);
  await assert.rejects(
    fetchInclusion(kept, COMMUNITY, 9, { ballotBox: BOX.did, endpoint: ENDPOINT, fetch: answering(200, { threadId: "other", payload: {} }) }),
    /another request/,
  );
});
