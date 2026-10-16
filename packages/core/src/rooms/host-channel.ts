// The channel to a room's host — HTTPS, no bearer.
//
// Two kinds of document travel on it. A **completed** document — one the
// member's VTA finished as the member (`rooms/keys/act`), presentation and
// proof included — goes out exactly as it came back (`sendCompleted`): nothing
// here signs it, and nothing here could, since the member's key is the VTA's.
// A document signed **here** (`send`) is one signed by a key this context
// holds: the single-use upload key a proxied upload's chunks, commit and abort
// are signed by (`rooms/blobs/upload/*/0.2`).
//
// A room call carries no session. The host authorises it from the presentation
// in the payload, which the member's VTA minted for the DID that signs the
// document, so the document's proof is the only credential on the wire and this
// channel is the whole of the transport: sign, POST to the host's Trust-Task
// endpoint, and believe the reply only once it is the host's — signed by the
// host's DID for `authentication`, threaded to this request and addressed back
// to its issuer (`decodeTrustTaskHttpReply`).
//
// The endpoint comes from the host's DID document (`TrustTaskHTTPS`, matched on
// the service type) and is held to the same policy as the VTA's REST endpoint:
// `https:` only, a public address, never followed through a redirect.

import { guardedFetch } from "@openvtc/vti-didcomm-js/net-guard";

import { resolveDidDocument, type NetPolicy } from "../didcomm/index.js";
import { withFetchTimeout, isFetchTimeout, DEFAULT_FETCH_TIMEOUT_MS } from "../http/timeout-fetch.js";
import type { SendOpts, TrustTaskSender } from "../vta/channel.js";
import { trustTaskBaseFromDocument, trustTaskUrl } from "../vta/endpoint.js";
import { VtaClientError } from "../vta/errors.js";
import { decodeTrustTaskHttpReply } from "../vta/http-reply.js";
import type { TrustTask } from "../vta/protocol.js";
import { asTaskSigner, signOutboundTask, type ChannelSigner, type TaskSigner } from "../vta/trust-task.js";

export interface RoomHostChannelOptions {
  /** The host's DID: every document is addressed to it and every reply must be signed by it. */
  hostDid: string;
  /** The dispatcher URL, `<TrustTaskHTTPS base>/trust-tasks`. See {@link roomHostEndpoint}. */
  endpoint: string;
  /** Signs what `send` sends: an upload's single-use key. Absent on a channel
   *  that carries only completed documents (`sendCompleted`). */
  signing?: ChannelSigner;
  fetch?: typeof fetch;
  netPolicy?: NetPolicy;
}

/** A `TrustTaskSender` for one room host. */
export class RoomHostChannel implements TrustTaskSender {
  readonly hostDid: string;
  private readonly endpoint: string;
  private readonly signer: TaskSigner | undefined;
  private readonly policyFetch: typeof fetch;

  constructor(opts: RoomHostChannelOptions) {
    this.hostDid = opts.hostDid;
    this.endpoint = opts.endpoint;
    this.signer = opts.signing ? asTaskSigner(opts.signing) : undefined;
    this.policyFetch = guardedFetch(opts.fetch, {
      label: "room host",
      schemes: ["https:"],
      ...opts.netPolicy,
    }) as typeof fetch;
  }

  async send<Res>(envelope: TrustTask<unknown>, opts: SendOpts = {}): Promise<Res> {
    const label = opts.operationLabel ?? envelope.type;
    // A document addressed elsewhere would be signed by this caller and handed
    // to a host it does not name — refused before it is signed.
    this.checkAddressed(envelope, label);
    if (!this.signer) {
      throw new VtaClientError(
        "e.client.identity",
        `${label}: this channel to ${this.hostDid} carries completed documents only, and signs nothing`,
      );
    }
    await signOutboundTask(envelope, this.signer);
    return this.post<Res>(envelope, label, opts);
  }

  /**
   * Send a document the member's VTA completed (`rooms/keys/act`), unchanged.
   *
   * It must already carry its proof and its issuer — the member — and be
   * addressed to this host. The reply is believed only once it is the host's,
   * threaded to this document and addressed back to the member.
   */
  async sendCompleted<Res>(document: Record<string, unknown>, opts: SendOpts = {}): Promise<Res> {
    const envelope = document as unknown as TrustTask<unknown>;
    const label = opts.operationLabel ?? String(envelope.type);
    this.checkAddressed(envelope, label);
    if (typeof envelope.issuer !== "string" || !(document as { proof?: unknown }).proof) {
      throw new VtaClientError(
        "e.client.identity",
        `${label}: the document came back from the VTA without an issuer or a proof, so it is not one the member signed`,
      );
    }
    return this.post<Res>(envelope, label, opts);
  }

  private checkAddressed(envelope: TrustTask<unknown>, label: string): void {
    if (envelope.recipient !== this.hostDid) {
      throw new VtaClientError(
        "e.client.parse",
        `${label}: the document is addressed to ${String(envelope.recipient)}, not to the host ${this.hostDid}`,
      );
    }
  }

  private async post<Res>(envelope: TrustTask<unknown>, label: string, opts: SendOpts): Promise<Res> {
    const timeoutMs = opts.timeoutMs ?? DEFAULT_FETCH_TIMEOUT_MS;
    let res: Response;
    try {
      res = await withFetchTimeout(this.policyFetch, timeoutMs)(this.endpoint, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(envelope),
        // `guardedFetch` refuses a redirect rather than following it.
        credentials: "omit",
      });
    } catch (err) {
      if (isFetchTimeout(err)) {
        throw new VtaClientError("e.client.timeout", `${label}: the room host did not respond within ${timeoutMs / 1000}s`);
      }
      throw new VtaClientError("e.client.network", `${label}: the room host could not be reached (${(err as Error).message})`);
    }
    return decodeTrustTaskHttpReply<Res>(res, {
      ...(opts.expectedResponseType !== undefined ? { expectedResponseType: opts.expectedResponseType } : {}),
      operationLabel: label,
      expectedSigner: this.hostDid,
      inReplyTo: envelope,
    });
  }
}

/**
 * The host's dispatcher URL, from its DID document.
 *
 * Refuses a host that advertises no `TrustTaskHTTPS` service rather than
 * guessing one from the DID's domain: the document is the authority for where a
 * party listens, and a guessed URL is one the host never said it serves.
 */
export async function roomHostEndpoint(
  hostDid: string,
  resolve: (did: string) => Promise<Record<string, unknown>> = resolveDidDocument,
): Promise<string> {
  const doc = await resolve(hostDid);
  const base = trustTaskBaseFromDocument(doc);
  if (!base) {
    throw new VtaClientError(
      "e.client.parse",
      `${hostDid} advertises no TrustTaskHTTPS service, so there is nowhere to send a room request`,
    );
  }
  return trustTaskUrl(base);
}
