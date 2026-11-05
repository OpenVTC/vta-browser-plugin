// A member's side of a community election (VTI-VOT-020 – 053): read the
// elections, take a ticket, vote, keep the receipt — every key in the member's
// VTA.
//
// The wallet carries documents between three parties and holds no key of its
// own here:
//
// - **The member's VTA** signs the community's reads and the ticket request as
//   the member (`vta/pcs/voter/read`, `vta/pcs/voter/register`), unblinds the
//   ticket (`voter/accept`), builds and signs each cast under a key made for
//   that cast alone (`vta/pcs/vote`, `vta/pcs/vote-encrypted`), and keeps and
//   checks the receipt (`voter/receipt`) — at the cast, and again after close
//   against the head the community kept (`voter/receipts/list`, VTI-VOT-053).
// - **The community** answers the reads and issues the ticket, blind. It never
//   sees a ballot.
// - **The ballot box** takes the cast over its HTTPS door (VTI-VOT-004) — the
//   one binding a sender with no persistent identifier and no session can use —
//   and never learns whose it is.
//
// So the ballot goes from the member's own window to the VTA and from the
// wallet to the ballot box; nothing here sends a ballot, a ticket or a cast to
// the community, and nothing a portal page can read carries a choice. The
// reference client is `pnm elections` (`vta-cli-common/src/commands/elections.rs`
// in verifiable-trust-infrastructure).

import { guardedFetch } from "@openvtc/vti-didcomm-js/net-guard";

import type { NetPolicy } from "../didcomm/index.js";
import { DEFAULT_FETCH_TIMEOUT_MS, isFetchTimeout, withFetchTimeout } from "../http/timeout-fetch.js";
import type { TrustTaskSender } from "../vta/channel.js";
import { isTrustTaskErrorType } from "../vta/protocol.js";
import { buildTrustTask, verifyTrustTaskReply } from "../vta/trust-task.js";

import type { Answer, Ballot, Manifest, Question } from "../specs/_shared/components.js";
import type { ElectionListItem } from "../specs/vtc/elections/list/0.5/payload.js";
import type { VTCElectionsShowResponsePayload } from "../specs/vtc/elections/show/0.6/payload.js";
import {
  TYPE_URI as VOTER_READ,
  RESPONSE_TYPE_URI as VOTER_READ_RESPONSE,
  type VTAPCSVoterReadPayload,
  type VTAPCSVoterReadResponsePayload,
} from "../specs/vta/pcs/voter/read/0.7/payload.js";
import {
  TYPE_URI as VOTER_RECEIPTS_LIST,
  RESPONSE_TYPE_URI as VOTER_RECEIPTS_LIST_RESPONSE,
  type VTAPCSVoterReceiptsListPayload,
  type VTAPCSVoterReceiptsListResponsePayload,
} from "../specs/vta/pcs/voter/receipts/list/0.1/payload.js";
import {
  TYPE_URI as VOTER_REGISTER,
  RESPONSE_TYPE_URI as VOTER_REGISTER_RESPONSE,
  type VTAPCSVoterRegisterPayload,
  type VTAPCSVoterRegisterResponsePayload,
} from "../specs/vta/pcs/voter/register/0.5/payload.js";
import {
  TYPE_URI as VOTER_ACCEPT,
  RESPONSE_TYPE_URI as VOTER_ACCEPT_RESPONSE,
  type VTAPCSVoterAcceptPayload,
  type VTAPCSVoterAcceptResponsePayload,
} from "../specs/vta/pcs/voter/accept/0.1/payload.js";
import {
  TYPE_URI as VOTER_RECEIPT,
  RESPONSE_TYPE_URI as VOTER_RECEIPT_RESPONSE,
  type VTAPCSVoterReceiptPayload,
  type VTAPCSVoterReceiptResponsePayload,
} from "../specs/vta/pcs/voter/receipt/0.1/payload.js";
import {
  TYPE_URI as VOTE,
  RESPONSE_TYPE_URI as VOTE_RESPONSE,
  type VTAPCSVotePayload,
  type VTAPCSVoteResponsePayload,
} from "../specs/vta/pcs/vote/0.4/payload.js";
import {
  TYPE_URI as VOTE_ENCRYPTED,
  RESPONSE_TYPE_URI as VOTE_ENCRYPTED_RESPONSE,
  type VTAPCSVoteEncryptedPayload,
  type VTAPCSVoteEncryptedResponsePayload,
} from "../specs/vta/pcs/vote-encrypted/0.5/payload.js";

