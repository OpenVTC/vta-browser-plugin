import { Identity, type PublicJwk } from "../didcomm/index.js";
import { InMemoryDidcommBridge } from "./bridge-memory.js";
import { DidcommVtaTransport } from "./didcomm.js";
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
export function smokeBuildDidcommEnrollChallenge(): SmokeDidcommEnrollChallengeResult {
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

    const built = transport.buildOutbound(PasskeyManagementProtocol.enrollChallenge, {
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
      handlers: {
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
