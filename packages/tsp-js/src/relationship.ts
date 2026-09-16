// The TSP relationship state machine (§7.2, §7.3).
//
// Where DIDComm's relationships are implicit, TSP's are explicit, and Rev 3
// made them load-bearing: §7.2.2 says an endpoint SHOULD drop an application
// message from a VID it holds no relationship with. So this is not bookkeeping
// — it decides whether anything we send arrives.
//
//   None ──[send RFI]──► Pending ──[receive RFA]──► Bidirectional
//    │                      │                            │
//    │  [receive RFI]       │  [receive RFD]             │ [send/receive RFD]
//    ▼                      ▼                            ▼
//   InviteReceived         None                         None
//    │
//    │  [send RFA]
//    ▼
//   Bidirectional
//
// ── Why this is here and not in the wallet ──
//
// Everything in this module is a pure function: state plus event in, state or a
// refusal out. No storage, no clock, no keys. That is the line — this package
// owns *what the protocol says happens next*, and the wallet owns *where that
// is written down*, because only it knows about `chrome.storage` and MV3
// teardown. Putting the rules here is what lets them be tested against the
// specification rather than against a mock of a store.
//
// It is also why `unpack` does not apply them. A codec that silently mutated
// relationship state would make receiving a message a side effect, and the one
// thing a wallet must be able to do is look at an invite before answering it.

/** The state of a relationship between two VIDs, from our side. */
export type RelationshipState = "none" | "pending" | "inviteReceived" | "bidirectional";

/** What just happened. */
export type RelationshipEvent =
  | "sendInvite"
  | "receiveInvite"
  | "sendAccept"
  | "receiveAccept"
  | "sendCancel"
  | "receiveCancel";

/** A transition the state machine does not allow. Carries both halves so a
 *  caller can say what it refused rather than only that it did. */
export class InvalidTransitionError extends Error {
  readonly code = "E_TSP_TRANSITION" as const;
  readonly state: RelationshipState;
  readonly event: RelationshipEvent;

  constructor(state: RelationshipState, event: RelationshipEvent) {
    super(`tsp: cannot ${event} in relationship state ${state}`);
    this.name = "InvalidTransitionError";
    this.state = state;
    this.event = event;
  }
}

const TRANSITIONS: Record<RelationshipState, Partial<Record<RelationshipEvent, RelationshipState>>> = {
  none: {
    sendInvite: "pending",
    receiveInvite: "inviteReceived",
  },
  pending: {
    receiveAccept: "bidirectional",
    receiveCancel: "none",
    sendCancel: "none",
  },
  inviteReceived: {
    sendAccept: "bidirectional",
    sendCancel: "none",
    // The inviter withdrew before we answered. §7.3 removes the relationship in
    // this direction; the mirror case, where we decline, is `sendCancel`.
    receiveCancel: "none",
  },
  bidirectional: {
    sendCancel: "none",
    receiveCancel: "none",
  },
};

/** Apply a transition, or throw {@link InvalidTransitionError}. */
export function transition(
  state: RelationshipState,
  event: RelationshipEvent,
): RelationshipState {
  const next = TRANSITIONS[state][event];
  if (next === undefined) throw new InvalidTransitionError(state, event);
  return next;
}

/** May we send an application message in this state? */
export function canSend(state: RelationshipState): boolean {
  return state === "bidirectional";
}

/**
 * Does this state admit an inbound application message under §7.2.2?
 *
 * **Any** recorded relationship does, not only a completed one. Receiving an
 * invite records the inbound half, and §3.6 lets a sender pack user data
 * alongside its invite rather than wait a round trip — so gating on
 * `bidirectional` alone would drop messages the specification expects to
 * arrive. This asymmetry with {@link canSend} is deliberate on both sides: we
 * are strict about what we send and lenient about what we accept, which is the
 * only ordering that cannot deadlock.
 */
export function admitsApplicationMessage(state: RelationshipState): boolean {
  return state !== "none";
}

/** What to do with an invite that arrived while our own was outstanding. */
export type InviteRaceOutcome =
  | { keep: "ours"; reason: string }
  | { keep: "theirs"; reason: string };

