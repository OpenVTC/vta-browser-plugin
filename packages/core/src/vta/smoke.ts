import {
  Identity,
  packAuthcrypt,
  packAuthcryptJson,
  unpackMessage,
  type PublicJwk,
} from "../didcomm/index.js";
import { InMemoryDidcommBridge } from "./bridge-memory.js";
import {
  Pickup3Dispatcher,
  WebSocketDidcommBridge,
  type WebSocketLike,
} from "./bridge-websocket.js";
import { DidcommVtaTransport } from "./didcomm.js";
import {
  CoordinateMediationProtocol,
  type KeylistUpdateResponseBody,
  type MediateGrantBody,
} from "./mediation.js";
import { MediatorClient } from "./mediator-client.js";
import { PickupProtocol, type LiveDeliveryChangeBody } from "./pickup.js";
import { PasskeyManagementProtocol } from "./protocol.js";
import type { DidcommMessageBridge } from "./transport.js";
import type { EnrollmentChallengeResponse } from "./types.js";

export interface SmokeDidcommEnrollChallengeResult {
  ok: boolean;
  outerJweLength: number;
  innerJweLength: number;
  requestId: string;
  forwardWrapped: boolean;
  error?: string;
}

/**
 * Exercise the full DIDComm enrollment-challenge construction path
 * end-to-end:
 *
 * 1. Mint stub holder / VTA / mediator identities (in-WASM, ephemeral).
 * 2. Build the inner enroll-challenge plaintext message.
 * 3. Authcrypt holder → VTA.
 * 4. Wrap in a Routing 2.0 forward envelope addressed to the VTA.
 * 5. Anoncrypt the forward envelope to the mediator.
 *
 * Returns the byte-length of each envelope plus the request id, so
 * the PWA console can confirm both inner and outer JWEs are
 * non-empty (i.e. crypto ran end-to-end) and that the forward
 * wrapping actually grew the bundle (i.e. the mediator step fired).
 */
export async function smokeBuildDidcommEnrollChallenge(): Promise<SmokeDidcommEnrollChallengeResult> {
  let holder: Identity | null = null;
  let vta: Identity | null = null;
  let mediator: Identity | null = null;
  try {
    holder = Identity.generate("did:key:zHolderStub");
    vta = Identity.generate("did:webvh:vta.example.com:abc");
    mediator = Identity.generate("did:key:zMediatorStub");

    const vtaPub = vta.publicJwk() as { kid: string; jwk: PublicJwk };
    const medPub = mediator.publicJwk() as { kid: string; jwk: PublicJwk };

    const bridge: DidcommMessageBridge = {
      sendAndAwaitReply: () => {
        throw new Error("smoke bridge not callable — construction-only test");
      },
      send: () => Promise.resolve(),
    };

    const transport = new DidcommVtaTransport({
      bridge,
      holder,
      vta: {
        did: vta.did,
        keyAgreementKid: vtaPub.kid,
        keyAgreementPublicJwk: vtaPub.jwk,
      },
      mediator: {
        did: mediator.did,
        keyAgreementKid: medPub.kid,
        keyAgreementPublicJwk: medPub.jwk,
      },
    });

    const built = await transport.buildOutbound(PasskeyManagementProtocol.enrollChallenge, {
      did: holder.did,
    });

    return {
      ok: true,
      outerJweLength: built.outer.length,
      innerJweLength: built.inner.length,
      requestId: built.requestId,
      forwardWrapped: built.outer !== built.inner,
    };
  } catch (err) {
    return {
      ok: false,
      outerJweLength: 0,
      innerJweLength: 0,
      requestId: "",
      forwardWrapped: false,
      error: (err as Error).message,
    };
  } finally {
    holder?.dispose();
    vta?.dispose();
    mediator?.dispose();
  }
}

// ---------------------------------------------------------------------------
// Full end-to-end DIDComm round-trip through DidcommVtaTransport +
// InMemoryDidcommBridge. Validates the entire passkey-management/1.0
// enroll-challenge exchange — request construction, mediator unwrap,
// VTA-side authcrypt validation, response packing, response unpack,
// thid threading.
// ---------------------------------------------------------------------------

export interface SmokeDidcommRoundtripResult {
  ok: boolean;
  recoveredChallenge?: string;
  recoveredRpId?: string;
  error?: string;
}