export type {
  Answer as ElectionAnswer,
  Ballot as ElectionBallot,
  ElectionListItem,
  Manifest as ElectionManifest,
  Question as ElectionQuestion,
  VTCElectionsShowResponsePayload as ElectionShown,
};
export {
  TYPE_URI as ELECTIONS_LIST_TYPE,
  RESPONSE_TYPE_URI as ELECTIONS_LIST_RESPONSE_TYPE,
} from "../specs/vtc/elections/list/0.5/payload.js";
export {
  TYPE_URI as ELECTIONS_SHOW_TYPE,
  RESPONSE_TYPE_URI as ELECTIONS_SHOW_RESPONSE_TYPE,
} from "../specs/vtc/elections/show/0.6/payload.js";
export { RESPONSE_TYPE_URI as TICKETS_ISSUE_RESPONSE_TYPE } from "../specs/vtc/elections/tickets/issue/0.3/payload.js";

/** Who the VTA is asked as, and which VTA. */
export interface VoterAgent {
  holder: { did: string };
  service: { did: string };
}

/** The member at the community: the persona the roll admits, and the VTA
 *  context its voter keys are derived in. */
export interface VoterTarget {
  contextId: string;
  community: string;
  member: string;
}

function ask<P, R>(
  sender: TrustTaskSender,
  agent: VoterAgent,
  type: string,
  responseType: string,
  label: string,
  payload: P,
): Promise<R> {
  const envelope = buildTrustTask(type, payload, { issuer: agent.holder.did, recipient: agent.service.did });
  return sender.send<R>(envelope, { expectedResponseType: responseType, operationLabel: label });
}

/** What a read presents (`vta/pcs/voter/read/0.7`, VTI-VOT-015): the vault
 *  handle of the membership credential the member chose to show, and the DID
 *  they were told the election's credential roll names. The VTA presents it
 *  only where that credential's issuer is exactly `memberOf`, and refuses
 *  `membershipCredentialMismatch` otherwise (VTI-VOT-016). */
export interface ReadPresenting {
  membershipCredential: string;
  memberOf: string;
}

/** `vta/pcs/voter/read`: the VTA signs one election read as the member,
 *  addressed to the community — a `vtc/elections/list/0.5` or
 *  `vtc/elections/show/0.6` request or, once the election's board is deleted,
 *  a `vtc/elections/tombstones/show/0.1` request (VTI-BRD-009) — read/0.7,
 *  the first to sign a tombstone read. The wallet sends the document unchanged.
 *  `presenting`, for a `show` only, has the VTA present the member's
 *  membership credential in it, bound to that document; a community answers
 *  such a read once, so a lost answer is a new read, never a resend. */
export async function pcsVoterRead(
  sender: TrustTaskSender,
  agent: VoterAgent,
  t: VoterTarget,
  read: "list" | "show" | "tombstone",
  payload: Record<string, unknown>,
  presenting?: ReadPresenting,
): Promise<VTAPCSVoterReadResponsePayload> {
  if (presenting && read !== "show") throw new Error("Only a show presents a membership credential.");
  const p: VTAPCSVoterReadPayload = {
    ...t,
    read,
    payload,
    ...(presenting ? { membershipCredential: presenting.membershipCredential, memberOf: presenting.memberOf } : {}),
  };
  return ask(sender, agent, VOTER_READ, VOTER_READ_RESPONSE, "vta/pcs/voter/read/0.7", p);
}

/** `vta/pcs/voter/register/0.5`: the blinded ticket request, and — because
 *  `member` is named — that request (`vtc/elections/tickets/issue/0.3`) as a
 *  document signed as the member. Under a `credential` roll,
 *  `membershipCredential` is the vault handle of the member's membership
 *  credential for `roll.memberOf`, which the VTA presents in that document
 *  (VTI-VOT-025); the VTA refuses a credential roll without one
 *  (`membershipCredentialRequired`). */
