// A community's directory disclosure statement (`vtc/directory/disclosure`,
// carried as `directoryDisclosure` in `vtc/join-requests/manifest/0.4`): what
// its member directory would disclose about the person joining, and to whom
// (VTI-DIR-130). A wallet shows it before the person applies.
//
// The community generates the statement from its configuration. Every audience
// in it is the widest a value can reach; the person can always show less once
// they have joined. Field labels and descriptions are the community's own
// words, so they are only ever shown as text.

import type {
  Audience,
  DirectoryDisclosure,
} from "@openvtc/trust-tasks/vtc/join-requests/manifest/0.4/payload";
import { OobReplyInvalidError } from "./oob-sign-in.js";

export type { DirectoryDisclosure };

const AUDIENCES: readonly Audience[] = ["admins", "groups", "connections", "members", "public"];

/** Who an audience is, said to the person joining. */
const TO_WHOM: Record<Audience, string> = {
  admins: "the community's administrators only",
  groups: "members who share a group with you",
  connections: "members you have a verified relationship with",
  members: "the community's other members",
  public: "anyone, outside the community too",
};

/**
 * The statement, if it is one a wallet can show faithfully; else refused.
 *
 * A wallet that showed part of a statement, or guessed at a member it could
 * not read, would tell the person less than the community disclosed. So a
 * statement missing anything it must state is refused, which stops the join
 * here rather than letting the person apply without being told.
 */
export function checkDirectoryDisclosure(d: unknown): DirectoryDisclosure {
  const s = d as DirectoryDisclosure | undefined;
  const bad = (why: string) => new OobReplyInvalidError(`directory disclosure: ${why}`);
  if (!s || typeof s !== "object") throw bad("not an object");
  if (!Array.isArray(s.fields)) throw bad("no fields");
  for (const f of s.fields) {
    if (!f || typeof f.label !== "string" || !AUDIENCES.includes(f.ceiling) || !AUDIENCES.includes(f.defaultVisibility)) {
      throw bad("a field without a label or its audiences");
    }
  }
  if (!s.newCard || typeof s.newCard.listing !== "string") throw bad("no new-card defaults");
  if (!AUDIENCES.includes(s.membershipIdentifiers)) throw bad("no membership-identifier reach");
  if (typeof s.adminNotes !== "boolean" || typeof s.externalCards !== "boolean") {
    throw bad("does not say whether notes are kept or cards published");
  }
  if (typeof s.statementDigest !== "string" || s.statementDigest === "") throw bad("no statementDigest");
  return s;
}

/** An ISO 8601 duration in words where it is whole days or weeks, else as given. */
export function durationWords(iso: string): string {
  const m = /^P(?:(\d+)W)?(?:(\d+)D)?$/.exec(iso);
  if (!m || (!m[1] && !m[2])) return iso;
  const days = Number(m[1] ?? 0) * 7 + Number(m[2] ?? 0);
  return days === 1 ? "1 day" : `${days} days`;
}

function list(names: string[]): string {
  return names.length < 2 ? names.join("") : `${names.slice(0, -1).join(", ")} and ${names.at(-1)}`;
}

/**
 * The statement in plain sentences, addressed to the person joining: what
 * their card will show and to whom, how far each part can ever go, and the
 * community-wide facts (their DID, notes, groups, publishing beyond).
 */
export function describeDirectoryDisclosure(d: DirectoryDisclosure): string[] {
  const out: string[] = [];
  const shown = AUDIENCES.filter((a) => a !== "admins")
    .map((a) => ({ a, labels: d.fields.filter((f) => f.defaultVisibility === a).map((f) => f.label) }))
    .filter((g) => g.labels.length > 0);
  for (const g of shown) {
    out.push(`Your ${list(g.labels)} will be seen by ${TO_WHOM[g.a]}.`);
  }
  out.push(
    shown.length > 0
      ? "Anything else you add is seen by the administrators only, until you choose otherwise."
      : "Anything you add is seen by the administrators only, until you choose otherwise.",
  );
  const widest = AUDIENCES.filter((a) => a !== "admins")
    .map((a) => ({ a, labels: d.fields.filter((f) => f.ceiling === a).map((f) => f.label) }))
    .filter((g) => g.labels.length > 0);
  for (const g of widest) {
    out.push(`You may choose to show your ${list(g.labels)} to ${TO_WHOM[g.a]}, and no further.`);
  }
  const asserted = d.fields.filter((f) => f.source === "admin").map((f) => f.label);
  if (asserted.length > 0) {
    out.push(`The community sets your ${list(asserted)} itself; you can read ${asserted.length === 1 ? "it" : "them"} but not change ${asserted.length === 1 ? "it" : "them"}.`);
  }
  out.push(
    d.newCard.listing === "listed"
      ? "Members browsing the directory will find you; you can hide yourself."
      : d.newCard.listing === "findable"
        ? "Members can find you by searching, not by browsing; you can hide yourself."
        : "Members won't find you in the directory unless you choose to be listed.",
  );
  out.push(
    d.membershipIdentifiers === "admins"
      ? "The DID you join with is seen by the administrators only."
      : `The DID you join with is seen by the administrators only, unless you choose to show it to ${TO_WHOM[d.membershipIdentifiers]}.`,
  );
  out.push(d.adminNotes ? "The administrators may keep notes about you. They never appear on your card." : "The administrators keep no notes about members.");
  if (d.groups && typeof d.groups.credentialValidity === "string") {
    out.push(`If you join a group you'll hold a credential showing it, valid for ${durationWords(d.groups.credentialValidity)} at a time, which you can show outside the community.`);
  }
  out.push(d.externalCards ? "You may publish your card beyond the community; it is off unless you turn it on." : "Your card is never published outside the community.");
  return out;
}