const FAKE_CHALLENGE = "AAECAwQFBgcICQoLDA0ODw";
const FAKE_RP_ID = "wallet.example.com";

export async function smokeDidcommVtaTransportRoundtrip(): Promise<SmokeDidcommRoundtripResult> {
  let holder: Identity | null = null;
  let vta: Identity | null = null;
  let mediator: Identity | null = null;
  try {
    holder = Identity.generate("did:key:zHolderStub");
    vta = Identity.generate("did:webvh:vta.example.com:abc");
    mediator = Identity.generate("did:key:zMediatorStub");

    const vtaPub = vta.publicJwk() as { kid: string; jwk: PublicJwk };
    const medPub = mediator.publicJwk() as { kid: string; jwk: PublicJwk };
    const holderPub = holder.publicJwk() as { kid: string; jwk: PublicJwk };

    const bridge = new InMemoryDidcommBridge({
      vta,
      mediator,
      holderPublicJwk: holderPub,
      vtaHandlers: {
        [PasskeyManagementProtocol.enrollChallenge]: (req) => {
          const body = req.body as { did?: string };
          const reply: EnrollmentChallengeResponse = {
            challenge: FAKE_CHALLENGE,
            rpId: FAKE_RP_ID,
            rpName: "Test Wallet",
            userHandle: "dXNlci0wMDE",
            userName: body.did ?? "anon",
            userDisplayName: "Test User",
            timeoutMs: 60_000,
          };
          return {
            type: PasskeyManagementProtocol.enrollChallengeResponse,
            body: reply,
          };
        },
      },
    });

    const transport = new DidcommVtaTransport({
      bridge,
      holder,
      vta: {
        did: vta.did,
        keyAgreementKid: vtaPub.kid,
        keyAgreementPublicJwk: vtaPub.jwk,
      },
      mediator: {
        did: mediator.did,
        keyAgreementKid: medPub.kid,
        keyAgreementPublicJwk: medPub.jwk,
      },
    });

    const challenge = await transport.requestEnrollmentChallenge(holder.did);

    if (challenge.challenge !== FAKE_CHALLENGE) {
      return {
        ok: false,
        error: `challenge mismatch: ${challenge.challenge} != ${FAKE_CHALLENGE}`,
      };
    }
    if (challenge.rpId !== FAKE_RP_ID) {
      return {
        ok: false,
        error: `rpId mismatch: ${challenge.rpId} != ${FAKE_RP_ID}`,
      };
    }

    return {
      ok: true,
      recoveredChallenge: challenge.challenge,
      recoveredRpId: challenge.rpId,
    };
  } catch (err) {
    return { ok: false, error: (err as Error).message };
  } finally {
    holder?.dispose();
    vta?.dispose();
    mediator?.dispose();
  }
}

// Silence unused-import warnings — the bridge type is part of the
// public surface even when only used inside this file.
export type { DidcommMessageBridge };

// ---------------------------------------------------------------------------
// WebSocket bridge demux smoke: drive two concurrent enroll-challenge
// requests through a single WebSocketDidcommBridge backed by a fake
// WebSocket that replies *out of order*. Validates the thid-based
// demuxer routes each reply to its waiting Promise without crossing
// streams.
// ---------------------------------------------------------------------------

export interface SmokeWsBridgeDemuxResult {
  ok: boolean;
  firstChallenge?: string;
  secondChallenge?: string;
  error?: string;
}

const FIRST_CHALLENGE = "Y2hhbGxlbmdlLW9uZQ";
const SECOND_CHALLENGE = "Y2hhbGxlbmdlLXR3bw";

class FakeMediatorWebSocket implements WebSocketLike {
  readyState = 0;
  private openHandlers: Array<() => void> = [];
  private messageHandlers: Array<(e: { data: unknown }) => void> = [];
  private closeHandlers: Array<() => void> = [];
  private errorHandlers: Array<() => void> = [];

  constructor(private readonly onSend: (data: string) => void) {
    // Open asynchronously so the bridge's await-open suspends first.
    queueMicrotask(() => {
      this.readyState = 1;
      for (const h of this.openHandlers) h();
    });
  }

  addEventListener(event: "open" | "message" | "close" | "error", handler: never): void {
    const map = {
      open: this.openHandlers,
      message: this.messageHandlers,
      close: this.closeHandlers,
      error: this.errorHandlers,
    } as const;
    (map[event] as Array<typeof handler>).push(handler);
  }

