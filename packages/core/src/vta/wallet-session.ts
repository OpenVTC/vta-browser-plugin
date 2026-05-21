import type { Identity } from "../didcomm/index.js";
import {
  connectMediatorSession,
  type MediatorConnection,
  type ResolvedKeyAgreement,
  type WebSocketCtor,
} from "../didcomm/index.js";
import {
  generateOrLoadHolderIdentity,
  type KVStore,
} from "../store/index.js";
import { MediatorSessionBridge } from "./bridge-mediator-session.js";
import { DidcommVtaTransport } from "./didcomm.js";
import type { DidcommMessageBridge, VtaTransport } from "./transport.js";

/**
 * Config for {@link WalletSession.fromDids} — the live path. Supply
 * DIDs; the VTA + mediator are resolved (the mediator via its hosting
 * service), the holder authenticates to the mediator, and a live
 * WebSocket session is opened.
 */
export interface WalletSessionFromDidsConfig {
  /** Persistent store for the holder identity. */
  store: KVStore;
  /** VTA DID (`did:webvh` or `did:key`). */
  vtaDid: string;
  /** Mediator DID. */
  mediatorDid: string;
  /** fetch impl for the mediator auth handshake (defaults to global). */
  fetch?: typeof fetch;
  /** WebSocket ctor (defaults to globalThis.WebSocket). */
  webSocketImpl?: WebSocketCtor;
  /** Allow `ws://`/`http://` endpoints. Local dev only. */
  allowInsecure?: boolean;
  /** Per-request timeout. */
  timeoutMs?: number;
}

/**
 * Config for {@link WalletSession.withBridge} — the test path. Inject a
 * bridge (e.g. the in-memory bridge) plus pre-resolved endpoints, no
 * network.
 */
export interface WalletSessionWithBridgeConfig {
  store: KVStore;
  bridge: DidcommMessageBridge;
  vta: ResolvedKeyAgreement;
  mediator: ResolvedKeyAgreement;
  timeoutMs?: number;
}

export interface WalletSessionState {
  holder: Identity;
  /** True once a live mediator session is open (live delivery enabled). */
  liveMode: boolean;
  /** True if this run minted a fresh identity (first launch). */
  freshlyMintedIdentity: boolean;
}

/**
 * Top-level wallet orchestrator. Composes the persisted holder
 * identity, a connected mediator transport, and the passkey-management
 * transport against the VTA.
 *
 * The mediator transport is the library's `MediatorSession` (challenge
 * → JWT → bearer-subprotocol WebSocket → pickup live-delivery), adapted
 * to the bridge via `MediatorSessionBridge`. There is no
 * coordinate-mediation enrollment: the holder is a bare `did:key` that
 * can't advertise a mediator service, so the authenticated session +
 * live delivery is the complete inbound path for request/response.
 * Full mediation (mediate-grant routing key published in the holder's
 * DID document + keylist-update) is a future milestone gated on a
 * service-advertising holder DID (`did:peer`/`did:webvh`).
 *
 * Construct via {@link fromDids} (live) or {@link withBridge} (tests).
 */
export class WalletSession {
  private readonly holder: Identity;
  private readonly vtaTransport: DidcommVtaTransport;
  private readonly _state: WalletSessionState;
  private readonly onClose: () => void;

  private constructor(args: {
    holder: Identity;
    vtaTransport: DidcommVtaTransport;
    state: WalletSessionState;
    onClose: () => void;
  }) {
    this.holder = args.holder;
    this.vtaTransport = args.vtaTransport;
    this._state = args.state;
    this.onClose = args.onClose;
  }

  /**
   * Live path: load-or-mint the holder, authenticate to the mediator,
   * open the WebSocket session, and wire the VTA transport. Returns a
   * ready session — no separate bootstrap step.
   */
  static async fromDids(cfg: WalletSessionFromDidsConfig): Promise<WalletSession> {
    const { identity: holder, freshlyMinted } = await generateOrLoadHolderIdentity(
      cfg.store,
    );

    let connection: MediatorConnection;
    try {
      connection = await connectMediatorSession({
        holder,
        mediatorDid: cfg.mediatorDid,
        vtaDid: cfg.vtaDid,
        ...(cfg.fetch ? { fetch: cfg.fetch } : {}),
        ...(cfg.webSocketImpl ? { webSocketImpl: cfg.webSocketImpl } : {}),
        ...(cfg.allowInsecure !== undefined
          ? { allowInsecure: cfg.allowInsecure }
          : {}),
      });
    } catch (err) {
      holder.dispose();
      throw err;
    }

    const bridge = new MediatorSessionBridge(connection, cfg.timeoutMs);
    const vtaTransport = new DidcommVtaTransport({
      bridge,
      holder,
      vta: connection.vta,
      mediator: connection.mediator,
      ...(cfg.timeoutMs !== undefined ? { timeoutMs: cfg.timeoutMs } : {}),
    });

    return new WalletSession({
      holder,
      vtaTransport,
      state: { holder, liveMode: true, freshlyMintedIdentity: freshlyMinted },
      onClose: () => connection.close(),
    });
  }

  /**
   * Test path: inject a bridge (e.g. the in-memory bridge) and
   * pre-resolved endpoints. No network, no live session.
   */
  static async withBridge(
    cfg: WalletSessionWithBridgeConfig,
  ): Promise<WalletSession> {
    const { identity: holder, freshlyMinted } = await generateOrLoadHolderIdentity(
      cfg.store,
    );
    const vtaTransport = new DidcommVtaTransport({
      bridge: cfg.bridge,
      holder,
      vta: cfg.vta,
      mediator: cfg.mediator,
      ...(cfg.timeoutMs !== undefined ? { timeoutMs: cfg.timeoutMs } : {}),
    });
    return new WalletSession({
      holder,
      vtaTransport,
      state: { holder, liveMode: false, freshlyMintedIdentity: freshlyMinted },
      onClose: () => {},
    });
  }

  /** Current session state. */
  state(): WalletSessionState {
    return this._state;
  }

  /** The ready VTA transport for passkey-management exchanges. */
  transport(): VtaTransport {
    return this.vtaTransport;
  }

  /** Tear down the mediator session + dispose the holder identity. */
  close(): void {
    this.onClose();
    this.holder.dispose();
  }
}
