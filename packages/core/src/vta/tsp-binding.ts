// The TSP transport binding: how a Trust Task is carried in a TSP payload.
//
// One module, both directions — outbound frames are wrapped here and inbound
// ones opened here, so the binding is a single fact about this package rather
// than a convention each path remembers. The next transport should be a module
// beside this one, not an edit spread across every sender and receiver.
//
// ## Why TSP needs a wrapper when the other two bindings do not
//
// Each binding has to say "this payload is a Trust Task" somewhere a reader can
// see before parsing. HTTPS says it with the request path (`POST …/trust-tasks`)
// and DIDComm with the message `type`. A TSP frame has neither — a sender VID, a
// recipient VID and opaque bytes — so the binding puts it in the JSON.
//
// ## What this replaces
//
// Both ends of this workspace sealed the bare document and said so in comments:
// this package's `tsp-channel.ts` carried "TSP plaintext = the Trust-Task
// envelope JSON (no binding wrapper)", and the VTA's inbound module called its
// payload "identical to the REST body". They agreed with each other and with
// nothing else — a conformant peer built on `trust-tasks-tsp` would have refused
// every frame with `WrongEnvelopeType`, and neither side could have used the
// binding library at all. Cut over with the VTA in one change; nothing is
// deployed, so there is no window to keep the old shape alive for.

import { VtaClientError } from "./errors.js";
import { TSP_BINDING_ENVELOPE_TYPE } from "./protocol.js";

/** Wrap a Trust-Task document in the binding envelope. */
export function wrapTspEnvelope(document: unknown): string {
  return JSON.stringify({ type: TSP_BINDING_ENVELOPE_TYPE, document });
}

/**
 * Open a TSP binding envelope and return the Trust-Task document.
 *
 * A payload that is not an envelope, or carries another binding's type, is
 * refused rather than read as a document. Accepting a bare one "just in case"
 * would keep the old dialect alive on the wire for as long as anything spoke
 * it, and the refusal is what tells a misconfigured peer which half is wrong.
 */
export function openTspEnvelope(plaintext: string): Record<string, unknown> {
  let envelope: unknown;
  try {
    envelope = JSON.parse(plaintext);
  } catch (err) {
    throw new VtaClientError(
      "e.client.parse",
      `tsp: payload is not JSON: ${(err as Error).message}`,
    );
  }
  if (typeof envelope !== "object" || envelope === null) {
    throw new VtaClientError("e.client.parse", "tsp: payload is not an object");
  }
  const { type, document } = envelope as { type?: unknown; document?: unknown };
  if (type !== TSP_BINDING_ENVELOPE_TYPE) {
    // Names what arrived, so a peer sending another binding's wrapper — or the
    // bare document this workspace used to send — can see which it did.
    throw new VtaClientError(
      "e.client.parse",
      `tsp: payload is not a ${TSP_BINDING_ENVELOPE_TYPE} envelope (got ${JSON.stringify(type)})`,
    );
  }
  if (typeof document !== "object" || document === null) {
    throw new VtaClientError("e.client.parse", "tsp: envelope carries no `document`");
  }
  return document as Record<string, unknown>;
}