  send(data: string): void {
    this.onSend(data);
  }

  close(): void {
    this.readyState = 3;
    for (const h of this.closeHandlers) h();
  }

  /** Test hook — deliver a frame as if the mediator pushed it. */
  deliver(frame: string): void {
    for (const h of this.messageHandlers) h({ data: frame });
  }
}

export async function smokeWsBridgeDemux(): Promise<SmokeWsBridgeDemuxResult> {
  let holder: Identity | null = null;
  let vta: Identity | null = null;
  let mediator: Identity | null = null;
  try {
    holder = Identity.generate("did:key:zHolderStub");
    vta = Identity.generate("did:webvh:vta.example.com:abc");
    mediator = Identity.generate("did:key:zMediatorStub");

    const vtaPub = vta.publicJwk() as { kid: string; jwk: PublicJwk };
    const medPub = mediator.publicJwk() as { kid: string; jwk: PublicJwk };
    const holderPub = holder.publicJwk() as { kid: string; jwk: PublicJwk };

    // Hand-rolled state machine driving the fake mediator. Each
    // outbound frame is processed via the in-memory bridge logic to
    // produce the reply JWE we'd ship back over WS. We hold replies
    // in an out-of-order buffer to actively shuffle them.
    const inMemory = new InMemoryDidcommBridge({
      vta,
      mediator,
      holderPublicJwk: holderPub,
      vtaHandlers: {
        [PasskeyManagementProtocol.enrollChallenge]: (req) => {
          const body = req.body as { did?: string };
          // Use the DID as a stable per-request tag so we can return
          // distinct challenges per caller.
          const challenge = body.did?.endsWith("one") ? FIRST_CHALLENGE : SECOND_CHALLENGE;
          const reply: EnrollmentChallengeResponse = {
            challenge,
            rpId: "wallet.example.com",
            rpName: "Test Wallet",
            userHandle: "dXNlcg",
            userName: body.did ?? "anon",
            userDisplayName: body.did ?? "Anon",
            timeoutMs: 60_000,
          };
          return {
            type: PasskeyManagementProtocol.enrollChallengeResponse,
            body: reply,
          };
        },
      },
    });

    let fakeSocket: FakeMediatorWebSocket | null = null;
    const replyBuffer: string[] = [];

    const bridge = new WebSocketDidcommBridge({
      url: "wss://test.invalid/",
      holder,
      expectedSenders: { [vta.did]: vtaPub.jwk },
      webSocketFactory: (_url: string) => {
        fakeSocket = new FakeMediatorWebSocket((outer) => {
          void inMemory
            .sendAndAwaitReply(outer, "(ignored — bridge uses real thid)")
            .then((reply) => {
              replyBuffer.push(reply);
              // Once we have *both* replies queued, deliver in
              // reverse to exercise the demuxer.
              if (replyBuffer.length === 2) {
                const [first, second] = replyBuffer.splice(0, 2);
                fakeSocket?.deliver(second!);
                fakeSocket?.deliver(first!);
              }
            });
        });
        return fakeSocket;
      },
    });

    const transport = new DidcommVtaTransport({
      bridge,
      holder,
      vta: {
        did: vta.did,
        keyAgreementKid: vtaPub.kid,
        keyAgreementPublicJwk: vtaPub.jwk,
      },
      mediator: {
        did: mediator.did,
        keyAgreementKid: medPub.kid,
        keyAgreementPublicJwk: medPub.jwk,
      },
      timeoutMs: 5_000,
    });

    const [firstResult, secondResult] = await Promise.all([
      transport.requestEnrollmentChallenge("did:key:caller-one"),
      transport.requestEnrollmentChallenge("did:key:caller-two"),
    ]);

    bridge.close();

    if (firstResult.challenge !== FIRST_CHALLENGE) {
      return {
        ok: false,
        error: `first challenge mismatch: ${firstResult.challenge} != ${FIRST_CHALLENGE}`,
      };
    }
    if (secondResult.challenge !== SECOND_CHALLENGE) {
      return {
        ok: false,
        error: `second challenge mismatch: ${secondResult.challenge} != ${SECOND_CHALLENGE}`,
      };
    }

    return {
      ok: true,
      firstChallenge: firstResult.challenge,
      secondChallenge: secondResult.challenge,
    };
  } catch (err) {
    return { ok: false, error: (err as Error).message };
  } finally {
    holder?.dispose();
    vta?.dispose();
    mediator?.dispose();
  }
}

