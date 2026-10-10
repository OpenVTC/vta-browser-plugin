// The trigger-link reader (VTI spec chapter 7a), against every row of the
// chapter's Examples table, then the edges of each rule the table does not
// reach.
//
// The Examples rows are the conformance surface other readers are tested
// against too, so each is its own test, named for the row.

import { test } from "node:test";
import assert from "node:assert/strict";
import {
  parseTriggerLink,
  outcomeOf,
  triggerLinkMessage,
  TRIGGER_LINK_MESSAGES,
  isValidHandle,
  meetsHostRules,
  contactDomainLabel,
  isTriggerLinkText,
  SIGN_IN_FLOW,
} from "../dist/links/index.js";

const FROM = "did:webvh:QmPEQVM1JPTyrvEgBcDXwjK4TeyLGSX1PxjgyeAisPviUx:members.example.org";
const ID = "Hk2pQ9xV4mT7rW1sZ8yN3A";
const EXP = 1791460920;
const LINK = `https://link.trustoverip.org/t#_from=${FROM}&_id=${ID}&_exp=${EXP}&_type=/vti/flow/sign-in/0.1`;
const SIGN_IN = "https://link.trustoverip.org/vti/flow/sign-in/0.1";

/** The reader's clock sits at `_exp` unless a test moves it. */
const read = (text, extra = {}) => parseTriggerLink(text, { now: EXP, ...extra });

const accepted = (r) => {
  assert.equal(r.ok, true, `expected accept, got ${JSON.stringify(r)}`);
  return r.link;
};
const refused = (r, reason, outcome) => {
  assert.equal(r.ok, false, `expected ${reason}, got accept`);
  assert.equal(r.reason, reason);
  assert.equal(r.outcome, outcome);
};
const withFragment = (fragment) => `https://link.trustoverip.org/t#${fragment}`;
const fields = (over) => {
  const f = { _from: FROM, _id: ID, _exp: String(EXP), _type: "/vti/flow/sign-in/0.1", ...over };
  return Object.entries(f)
    .filter(([, v]) => v !== undefined)
    .map(([k, v]) => `${k}=${v}`)
    .join("&");
};

test("the size note holds: the example link is 184 bytes", () => {
  assert.equal(new TextEncoder().encode(LINK).length, 184);
});

// ── Examples table ───────────────────────────────────────────────────────────

test("example: the link above is accepted with the sign-in flow", () => {
  const link = accepted(read(LINK));
  assert.equal(link.flow.uri, SIGN_IN);
  assert.equal(link.flow.spec, SIGN_IN_FLOW);
  assert.equal(link.from.kind, "did:webvh");
  assert.equal(link.from.value, FROM);
  assert.equal(link.id, ID);
  assert.equal(link.exp, EXP);
  assert.equal(link.host, "link.trustoverip.org");
});

test("example: _type in absolute form is the same flow", () => {
  const link = accepted(read(withFragment(fields({ _type: SIGN_IN }))));
  assert.equal(link.flow.uri, SIGN_IN);
});

test("example: an alias scheme the reader registers is the same flow", () => {
  const text = LINK.replace(/^https:/, "keyring:");
  assert.equal(accepted(read(text, { aliasSchemes: ["keyring"] })).flow.uri, SIGN_IN);
  // …and one it does not register is not ours.
  refused(read(text), "not-ours", "pass-on");
});

test("example: an upper-cased authority is the same flow", () => {
  const link = accepted(read(LINK.replace("link.trustoverip.org", "LINK.TRUSTOVERIP.ORG")));
  assert.equal(link.flow.uri, SIGN_IN);
  assert.equal(link.host, "link.trustoverip.org");
});

test("example: a query before # is not read", () => {
  const text = LINK.replace("/t#", "/t?utm_source=newsletter#");
  assert.equal(accepted(read(text)).flow.uri, SIGN_IN);
});

test("example: an unknown name appended to the fragment is ignored", () => {
  assert.equal(accepted(read(`${LINK}&utm_source=x`)).flow.uri, SIGN_IN);
});