export function pcsVoterRegister(
  sender: TrustTaskSender,
  agent: VoterAgent,
  t: VoterTarget,
  shown: Pick<VTCElectionsShowResponsePayload, "parameters" | "manifest">,
  membershipCredential?: string,
): Promise<VTAPCSVoterRegisterResponsePayload> {
  const p: VTAPCSVoterRegisterPayload = {
    contextId: t.contextId,
    community: t.community,
    member: t.member,
    parameters: shown.parameters,
    manifest: shown.manifest,
    ...(membershipCredential !== undefined ? { membershipCredential } : {}),
  } as VTAPCSVoterRegisterPayload;
  return ask(sender, agent, VOTER_REGISTER, VOTER_REGISTER_RESPONSE, "vta/pcs/voter/register/0.5", p);
}

/** `vta/pcs/voter/accept/0.1`: unblind the community's answer into the VTA. */
export function pcsVoterAccept(
  sender: TrustTaskSender,
  agent: VoterAgent,
  t: VoterTarget,
  electionId: string,
  parameters: VTCElectionsShowResponsePayload["parameters"],
  issued: Record<string, unknown>,
): Promise<VTAPCSVoterAcceptResponsePayload> {
  const p = {
    contextId: t.contextId,
    community: t.community,
    electionId,
    parameters,
    response: issued,
  } as unknown as VTAPCSVoterAcceptPayload;
  return ask(sender, agent, VOTER_ACCEPT, VOTER_ACCEPT_RESPONSE, "vta/pcs/voter/accept/0.1", p);
}

/** The cast, built and signed in the VTA under a key made for it alone: open
 *  (`vta/pcs/vote/0.4`), or encrypted under the election key the trustees'
 *  signed steps form (`vta/pcs/vote-encrypted/0.5`) — the VTA forms it from
 *  `ceremony` itself and encrypts under no other. */
export async function pcsCast(
  sender: TrustTaskSender,
  agent: VoterAgent,
  t: VoterTarget,
  shown: VTCElectionsShowResponsePayload,
  ballot: Ballot,
): Promise<{ castDocument: Record<string, unknown>; tag: string }> {
  const base = { contextId: t.contextId, community: t.community, parameters: shown.parameters, manifest: shown.manifest, ballot };
  if (shown.manifest.secrecy === "open") {
    const r = await ask<VTAPCSVotePayload, VTAPCSVoteResponsePayload>(
      sender, agent, VOTE, VOTE_RESPONSE, "vta/pcs/vote/0.4", base as VTAPCSVotePayload,
    );
    return { castDocument: r.castDocument as unknown as Record<string, unknown>, tag: String(r.tag) };
  }
  if (!shown.ceremony) {
    throw new Error("The trustees have not formed this election's key yet. Vote once voting opens.");
  }
  const r = await ask<VTAPCSVoteEncryptedPayload, VTAPCSVoteEncryptedResponsePayload>(
    sender, agent, VOTE_ENCRYPTED, VOTE_ENCRYPTED_RESPONSE, "vta/pcs/vote-encrypted/0.5",
    { ...base, ceremony: shown.ceremony } as unknown as VTAPCSVoteEncryptedPayload,
  );
  return { castDocument: r.castDocument as unknown as Record<string, unknown>, tag: String(r.tag) };
}

/** `vta/pcs/voter/receipt/0.1`: the VTA keeps the ballot box's receipt and
 *  checks it — with `evidence`, against a head the community kept: the
 *  checkpoint's signed document and the cast's inclusion proof, which the
 *  wallet fetched from the ballot box itself (`fetchInclusion`). */
export function pcsVoterReceipt(
  sender: TrustTaskSender,
  agent: VoterAgent,
  t: VoterTarget,
  electionId: string,
  receipt: Record<string, unknown>,
  evidence?: { checkpoint: Record<string, unknown>; inclusion: BoardInclusion },
): Promise<VTAPCSVoterReceiptResponsePayload> {
  const p = {
    contextId: t.contextId,
    community: t.community,
    electionId,
    receipt,
    ...(evidence ? { checkpoint: evidence.checkpoint, inclusion: evidence.inclusion } : {}),
  } as unknown as VTAPCSVoterReceiptPayload;
  return ask(sender, agent, VOTER_RECEIPT, VOTER_RECEIPT_RESPONSE, "vta/pcs/voter/receipt/0.1", p);
}

