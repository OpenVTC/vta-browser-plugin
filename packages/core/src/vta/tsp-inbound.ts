// Executor-initiated TSP messages: verify one, and shape it like the DIDComm
// inbound the wallet already knows how to handle.
//
// The VTA pushes `task-consent` and step-up requests to a wallet. Over DIDComm
// those arrive as a binding envelope (`TRUST_TASK_ENVELOPE_TYPE`) whose `body`
// is the Trust-Task document. Over TSP the plaintext *is* the document, with no
// wrapper — so the two paths differ only in carriage, and this module makes
// that the only difference the inbound pipeline sees.
//
// **The pipeline is already document-centric**, which is why the adaptation is
// honest rather than a fudge: `parseTaskConsentRequest` verifies the
// Data-Integrity proof on the document, and dedup is claimed on the document
// (SPEC §7.2 item 11 — "transport message identifiers MUST NOT substitute for
// the document `id`"). Nothing downstream trusts the envelope for anything
// security-bearing. What it does read is `type`, as the discriminator for "this
// carries a Trust-Task document", and `from`, for the sender — and both of
// those this module supplies truthfully.
//
// **The sender is a candidate until unpack proves it.** A TSP frame names its
// sender and receiver in cleartext CESR, before any crypto, which is how the
// mediator routes without keys. We read that VID only to look up which keys to
// try; `unpack` then verifies the Ed25519 signature and the HPKE-Auth
// sender-binding against them, so a frame claiming to be from an executor it
// cannot authenticate as fails there rather than reaching a human. Reading the
// cleartext VID and *believing* it are different acts, and only the first
// happens here.

import { decodeEnvelope, unpack } from "@openvtc/vti-tsp-js";

import { VtaClientError } from "./errors.js";
import { TRUST_TASK_ENVELOPE_TYPE } from "./protocol.js";
import type { TspHolderIdentity, TspRemoteEndpoint } from "./tsp-channel.js";

const fromUtf8 = new TextDecoder();

export interface UnpackInboundTspOptions {
  /** The wallet identity the frame is sealed to. */
  holder: TspHolderIdentity;
  /** Resolve a sender VID to its TSP keys. Called with the VID the frame names
   *  in cleartext, whose authenticity `unpack` then decides. */
  resolveSender: (vid: string) => Promise<TspRemoteEndpoint>;
}

/**
 * The DIDComm-shaped message an inbound TSP frame becomes.
 *
 * `id` is the **Trust-Task document's** id, not a transport id — TSP has no
 * envelope id to borrow, and the document id is the one SPEC §7.2 item 11 says
 * to key on anyway. That makes the TSP path structurally closer to the spec
 * than the DIDComm one, where `message.id` is the sender's transport id and
 * dedup has to reach past it into `body`.
 */
export interface InboundTspMessage extends Record<string, unknown> {
  id: string;
  type: string;
  from: string;
  to: string[];
  body: Record<string, unknown>;
}

/**
 * Verify a sealed inbound TSP frame and shape it for the inbound pipeline.
 *
 * Throws a {@link VtaClientError} when the frame is unreadable, unverifiable,
 * or carries something that is not a Trust-Task document. Every one of those is
 * a message that must not reach a prompt.
 */
export async function unpackInboundTsp(
  bytes: Uint8Array,
  opts: UnpackInboundTspOptions,
): Promise<InboundTspMessage> {
  let claimedSender: string;
  try {
    claimedSender = decodeEnvelope(bytes).envelope.sender;
  } catch (err) {
    throw new VtaClientError(
      "e.client.parse",
      `tsp inbound: unreadable envelope: ${(err as Error).message}`,
    );
  }

  let sender: TspRemoteEndpoint;
  try {
    sender = await opts.resolveSender(claimedSender);
  } catch (err) {
    throw new VtaClientError(
      "e.client.parse",
      `tsp inbound: cannot resolve sender ${claimedSender}: ${(err as Error).message}`,
    );
  }

  let opened;
  try {
    opened = await unpack(bytes, {
      receiverDecryptionKey: opts.holder.encryptionPrivateKey,
      senderEncryptionKey: sender.encryptionPublicKey,
      senderSigningKey: sender.signingPublicKey,
    });
  } catch (err) {
    // Signature or sender-auth failure: the cleartext VID was a claim this
    // frame could not back up.
    throw new VtaClientError(
      "e.p.msg.unauthorized",
      `tsp inbound: unpack failed for claimed sender ${claimedSender}: ${(err as Error).message}`,
    );
  }

  // `unpack` verified against the keys we resolved for `claimedSender`, so a
  // disagreement here would mean the library reported a sender it did not
  // check. Cheap to assert, and the assertion is the whole basis for putting
  // `from` on the message below.
  if (opened.sender !== claimedSender) {
    throw new VtaClientError(
      "e.p.msg.unauthorized",
      `tsp inbound: proven sender ${opened.sender} != envelope sender ${claimedSender}`,
    );
  }

  let doc: Record<string, unknown>;
  try {
    doc = JSON.parse(fromUtf8.decode(opened.payload)) as Record<string, unknown>;
  } catch (err) {
    throw new VtaClientError(
      "e.client.parse",
      `tsp inbound: payload is not JSON: ${(err as Error).message}`,
    );
  }

  const id = typeof doc.id === "string" ? doc.id : undefined;
  if (!id || typeof doc.type !== "string") {
    // Not a Trust-Task document. Refused rather than forwarded: the pipeline
    // would key dedup on a missing id, and an inbound with no stable identity
    // is one that cannot be de-duplicated or recovered.
    throw new VtaClientError(
      "e.client.parse",
      "tsp inbound: payload is not a Trust-Task document (no `id`/`type`)",
    );
  }

  return {
    id,
    // The discriminator the inbound parsers read for "carries a Trust-Task
    // document". It is spelled as the DIDComm binding's envelope type because
    // that is the constant those parsers compare against; it says what the
    // message contains, not which wire carried it. The transport is recorded
    // separately below rather than encoded in this field.
    type: TRUST_TASK_ENVELOPE_TYPE,
    from: opened.sender,
    to: [opts.holder.vid],
    body: doc,
    transport: "tsp",
  };
}