test("example: link host invite.example.org is wrong-host", () => {
  refused(read(LINK.replace("link.trustoverip.org", "invite.example.org")), "wrong-host", "invalid");
});

test("example: _type=//evil.example/… is bad-type", () => {
  refused(read(withFragment(fields({ _type: "//evil.example/vti/flow/sign-in/0.1" }))), "bad-type", "invalid");
});

test("example: _type with a .. segment is bad-type", () => {
  refused(read(withFragment(fields({ _type: "/vti/flow/../flow/sign-in/0.1" }))), "bad-type", "invalid");
});

test("example: _type with percent-encoding is bad-type, not normalised", () => {
  refused(read(withFragment(fields({ _type: "/vti/flow/sign%2Din/0.1" }))), "bad-type", "invalid");
});

test("example: _id of 23 characters is accepted", () => {
  const id23 = `${ID}A`;
  assert.equal(id23.length, 23);
  assert.equal(accepted(read(withFragment(fields({ _id: id23 })))).id, id23);
});

test("example: _id of 21, 25 or 44 characters is bad-id", () => {
  for (const id of [ID.slice(0, 21), `${ID}AAA`, `${ID}${ID}`]) {
    assert.ok([21, 25, 44].includes(id.length));
    refused(read(withFragment(fields({ _id: id }))), "bad-id", "invalid");
  }
});

test("example: _id of 22 characters with non-zero unused bits is bad-id", () => {
  const id = `${ID.slice(0, 21)}B`; // 'B' = 1: a low bit set in the 4 unused
  refused(read(withFragment(fields({ _id: id }))), "bad-id", "invalid");
});

test("example: _id appearing twice is repeated-param", () => {
  refused(read(`${LINK}&_id=${ID}`), "repeated-param", "invalid");
});

test("example: an agent name is unsupported-vid (update)", () => {
  refused(read(withFragment(fields({ _from: "members.example.org/@" }))), "unsupported-vid", "update");
});

test("example: a did:key contact is from-not-allowed for sign-in", () => {
  const didKey = "did:key:z6MkhaXgBZDvotDkL5257faiztiGiC2QtKLGpbnnEGta2doK";
  refused(read(withFragment(fields({ _from: didKey }))), "from-not-allowed", "invalid");
});

test("example: did:web with %253A parses as %3A (refused later, at resolution)", () => {
  const link = accepted(read(withFragment(fields({ _from: "did:web:example.com%253A8443" }))));
  assert.equal(link.from.value, "did:web:example.com%3A8443");
  assert.equal(link.from.kind, "did:web");
});

test("example: the reader's clock 59 seconds past _exp is accepted", () => {
  accepted(read(LINK, { now: EXP + 59 }));
});

test("example: the reader's clock 60 seconds past _exp is expired", () => {
  refused(read(LINK, { now: EXP + 60 }), "expired", "expired");
});

test("example: the vta-claim link is a flow this reader does not implement", () => {
  const claim =
    "https://link.trustoverip.org/t#_from=did:webvh:QmXa7Rk2ZpLwT9vNc4HbYe1Jd8sMfU3qGo6PtVnEyKiBhW:dids.example.org:farm-auth&_id=Rv8LmQ2nX5tW9kPz3cJhYg&_exp=1791460920&_type=/vti/flow/vta-claim/0.1";
  assert.equal(new TextEncoder().encode(claim).length, 193);
  refused(read(claim), "unknown-flow", "update");
});

test("VTI-LNK-050: the unverified label is the domain then the path", () => {
  const did = "did:webvh:QmXa7Rk2ZpLwT9vNc4HbYe1Jd8sMfU3qGo6PtVnEyKiBhW:dids.example.org:farm-auth";
  assert.equal(contactDomainLabel({ kind: "did:webvh", value: did }), "dids.example.org/farm-auth");
  assert.equal(contactDomainLabel({ kind: "did:webvh", value: FROM }), "members.example.org");
  assert.equal(contactDomainLabel({ kind: "did:key", value: "did:key:z6Mk" }), undefined);
});

