// Forming the TSP relationship a Rev 3 peer requires before it will accept
// anything (7.2.2).
//
// Rev 3 turned relationships from bookkeeping into a precondition: "if an
// endpoint receives an application message destined to one of its legitimate
// VIDs, but it has not established a relationship from the source VID in the
// message to its own VID, it SHOULD drop the message." The message is dropped,
// not refused -- nothing comes back -- so a wallet that skips this does not get
// an error, it gets a 30-second timeout and a transport that looks broken.
//
// `@openvtc/vti-tsp-js` owns the wire form and the state machine, both pure.
// This module owns the part that needs a transport and somewhere to remember
// things, which is why it is here and not there.
//
// -- Why the wallet must not over-trust its own record --
//
// The far side's relationship state is **in-memory by default**:
// `affinidi-messaging-sdk`'s `RelationshipStore` defaults to
// `InMemoryRelationshipStore`, so unless a deployment supplies a durable one, a
// VTA forgets every relationship it holds when its process restarts. A wallet
// that persisted "we are related" and believed it would then send application
// messages into a silence, indefinitely, with nothing on either side saying why.
//
// So the record here is a cache of a belief about someone else's memory, not a
// fact, and it is treated that way: a failed send clears it (see
// `forgetOnFailure`) and the next attempt re-invites. That is one wasted round
// trip after a VTA restart, against an otherwise permanent silent failure.
//
// -- Why a timed-out handshake still sends --
//
// The mirror risk is a VTA that does not implement control messages at all: it
// never answers the invite, and a wallet that waited for an accept before ever
// sending would have broken itself against a peer that would have taken the
// message happily. So the handshake is best-effort -- invite, wait briefly,
// proceed either way. A gating peer has accepted by then; a non-gating peer
// never cared; and a gating peer that was slow drops this one message and works
// on the retry, which is strictly better than never sending at all.

import {
  packInvite,
  resolveAccept,
  unpack,
  transition,
  type ControlMessage,
  type RelationshipState,
} from "@openvtc/vti-tsp-js";

import type { TspFrameClaim } from "../didcomm/index.js";
import type { TspHolderIdentity, TspRemoteEndpoint, TspTransport } from "./tsp-channel.js";

/** How long to wait for an accept before sending anyway. Deliberately far
 *  shorter than a request timeout: this is a courtesy round trip, and a peer
 *  that has not answered in this long is one that is not going to. */
export const DEFAULT_HANDSHAKE_TIMEOUT_MS = 5_000;

/** What we believe about one (ourVid, theirVid) pair. */
export interface RelationshipRecord {
  state: RelationshipState;
  /** Hex digest of the invite we sent, when we sent one. The accept echoes it,
   *  and a later cancellation may name it (7.2.1). */
  ourDigest?: string;
  /** Hex digest of the other half -- their invite, or the accept they sent. */
  theirDigest?: string;
}

/**
 * Where relationship records live.
 *
 * Injected rather than imported because `vta/` sits below `store/` in this
 * package's layering, and because durability is a deployment question -- see
 * the module note on why persisting harder than the far side does is not
 * automatically an improvement.
 */
export interface RelationshipStore {
  get(ourVid: string, theirVid: string): Promise<RelationshipRecord | undefined>;
  set(ourVid: string, theirVid: string, record: RelationshipRecord): Promise<void>;
  clear(ourVid: string, theirVid: string): Promise<void>;
}

/**
 * The default store: in memory, for the life of the channel.
 *
 * Matching the far side's own default is the point. A relationship this wallet
 * remembered across a service-worker teardown, against a VTA that forgot it on
 * restart, is a message dropped in silence -- so the cheap, symmetric answer is
 * to re-invite when we come back, which costs one round trip and cannot go
 * quietly wrong.
 */
export class MemoryRelationshipStore implements RelationshipStore {
  private readonly records = new Map<string, RelationshipRecord>();

  /** Keyed on the pair, not the peer: one wallet may hold several VIDs, and a
   *  relationship belongs to a direction rather than to a party. JSON rather
   *  than a separator character, because a DID may contain most of them. */
  private key(ourVid: string, theirVid: string): string {
    return JSON.stringify([ourVid, theirVid]);
  }

  async get(ourVid: string, theirVid: string): Promise<RelationshipRecord | undefined> {
    return this.records.get(this.key(ourVid, theirVid));
  }

  async set(ourVid: string, theirVid: string, record: RelationshipRecord): Promise<void> {
    this.records.set(this.key(ourVid, theirVid), record);
  }

  async clear(ourVid: string, theirVid: string): Promise<void> {
    this.records.delete(this.key(ourVid, theirVid));
  }
}

const toHex = (bytes: Uint8Array): string =>
  Array.from(bytes, (b) => b.toString(16).padStart(2, "0")).join("");

