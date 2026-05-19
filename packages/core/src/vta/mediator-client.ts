import {
  Identity,
  packAuthcrypt,
  unpackMessage,
  type PublicJwk,
} from "../didcomm/index.js";
import type { RemoteDidcommEndpoint } from "./didcomm.js";
import { VtaClientError, type VtaErrorCode } from "./errors.js";
import {
  CoordinateMediationProtocol,
  type KeylistBody,
  type KeylistQueryBody,
  type KeylistUpdateBody,
  type KeylistUpdateItem,
  type KeylistUpdateResponseBody,
  type MediateGrantBody,
  type MediateRequestBody,
} from "./mediation.js";
import {
  PickupProtocol,
  type LiveDeliveryChangeBody,
  type MessagesReceivedBody,
} from "./pickup.js";
import type { DidcommMessageBridge } from "./transport.js";

export interface MediatorClientOptions {
  bridge: DidcommMessageBridge;
  holder: Identity;
  mediator: RemoteDidcommEndpoint;
  /** Per-request timeout (default 30s). */
  timeoutMs?: number;
}

const DEFAULT_TIMEOUT_MS = 30_000;

function newMessageId(): string {
  return globalThis.crypto.randomUUID();
}

interface ProblemReportBody {
  code?: string;
  comment?: string;
}

const KNOWN_ERROR_CODES = new Set<VtaErrorCode>([
  "e.p.msg.unauthorized",
  "e.p.msg.forbidden",
  "e.p.msg.notfound",
  "e.p.msg.conflict",
  "e.p.msg.rate_limited",
  "e.p.msg.bad_request",
  "e.p.msg.internal",
]);

function coerceProblemCode(code: string | undefined): VtaErrorCode {
  if (code && KNOWN_ERROR_CODES.has(code as VtaErrorCode)) {
    return code as VtaErrorCode;
  }
  return "e.p.msg.bad_request";
}

/**
 * `coordinate-mediation/2.0` client. Talks directly to a DIDComm
 * mediator (authcrypt holder→mediator; **no** forward wrapping) and
 * threads request/response by DIDComm `thid` through the shared
 * `DidcommMessageBridge`.
 *
 * Typical first-run sequence:
 *
 * ```ts
 * const mc = new MediatorClient({ bridge, holder, mediator });
 * const grant = await mc.requestMediation();
 * await mc.updateKeylist([{ recipient_did: holder.did, action: "add" }]);
 * // grant.routing_did → publish in your DID document's service entry
 * ```
 */
export class MediatorClient {
  private readonly bridge: DidcommMessageBridge;
  private readonly holder: Identity;
  private readonly mediator: RemoteDidcommEndpoint;
  private readonly timeoutMs: number;

  constructor(opts: MediatorClientOptions) {
    this.bridge = opts.bridge;
    this.holder = opts.holder;
    this.mediator = opts.mediator;
    this.timeoutMs = opts.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  }

  requestMediation(): Promise<MediateGrantBody> {
    const body: MediateRequestBody = {};
    return this.exchange<MediateRequestBody, MediateGrantBody>(
      CoordinateMediationProtocol.mediateRequest,
      body,
      [
        CoordinateMediationProtocol.mediateGrant,
        CoordinateMediationProtocol.mediateDeny,
      ],
    );
  }

  updateKeylist(updates: KeylistUpdateItem[]): Promise<KeylistUpdateResponseBody> {
    const body: KeylistUpdateBody = { updates };
    return this.exchange<KeylistUpdateBody, KeylistUpdateResponseBody>(
      CoordinateMediationProtocol.keylistUpdate,
      body,
      [CoordinateMediationProtocol.keylistUpdateResponse],
    );
  }

  queryKeylist(paginate?: { limit?: number; offset?: number }): Promise<KeylistBody> {
    const body: KeylistQueryBody = paginate ? { paginate } : {};
    return this.exchange<KeylistQueryBody, KeylistBody>(
      CoordinateMediationProtocol.keylistQuery,
      body,
      [CoordinateMediationProtocol.keylist],
    );
  }