// ── Step 1 ───────────────────────────────────────────────────────────────────

test("step 1: surrounding ASCII whitespace is trimmed", () => {
  accepted(read(`  \t${LINK}\n `));
});

test("step 1: more than 1,536 code points is too-long, counted in code points", () => {
  const pad = (n) => `${LINK}&x=${"a".repeat(n - LINK.length - 3)}`;
  accepted(read(pad(1536)));
  refused(read(pad(1537)), "too-long", "invalid");
  // An astral character is one code point, two UTF-16 units: 1,536 of them is
  // still within the limit (and then refused for grammar, not length).
  const astral = `${LINK}&x=${"😀".repeat(1536 - LINK.length - 3)}`;
  assert.equal([...astral].length, 1536);
  assert.notEqual(read(astral).reason, "too-long");
});

// ── Step 2 ───────────────────────────────────────────────────────────────────

test("step 2: text that is not a URL, or another scheme, is not-ours", () => {
  for (const t of ["hello", "mailto:a@b.example", "ftp://link.trustoverip.org/t#_from=x", ""]) {
    refused(read(t), "not-ours", "pass-on");
  }
});

test("step 2: an https URL with no reserved name in the fragment is not-ours", () => {
  refused(read("https://example.com/page#section"), "not-ours", "pass-on");
  refused(read("https://example.com/"), "not-ours", "pass-on");
});

test("step 2: reserved names only in the query is query-form", () => {
  refused(read(`https://link.trustoverip.org/t?${fields({})}`), "query-form", "invalid");
});

test("step 2: the scheme is matched case-insensitively; http is insecure-scheme", () => {
  accepted(read(LINK.replace(/^https/, "HTTPS")));
  refused(read(LINK.replace(/^https/, "http")), "insecure-scheme", "invalid");
});

test("step 2: names are compared after decoding", () => {
  accepted(read(LINK.replace("_from=", "%5Ffrom=")));
});

// ── Step 3 ───────────────────────────────────────────────────────────────────

test("step 3: a control character or space anywhere is bad-grammar", () => {
  refused(read(LINK.replace("/t#", "/t x#")), "bad-grammar", "invalid");
  refused(read(`${LINK}&x=a\u007fb`), "bad-grammar", "invalid");
});

test("step 3: a second # is bad-grammar", () => {
  refused(read(`${LINK}#again`), "bad-grammar", "invalid");
});

// ── Step 4 ───────────────────────────────────────────────────────────────────

test("step 4: userinfo or a port is bad-authority", () => {
  refused(read(LINK.replace("link.trustoverip.org", "user@link.trustoverip.org")), "bad-authority", "invalid");
  refused(read(LINK.replace("link.trustoverip.org", "link.trustoverip.org:443")), "bad-authority", "invalid");
});

test("step 4: hosts that fail the host rules are bad-authority", () => {
  for (const host of ["localhost", "a.localhost", "printer.local", "home.arpa", "x.home.arpa", "127.0.0.1", "0x7f.1", "[::1]", "single", "example.123", "trailing.dot."]) {
    refused(read(LINK.replace("link.trustoverip.org", host)), "bad-authority", "invalid");
  }
});

test("VTI-LNK-060: the host rules", () => {
  assert.equal(meetsHostRules("link.trustoverip.org"), true);
  assert.equal(meetsHostRules("a-b.example"), true);
  assert.equal(meetsHostRules("-a.example"), false);
  assert.equal(meetsHostRules("a-.example"), false);
  assert.equal(meetsHostRules(`${"a".repeat(64)}.example`), false);
  assert.equal(meetsHostRules(`${"a".repeat(63)}.example`), true);
  assert.equal(meetsHostRules(`${"a.".repeat(127)}ab`), false); // 256 chars
  assert.equal(meetsHostRules("Upper.example"), false); // must be parsed (lowercased) first
  assert.equal(meetsHostRules("10.0.0.1"), false);
});

// ── Step 5 ───────────────────────────────────────────────────────────────────