// ---------------------------------------------------------------------------
// Coordinate-mediation/2.0 enrollment smoke. Drives mediate-request
// → grant and keylist-update through the in-memory bridge (the same
// bridge used for VTA traffic, exercising the "direct authcrypt to
// mediator, NOT forward-wrapped" path).
// ---------------------------------------------------------------------------

export interface SmokeMediatorEnrollmentResult {
  ok: boolean;
  routingDid?: string;
  keylistUpdateResult?: string;
  error?: string;
}

const FAKE_ROUTING_DID = "did:key:zMediatorRouting";

export async function smokeMediatorEnrollment(): Promise<SmokeMediatorEnrollmentResult> {
  let holder: Identity | null = null;
  let mediator: Identity | null = null;
  try {
    holder = Identity.generate("did:key:zHolderForMediation");
    mediator = Identity.generate("did:key:zMediatorEnrollment");

    const mediatorPub = mediator.publicJwk() as { kid: string; jwk: PublicJwk };
    const holderPub = holder.publicJwk() as { kid: string; jwk: PublicJwk };

    const bridge = new InMemoryDidcommBridge({
      mediator,
      holderPublicJwk: holderPub,
      mediatorHandlers: {
        [CoordinateMediationProtocol.mediateRequest]: () => {
          const reply: MediateGrantBody = { routing_did: [FAKE_ROUTING_DID] };
          return { type: CoordinateMediationProtocol.mediateGrant, body: reply };
        },
        [CoordinateMediationProtocol.keylistUpdate]: (req) => {
          const body = req.body as {
            updates?: Array<{ recipient_did: string; action: "add" | "remove" }>;
          };
          const updated =
            body.updates?.map((u) => ({
              recipient_did: u.recipient_did,
              action: u.action,
              result: "success" as const,
            })) ?? [];
          const reply: KeylistUpdateResponseBody = { updated };
          return {
            type: CoordinateMediationProtocol.keylistUpdateResponse,
            body: reply,
          };
        },
      },
    });

    const client = new MediatorClient({
      bridge,
      holder,
      mediator: {
        did: mediator.did,
        keyAgreementKid: mediatorPub.kid,
        keyAgreementPublicJwk: mediatorPub.jwk,
      },
      timeoutMs: 5_000,
    });

    const grant = await client.requestMediation();
    if (grant.routing_did[0] !== FAKE_ROUTING_DID) {
      return {
        ok: false,
        error: `routing_did mismatch: ${grant.routing_did[0]} != ${FAKE_ROUTING_DID}`,
      };
    }

    const updateResp = await client.updateKeylist([
      { recipient_did: holder.did, action: "add" },
    ]);
    const first = updateResp.updated[0];
    if (!first || first.result !== "success") {
      return {
        ok: false,
        error: `keylist-update did not return success (${first?.result ?? "(none)"})`,
      };
    }

    return {
      ok: true,
      routingDid: grant.routing_did[0],
      keylistUpdateResult: first.result,
    };
  } catch (err) {
    return { ok: false, error: (err as Error).message };
  } finally {
    holder?.dispose();
    mediator?.dispose();
  }
}

// ---------------------------------------------------------------------------
// Pickup3Dispatcher smoke: build a pickup/3.0/delivery wrapping two
// inner authcrypt'd messages (as the mediator would emit in live
// mode), feed to the dispatcher, verify both inner JWEs come out
// and that a frame from a non-mediator sender (e.g. direct VTA
// reply) passes through unchanged.
// ---------------------------------------------------------------------------

export interface SmokePickupDispatchResult {
  ok: boolean;
  extractedFromDelivery?: number;
  passthroughLen?: number;
  firstInnerType?: string;
  secondInnerType?: string;
  error?: string;
}