/**
 * Resolve the §7.2.3 invite race.
 *
 * Both endpoints may invite each other for the same VID pair at once. Both keep
 * the invite whose digest is lexicographically **lower** and discard the other,
 * so the two sides converge on one exchange and one thread id instead of each
 * believing it opened the relationship.
 *
 * The rule only works because both sides compute it the same way on the same
 * two values, so this compares bytes and nothing else — no timestamps, no
 * "ours wins", no tie-break on VID. A tie means the same digest, which means
 * the same message, which cannot be two invites.
 */
export function resolveInviteRace(
  ourInviteDigest: Uint8Array,
  theirInviteDigest: Uint8Array,
): InviteRaceOutcome {
  const cmp = compareBytes(ourInviteDigest, theirInviteDigest);
  if (cmp < 0) {
    return { keep: "ours", reason: "our invite has the lower digest; discard theirs" };
  }
  return { keep: "theirs", reason: "their invite has the lower digest; adopt it and drop ours" };
}

/** Lexicographic byte comparison, as §7.2.3's rule requires. */
export function compareBytes(a: Uint8Array, b: Uint8Array): number {
  const n = Math.min(a.length, b.length);
  for (let i = 0; i < n; i++) {
    if (a[i]! !== b[i]!) return a[i]! < b[i]! ? -1 : 1;
  }
  return a.length - b.length;
}

/** What a received accept calls for, per §7.2.2. */
export type AcceptOutcome =
  /** It answers our outstanding invite: apply `receiveAccept`. */
  | { action: "adopt" }
  /** Drop it silently — it answers nothing we sent. */
  | { action: "ignore"; reason: string };

/**
 * Decide whether a received accept answers our invite (§7.2.2).
 *
 * An accept's Digest is copied verbatim from the invite it answers, so it must
 * equal the digest of the invite we have outstanding. Anything else — no invite
 * outstanding, or a digest naming an invite we never sent — is ignored rather
 * than answered, for the same reason {@link resolveCancel} ignores an unknown
 * cancellation. {@link transition} alone cannot make this check: it sees the
 * state, not the digests.
 *
 * `answeredDigest` is the accept's Digest; `ourInviteDigest` is the digest of
 * the invite we sent, or `undefined` if we hold none.
 */
export function resolveAccept(
  state: RelationshipState,
  answeredDigest: Uint8Array | undefined,
  ourInviteDigest: Uint8Array | undefined,
): AcceptOutcome {
  if (state !== "pending" || ourInviteDigest === undefined) {
    return { action: "ignore", reason: "answers no invite we have outstanding" };
  }
  if (answeredDigest === undefined || compareBytes(answeredDigest, ourInviteDigest) !== 0) {
    return { action: "ignore", reason: "answers an invite we did not send" };
  }
  return { action: "adopt" };
}

/** What a cancellation calls for, per §7.3. */
export type CancelOutcome =
  /** Ignore it entirely — we hold nothing it could be about. */
  | { action: "ignore"; reason: string }
  /** Remove our half; send no reply. */
  | { action: "remove" }
  /** Remove our half, and answer with a cancellation of our own. */
  | { action: "removeAndReply" };

/**
 * Decide what a received cancellation calls for (§7.3).
 *
 *   nothing held       -> ignore entirely
 *   one direction only -> remove it, no reply
 *   bidirectional      -> reply with a cancellation, then remove
 *
 * A cancellation naming a relationship we do not recognise is **ignored rather
 * than answered**, and that is a privacy property, not tidiness: answering
 * would let anyone probe which relationships we hold by cancelling ones they
 * guessed at.
 *
 * `namedDigest` is the digest the cancellation carries; `knownDigests` are the
 * digests of the halves we hold for this peer — §7.2.1 lets a cancellation name
 * either, which is why this takes a set rather than one value.
 */
export function resolveCancel(
  state: RelationshipState,
  namedDigest: Uint8Array | undefined,
  knownDigests: readonly Uint8Array[],
): CancelOutcome {
  if (state === "none") {
    return { action: "ignore", reason: "names no relationship we hold" };
  }
  if (namedDigest !== undefined && !knownDigests.some((d) => compareBytes(d, namedDigest) === 0)) {
    return { action: "ignore", reason: "names an unrecognised relationship" };
  }
  return state === "bidirectional" ? { action: "removeAndReply" } : { action: "remove" };
}