test("step 5: any reserved name repeated is refused, even with equal values", () => {
  refused(read(`${LINK}&_from=${FROM}`), "repeated-param", "invalid");
  refused(read(`${LINK}&_exp=${EXP}`), "repeated-param", "invalid");
  refused(read(`${LINK}&_type=/vti/flow/sign-in/0.1`), "repeated-param", "invalid");
  // An unknown name repeated is still ignored.
  accepted(read(`${LINK}&x=1&x=2`));
});

// ── Step 6 ───────────────────────────────────────────────────────────────────

test("step 6: _from absent is missing-from", () => {
  refused(read(withFragment(fields({ _from: undefined }))), "missing-from", "invalid");
});

test("step 6: a malformed DID is bad-from", () => {
  for (const f of ["did:", "did:webvh:", "did:WEB:example.com", "did:web:a/b", "did:webvh:scid", "nonsense"]) {
    refused(read(withFragment(fields({ _from: f }))), "bad-from", "invalid");
  }
});

test("step 6: a DID method or identifier type the reader does not support is unsupported-vid", () => {
  refused(read(withFragment(fields({ _from: "did:ion:abc" }))), "unsupported-vid", "update");
  refused(read(withFragment(fields({ _from: "urn:example:abc" }))), "unsupported-vid", "update");
});

test("step 6: /@ wins over DID syntax", () => {
  refused(read(withFragment(fields({ _from: "did:web:example.com/@x" }))), "unsupported-vid", "update");
});

test("step 6: _from splits at the first =, so a raw = in a value is kept", () => {
  // did syntax refuses '=', so this reads as bad-from — the point is that the
  // value was not cut at the second '='.
  refused(read(withFragment(fields({ _from: "did:web:a=b.example" }))), "bad-from", "invalid");
});

// ── Step 7 ───────────────────────────────────────────────────────────────────

test("VTI-LNK-033: handle rules", () => {
  assert.equal(isValidHandle(ID), true);
  assert.equal(isValidHandle("A".repeat(43)), true);
  assert.equal(isValidHandle("A".repeat(42)), true);
  assert.equal(isValidHandle("A".repeat(24)), true);
  for (const len of [25, 29, 33, 37, 41]) assert.equal(isValidHandle("A".repeat(len)), false, `len ${len}`);
  assert.equal(isValidHandle(`${"A".repeat(22)}=`), false);
  assert.equal(isValidHandle(`${"A".repeat(21)}+`), false);
  // 23 chars: two unused bits. 'E' = 4 = 0b000100 → zero; 'B' = 1 → not.
  assert.equal(isValidHandle(`${"A".repeat(22)}E`), true);
  assert.equal(isValidHandle(`${"A".repeat(22)}B`), false);
  // 22 chars: four unused bits. 'Q' = 16 → zero; 'I' = 8 → not.
  assert.equal(isValidHandle(`${"A".repeat(21)}Q`), true);
  assert.equal(isValidHandle(`${"A".repeat(21)}I`), false);
});

test("step 7: _id absent is bad-id", () => {
  refused(read(withFragment(fields({ _id: undefined }))), "bad-id", "invalid");
});

test("step 7: _exp grammar", () => {
  for (const e of ["", "01", "-1", "1.5", "1e9", "9007199254740992", " 1"]) {
    refused(read(withFragment(fields({ _exp: encodeURIComponent(e) }))), "bad-exp", "invalid");
  }
  // 0 is well formed (and long past).
  refused(read(withFragment(fields({ _exp: "0" }))), "expired", "expired");
  // 2^53−1 is the largest accepted.
  accepted(read(withFragment(fields({ _exp: "9007199254740991" }))));
});

// ── Step 8 ───────────────────────────────────────────────────────────────────

test("step 8: _type grammar", () => {
  for (const t of [
    "vti/flow/sign-in/0.1",
    "/vti/flow/sign-in",
    "/vti/flow/sign-in/01.1",
    "/vti/flow/sign-in/0.1/",
    "/vti/flow/./sign-in/0.1",
    "/vti/flow/sign in/0.1",
    "https://link.trustoverip.org/vti/flow/sign-in/0.1%3Fq",
    "http://link.trustoverip.org/vti/flow/sign-in/0.1",
  ]) {
    refused(read(withFragment(fields({ _type: t.replace(/ /g, "%20") }))), "bad-type", "invalid");
  }
});