export async function smokePickupDispatch(): Promise<SmokePickupDispatchResult> {
  let holder: Identity | null = null;
  let vta: Identity | null = null;
  let mediator: Identity | null = null;
  try {
    holder = Identity.generate("did:key:zHolderPickup");
    vta = Identity.generate("did:webvh:vta.example.com:abc");
    mediator = Identity.generate("did:key:zMediatorPickup");

    const vtaPub = vta.publicJwk() as { kid: string; jwk: PublicJwk };
    const holderPub = holder.publicJwk() as { kid: string; jwk: PublicJwk };

    // Build two inner messages the VTA would normally have queued
    // at the mediator awaiting delivery.
    const innerA = await packAuthcrypt(
      {
        type: "https://example.org/test/1.0/alpha",
        from: vta.did,
        to: [holder.did],
        body: { tag: "first" },
      },
      vta,
      [holderPub],
    );
    const innerB = await packAuthcrypt(
      {
        type: "https://example.org/test/1.0/beta",
        from: vta.did,
        to: [holder.did],
        body: { tag: "second" },
      },
      vta,
      [holderPub],
    );

    // Mediator wraps both in a pickup/3.0/delivery envelope. The
    // delivery's `attachments` (an extra field, not in `body`) carry
    // the inner JWEs as parsed JSON.
    const deliveryMessage = {
      id: globalThis.crypto.randomUUID(),
      type: PickupProtocol.delivery,
      from: mediator.did,
      to: [holder.did],
      body: { recipient_did: holder.did },
      attachments: [
        { id: "msg-1", data: { json: JSON.parse(innerA) } },
        { id: "msg-2", data: { json: JSON.parse(innerB) } },
      ],
    };
    const deliveryJwe = await packAuthcryptJson(
      JSON.stringify(deliveryMessage),
      mediator,
      [holderPub],
    );

    const dispatcher = new Pickup3Dispatcher({
      holder,
      mediator: {
        did: mediator.did,
        keyAgreementPublicJwk:
          (mediator.publicJwk() as { kid: string; jwk: PublicJwk }).jwk,
      },
    });

    const extracted = await dispatcher.extract(deliveryJwe);
    if (extracted.length !== 2) {
      return {
        ok: false,
        error: `expected 2 extracted inner JWEs, got ${extracted.length}`,
      };
    }

    // Semantic verification: each extracted JWE decrypts to one of
    // the original messages with the right body tag. JSON key order
    // doesn't survive parse → stringify round-trips, so we don't
    // compare raw strings.
    const decoded = await Promise.all(
      extracted.map(async (jwe) => {
        const r = await unpackMessage(
          { input: jwe, sender_public_jwk: vtaPub.jwk },
          holder!,
        );
        if (r.kind !== "encrypted" || !r.authenticated) {
          throw new Error(`extracted JWE failed auth: ${r.kind}`);
        }
        return r.message as { type?: string; body?: { tag?: string } };
      }),
    );
    const tags = new Set(decoded.map((d) => d.body?.tag));
    if (!tags.has("first") || !tags.has("second")) {
      return {
        ok: false,
        error: `expected tags {first,second}, got ${[...tags].join(",")}`,
      };
    }

    // Pass-through: a frame whose sender isn't the mediator (the
    // VTA, in this case) should come back unchanged.
    const passthrough = await dispatcher.extract(innerA);
    if (passthrough.length !== 1 || passthrough[0] !== innerA) {
      return { ok: false, error: "non-mediator frame did not pass through" };
    }

    return {
      ok: true,
      extractedFromDelivery: extracted.length,
      passthroughLen: passthrough.length,
      firstInnerType: "https://example.org/test/1.0/alpha",
      secondInnerType: "https://example.org/test/1.0/beta",
    };
  } catch (err) {
    return { ok: false, error: (err as Error).message };
  } finally {
    holder?.dispose();
    vta?.dispose();
    mediator?.dispose();
  }
}

// ---------------------------------------------------------------------------
// Notification smoke: setLiveDelivery dispatches a one-way DIDComm
// notification through bridge.send(). The fake mediator handler
// records the flag and returns null (no reply). Validates that the
// in-memory bridge correctly handles the "no reply" path.
// ---------------------------------------------------------------------------

export interface SmokeLiveDeliveryResult {
  ok: boolean;
  recordedFlag?: boolean;
  ackedIdsCount?: number;
  error?: string;
}

