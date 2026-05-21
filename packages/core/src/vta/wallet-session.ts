import type { Identity, PublicJwk } from "../didcomm/index.js";
import { resolveKeyAgreement, resolveMediatorEndpoint } from "../didcomm/index.js";
import {
  generateOrLoadHolderIdentity,
  type KVStore,
} from "../store/index.js";
import {
  WebSocketDidcommBridge,
  type MessageDispatcher,
  type WebSocketFactory,
} from "./bridge-websocket.js";
import { DidcommVtaTransport, type RemoteDidcommEndpoint } from "./didcomm.js";
import { MediatorClient } from "./mediator-client.js";
import type { DidcommMessageBridge, VtaTransport } from "./transport.js";

const STORE_KEY_MEDIATOR_ENROLLMENT = "pnm/mediator-enrollment/v1";

interface PersistedMediatorEnrollment {
  /** Mediator DID the wallet enrolled with. */
  mediatorDid: string;
  /** Holder DID at the time of enrollment (sanity check on re-boot). */
  holderDid: string;
  /** `routing_did[]` from the mediate-grant response. */
  routingDids: string[];
  /** Unix millis. */
  enrolledAt: number;
}

export interface WalletSessionConfig {
  /** Persistent store for holder identity + enrollment state. */
  store: KVStore;
  /** Mediator endpoint to enroll with. */
  mediator: RemoteDidcommEndpoint & {
    /** WebSocket URL the bridge connects to. */
    websocketUrl: string;
  };
  /** VTA endpoint the wallet talks to. */
  vta: RemoteDidcommEndpoint;
  /** Custom WS factory for tests (defaults to globalThis.WebSocket). */
  webSocketFactory?: WebSocketFactory;
  /** Bridge dispatcher (defaults to Pickup3Dispatcher when omitted). */
  dispatcher?: MessageDispatcher;
  /** Existing bridge (skips construction; for tests). */
  bridgeOverride?: DidcommMessageBridge;
  /** Per-request timeout. */
  timeoutMs?: number;
}

/**
 * Config for {@link WalletSession.fromDids} — supply DIDs instead of
 * pre-resolved endpoints. The VTA + mediator are resolved to their
 * key-agreement material (and the mediator's WebSocket URL) via the
 * DID hosting service.
 */
export interface WalletSessionFromDidsConfig {
  /** Persistent store for holder identity + enrollment state. */
  store: KVStore;
  /** VTA DID (`did:webvh` or `did:key`). Resolved to its key-agreement endpoint. */
  vtaDid: string;
  /** Mediator DID. Resolved to its key-agreement endpoint + WebSocket URL. */
  mediatorDid: string;
  /** Custom WS factory for tests (defaults to globalThis.WebSocket). */
  webSocketFactory?: WebSocketFactory;
  /** Bridge dispatcher (defaults to Pickup3Dispatcher when omitted). */
  dispatcher?: MessageDispatcher;
  /** Per-request timeout. */
  timeoutMs?: number;
  /** Allow `ws://`/`http://` mediator endpoints. Local dev only. */
  allowInsecure?: boolean;
}

export interface WalletSessionState {
  holder: Identity;
  routingDids: string[];
  liveMode: boolean;
  freshlyMintedIdentity: boolean;
  freshlyEnrolled: boolean;
}

/**
 * Top-level wallet orchestrator. Composes:
 *   - `generateOrLoadHolderIdentity` (KVStore-persisted holder)
 *   - `WebSocketDidcommBridge` (or test bridge override)
 *   - `MediatorClient` (coordinate-mediation + pickup live-mode)
 *   - `DidcommVtaTransport` (passkey-management against the VTA)
 *
 * Lifecycle:
 *   1. `bootstrap()` loads-or-mints holder, builds the bridge with
 *      both mediator + VTA registered as expected senders, then
 *      enrolls (mediate-request + keylist-update(add)) **only on
 *      first run** — subsequent boots skip the enrollment step
 *      (state persisted in the KVStore).
 *   2. `setLiveDelivery(true)` flips the mediator into push mode so
 *      Pickup3Dispatcher receives inbound messages on the same WS.
 *   3. `transport()` exposes the ready `DidcommVtaTransport` for
 *      passkey-management exchanges.
 *   4. `close()` tears down the bridge and disposes identities.
 *
 * Idempotent across reboots: if `freshlyMintedIdentity` is false
 * and `freshlyEnrolled` is false, the wallet is resuming an
 * existing relationship with the same DIDs and mediator.
 */
export class WalletSession {
  private readonly config: WalletSessionConfig;
  private state: WalletSessionState | null = null;
  private bridge: DidcommMessageBridge | null = null;
  private mediatorClient: MediatorClient | null = null;
  private vtaTransport: DidcommVtaTransport | null = null;

  constructor(config: WalletSessionConfig) {
    this.config = config;
  }

  /**
   * Resolve the VTA + mediator DIDs to their key-agreement endpoints
   * (hitting the DID hosting service for `did:webvh`) and construct a
   * ready-to-bootstrap session. The returned session still needs
   * `bootstrap()` called on it.
   */
  static async fromDids(cfg: WalletSessionFromDidsConfig): Promise<WalletSession> {
    const [vta, mediator] = await Promise.all([
      resolveKeyAgreement(cfg.vtaDid),
      resolveMediatorEndpoint(cfg.mediatorDid, {
        allowInsecure: cfg.allowInsecure ?? false,
      }),
    ]);
    return new WalletSession({
      store: cfg.store,
      vta,
      mediator: {
        did: mediator.did,
        keyAgreementKid: mediator.keyAgreementKid,
        keyAgreementPublicJwk: mediator.keyAgreementPublicJwk,
        websocketUrl: mediator.websocketUrl,
      },
      ...(cfg.webSocketFactory !== undefined
        ? { webSocketFactory: cfg.webSocketFactory }
        : {}),
      ...(cfg.dispatcher !== undefined ? { dispatcher: cfg.dispatcher } : {}),
      ...(cfg.timeoutMs !== undefined ? { timeoutMs: cfg.timeoutMs } : {}),
    });
  }

