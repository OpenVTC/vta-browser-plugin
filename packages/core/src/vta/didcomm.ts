import {
  Identity,
  packAuthcrypt,
  packAuthcryptJson,
  wrapForward,
  type PublicJwk,
} from "../didcomm/index.js";
import { VtaClientError } from "./errors.js";
import {
  PasskeyVmTask,
  TRUST_TASK_ENVELOPE_TYPE,
  type EnrollChallengePayload,
  type EnrollSubmitPayload,
  type ListPayload,
  type RevokePayload,
  type TrustTask,
} from "./protocol.js";
import { buildTrustTask, parseTrustTaskReply } from "./trust-task.js";
import type { SendOpts, TrustTaskChannel } from "./channel.js";
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

/**
 * VTA transport over DIDComm v2 — the DIDComm {@link TrustTaskChannel}.
 * Authcrypts every request from the holder to the VTA, optionally wraps in a
 * `routing/2.0/forward` envelope for a mediator, and dispatches via an
 * injected `DidcommMessageBridge`. The bridge owns the actual network IO
 * (WebSocket, HTTPS, etc.) — keeping this class transport-pure makes it
 * directly testable with an in-memory bridge.
 *
 * Implements both the generic `TrustTaskChannel` (`send`) and the
 * passkey-management `VtaTransport` convenience surface (the latter delegates
 * to the former).
 */
export class DidcommVtaTransport implements VtaTransport, TrustTaskChannel {
  readonly kind = "didcomm" as const;
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
    return this.exchange<EnrollChallengePayload, EnrollmentChallengeResponse>(
      PasskeyVmTask.enrollChallenge,
      { did },
    );
  }

  submitPasskeyEnrollment(req: EnrollmentSubmitRequest): Promise<EnrollmentSubmitResponse> {
    const payload: EnrollSubmitPayload = {
      did: req.did,
      ceremonyId: req.ceremonyId,
      credentialId: req.credentialId,
      publicKeyMultibase: req.publicKeyMultibase,
      coseAlgorithm: req.coseAlgorithm,
      attestationObject: req.attestationObject,
      clientDataJson: req.clientDataJson,
      authenticatorData: req.authenticatorData,
      transports: req.transports,
      ...(req.label !== undefined ? { label: req.label } : {}),
    };
    return this.exchange<EnrollSubmitPayload, EnrollmentSubmitResponse>(
      PasskeyVmTask.enrollSubmit,
      payload,
    );
  }

  listPasskeys(did: string): Promise<PasskeyList> {
    return this.exchange<ListPayload, PasskeyList>(PasskeyVmTask.list, { did });
  }

  async removePasskey(did: string, fragment: string): Promise<void> {
    await this.exchange<RevokePayload, unknown>(PasskeyVmTask.revoke, {
      did,
      fragment,
    });
  }

  /**
   * `TrustTaskChannel.send` — transmit a pre-built Trust-Task envelope over
   * DIDComm and return its response payload. Authcrypts the envelope to the
   * VTA, optionally forwards via the mediator, awaits the reply correlated by
   * the envelope id (`thid`), validates the binding envelope, and decodes the
   * body — either the success `payload` or a `trust-task-error/{0.1,0.2}`
   * (throws a normalized {@link VtaClientError}).
   */
  async send<Res>(envelope: TrustTask<unknown>, opts: SendOpts = {}): Promise<Res> {
    const { outer, requestId } = await this.packEnvelope(envelope);

    // The bridge returns the decrypted, sender-authenticated reply (it
    // owns unpacking; only authenticated authcrypt frames are surfaced).
    const msg = await this.bridge.sendAndAwaitReply(outer, requestId, {
      timeoutMs: opts.timeoutMs ?? this.timeoutMs,
    });
    if (msg.type !== TRUST_TASK_ENVELOPE_TYPE) {
      throw new VtaClientError(
        "e.client.parse",
        `reply type ${msg.type ?? "(none)"} != Trust-Task binding envelope`,
      );
    }
    if (msg.thid !== requestId) {
      throw new VtaClientError(
        "e.client.parse",
        `reply thid ${msg.thid ?? "(none)"} != request id ${requestId}`,
      );
    }
    if (msg.from !== this.vta.did) {
      throw new VtaClientError(
        "e.p.msg.unauthorized",
        `reply from ${msg.from ?? "(none)"} != VTA ${this.vta.did}`,
      );
    }

    // The binding envelope has already vouched for the message, so accept any
    // non-error response type unless the caller pinned an expectedResponseType.
    const doc = (msg.body ?? {}) as TrustTask<unknown>;
    return parseTrustTaskReply<Res>(doc, {
      ...(opts.expectedResponseType !== undefined
        ? { expectedResponseType: opts.expectedResponseType }
        : {}),
      ...(opts.operationLabel !== undefined
        ? { operationLabel: opts.operationLabel }
        : {}),
    });
  }

  /**
   * Build a Trust-Task request from (taskUri, payload) and send it. Used by
   * the passkey-management convenience methods; new callers should build an
   * envelope with `buildTrustTask` and call {@link send} directly.
   */
  private exchange<Req extends object, Res>(taskUri: string, payload: Req): Promise<Res> {
    return this.send<Res>(buildTrustTask<Req>(taskUri, payload, { issuer: this.holder.did }));
  }

  /**
   * Build the wire form: a `TrustTask` envelope (the request) carried as
   * the body of a binding-typed DIDComm message, authcrypt'd to the VTA
   * and (when a mediator is configured) wrapped in a routing/2.0/forward.
   * Public-ish so the smoke helper can introspect the envelope.
   */
  async buildOutbound<Req extends object>(
    taskUri: string,
    payload: Req,
  ): Promise<{ outer: string; inner: string; requestId: string }> {
    return this.packEnvelope(buildTrustTask<Req>(taskUri, payload, { issuer: this.holder.did }));
  }

  /**
   * Authcrypt a pre-built Trust-Task envelope to the VTA, wrapping it in a
   * `routing/2.0/forward` addressed to the mediator when one is configured.
   * The envelope `id` is the correlation id (`requestId`).
   */
  private async packEnvelope(
    envelope: TrustTask<unknown>,
  ): Promise<{ outer: string; inner: string; requestId: string }> {
    const requestId = envelope.id;
    const message = {
      id: requestId,
      type: TRUST_TASK_ENVELOPE_TYPE,
      from: this.holder.did,
      to: [this.vta.did],
      body: envelope,
    };

    const inner = await packAuthcrypt(message, this.holder, [
      { kid: this.vta.keyAgreementKid, jwk: this.vta.keyAgreementPublicJwk },
    ]);

    if (!this.mediator) return { outer: inner, inner, requestId };

    const forwardJson = wrapForward(
      this.vta.did,
      this.holder.did,
      this.mediator.did,
      inner,
    );
    const outer = await packAuthcryptJson(forwardJson, this.holder, [
      {
        kid: this.mediator.keyAgreementKid,
        jwk: this.mediator.keyAgreementPublicJwk,
      },
    ]);
    return { outer, inner, requestId };
  }
}