export async function smokeMediatorNotifications(): Promise<SmokeLiveDeliveryResult> {
  let holder: Identity | null = null;
  let mediator: Identity | null = null;
  try {
    holder = Identity.generate("did:key:zHolderNotify");
    mediator = Identity.generate("did:key:zMediatorNotify");

    const mediatorPub = mediator.publicJwk() as { kid: string; jwk: PublicJwk };
    const holderPub = holder.publicJwk() as { kid: string; jwk: PublicJwk };

    let recordedFlag: boolean | undefined;
    let ackedIds: string[] = [];

    const bridge = new InMemoryDidcommBridge({
      mediator,
      holderPublicJwk: holderPub,
      mediatorHandlers: {
        [PickupProtocol.liveDeliveryChange]: (req) => {
          const body = req.body as LiveDeliveryChangeBody;
          recordedFlag = body.live_delivery;
          return null; // notification — no reply
        },
        [PickupProtocol.messagesReceived]: (req) => {
          const body = req.body as { message_id_list?: string[] };
          ackedIds = body.message_id_list ?? [];
          return null; // notification — no reply
        },
      },
    });

    const client = new MediatorClient({
      bridge,
      holder,
      mediator: {
        did: mediator.did,
        keyAgreementKid: mediatorPub.kid,
        keyAgreementPublicJwk: mediatorPub.jwk,
      },
    });

    await client.setLiveDelivery(true);
    if (recordedFlag !== true) {
      return {
        ok: false,
        error: `expected recordedFlag=true, got ${recordedFlag}`,
      };
    }

    await client.acknowledgeMessages(["msg-1", "msg-2", "msg-3"]);
    if (ackedIds.length !== 3) {
      return {
        ok: false,
        error: `expected 3 acked ids, got ${ackedIds.length}`,
      };
    }

    return {
      ok: true,
      recordedFlag,
      ackedIdsCount: ackedIds.length,
    };
  } catch (err) {
    return { ok: false, error: (err as Error).message };
  } finally {
    holder?.dispose();
    mediator?.dispose();
  }
}

// ---------------------------------------------------------------------------
// Full wallet-boot smoke: WalletSession from-scratch → mediator
// enrollment → live mode → passkey-management/1.0 enroll-challenge
// against a fake VTA, then a resume-boot that verifies the
// persisted state is loaded (no re-enrollment).
// ---------------------------------------------------------------------------

import { InMemoryKVStore } from "../store/index.js";
import { WalletSession } from "./wallet-session.js";

export interface SmokeWalletBootResult {
  ok: boolean;
  /** Holder DID was identical across the two boots (persistence works). */
  didStablePerBoot?: boolean;
  /** First boot's enrollment with the mediator returned a routing DID. */
  firstBootEnrolled?: boolean;
  /** Live delivery flag flipped on after enrollment. */
  liveMode?: boolean;
  /** Fake VTA's enroll-challenge reply round-tripped through the
   *  bootstrapped DidcommVtaTransport. */
  recoveredChallenge?: string;
  /** Second boot resumed without re-enrolling. */
  resumeSkippedEnrollment?: boolean;
  error?: string;
}

