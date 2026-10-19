// A member's external directory card (`vtc/directory/card/publish/0.1`), as a
// wallet builds it before the member signs.
//
// Pinned: the card is exactly the member's public values in the specification's
// fixed mapping, framed by `uid` (their entry) and `issuer` (their DID); the
// person is told it can be read by anyone; and a card the agent changed while
// signing is refused rather than sent.

import { test } from "node:test";
import assert from "node:assert/strict";

import {
  buildExternalCard,
  describeExternalCard,
  checkSignedCard,
  buildCardPublish,
  publicValues,
  publishedStateOf,
  CARD_PUBLISH,
} from "../dist/vtc/index.js";

const ENTRY = "dir_Q2xhcmFRMmxoY21GUk1t";
const CAROL = "did:example:carol";

const field = (key, label, jsContactPath, order, extra = {}) => ({
  key,
  label,
  type: "text",
  source: "member",
  base: true,
  required: false,
  ceiling: "public",
  defaultVisibility: "admins",
  searchable: false,
  facet: false,
  order,
  state: "active",
  ...(jsContactPath ? { jsContactPath } : {}),
  ...extra,
});

const FIELDS = [
  field("displayName", "Name", "name.full", 0, { defaultVisibility: "members" }),
  field("nickname", "Nickname", "nicknames", 10),
  field("avatar", "Picture", "media", 20, { type: "image" }),
  field("pronouns", "Pronouns", "speakToAs.pronouns", 30),
  field("bio", "About", "notes", 40),
  field("links", "Links", "links", 50, { type: "url" }),
  field("did", "DID", undefined, 90, { source: "derived", ceiling: "members" }),
];

const card = (values, visibility) => ({
  entryId: ENTRY,
  values,
  visibility,
  discoverability: { listing: "listed", search: "byName", external: false },
  introductions: "anyone",
  revision: 7,
  updatedAt: "2026-10-19T09:00:00Z",
});

test("the specification's example card is exactly what the wallet builds", () => {
  const draft = buildExternalCard(
    CAROL,
    card(
      {
        displayName: "Carol Example",
        bio: "Rust, decentralised identity, and long walks.",
        pronouns: "she/her",
      },
      { displayName: "public", bio: "public", pronouns: "members" },
    ),
    FIELDS,
  );
  assert.deepEqual(draft.card, {
    "@type": "Card",
    version: "1.0",
    uid: `urn:vtc-directory:${ENTRY}`,
    issuer: CAROL,
    name: { full: "Carol Example" },
    notes: { n1: { note: "Rust, decentralised identity, and long walks." } },
  });
  assert.equal(draft.revision, 7);
  assert.deepEqual(
    draft.values.map((v) => v.key),
    ["displayName", "bio"],
    "pronouns are shown to members only, so not published",
  );
});

test("every base field lands in its fixed place", () => {
  const sha = "ab".repeat(32);
  const { card: c } = buildExternalCard(
    CAROL,
    card(
      {
        nickname: "cee",
        pronouns: "she/her",
        links: ["https://a.example", "https://b.example"],
        avatar: { sha256: sha, mediaType: "image/jpeg", size: 9, url: "https://x.example/a" },
      },
      { nickname: "public", pronouns: "public", links: "public", avatar: "public" },
    ),
    FIELDS,
  );
  assert.deepEqual(c.nicknames, { k1: { name: "cee" } });
  assert.deepEqual(c.speakToAs, { pronouns: { p1: { pronouns: "she/her" } } });
  assert.deepEqual(c.links, { l1: { uri: "https://a.example" }, l2: { uri: "https://b.example" } });
  assert.deepEqual(c.media, {
    m1: { kind: "photo", uri: `urn:vtc-directory:${ENTRY}:avatar:${sha}`, mediaType: "image/jpeg" },
  });
});

test("a community field is a member named by its key", () => {
  const team = field("org.example.team", "Team", "name.full", 60, { base: false });
  const { card: c } = buildExternalCard(
    CAROL,
    card({ "org.example.team": "Platform" }, { "org.example.team": "public" }),
    [...FIELDS, team],
  );
  assert.equal(c["org.example.team"], "Platform");
  assert.equal(c.name, undefined, "a community field's own path is never followed");
});

test("only active fields with a public ceiling and a public choice are public", () => {
  const retired = field("org.example.old", "Old", undefined, 70, { base: false, state: "retired" });
  const narrow = field("org.example.narrow", "Narrow", undefined, 71, { base: false, ceiling: "members" });
  const got = publicValues(
    card(
      { "org.example.old": "x", "org.example.narrow": "y", displayName: "C" },
      { "org.example.old": "public", "org.example.narrow": "public" },
    ),
    [...FIELDS, retired, narrow],
  );
  assert.deepEqual(got, [], "displayName defaults to members");
});

test("the person is told anyone can read it, and every value", () => {
  const draft = buildExternalCard(
    CAROL,
    card({ displayName: "Carol" }, { displayName: "public" }),
    FIELDS,
  );
  const said = describeExternalCard("Acme Guild", draft);
  assert.match(said.meaning[0], /Anyone/);
  assert.match(said.meaning[0], /outside Acme Guild/);
  assert.deepEqual(said.values, ["Name: Carol"]);
});

test("a card the agent changed while signing is refused", () => {
  const unsigned = { "@type": "Card", version: "1.0", uid: `urn:vtc-directory:${ENTRY}`, issuer: CAROL, name: { full: "Carol" } };
  const proof = {
    type: "DataIntegrityProof",
    cryptosuite: "eddsa-jcs-2022",
    verificationMethod: `${CAROL}#key-1`,
    proofPurpose: "assertionMethod",
    proofValue: "z1",
  };
  assert.deepEqual(checkSignedCard(unsigned, { ...unsigned, proof }, CAROL), { ...unsigned, proof });
  assert.throws(() => checkSignedCard(unsigned, { ...unsigned, name: { full: "Mallory" }, proof }, CAROL));
  assert.throws(() =>
    checkSignedCard(unsigned, { ...unsigned, proof: { ...proof, verificationMethod: "did:example:other#k" } }, CAROL),
  );
  assert.throws(() =>
    checkSignedCard(unsigned, { ...unsigned, proof: { ...proof, proofPurpose: "authentication" } }, CAROL),
  );
});

test("the publish request carries the signed card and the revision signed against", () => {
  const doc = buildCardPublish(CAROL, "did:example:community", { a: 1 }, 7);
  assert.equal(doc.type, CARD_PUBLISH);
  assert.equal(doc.issuer, CAROL);
  assert.deepEqual(doc.payload, { card: { a: 1 }, expectedRevision: 7 });
  assert.equal(publishedStateOf({ externalCard: { state: "published", cardDigest: "z" } }).state, "published");
  assert.throws(() => publishedStateOf({}));
});