test("step 8: the path form resolves against https and the host whatever the scheme", () => {
  const link = accepted(read(LINK.replace(/^https:/, "keyring:"), { aliasSchemes: ["keyring"] }));
  assert.equal(link.flow.uri, SIGN_IN);
});

test("step 8: an absolute flow on another host is wrong-host", () => {
  refused(read(withFragment(fields({ _type: "https://evil.example/vti/flow/sign-in/0.1" }))), "wrong-host", "invalid");
});

test("step 8: an unknown flow is unknown-flow (update)", () => {
  refused(read(withFragment(fields({ _type: "/vti/flow/step-up/0.1" }))), "unknown-flow", "update");
});

test("step 8: a MAJOR or (draft) MINOR the reader does not implement is unsupported-version", () => {
  refused(read(withFragment(fields({ _type: "/vti/flow/sign-in/1.0" }))), "unsupported-version", "update");
  refused(read(withFragment(fields({ _type: "/vti/flow/sign-in/0.2" }))), "unsupported-version", "update");
});

test("step 8: _type absent is accepted with no flow (the caller decides, VTI-LNK-055)", () => {
  const link = accepted(read(withFragment(fields({ _type: undefined }))));
  assert.equal(link.flow, undefined);
});

// ── Step 9 ───────────────────────────────────────────────────────────────────

test("step 9: sign-in requires _exp", () => {
  refused(read(withFragment(fields({ _exp: undefined }))), "missing-exp", "invalid");
});

test("step 9: the reason order — a bad id is reported before a bad type", () => {
  refused(read(withFragment(fields({ _id: "x", _type: "bad" }))), "bad-id", "invalid");
});

// ── Outcomes and messages ────────────────────────────────────────────────────

test("VTI-LNK-021: the outcome table", () => {
  for (const r of ["unsupported-vid", "unknown-flow", "unsupported-version"]) assert.equal(outcomeOf(r), "update");
  assert.equal(outcomeOf("expired"), "expired");
  assert.equal(outcomeOf("no-common-transport"), "unreachable");
  assert.equal(outcomeOf("not-ours"), "pass-on");
  for (const r of [
    "too-long", "query-form", "insecure-scheme", "bad-grammar", "bad-authority", "repeated-param",
    "missing-from", "bad-from", "bad-id", "bad-exp", "bad-type", "wrong-host", "from-not-allowed",
    "missing-exp", "did-document-unverified", "wrong-origin", "untyped",
  ]) {
    assert.equal(outcomeOf(r), "invalid", r);
  }
});

test("VTI-LNK-021: the messages, verbatim, and none for pass-on", () => {
  assert.equal(triggerLinkMessage("update"), "This code needs a newer version of the app.");
  assert.equal(triggerLinkMessage("expired"), "This code has expired. Get a new one.");
  assert.equal(triggerLinkMessage("unreachable"), "This service can't be reached from your wallet.");
  assert.equal(triggerLinkMessage("invalid"), "This code can't be used.");
  assert.equal(triggerLinkMessage("pass-on"), undefined);
  assert.equal(Object.keys(TRIGGER_LINK_MESSAGES).length, 4);
});

test("isTriggerLinkText: everything but pass-on", () => {
  assert.equal(isTriggerLinkText(LINK, { now: EXP }), true);
  assert.equal(isTriggerLinkText(LINK, { now: EXP + 3600 }), true);
  assert.equal(isTriggerLinkText("https://example.com/#top", { now: EXP }), false);
});

test("the parser never throws", () => {
  for (const t of [undefined, null, 42, "%", "https://%", "https://#_from=%E0%A4%A", `https://a.example/#_from=%FF`]) {
    assert.doesNotThrow(() => parseTriggerLink(t, { now: 0 }));
  }
});