  /** Run the full first-or-resume boot sequence. */
  async bootstrap(): Promise<WalletSessionState> {
    const { identity: holder, freshlyMinted } = await generateOrLoadHolderIdentity(
      this.config.store,
    );

    const holderPub = holder.publicJwk() as { kid: string; jwk: PublicJwk };

    const bridge =
      this.config.bridgeOverride ??
      new WebSocketDidcommBridge({
        url: this.config.mediator.websocketUrl,
        holder,
        expectedSenders: {
          [this.config.mediator.did]: this.config.mediator.keyAgreementPublicJwk,
          [this.config.vta.did]: this.config.vta.keyAgreementPublicJwk,
        },
        ...(this.config.dispatcher !== undefined
          ? { dispatcher: this.config.dispatcher }
          : {}),
        ...(this.config.webSocketFactory !== undefined
          ? { webSocketFactory: this.config.webSocketFactory }
          : {}),
        ...(this.config.timeoutMs !== undefined
          ? { timeoutMs: this.config.timeoutMs }
          : {}),
      });
    this.bridge = bridge;

    const mediatorClient = new MediatorClient({
      bridge,
      holder,
      mediator: {
        did: this.config.mediator.did,
        keyAgreementKid: this.config.mediator.keyAgreementKid,
        keyAgreementPublicJwk: this.config.mediator.keyAgreementPublicJwk,
      },
      ...(this.config.timeoutMs !== undefined ? { timeoutMs: this.config.timeoutMs } : {}),
    });
    this.mediatorClient = mediatorClient;

    const persistedEnrollment = await this.config.store.get<PersistedMediatorEnrollment>(
      STORE_KEY_MEDIATOR_ENROLLMENT,
    );

    let routingDids: string[];
    let freshlyEnrolled = false;
    if (
      persistedEnrollment &&
      persistedEnrollment.mediatorDid === this.config.mediator.did &&
      persistedEnrollment.holderDid === holder.did
    ) {
      routingDids = persistedEnrollment.routingDids;
    } else {
      const grant = await mediatorClient.requestMediation();
      await mediatorClient.updateKeylist([
        { recipient_did: holder.did, action: "add" },
      ]);
      routingDids = grant.routing_did;
      freshlyEnrolled = true;
      const record: PersistedMediatorEnrollment = {
        mediatorDid: this.config.mediator.did,
        holderDid: holder.did,
        routingDids,
        enrolledAt: Date.now(),
      };
      await this.config.store.put(STORE_KEY_MEDIATOR_ENROLLMENT, record);
    }

    this.vtaTransport = new DidcommVtaTransport({
      bridge,
      holder,
      vta: this.config.vta,
      mediator: {
        did: this.config.mediator.did,
        keyAgreementKid: this.config.mediator.keyAgreementKid,
        keyAgreementPublicJwk: this.config.mediator.keyAgreementPublicJwk,
      },
      ...(this.config.timeoutMs !== undefined ? { timeoutMs: this.config.timeoutMs } : {}),
    });

    this.state = {
      holder,
      routingDids,
      liveMode: false,
      freshlyMintedIdentity: freshlyMinted,
      freshlyEnrolled,
    };
    // Reference holderPub to keep it tied to the lifetime — the
    // bridge already holds the JWK in its sender registry.
    void holderPub;
    return this.state;
  }

  /** Flip Pickup 3.0 live-delivery mode on/off. */
  async setLiveDelivery(enabled: boolean): Promise<void> {
    if (!this.mediatorClient || !this.state) {
      throw new Error("WalletSession not bootstrapped yet — call bootstrap() first");
    }
    await this.mediatorClient.setLiveDelivery(enabled);
    this.state.liveMode = enabled;
  }

  /** Acknowledge processed deliveries. */
  async acknowledgeMessages(messageIds: string[]): Promise<void> {
    if (!this.mediatorClient) {
      throw new Error("WalletSession not bootstrapped yet — call bootstrap() first");
    }
    await this.mediatorClient.acknowledgeMessages(messageIds);
  }

  /** Get the ready VTA transport. Throws if `bootstrap()` hasn't completed. */
  transport(): VtaTransport {
    if (!this.vtaTransport) {
      throw new Error("WalletSession not bootstrapped yet — call bootstrap() first");
    }
    return this.vtaTransport;
  }

  /** Get the underlying mediator client for direct keylist queries, etc. */
  mediator(): MediatorClient {
    if (!this.mediatorClient) {
      throw new Error("WalletSession not bootstrapped yet — call bootstrap() first");
    }
    return this.mediatorClient;
  }

  /** Tear down the bridge + dispose the holder identity. */
  close(): void {
    if (
      this.bridge &&
      "close" in this.bridge &&
      typeof (this.bridge as { close?: () => void }).close === "function"
    ) {
      (this.bridge as { close: () => void }).close();
    }
    this.state?.holder.dispose();
    this.state = null;
    this.bridge = null;
    this.mediatorClient = null;
    this.vtaTransport = null;
  }
}