/** `vta/pcs/voter/receipts/list/0.1`: the receipts the VTA keeps for one
 *  election, each exactly as the ballot box signed it, and the ballot box. */
export function pcsVoterReceiptsList(
  sender: TrustTaskSender,
  agent: VoterAgent,
  t: VoterTarget,
  electionId: string,
): Promise<VTAPCSVoterReceiptsListResponsePayload> {
  const p: VTAPCSVoterReceiptsListPayload = { contextId: t.contextId, community: t.community, electionId };
  return ask(sender, agent, VOTER_RECEIPTS_LIST, VOTER_RECEIPTS_LIST_RESPONSE, "vta/pcs/voter/receipts/list/0.1", p);
}

// ── Checking a vote after close (VTI-VOT-053) ────────────────────────────────

/** A `voting/board/inclusion/0.1` answer: the RFC 9162 audit path of one leaf
 *  in a tree of `treeSize`. */
export interface BoardInclusion {
  leafIndex: number;
  treeSize: number;
  entryHash: string;
  path: string[];
}

/** What the community keeps of an election that a receipt is checked against:
 *  its `vtc/elections/show` answer, or — once the board it was opened on is
 *  deleted — its `vtc/elections/tombstones/show` answer (VTI-BRD-009). */
export interface KeptHeads {
  state?: string;
  manifest?: { votingClosesAt?: string };
  checkpoints: { head: { treeSize: number; issuedAt?: string }; document: Record<string, unknown> }[];
}

/** The head to check receipts against: the newest the community kept, once
 *  voting has closed. From a `show`, only once the election is `closed` or
 *  `tallied` and the head is dated at or after the close; from a tombstone,
 *  its newest — a board is deleted only after its elections ended
 *  (VTI-BRD-007). Throws, in the member's words, when there is none yet. */
export function closingCheckpoint(kept: KeptHeads, fromTombstone: boolean): { document: Record<string, unknown>; treeSize: number } {
  if (!fromTombstone) {
    if (kept.state === "cancelled") throw new Error("This election was cancelled: no vote in it is counted.");
    if (kept.state !== "closed" && kept.state !== "tallied") {
      throw new Error("Voting has not closed yet. Check your vote once it has.");
    }
  }
  const last = kept.checkpoints.at(-1);
  if (!last) throw new Error("The community has not kept a head of this election's board yet. Try again later.");
  const closes = kept.manifest?.votingClosesAt;
  if (!fromTombstone && closes && last.head.issuedAt && Date.parse(last.head.issuedAt) < Date.parse(closes)) {
    throw new Error("The community has not kept the board's head from the close yet. Try again in a little while.");
  }
  return { document: last.document, treeSize: last.head.treeSize };
}

export interface FetchInclusionOptions {
  /** The ballot box's DID: the receipt's issuer, and the inclusion answer's. */
  ballotBox: string;
  /** `<TrustTaskHTTPS base>/trust-tasks`, from the ballot box's DID document. */
  endpoint: string;
  fetch?: typeof fetch;
  netPolicy?: NetPolicy;
  timeoutMs?: number;
}

/**
 * The inclusion proof of a receipt's cast in a head of `treeSize`, asked of
 * the ballot box from the wallet's own connection, unsigned: on a private
 * board the receipt's token is the whole authority, and nothing names the
 * member (`voting/board/inclusion/0.1`, VTI-VOT-052). Never through the VTA or
 * the community, which would learn which leaf is the member's. A head too
 * small to hold the cast has no proof to ask for: the VTA answers it
 * `notIncluded` with an empty path.
 */
