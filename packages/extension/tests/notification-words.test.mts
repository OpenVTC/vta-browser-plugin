// The console's words for a held notification: it says a thing exists, who said
// so and whom it concerns — never that the member may take part (VTI-NTF-004) —
// and an unknown kind is shown as existing and nothing more (VTI-NTF-012).

import { test } from "node:test";
import assert from "node:assert/strict";

import { UNKNOWN_KIND_NOTE, kindWords, lapsed, periodWords, presentWords } from "../src/manager/notification-words.ts";

test("vti_ntf_012: an election is a kind this wallet knows; anything else is shown by its own name only", () => {
  assert.deepEqual(kindWords("election"), { label: "Election", known: true });
  assert.deepEqual(kindWords("org.example:meetingInvite"), { label: "org.example:meetingInvite", known: false });
  assert.match(UNKNOWN_KIND_NOTE, /will not open it/);
});

test("a period reads as stated, and says so when none is", () => {
  assert.match(periodWords("2027-03-01T09:00:00Z", "2027-03-08T09:00:00Z"), /^Mon, 01 Mar 2027 09:00 UTC until Mon, 08 Mar 2027 09:00 UTC$/);
  assert.match(periodWords(undefined, "2027-03-08T09:00:00Z"), /^until /);
  assert.match(periodWords("2027-03-01T09:00:00Z", undefined), /^from /);
  assert.equal(periodWords(undefined, undefined), "no period stated");
});

test("withdrawn, or past its validUntil, is lapsed", () => {
  const now = Date.parse("2027-03-05T00:00:00Z");
  assert.equal(lapsed("withdrawn", undefined, now), true);
  assert.equal(lapsed("available", "2027-03-04T00:00:00Z", now), true);
  assert.equal(lapsed("available", "2027-03-08T00:00:00Z", now), false);
  assert.equal(lapsed("available", undefined, now), false);
});

test("vti_vot_016: before presenting, the member is told who learns what", () => {
  const w = presentWords("did:webvh:QmA:a.example", "did:webvh:QmB:b.example");
  assert.match(w, /shows this election only to members of did:webvh:QmB:b\.example/);
  assert.match(w, /before you have seen the election/);
  assert.doesNotMatch(w, /eligible|invited/i);
});
