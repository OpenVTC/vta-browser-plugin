import {
  Identity,
  packAnoncryptJson,
  packAuthcrypt,
  unpackMessage,
  wrapForward,
  type PublicJwk,
} from "../didcomm/index.js";
import { VtaClientError, type VtaErrorCode } from "./errors.js";
import {
  PasskeyManagementProtocol,
  type EnrollChallengeRequestBody,
  type EnrollChallengeResponseBody,
  type EnrollSubmitRequestBody,
  type EnrollSubmitResponseBody,
  type ListRequestBody,
  type ListResponseBody,
  type ProblemReportBody,
  type RevokeRequestBody,
} from "./protocol.js";
import type { DidcommMessageBridge, VtaTransport } from "./transport.js";
import type {
  EnrollmentChallengeResponse,
  EnrollmentSubmitRequest,
  EnrollmentSubmitResponse,
  PasskeyList,
} from "./types.js";

export interface RemoteDidcommEndpoint {
  did: string;
  keyAgreementKid: string;
  keyAgreementPublicJwk: PublicJwk;
}

export interface DidcommVtaTransportOptions {
  bridge: DidcommMessageBridge;
  holder: Identity;
  vta: RemoteDidcommEndpoint;
  /** Optional mediator. When set, every outbound message gets wrapped
   *  in a routing/2.0/forward envelope and anoncrypt'd to the mediator. */
  mediator?: RemoteDidcommEndpoint;
  /** Per-request timeout (default 30s). */
  timeoutMs?: number;
}

const DEFAULT_TIMEOUT_MS = 30_000;

function newMessageId(): string {
  return globalThis.crypto.randomUUID();
}

/**
 * VTA transport over DIDComm v2. Authcrypts every request from the
 * holder to the VTA, optionally wraps in a `routing/2.0/forward`
 * envelope for a mediator, and dispatches via an injected
 * `DidcommMessageBridge`. The bridge owns the actual network IO
 * (WebSocket, HTTPS, etc.) — keeping this class transport-pure makes
 * it directly testable with an in-memory bridge.
 */
export class DidcommVtaTransport implements VtaTransport {
  private readonly bridge: DidcommMessageBridge;
  private readonly holder: Identity;
  private readonly vta: RemoteDidcommEndpoint;
  private readonly mediator?: RemoteDidcommEndpoint;
  private readonly timeoutMs: number;

  constructor(opts: DidcommVtaTransportOptions) {
    this.bridge = opts.bridge;
    this.holder = opts.holder;
    this.vta = opts.vta;
    if (opts.mediator !== undefined) this.mediator = opts.mediator;
    this.timeoutMs = opts.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  }

  requestEnrollmentChallenge(did: string): Promise<EnrollmentChallengeResponse> {
    return this.exchange<EnrollChallengeRequestBody, EnrollChallengeResponseBody>(
      PasskeyManagementProtocol.enrollChallenge,
      { did },
      PasskeyManagementProtocol.enrollChallengeResponse,
    );
  }

  submitPasskeyEnrollment(req: EnrollmentSubmitRequest): Promise<EnrollmentSubmitResponse> {
    const body: EnrollSubmitRequestBody = {
      did: req.did,
      credentialId: req.credentialId,
      publicKeyMultibase: req.publicKeyMultibase,
      coseAlgorithm: req.coseAlgorithm,
      attestationObject: req.attestationObject,
      clientDataJson: req.clientDataJson,
      authenticatorData: req.authenticatorData,
      transports: req.transports,
      ...(req.label !== undefined ? { label: req.label } : {}),
    };
    return this.exchange<EnrollSubmitRequestBody, EnrollSubmitResponseBody>(
      PasskeyManagementProtocol.enrollSubmit,
      body,
      PasskeyManagementProtocol.enrollSubmitResponse,
    );
  }