export async function fetchInclusion(
  receipt: Record<string, unknown>,
  community: string,
  treeSize: number,
  opts: FetchInclusionOptions,
): Promise<BoardInclusion> {
  const r = (receipt.payload ?? {}) as { electionId?: string; leafIndex?: number; entryHash?: string; receiptToken?: string };
  const leafIndex = Number(r.leafIndex);
  const entryHash = String(r.entryHash ?? "");
  if (leafIndex >= treeSize) return { leafIndex, treeSize, entryHash, path: [] };
  const request = buildTrustTask(
    "https://trusttasks.org/spec/voting/board/inclusion/0.1#request",
    {
      community,
      electionId: r.electionId,
      leafIndex,
      treeSize,
      ...(r.receiptToken ? { receiptToken: r.receiptToken } : {}),
    },
    { id: `urn:uuid:${globalThis.crypto.randomUUID()}`, recipient: opts.ballotBox },
  );
  const policyFetch = guardedFetch(opts.fetch, { label: "ballot box", schemes: ["https:"], ...opts.netPolicy }) as typeof fetch;
  let res: Response;
  try {
    res = await withFetchTimeout(policyFetch, opts.timeoutMs ?? DEFAULT_FETCH_TIMEOUT_MS)(opts.endpoint, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(request),
      credentials: "omit",
    });
  } catch (err) {
    throw new Error(
      isFetchTimeout(err)
        ? "The ballot box did not answer in time. Try again later."
        : `The ballot box could not be reached (${(err as Error).message}). Try again later.`,
    );
  }
  let doc: Record<string, unknown>;
  try {
    doc = (await res.json()) as Record<string, unknown>;
  } catch {
    throw new Error(`The ballot box answered ${res.status} with no document.`);
  }
  if (isTrustTaskErrorType(doc.type as string | undefined)) {
    const code = String((doc.payload as { code?: unknown } | undefined)?.code ?? "taskFailed");
    throw new Error(`The ballot box would not show where your vote is on its board (${code}).`);
  }
  if (!res.ok) throw new Error(`The ballot box answered ${res.status}.`);
  if (doc.threadId !== request.id) throw new Error("The ballot box's answer is for another request.");
  // The path proves itself against the signed head; an unsigned answer is still
  // checked, and a signed one also attributes a failed path to the ballot box.
  if (doc.proof) await verifyTrustTaskReply(doc, opts.ballotBox, { proofPurpose: "any" });
  const p = (doc.payload ?? {}) as Partial<BoardInclusion>;
  return {
    leafIndex: Number(p.leafIndex),
    treeSize: Number(p.treeSize),
    entryHash: String(p.entryHash ?? ""),
    path: Array.isArray(p.path) ? p.path.map(String) : [],
  };
}

// ── Credential rolls ─────────────────────────────────────────────────────────

/** The party a `credential` roll admits the holders of a membership credential
 *  for (voting/_shared/0.4 `RollRule`, VTI-VOT-025), as the member is told it. */
export interface RollCredential {
  /** The manifest's `roll.memberOf`: the one DID whose membership credential counts. */
  memberOf: string;
  /** What `memberOf` is to the community, from its disclosure; absent when the
   *  community's disclosure does not say. */
  memberOfKind?: "thisCommunity" | "communityGroup" | "memberParty";
  memberOfName?: string;
}

/**
 * The election's credential roll, or `null` under any other rule. `memberOf` is
 * the manifest's — the digest binds it, and it is what the community checks a
 * presentation against — and the kind and name the disclosure's
 * (`disclosure.rollCredential`, VTI-VOT-090).
 */
export function rollCredentialOf(shown: Pick<VTCElectionsShowResponsePayload, "manifest" | "disclosure">): RollCredential | null {
  const roll = shown.manifest.roll;
  if (roll?.rule !== "credential" || typeof roll.memberOf !== "string" || roll.memberOf === "") return null;
  const d = shown.disclosure?.rollCredential;
  const told = d && d.memberOf === roll.memberOf ? d : undefined;
  return {
    memberOf: roll.memberOf,
    ...(told ? { memberOfKind: told.memberOfKind } : {}),
    ...(told?.memberOfName !== undefined ? { memberOfName: told.memberOfName } : {}),
  };
}

/** A vault credential as `vault/credentials/query` describes it: what choosing one needs. */
export interface HeldCredential {
  id: string;
  issuerDid?: string;
  status?: string;
  lifecycle?: string;
  validUntil?: string;
}