  /**
   * Toggle Pickup 3.0 live-delivery mode. When enabled, the
   * mediator pushes inbound DIDComm messages on the same channel
   * (via `pickup/3.0/delivery`) as soon as they arrive — the
   * pattern the `Pickup3Dispatcher` expects.
   *
   * Fire-and-forget per spec; no reply.
   */
  async setLiveDelivery(enabled: boolean): Promise<void> {
    const body: LiveDeliveryChangeBody = { live_delivery: enabled };
    const { outer } = this.buildOutbound(PickupProtocol.liveDeliveryChange, body);
    await this.bridge.send(outer);
  }

  /**
   * Acknowledge delivery of one or more queued messages by their
   * mediator-assigned IDs. Tells the mediator it can drop them
   * from the holder's queue.
   *
   * Fire-and-forget per spec; no reply.
   */
  async acknowledgeMessages(messageIds: string[]): Promise<void> {
    if (messageIds.length === 0) return;
    const body: MessagesReceivedBody = { message_id_list: messageIds };
    const { outer } = this.buildOutbound(PickupProtocol.messagesReceived, body);
    await this.bridge.send(outer);
  }

  private async exchange<Req extends object, Res>(
    requestType: string,
    body: Req,
    acceptedResponseTypes: string[],
  ): Promise<Res> {
    const { outer, requestId } = this.buildOutbound(requestType, body);

    const replyRaw = await this.bridge.sendAndAwaitReply(outer, requestId, {
      timeoutMs: this.timeoutMs,
    });

    const result = unpackMessage(
      { input: replyRaw, sender_public_jwk: this.mediator.keyAgreementPublicJwk },
      this.holder,
    );
    if (result.kind !== "encrypted") {
      throw new VtaClientError(
        "e.client.parse",
        `mediator reply was ${result.kind}, expected encrypted`,
      );
    }
    if (!result.authenticated) {
      throw new VtaClientError(
        "e.p.msg.unauthorized",
        "mediator reply not authenticated",
      );
    }
    const msg = result.message as {
      type?: string;
      thid?: string;
      from?: string;
      body?: unknown;
    };
    if (msg.type === "https://didcomm.org/report-problem/2.0/problem-report") {
      const pr = (msg.body ?? {}) as ProblemReportBody;
      throw new VtaClientError(coerceProblemCode(pr.code), pr.comment ?? pr.code ?? "problem-report", {
        details: pr,
      });
    }
    if (msg.type === CoordinateMediationProtocol.mediateDeny) {
      throw new VtaClientError(
        "e.p.msg.forbidden",
        "mediator denied mediation request",
        { details: msg.body },
      );
    }
    if (!msg.type || !acceptedResponseTypes.includes(msg.type)) {
      throw new VtaClientError(
        "e.client.parse",
        `unexpected reply type: ${msg.type ?? "(none)"}`,
      );
    }
    if (msg.thid !== requestId) {
      throw new VtaClientError(
        "e.client.parse",
        `reply thid ${msg.thid ?? "(none)"} != request id ${requestId}`,
      );
    }
    if (msg.from !== this.mediator.did) {
      throw new VtaClientError(
        "e.p.msg.unauthorized",
        `reply from ${msg.from ?? "(none)"} != mediator ${this.mediator.did}`,
      );
    }
    return (msg.body ?? {}) as Res;
  }

  /**
   * Construct the outbound authcrypt envelope (no forward wrap —
   * the mediator IS the recipient). Exposed for tests/inspection.
   */
  buildOutbound<Req extends object>(
    requestType: string,
    body: Req,
  ): { outer: string; requestId: string } {
    const requestId = newMessageId();
    const message = {
      id: requestId,
      type: requestType,
      from: this.holder.did,
      to: [this.mediator.did],
      body,
    };
    const outer = packAuthcrypt(message, this.holder, [
      {
        kid: this.mediator.keyAgreementKid,
        jwk: this.mediator.keyAgreementPublicJwk,
      },
    ]);
    return { outer, requestId };
  }
}

// Suppress unused-import warning when only types are used.
export type { PublicJwk };