  listPasskeys(did: string): Promise<PasskeyList> {
    return this.exchange<ListRequestBody, ListResponseBody>(
      PasskeyManagementProtocol.list,
      { did },
      PasskeyManagementProtocol.listResponse,
    );
  }

  async removePasskey(did: string, fragment: string): Promise<void> {
    await this.exchange<RevokeRequestBody, Record<string, never>>(
      PasskeyManagementProtocol.revoke,
      { did, fragment },
      PasskeyManagementProtocol.revokeResponse,
    );
  }

  /**
   * Build, pack, transmit, unpack, validate. The reusable core for
   * every request-response exchange.
   */
  private async exchange<Req extends object, Res>(
    requestType: string,
    body: Req,
    expectedResponseType: string,
  ): Promise<Res> {
    const packed = this.buildOutbound(requestType, body);

    const replyRaw = await this.bridge.sendAndAwaitReply(
      packed.outer,
      packed.requestId,
      { timeoutMs: this.timeoutMs },
    );

    const result = unpackMessage(
      { input: replyRaw, sender_public_jwk: this.vta.keyAgreementPublicJwk },
      this.holder,
    );
    if (result.kind !== "encrypted") {
      throw new VtaClientError(
        "e.client.parse",
        `reply was ${result.kind}, expected encrypted`,
      );
    }
    if (!result.authenticated) {
      throw new VtaClientError(
        "e.p.msg.unauthorized",
        "reply not authenticated as VTA",
      );
    }
    const msg = result.message as {
      type?: string;
      thid?: string;
      from?: string;
      body?: unknown;
    };
    if (msg.type === PasskeyManagementProtocol.problemReport) {
      const pr = (msg.body ?? {}) as ProblemReportBody;
      throw new VtaClientError(coerceProblemCode(pr.code), pr.comment ?? pr.code, {
        details: pr,
      });
    }
    if (msg.type !== expectedResponseType) {
      throw new VtaClientError(
        "e.client.parse",
        `reply type ${msg.type ?? "(none)"} != ${expectedResponseType}`,
      );
    }
    if (msg.thid !== packed.requestId) {
      throw new VtaClientError(
        "e.client.parse",
        `reply thid ${msg.thid ?? "(none)"} != request id ${packed.requestId}`,
      );
    }
    if (msg.from !== this.vta.did) {
      throw new VtaClientError(
        "e.p.msg.unauthorized",
        `reply from ${msg.from ?? "(none)"} != VTA ${this.vta.did}`,
      );
    }
    return (msg.body ?? {}) as Res;
  }

  /**
   * Build the wire form. Public-ish for the smoke helper — keeps the
   * envelope-construction logic introspectable from tests/console.
   */
  buildOutbound<Req extends object>(
    requestType: string,
    body: Req,
  ): { outer: string; inner: string; requestId: string } {
    const requestId = newMessageId();
    const message = {
      id: requestId,
      type: requestType,
      from: this.holder.did,
      to: [this.vta.did],
      body,
    };

    const inner = packAuthcrypt(message, this.holder, [
      { kid: this.vta.keyAgreementKid, jwk: this.vta.keyAgreementPublicJwk },
    ]);

    if (!this.mediator) return { outer: inner, inner, requestId };

    const forwardJson = wrapForward(this.vta.did, inner);
    const outer = packAnoncryptJson(forwardJson, [
      {
        kid: this.mediator.keyAgreementKid,
        jwk: this.mediator.keyAgreementPublicJwk,
      },
    ]);
    return { outer, inner, requestId };
  }
}

function coerceProblemCode(code: string | undefined): VtaErrorCode {
  switch (code) {
    case "e.p.msg.unauthorized":
    case "e.p.msg.forbidden":
    case "e.p.msg.notfound":
    case "e.p.msg.conflict":
    case "e.p.msg.rate_limited":
    case "e.p.msg.bad_request":
    case "e.p.msg.internal":
      return code;
    default:
      return "e.p.msg.bad_request";
  }
}