/**
 * Which of the member's credentials to present for a roll naming `memberOf`:
 * an active, valid one whose issuer is **exactly** `memberOf` — the VTA refuses
 * any other (VTI-VOT-016), and a credential from a group of that party is not
 * one from the party. Of several, the one valid longest. `null` when the member
 * holds none, which means they hold no membership of that party here.
 */
export function membershipCredentialFor(held: readonly HeldCredential[], memberOf: string, now: number = Date.now()): string | null {
  const until = (c: HeldCredential): number => (c.validUntil ? Date.parse(c.validUntil) : Number.POSITIVE_INFINITY);
  const usable = held.filter(
    (c) =>
      c.issuerDid === memberOf &&
      (c.lifecycle === undefined || c.lifecycle === "active") &&
      (c.status === undefined || c.status === "valid") &&
      !(until(c) <= now),
  );
  if (usable.length === 0) return null;
  return usable.reduce((best, c) => (until(c) > until(best) ? c : best)).id;
}

/** How the party a roll names is spoken of to the member. */
export function rollPartyWords(rc: RollCredential): string {
  const name = rc.memberOfName?.trim();
  switch (rc.memberOfKind) {
    case "thisCommunity":
      return name ? `this community (${name})` : "this community";
    case "communityGroup":
      return name ? `the group ${name}` : `a group of this community (${rc.memberOf})`;
    case "memberParty":
      return name ? `${name}, a member of this community` : `${rc.memberOf}, a member of this community`;
    default:
      return name ? `${name} (${rc.memberOf})` : rc.memberOf;
  }
}

/**
 * What the member must be told before their membership credential is presented
 * to claim a ticket (VTI-VOT-025, VTI-VOT-090): whose credential counts, and
 * that presenting it shows the community their membership of that party.
 */
export function rollCredentialWarning(rc: RollCredential, communityName: string): string {
  const party = rollPartyWords(rc);
  const of = rc.memberOfKind === "thisCommunity" ? "it" : "that party";
  return `Only holders of a membership credential issued by ${party} take a ticket. Taking one presents yours to ${communityName}, so ${communityName} learns that you are a member of ${of}.`;
}

/**
 * What the member must be told before their membership credential is presented
 * just to read an election put to a member party's members (VTI-VOT-015,
 * VTI-VOT-016, VTI-VOT-090): the community learns the membership before the
 * member has seen what the election asks.
 */
export function readPresentationWarning(memberOf: string, communityName: string): string {
  return `${communityName} shows this election only to members of ${memberOf}. To read it, your agent presents your membership credential issued by ${memberOf} to ${communityName}, which then learns that you are a member of that party — before you have seen what the election asks. No other credential is shown.`;
}

// ── Written answers ──────────────────────────────────────────────────────────

/** The `textReleaseThreshold` the specification advises: a manifest may set as
 *  little as 1 (`voting/_shared/0.3`, VTI-VOT-065), but below this a written
 *  answer released with few others can identify who wrote it. */
export const TEXT_RELEASE_THRESHOLD_ADVISED = 10;

/**
 * What the member must be told before taking a ticket, and again on the ballot,
 * when `threshold` — the manifest's `textReleaseThreshold` — is below the
 * advised 10 (VTI-VOT-090); `null` at or above it. Derived from the manifest:
 * the community's disclosure carries no member for it.
 */
export function textReleaseWarning(threshold: number | undefined): string | null {
  if (typeof threshold !== "number" || !Number.isFinite(threshold) || threshold >= TEXT_RELEASE_THRESHOLD_ADVISED) {
    return null;
  }
  const counted = threshold === 1 ? "1 ballot is" : `${threshold} ballots are`;
  return `Written answers are released once ${counted} counted. Below ${TEXT_RELEASE_THRESHOLD_ADVISED}, a written answer may identify who wrote it.`;
}

// ── The ballot ───────────────────────────────────────────────────────────────

/** Characters as the ballot box counts them (Unicode scalar values), not
 *  UTF-16 code units. */
function scalarLength(s: string): number {
  return [...s].length;
}