export interface EnsureRelationshipOpts {
  transport: TspTransport;
  holder: TspHolderIdentity;
  vta: TspRemoteEndpoint;
  store: RelationshipStore;
  handshakeTimeoutMs?: number;
  /** Called with a one-line account of what happened, for diagnostics. A
   *  handshake that silently did nothing is indistinguishable from one that was
   *  never attempted. */
  onOutcome?: (outcome: RelationshipOutcome) => void;
}

export type RelationshipOutcome =
  | { kind: "alreadyEstablished" }
  | { kind: "established"; threadDigest: string }
  | { kind: "notAnswered"; reason: string }
  | { kind: "refused"; reason: string };

/**
 * Ensure a relationship with the VTA before an application message is sent.
 *
 * Best-effort by design -- see the module note. Never throws: every outcome is
 * reported through `onOutcome` and the caller proceeds, because the one thing
 * worse than an unformed relationship is a wallet that will not send at all.
 */
export async function ensureRelationship(
  opts: EnsureRelationshipOpts,
): Promise<RelationshipOutcome> {
  const { transport, holder, vta, store } = opts;
  const report = (outcome: RelationshipOutcome): RelationshipOutcome => {
    opts.onOutcome?.(outcome);
    return outcome;
  };

  const existing = await store.get(holder.vid, vta.vid);
  if (existing?.state === "bidirectional") {
    return report({ kind: "alreadyEstablished" });
  }

  // `transition` is the specification's own table: it refuses `sendInvite` from
  // any state but `none`, which is what stops a re-invite being sent to a peer
  // that would reject it as an invalid transition.
  const from = existing?.state ?? "none";
  let pending: RelationshipState;
  try {
    pending = transition(from, "sendInvite");
  } catch (err) {
    return report({ kind: "refused", reason: (err as Error).message });
  }

  let invite;
  try {
    invite = await packInvite(holder.vid, vta.vid, {
      senderSigningKey: holder.signingPrivateKey,
      receiverEncryptionKey: vta.encryptionPublicKey,
    });
  } catch (err) {
    return report({ kind: "refused", reason: `could not pack invite: ${(err as Error).message}` });
  }

  // The accept must be sealed by the VTA, be a control message, be an accept,
  // and echo *our* invite's digest. The last is the one that matters: on a
  // shared socket an accept to somebody else's invite is a frame we can read
  // and must not claim.
  let declined: string | undefined;
  const claims: TspFrameClaim = async (bytes) => {
    let reply: { sender: string; messageType: string; control?: ControlMessage };
    try {
      reply = await unpack(bytes, {
        receiverDecryptionKey: holder.encryptionPrivateKey,
        senderSigningKey: vta.signingPublicKey,
      });
    } catch (err) {
      declined = `unpack failed: ${(err as Error).message}`;
      return false;
    }
    if (reply.sender !== vta.vid) {
      declined = `sealed by ${reply.sender}, not the VTA`;
      return false;
    }
    const control = reply.control;
    if (reply.messageType !== "control" || !control) {
      declined = `not a control message (${reply.messageType})`;
      return false;
    }
    if (control.controlType !== "accept") {
      declined = `a ${control.controlType}, not an accept`;
      return false;
    }
    const outcome = resolveAccept(pending, control.inReplyTo, invite.threadDigest);
    if (outcome.action === "ignore") {
      declined = `an accept that ${outcome.reason}`;
      return false;
    }
    return true;
  };

  await store.set(holder.vid, vta.vid, {
    state: pending,
    ourDigest: toHex(invite.threadDigest),
  });

  try {
    await transport.sendAndAwaitReply(invite.bytes, {
      timeoutMs: opts.handshakeTimeoutMs ?? DEFAULT_HANDSHAKE_TIMEOUT_MS,
      claims,
    });
  } catch (err) {
    // Left at `pending`, not cleared: we did send an invite, and a peer that
    // answers late is a peer we are related to. Clearing here would make the
    // next send re-invite a VTA that had already accepted, which its own state
    // machine refuses as an invalid transition.
    const reason = declined
      ? `${(err as Error).message} -- last frame declined: ${declined}`
      : (err as Error).message;
    return report({ kind: "notAnswered", reason });
  }

  await store.set(holder.vid, vta.vid, {
    state: transition(pending, "receiveAccept"),
    ourDigest: toHex(invite.threadDigest),
  });
  return report({ kind: "established", threadDigest: toHex(invite.threadDigest) });
}

/**
 * Forget the relationship after a send failed.
 *
 * The far side's state is in-memory by default, so "my message went nowhere" is
 * most often "the VTA restarted and no longer knows me". Clearing makes the next
 * attempt re-invite; leaving it cached makes every subsequent send fail the same
 * silent way.
 */
export async function forgetOnFailure(
  store: RelationshipStore,
  ourVid: string,
  theirVid: string,
): Promise<void> {
  await store.clear(ourVid, theirVid);
}
