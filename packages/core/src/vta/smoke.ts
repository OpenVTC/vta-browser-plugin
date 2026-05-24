import { Identity, type PublicJwk } from "../didcomm/index.js";
import { InMemoryKVStore } from "../store/index.js";
import { InMemoryDidcommBridge } from "./bridge-memory.js";
import { DidcommVtaTransport } from "./didcomm.js";
import {
  CoordinateMediationProtocol,
  type KeylistUpdateResponseBody,
  type MediateGrantBody,
} from "./mediation.js";
import { MediatorClient } from "./mediator-client.js";
import { PickupProtocol, type LiveDeliveryChangeBody } from "./pickup.js";
import {
  PasskeyVmTask,
  TRUST_TASK_ENVELOPE_TYPE,
  TRUST_TASK_ERROR_TYPE,
} from "./protocol.js";
import type { DidcommMessageBridge } from "./transport.js";
import type { EnrollmentChallengeResponse } from "./types.js";
import { WalletSession } from "./wallet-session.js";

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
 * 1. Mint stub holder / VTA / mediator identities (ephemeral).
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

    const built = await transport.buildOutbound(PasskeyVmTask.enrollChallenge, {
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
// VTA-side authcrypt validation, response routing, response delivery,
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
        // The fake VTA receives one binding-envelope type; it switches on
        // the inner TrustTask's own `type` and replies with a trust-task
        // result envelope (matching the real VTA's DIDComm binding).
        [TRUST_TASK_ENVELOPE_TYPE]: (req) => {
          const tt = req.body as { type?: string; payload?: { did?: string } };
          if (tt.type === PasskeyVmTask.enrollChallenge) {
            const result: EnrollmentChallengeResponse = {
              ceremonyId: "ceremony-001",
              challenge: FAKE_CHALLENGE,
              rpId: FAKE_RP_ID,
              rpName: "Test Wallet",
              userHandle: "dXNlci0wMDE",
              userName: tt.payload?.did ?? "anon",
              userDisplayName: "Test User",
              timeoutMs: 60_000,
            };
            return {
              type: TRUST_TASK_ENVELOPE_TYPE,
              body: {
                id: "resp-enroll-challenge",
                type: PasskeyVmTask.enrollChallenge,
                payload: result,
              },
            };
          }
          return {
            type: TRUST_TASK_ENVELOPE_TYPE,
            body: {
              id: "resp-error",
              type: TRUST_TASK_ERROR_TYPE,
              payload: { code: "unsupported_type", message: tt.type ?? "" },
            },
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
// Coordinate-mediation/2.0 enrollment smoke. Drives mediate-request
// → grant and keylist-update through the in-memory bridge (the same
// bridge used for VTA traffic, exercising the "direct authcrypt to
// mediator, NOT forward-wrapped" path). MediatorClient is retained as a
// standalone primitive even though WalletSession no longer enrolls.
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
// Wallet-boot smoke: WalletSession.withBridge → passkey-management/1.0
// enroll-challenge against a fake VTA, then a resume-boot that verifies
// the persisted holder identity is reloaded (same DID across boots).
// Uses the in-memory bridge (the test seam); the live path is
// WalletSession.fromDids over a real MediatorSession.
// ---------------------------------------------------------------------------

export interface SmokeWalletBootResult {
  ok: boolean;
  /** Holder DID was identical across the two boots (persistence works). */
  didStablePerBoot?: boolean;
  /** Fake VTA's enroll-challenge reply round-tripped through the session. */
  recoveredChallenge?: string;
  /** Second boot reloaded the persisted identity (didn't mint fresh). */
  resumeReloadedIdentity?: boolean;
  error?: string;
}

export async function smokeWalletBoot(): Promise<SmokeWalletBootResult> {
  // Identities representing the network the wallet talks to. These
  // would normally be resolved from the VTA's + mediator's DID docs.
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

    const vtaEndpoint = {
      did: vtaIdentity.did,
      keyAgreementKid: vtaPub.kid,
      keyAgreementPublicJwk: vtaPub.jwk,
    };
    const mediatorEndpoint = {
      did: mediatorIdentity.did,
      keyAgreementKid: medPub.kid,
      keyAgreementPublicJwk: medPub.jwk,
    };

    // The in-memory bridge needs the holder's public JWK to unpack its
    // authcrypt requests, so we pre-resolve the holder once (minting +
    // persisting it) before building the bridge. Both WalletSessions
    // then reload that same persisted holder.
    const { generateOrLoadHolderIdentity: gen } = await import(
      "../store/index.js"
    );
    const peek = await gen(store);
    const holderPub = peek.identity.publicJwk() as { kid: string; jwk: PublicJwk };
    peek.identity.dispose();

    const makeBridge = () =>
      new InMemoryDidcommBridge({
        vta: vtaIdentity!,
        mediator: mediatorIdentity!,
        holderPublicJwk: holderPub,
        vtaHandlers: {
          [TRUST_TASK_ENVELOPE_TYPE]: () => ({
            type: TRUST_TASK_ENVELOPE_TYPE,
            body: {
              id: "resp-wallet-boot",
              type: PasskeyVmTask.enrollChallenge,
              payload: {
                ceremonyId: "ceremony-wallet-boot",
                challenge: "Y2hhbGwtd2FsbGV0LWJvb3Q",
                rpId: "wallet.example.com",
                rpName: "Wallet Boot Smoke",
                userHandle: "dXNlcg",
                userName: "alice",
                userDisplayName: "Alice",
                timeoutMs: 60_000,
              },
            },
          }),
        },
      });

    // ---- First boot ----
    session1 = await WalletSession.withBridge({
      store,
      bridge: makeBridge(),
      vta: vtaEndpoint,
      mediator: mediatorEndpoint,
      timeoutMs: 5_000,
    });
    const holderDid1 = session1.state().holder.did;
    const challenge1 = await session1
      .transport()
      .requestEnrollmentChallenge(holderDid1);
    session1.close();

    // ---- Second boot: resume from the persisted identity ----
    session2 = await WalletSession.withBridge({
      store,
      bridge: makeBridge(),
      vta: vtaEndpoint,
      mediator: mediatorEndpoint,
      timeoutMs: 5_000,
    });
    const state2 = session2.state();
    const holderDid2 = state2.holder.did;
    session2.close();

    return {
      ok: true,
      didStablePerBoot: holderDid1 === holderDid2,
      recoveredChallenge: challenge1.challenge,
      resumeReloadedIdentity: !state2.freshlyMintedIdentity,
    };
  } catch (err) {
    return { ok: false, error: (err as Error).message };
  } finally {
    vtaIdentity?.dispose();
    mediatorIdentity?.dispose();
  }
}