function optionKeys(q: Question): string[] {
  return q.type === "text" ? [] : q.options.map((o) => o.key);
}

/**
 * Why `ballot` would be refused for `manifest`, in words for the member, or
 * `null` when it is a ballot the ballot box admits. The same rules as the
 * ballot box's own (`vti_voting::rules::check_ballot`), checked here so the
 * member hears about a mistake in their own window rather than as a refusal
 * after the cast is built. The VTA and the ballot box check again.
 */
export function ballotRefusal(manifest: Manifest, manifestDigest: string, ballot: Ballot): string | null {
  if (ballot.electionId !== manifest.electionId || ballot.manifestDigest !== manifestDigest) {
    return "The ballot is for another election.";
  }
  const answered = new Set<string>();
  for (const a of ballot.answers) {
    const q = manifest.questions.find((x) => x.key === a.question);
    const name = q?.text?.trim() || a.question;
    if (!q) return `The election asks no question ${a.question}.`;
    if (answered.has(a.question)) return `“${name}” is answered twice.`;
    answered.add(a.question);
    const members = (["choice", "ranking", "scores", "text", "abstain"] as const).filter((k) => a[k] !== undefined);
    if (members.length !== 1) return `“${name}” needs exactly one answer.`;
    if (a.abstain !== undefined) {
      if (a.abstain !== true) return `“${name}” is answered wrongly.`;
      if (!q.optional) return `“${name}” must be answered.`;
      continue;
    }
    const opts = new Set(optionKeys(q));
    switch (q.type) {
      case "choice": {
        const c = a.choice;
        if (!c) return `“${name}” takes a choice.`;
        if (new Set(c).size !== c.length || c.some((k) => !opts.has(k))) return `“${name}” has an unknown or repeated option.`;
        if (c.length < q.minSelections || c.length > q.maxSelections) {
          return q.minSelections === q.maxSelections
            ? `Choose ${q.minSelections} for “${name}”.`
            : `Choose between ${q.minSelections} and ${q.maxSelections} for “${name}”.`;
        }
        break;
      }
      case "ranking": {
        const r = a.ranking;
        if (!r) return `“${name}” takes a ranking.`;
        if (new Set(r).size !== r.length || r.some((k) => !opts.has(k))) return `“${name}” has an unknown or repeated option.`;
        if (q.partial ? r.length === 0 : r.length !== opts.size) {
          return q.partial ? `Rank at least one option for “${name}”.` : `Rank every option for “${name}”.`;
        }
        break;
      }
      case "score": {
        const s = a.scores;
        if (!s) return `“${name}” takes scores.`;
        const scored = Object.keys(s);
        if (scored.length !== opts.size || scored.some((k) => !opts.has(k))) return `Score every option for “${name}”.`;
        if (Object.values(s).some((v) => typeof v !== "number" || !Number.isInteger(v) || v < q.min || v > q.max)) {
          return `Scores for “${name}” are whole numbers from ${q.min} to ${q.max}.`;
        }
        break;
      }
      case "text": {
        if (typeof a.text !== "string") return `“${name}” takes text.`;
        if (scalarLength(a.text) > q.maxLength) return `“${name}” takes at most ${q.maxLength} characters.`;
        break;
      }
      default:
        return `“${name}” is a kind of question this wallet cannot answer.`;
    }
  }
  const missing = manifest.questions.find((q) => !answered.has(q.key));
  if (missing) return `“${missing.text?.trim() || missing.key}” is unanswered.`;
  return null;
}

/** A ballot from per-question answers, with every unanswered optional question
 *  abstained. `answers` maps a question key to its one answer member. */
export function ballotOf(
  manifest: Manifest,
  manifestDigest: string,
  answers: Record<string, Omit<Answer, "question">>,
): Ballot {
  return {
    electionId: manifest.electionId,
    manifestDigest,
    answers: manifest.questions.map((q): Answer => {
      const given = answers[q.key];
      return given ? ({ question: q.key, ...given } as Answer) : { question: q.key, abstain: true };
    }) as Ballot["answers"],
  };
}

// ── The cast ─────────────────────────────────────────────────────────────────