export async function smokeWalletBoot(): Promise<SmokeWalletBootResult> {
  // Identities representing the network the wallet talks to. These
  // would normally be resolved from the VTA's DID document and the
  // mediator's `routing_did`.
  let vtaIdentity: Identity | null = null;
  let mediatorIdentity: Identity | null = null;
  let session1: WalletSession | null = null;
  let session2: WalletSession | null = null;

  try {
    vtaIdentity = Identity.generate("did:webvh:vta.example.com:abc");
    mediatorIdentity = Identity.generate("did:key:zMediatorWallet");
    const vtaPub = vtaIdentity.publicJwk() as { kid: string; jwk: PublicJwk };
    const medPub = mediatorIdentity.publicJwk() as { kid: string; jwk: PublicJwk };

    const store = new InMemoryKVStore();

    // Build a fake mediator+VTA bridge that's reusable across both
    // sessions. We use closures over `vtaIdentity` and
    // `mediatorIdentity` so the bridge keeps working between boots.
    const makeBridge = (holderPubJwk: { kid: string; jwk: PublicJwk }) =>
      new InMemoryDidcommBridge({
        vta: vtaIdentity!,
        mediator: mediatorIdentity!,
        holderPublicJwk: holderPubJwk,
        mediatorHandlers: {
          [CoordinateMediationProtocol.mediateRequest]: () => ({
            type: CoordinateMediationProtocol.mediateGrant,
            body: { routing_did: ["did:key:zMediatorWalletRouting"] },
          }),
          [CoordinateMediationProtocol.keylistUpdate]: (req) => {
            const body = req.body as {
              updates?: Array<{ recipient_did: string; action: "add" | "remove" }>;
            };
            return {
              type: CoordinateMediationProtocol.keylistUpdateResponse,
              body: {
                updated:
                  body.updates?.map((u) => ({
                    recipient_did: u.recipient_did,
                    action: u.action,
                    result: "success",
                  })) ?? [],
              },
            };
          },
          [PickupProtocol.liveDeliveryChange]: () => null,
        },
        vtaHandlers: {
          [PasskeyManagementProtocol.enrollChallenge]: () => ({
            type: PasskeyManagementProtocol.enrollChallengeResponse,
            body: {
              challenge: "Y2hhbGwtd2FsbGV0LWJvb3Q",
              rpId: "wallet.example.com",
              rpName: "Wallet Boot Smoke",
              userHandle: "dXNlcg",
              userName: "alice",
              userDisplayName: "Alice",
              timeoutMs: 60_000,
            },
          }),
        },
      });

    // ---- First boot: from-scratch ----
    // We can't pass the holder pub JWK to the bridge before we know
    // the holder identity, so we construct the bridge after
    // bootstrap reads/generates the holder. The WalletSession's
    // bridgeOverride takes a fully-formed bridge — so we wire a
    // late-binding factory by deferring the InMemoryDidcommBridge
    // construction until we know the holder JWK.
    //
    // To keep WalletSession's contract clean, we instead use
    // WalletSession's natural bridge creation but with a no-op
    // WebSocket factory and a manual InMemoryDidcommBridge running
    // alongside that "delivers" replies in-process. The simpler
    // option: pre-load holder identity via the KVStore by running
    // generateOrLoadHolderIdentity ourselves first, build the
    // bridge with the resulting holder JWK, then pass via
    // bridgeOverride.
    const { generateOrLoadHolderIdentity: gen } = await import(
      "../store/index.js"
    );
    const peek = await gen(store);
    const holderPub = peek.identity.publicJwk() as { kid: string; jwk: PublicJwk };
    peek.identity.dispose();

    const bridge1 = makeBridge(holderPub);

    session1 = new WalletSession({
      store,
      mediator: {
        did: mediatorIdentity.did,
        keyAgreementKid: medPub.kid,
        keyAgreementPublicJwk: medPub.jwk,
        websocketUrl: "wss://test.invalid/",
      },
      vta: {
        did: vtaIdentity.did,
        keyAgreementKid: vtaPub.kid,
        keyAgreementPublicJwk: vtaPub.jwk,
      },
      bridgeOverride: bridge1,
      timeoutMs: 5_000,
    });
    const state1 = await session1.bootstrap();
    await session1.setLiveDelivery(true);
    const challenge1 = await session1
      .transport()
      .requestEnrollmentChallenge(state1.holder.did);

    // Capture before close() disposes the holder.
    const did1 = state1.holder.did;
    const liveMode1 = state1.liveMode;
    const enrolled1 = state1.freshlyEnrolled;
    const routing1Length = state1.routingDids.length;

    session1.close();

    // ---- Second boot: resume from persisted state ----
    const bridge2 = makeBridge(holderPub);
    session2 = new WalletSession({
      store,
      mediator: {
        did: mediatorIdentity.did,
        keyAgreementKid: medPub.kid,
        keyAgreementPublicJwk: medPub.jwk,
        websocketUrl: "wss://test.invalid/",
      },
      vta: {
        did: vtaIdentity.did,
        keyAgreementKid: vtaPub.kid,
        keyAgreementPublicJwk: vtaPub.jwk,
      },
      bridgeOverride: bridge2,
      timeoutMs: 5_000,
    });
    const state2 = await session2.bootstrap();
    const did2 = state2.holder.did;
    const enrolled2 = state2.freshlyEnrolled;
    session2.close();

    return {
      ok: true,
      didStablePerBoot: did1 === did2,
      firstBootEnrolled: enrolled1 && routing1Length > 0,
      liveMode: liveMode1,
      recoveredChallenge: challenge1.challenge,
      resumeSkippedEnrollment: !enrolled2,
    };
  } catch (err) {
    return { ok: false, error: (err as Error).message };
  } finally {
    vtaIdentity?.dispose();
    mediatorIdentity?.dispose();
  }
}