/** The longest pause before a cast is sent, so its arrival is not timed to the
 *  member's ticket — the same bound `pnm elections vote` uses. */
export const MAX_CAST_DELAY_MS = 20_000;

/** A random pause in [0, MAX_CAST_DELAY_MS). */
export function castDelayMs(random: () => number = Math.random): number {
  return Math.floor(random() * MAX_CAST_DELAY_MS);
}

/** The ballot box refused the cast: `code` is the Trust Task error code. */
export class CastRefusedError extends Error {
  readonly reason = "castRefused" as const;
  constructor(readonly code: string, message: string) {
    super(message);
    this.name = "CastRefusedError";
  }
}

export interface PostCastOptions {
  /** The ballot box's DID — the manifest's `ballotBox`. The receipt must be its. */
  ballotBox: string;
  /** `<TrustTaskHTTPS base>/trust-tasks`, from the ballot box's DID document. */
  endpoint: string;
  fetch?: typeof fetch;
  netPolicy?: NetPolicy;
  timeoutMs?: number;
}

/**
 * POST a cast the VTA built to the ballot box, and return its receipt — the
 * whole signed document, which is the evidence the VTA keeps.
 *
 * The cast goes out exactly as the VTA returned it. The receipt is believed
 * only once it is the ballot box's (its proof verifies and names the ballot
 * box), threaded to this cast and addressed back to the cast's one-time key.
 * Resending the same cast after a lost answer is safe: the ballot box answers a
 * replay with the first receipt.
 */
export async function postCast(cast: Record<string, unknown>, opts: PostCastOptions): Promise<Record<string, unknown>> {
  if (cast.recipient !== opts.ballotBox) {
    throw new Error("The cast is addressed to another ballot box than the election names.");
  }
  const policyFetch = guardedFetch(opts.fetch, {
    label: "ballot box",
    schemes: ["https:"],
    ...opts.netPolicy,
  }) as typeof fetch;
  const timeoutMs = opts.timeoutMs ?? DEFAULT_FETCH_TIMEOUT_MS;
  let res: Response;
  try {
    res = await withFetchTimeout(policyFetch, timeoutMs)(opts.endpoint, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(cast),
      credentials: "omit",
    });
  } catch (err) {
    throw new Error(
      isFetchTimeout(err)
        ? "The ballot box did not answer in time. Vote again to resend the same cast."
        : `The ballot box could not be reached (${(err as Error).message}). Vote again to resend the same cast.`,
    );
  }
  let doc: Record<string, unknown>;
  try {
    doc = (await res.json()) as Record<string, unknown>;
  } catch {
    throw new Error(`The ballot box answered ${res.status} with no document.`);
  }
  if (isTrustTaskErrorType(doc.type as string | undefined)) {
    const code = String((doc.payload as { code?: unknown } | undefined)?.code ?? "taskFailed");
    throw new CastRefusedError(code, castRefusalWords(code));
  }
  if (!res.ok) throw new Error(`The ballot box answered ${res.status}.`);
  await verifyTrustTaskReply(doc, opts.ballotBox, { proofPurpose: "any" });
  if (doc.threadId !== (cast.threadId ?? cast.id)) throw new Error("The ballot box's receipt answers another cast.");
  if (doc.recipient !== cast.issuer) throw new Error("The ballot box's receipt is addressed to someone else.");
  return doc;
}

/** A ballot box's refusal of a cast, in words for the member. */
export function castRefusalWords(code: string): string {
  const local = code.slice(code.lastIndexOf(":") + 1);
  const said: Record<string, string> = {
    notOpen: "Voting is not open for this election.",
    alreadyVoted: "You have voted in this election already, and it does not let a later vote replace an earlier one.",
    electionUnknown: "The ballot box does not know this election.",
    castInvalid: "The ballot box did not accept your ticket for this vote.",
    classMismatch: "Your ticket is for another election.",
    wrongLevel: "This election is counted another way than your wallet cast it. Update your wallet.",
    ballotInvalid: "The ballot box did not accept the ballot as filled in.",
    manifestMismatch: "The ballot box holds another version of this election.",
  };
  return said[local] ?? `The ballot box refused the vote (${code}).`;
}
