/// <reference types="chrome" />

// Offscreen document — runs the DIDComm login on behalf of the service
// worker. A real (hidden) document context, so dynamic `import()`, a DOM,
// WASM, and WebSocket all work here, unlike an MV3 service worker. The
// did:webvh resolver (didwebvh-ts) and the mediator session need exactly
// those, which is why this lives here rather than in `background.ts`.

import {
  buildConfirmResponse,
  connectMediatorSession,
  createStopwatch,
  didcommKeyAgreementFromSigning,
  generateSigningIdentity,
  Identity,
  IndexedDBKVStore,
  loginViaDidcomm,
  loginViaSiop,
  markInboundHandled,
  type MediatorConnection,
  MediatorSessionBridge,
  parseConfirmRequest,
  requestVtaApproval,
  resolveKeyAgreement,
  resolveVtaServices,
  setDeviceWakeRest,
  signingIdentityFromSecret,
  stepUpVtaFinish,
  stepUpVtaStart,
  signTrustTask,
  deriveSigningKeyId,
  forgetHolderRecord,
  holderIdentityState,
  holderInputsFromAdminReply,
  installVtaMintedHolder,
  ProvisionProblemReportError,
  runProvisionIntegration,
  vaultDeleteRest,
  vaultListRest,
  vaultSignTrustTaskRest,
  vtaCreateContext,
  vtaListContexts,
  vtaListDidsRest,
  vaultProxyLoginRest,
  vaultReleaseRest,
  vaultUpsertRest,
  verifyDid,
} from "@openvtc/pnm-core";
import { base64url } from "@openvtc/vti-didcomm-js";
import { getWalletMediatorDid, loadHolder } from "./holder.js";
import { WebAuthnPrfSecretWrap } from "./webauthn-prf-wrap.js";
import {
  OFFSCREEN_DIDCOMM_LOGIN,
  OFFSCREEN_GET_STATUS,
  OFFSCREEN_LOCK_WALLET,
  OFFSCREEN_CREATE_CONTEXT,
  OFFSCREEN_DERIVE_SIGNING_KEY_ID,
  OFFSCREEN_HOLDER_STATE,
  OFFSCREEN_LIST_CONTEXTS,
  OFFSCREEN_LIST_DIDS,
  OFFSCREEN_UNLOCK_PRF,
  OFFSCREEN_FORGET_HOLDER_RECORD,
  OFFSCREEN_REFRESH_VTA_TRANSPORTS,
  OFFSCREEN_REST_LOGIN,
  OFFSCREEN_SET_WAKE,
  OFFSCREEN_WALLET_LOCK_STATE,
  OFFSCREEN_ONBOARD_CONNECT,
  OFFSCREEN_ONBOARD_PREPARE,
  OFFSCREEN_SIGN_TRUST_TASK,
  OFFSCREEN_START_INBOUND,
  OFFSCREEN_STEP_UP_VTA,
  OFFSCREEN_TARGET,
  OFFSCREEN_VAULT_DELETE,
  OFFSCREEN_VAULT_LIST,
  OFFSCREEN_VAULT_PROXY_LOGIN,
  OFFSCREEN_VAULT_RELEASE,
  OFFSCREEN_VAULT_UPSERT,
  OFFSCREEN_VERIFY_DID,
  RUNTIME_INBOUND_CONSENT,
  type OffscreenDidcommLoginRequest,
  type OffscreenRestLoginRequest,
  type OffscreenCreateContextRequest,
  type OffscreenDeriveSigningKeyIdRequest,
  type OffscreenOnboardConnectRequest,
  type OffscreenOnboardPrepareRequest,
  type OffscreenUnlockPrfRequest,
  type OffscreenSetWakeRequest,
  type OffscreenSignTrustTaskRequest,
  type OffscreenStepUpVtaRequest,
  type OffscreenVaultDeleteRequest,
  type OffscreenVaultListRequest,
  type OffscreenVaultProxyLoginRequest,
  type OffscreenVaultReleaseRequest,
  type OffscreenVaultUpsertRequest,
  type OffscreenVerifyDidRequest,
  type OnboardConnectResult,
  type OnboardPrepareResult,
  type RuntimeLoginResponse,
  type SignTrustTaskParams,
  type SignTrustTaskResult,
  type VerifyRpDidResult,
} from "./bridge-protocol.js";

// Request durable IndexedDB on offscreen-document load. The wallet's
// irreplaceable key material (the v4 holder records) lives in
// IndexedDB here, while the non-secret `connection` metadata lives in
// `chrome.storage.local` (popup zustand store). Those two stores have
// different eviction semantics: `chrome.storage.local` is not cleared
// by the browser's "Cookies and other site data" wipe or by storage
// pressure, but best-effort IndexedDB IS. That asymmetry is what
// produces the "Stale connection cleared — no holder identity is
// persisted" state — the connection survives while the holder keys are
// silently evicted, leaving no recovery path but re-onboarding.
//
// `navigator.storage.persist()` marks this origin's storage durable so
// the browser stops evicting it under pressure. It's idempotent and
// cheap, but we gate on `persisted()` first so a granted box doesn't
// re-request on every offscreen spin-up. Never let this throw — a
// failed/absent StorageManager must not break offscreen startup; the
// wallet still works, it's just back to best-effort durability.
void (async function ensurePersistentStorage(): Promise<void> {
  try {
    if (!navigator.storage?.persist) {
      console.warn("[pnm] StorageManager.persist unavailable — IndexedDB remains best-effort");
      return;
    }
    if (await navigator.storage.persisted()) return; // already durable
    const granted = await navigator.storage.persist();
    console.info(
      granted
        ? "[pnm] persistent storage granted — IndexedDB holder records are now eviction-protected"
        : "[pnm] persistent storage request denied — IndexedDB holder records remain best-effort",
    );
  } catch (e: unknown) {
    console.warn("[pnm] persistent storage request failed:", e instanceof Error ? e.message : e);
  }
})();

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  // Defence-in-depth sender check — same rationale as the
  // background listener (M4 from the May 2026 security review).
  // MV3 isolation enforces this at the manifest layer; this
  // re-check surfaces a useful warn if anything ever slips
  // past.
  if (sender.id !== chrome.runtime.id) {
    // eslint-disable-next-line no-console
    console.warn(
      `[offscreen] rejecting message from foreign sender id=${sender.id} url=${sender.url}`,
    );
    sendResponse({ ok: false, error: "foreign sender rejected" });
    return false;
  }

  const msg = message as { target?: string; type?: string };
  if (msg?.target !== OFFSCREEN_TARGET) return false; // not for us
  if (msg.type === OFFSCREEN_DIDCOMM_LOGIN) {
    doDidcommLogin(message as OffscreenDidcommLoginRequest)
      .then(sendResponse)
      .catch((e: unknown) =>
        sendResponse({ ok: false, error: e instanceof Error ? e.message : String(e) }),
      );
    return true; // async sendResponse
  }
  if (msg.type === OFFSCREEN_REST_LOGIN) {
    doRestLogin(message as OffscreenRestLoginRequest)
      .then(sendResponse)
      .catch((e: unknown) =>
        sendResponse({ ok: false, error: e instanceof Error ? e.message : String(e) }),
      );
    return true; // async sendResponse
  }
  if (msg.type === OFFSCREEN_STEP_UP_VTA) {
    doStepUpVta(message as OffscreenStepUpVtaRequest)
      .then(sendResponse)
      .catch((e: unknown) =>
        sendResponse({ ok: false, error: e instanceof Error ? e.message : String(e) }),
      );
    return true; // async sendResponse
  }
  if (msg.type === OFFSCREEN_START_INBOUND) {
    const req = message as { vtaDids: string[] };
    void reconcileInbound(req.vtaDids ?? []);
    return false; // fire-and-forget
  }
  if (msg.type === OFFSCREEN_GET_STATUS) {
    sendResponse({ mediators: statusSnapshot() });
    return false; // synchronous response
  }
  if (msg.type === OFFSCREEN_LOCK_WALLET) {
    WebAuthnPrfSecretWrap.lock();
    return false; // fire-and-forget
  }
  if (msg.type === OFFSCREEN_ONBOARD_PREPARE) {
    doOnboardPrepare((message as OffscreenOnboardPrepareRequest).vtaDid)
      .then((result) => sendResponse({ ok: true, result }))
      .catch((e: unknown) =>
        sendResponse({ ok: false, error: e instanceof Error ? e.message : String(e) }),
      );
    return true; // async sendResponse
  }
  if (msg.type === OFFSCREEN_ONBOARD_CONNECT) {
    const req = message as OffscreenOnboardConnectRequest;
    doOnboardConnect({
      ...(req.context ? { context: req.context } : {}),
      createIfMissing: req.createIfMissing ?? false,
    })
      .then((result) => sendResponse({ ok: true, result }))
      .catch((e: unknown) => {
        // Preserve the structured problem-report fields when the VTA
        // replied with one. The popup branches on `code` to surface
        // recovery UX (e.g. the context_required picker); without
        // these fields the message string would have to be regex-
        // parsed, which is fragile.
        if (e instanceof ProvisionProblemReportError) {
          sendResponse({
            ok: false,
            error: e.message,
            code: e.report.code,
            candidates: e.report.args,
          });
          return;
        }
        sendResponse({ ok: false, error: e instanceof Error ? e.message : String(e) });
      });
    return true; // async sendResponse
  }
  if (msg.type === OFFSCREEN_LIST_CONTEXTS) {
    const req = message as { vtaDid: string; restBaseUrl: string };
    doListContexts(req)
      .then((result) => sendResponse({ ok: true, result }))
      .catch((e: unknown) =>
        sendResponse({ ok: false, error: e instanceof Error ? e.message : String(e) }),
      );
    return true; // async sendResponse
  }
  if (msg.type === OFFSCREEN_LIST_DIDS) {
    const req = message as { vtaDid: string; restBaseUrl: string; contextId?: string };
    doListDids(req)
      .then((result) => sendResponse({ ok: true, result }))
      .catch((e: unknown) =>
        sendResponse({ ok: false, error: e instanceof Error ? e.message : String(e) }),
      );
    return true; // async sendResponse
  }
  if (msg.type === OFFSCREEN_SET_WAKE) {
    const req = message as OffscreenSetWakeRequest;
    doSetWake(req)
      .then((result) => sendResponse({ ok: true, result }))
      .catch((e: unknown) =>
        sendResponse({ ok: false, error: e instanceof Error ? e.message : String(e) }),
      );
    return true; // async sendResponse
  }
  if (msg.type === OFFSCREEN_CREATE_CONTEXT) {
    const req = message as OffscreenCreateContextRequest & {
      vtaDid: string;
      restBaseUrl: string;
    };
    doCreateContext(req)
      .then((result) => sendResponse({ ok: true, result }))
      .catch((e: unknown) =>
        sendResponse({ ok: false, error: e instanceof Error ? e.message : String(e) }),
      );
    return true; // async sendResponse
  }
  if (msg.type === OFFSCREEN_DERIVE_SIGNING_KEY_ID) {
    const req = message as OffscreenDeriveSigningKeyIdRequest;
    doDeriveSigningKeyId(req.did)
      .then((result) => sendResponse({ ok: true, result }))
      .catch((e: unknown) =>
        sendResponse({ ok: false, error: e instanceof Error ? e.message : String(e) }),
      );
    return true; // async sendResponse
  }
  if (msg.type === OFFSCREEN_UNLOCK_PRF) {
    const req = message as OffscreenUnlockPrfRequest;
    // `chrome.runtime.sendMessage` JSON-serialises payloads, so the
    // bridge carries the PRF output as base64url. Decode at the
    // edge so `doUnlockPrf` sees real Uint8Array bytes (matching
    // what `seedCachedKeyFromPrfOutput` expects).
    let prfOutput: Uint8Array;
    try {
      if (typeof req.prfOutputB64u !== "string" || req.prfOutputB64u.length === 0) {
        throw new Error("prfOutputB64u missing or empty");
      }
      prfOutput = base64url.decode(req.prfOutputB64u);
    } catch (e) {
      sendResponse({ ok: false, error: e instanceof Error ? e.message : String(e) });
      return false;
    }
    doUnlockPrf(prfOutput)
      .then(() => sendResponse({ ok: true }))
      .catch((e: unknown) =>
        sendResponse({ ok: false, error: e instanceof Error ? e.message : String(e) }),
      );
    return true; // async sendResponse
  }
  if (msg.type === OFFSCREEN_WALLET_LOCK_STATE) {
    const req = message as { vtaDid?: string };
    doWalletLockState(req.vtaDid)
      .then((result) => sendResponse({ ok: true, result }))
      .catch((e: unknown) =>
        sendResponse({ ok: false, error: e instanceof Error ? e.message : String(e) }),
      );
    return true; // async sendResponse
  }
  if (msg.type === OFFSCREEN_FORGET_HOLDER_RECORD) {
    const req = message as { vtaDid: string };
    doForgetHolderRecord(req.vtaDid)
      .then(() => sendResponse({ ok: true }))
      .catch((e: unknown) =>
        sendResponse({ ok: false, error: e instanceof Error ? e.message : String(e) }),
      );
    return true; // async sendResponse
  }
  if (msg.type === OFFSCREEN_REFRESH_VTA_TRANSPORTS) {
    const req = message as { vtaDid: string };
    doRefreshVtaTransports(req.vtaDid)
      .then((result) => sendResponse({ ok: true, result }))
      .catch((e: unknown) =>
        sendResponse({ ok: false, error: e instanceof Error ? e.message : String(e) }),
      );
    return true; // async sendResponse
  }
  if (msg.type === OFFSCREEN_HOLDER_STATE) {
    doHolderState()
      .then((result) => sendResponse({ ok: true, result }))
      .catch((e: unknown) =>
        sendResponse({ ok: false, error: e instanceof Error ? e.message : String(e) }),
      );
    return true; // async sendResponse
  }
  if (msg.type === OFFSCREEN_SIGN_TRUST_TASK) {
    const req = message as OffscreenSignTrustTaskRequest;
    doSignTrustTask(req.vtaDid, req.params, req.restBaseUrl)
      .then((result) => sendResponse({ ok: true, result }))
      .catch((e: unknown) =>
        sendResponse({ ok: false, error: e instanceof Error ? e.message : String(e) }),
      );
    return true; // async sendResponse
  }
  if (msg.type === OFFSCREEN_VERIFY_DID) {
    doVerifyDid((message as OffscreenVerifyDidRequest).did)
      .then((result) => sendResponse({ ok: true, result }))
      .catch((e: unknown) =>
        sendResponse({ ok: false, error: e instanceof Error ? e.message : String(e) }),
      );
    return true; // async sendResponse
  }
  if (msg.type === OFFSCREEN_VAULT_LIST) {
    doVaultList(message as OffscreenVaultListRequest)
      .then((result) => sendResponse({ ok: true, result }))
      .catch((e: unknown) =>
        sendResponse({ ok: false, error: e instanceof Error ? e.message : String(e) }),
      );
    return true; // async sendResponse
  }
  if (msg.type === OFFSCREEN_VAULT_UPSERT) {
    doVaultUpsert(message as OffscreenVaultUpsertRequest)
      .then((result) => sendResponse({ ok: true, result }))
      .catch((e: unknown) =>
        sendResponse({ ok: false, error: e instanceof Error ? e.message : String(e) }),
      );
    return true;
  }
  if (msg.type === OFFSCREEN_VAULT_DELETE) {
    doVaultDelete(message as OffscreenVaultDeleteRequest)
      .then((result) => sendResponse({ ok: true, result }))
      .catch((e: unknown) =>
        sendResponse({ ok: false, error: e instanceof Error ? e.message : String(e) }),
      );
    return true;
  }
  if (msg.type === OFFSCREEN_VAULT_RELEASE) {
    doVaultRelease(message as OffscreenVaultReleaseRequest)
      .then((result) => sendResponse({ ok: true, result }))
      .catch((e: unknown) =>
        sendResponse({ ok: false, error: e instanceof Error ? e.message : String(e) }),
      );
    return true;
  }
  if (msg.type === OFFSCREEN_VAULT_PROXY_LOGIN) {
    doVaultProxyLogin(message as OffscreenVaultProxyLoginRequest)
      .then((result) => sendResponse({ ok: true, result }))
      .catch((e: unknown) =>
        sendResponse({ ok: false, error: e instanceof Error ? e.message : String(e) }),
      );
    return true;
  }
  return false;
});

// Vault — list. Resolves the VTA's keyAgreement, loads the holder identity
// (the X25519 leg of the did:peer is the authcrypt sender), and runs
// `vaultListRest` end-to-end against the VTA's REST + trust-task dispatcher.
async function doVaultList(req: OffscreenVaultListRequest) {
  const { identity: holder } = await loadHolder(req.vtaDid);
  const service = await resolveKeyAgreement(req.vtaDid);
  // The bridge protocol intentionally types filter loosely (string secretKind)
  // so it doesn't have to import @openvtc/pnm-core's narrowed enums. Cast at this
  // wire boundary — the values that flow through are sanity-checked by the
  // canonical schema validator on the VTA side anyway.
  type VaultRestOpts = Parameters<typeof vaultListRest>[0];
  const opts: VaultRestOpts = req.filter
    ? {
        baseUrl: req.restBaseUrl,
        holder,
        service,
        filter: req.filter as NonNullable<VaultRestOpts["filter"]>,
      }
    : { baseUrl: req.restBaseUrl, holder, service };
  const response = await vaultListRest(opts);
  return {
    entries: response.entries,
    truncated: response.truncated,
  };
}

// Vault — upsert. Sealed-secret packing happens inside @openvtc/pnm-core's
// vaultUpsertRest (uses the holder's X25519 to authcrypt the VaultSecret
// JSON to the VTA's keyAgreement key).
async function doVaultUpsert(req: OffscreenVaultUpsertRequest) {
  const { identity: holder } = await loadHolder(req.vtaDid);
  const service = await resolveKeyAgreement(req.vtaDid);
  type Opts = Parameters<typeof vaultUpsertRest>[0];
  // The bridge protocol types secretKind / secret loosely (strings) to
  // avoid importing @openvtc/pnm-core's enums into bridge-protocol.ts. Cast at
  // this boundary — server-side canonical-schema validation is the real
  // authority anyway.
  const opts = {
    baseUrl: req.restBaseUrl,
    holder,
    service,
    ...req.body,
  } as unknown as Opts;
  return await vaultUpsertRest(opts);
}

// Vault — delete. No envelope; just authenticated POST.
async function doVaultDelete(req: OffscreenVaultDeleteRequest) {
  const { identity: holder } = await loadHolder(req.vtaDid);
  const service = await resolveKeyAgreement(req.vtaDid);
  return await vaultDeleteRest({
    baseUrl: req.restBaseUrl,
    holder,
    service,
    ...req.body,
  });
}

// Vault — release. Server returns an authcrypt JWE; @openvtc/pnm-core's
// vaultReleaseRest unpacks it against the holder's private X25519
// (which lives here in offscreen) and surfaces the cleartext secret.
async function doVaultRelease(req: OffscreenVaultReleaseRequest) {
  const { identity: holder } = await loadHolder(req.vtaDid);
  const service = await resolveKeyAgreement(req.vtaDid);
  return await vaultReleaseRest({
    baseUrl: req.restBaseUrl,
    holder,
    service,
    ...req.body,
  });
}

// Vault — proxy-login. The VTA performs the login at the bound third
// party and authcrypts the resulting SessionBlob to the holder's
// X25519. Offscreen unpacks the JWE (the holder's private key lives
// here) and returns the cleartext SessionBlob to the popup over the
// bridge. The bridge protocol types `target` loosely so it doesn't
// have to import @openvtc/pnm-core's narrowed SiteTarget enum; cast at this
// wire boundary — the server-side canonical-schema validation is the
// real authority.
async function doVaultProxyLogin(req: OffscreenVaultProxyLoginRequest) {
  const { identity: holder } = await loadHolder(req.vtaDid);
  const service = await resolveKeyAgreement(req.vtaDid);
  type Opts = Parameters<typeof vaultProxyLoginRest>[0];
  const opts = {
    baseUrl: req.restBaseUrl,
    holder,
    service,
    ...req.body,
  } as unknown as Opts;
  return await vaultProxyLoginRest(opts);
}

// Resolve + verify a DID for the consent prompt's verification badge. The
// core `verifyDid` never throws — it returns `{ resolved: false, error }` on
// failure — so this is a thin pass-through that just normalises the shape
// across the IPC boundary.
async function doVerifyDid(did: string): Promise<VerifyRpDidResult> {
  const v = await verifyDid(did);
  return {
    did: v.did,
    method: v.method,
    resolved: v.resolved,
    ...(v.domain ? { domain: v.domain } : {}),
    ...(v.error ? { error: v.error } : {}),
  };
}

// Sign a Trust-Task envelope. Two paths:
//
// 1. **Holder-signed (default).** When `asDid` is absent the envelope
//    is signed locally by the wallet's holder did:key #key-2 — the
//    same eddsa-jcs-2022 Data Integrity proof the wallet has emitted
//    since the beginning. The RP attributes the request to the holder
//    DID.
//
// 2. **Principal-signed via VTA (`asDid` set).** After a
//    `vault/proxy-login/0.1` session the RP authenticates the session
//    as the vault entry's `principalDid`, NOT the holder DID. Any
//    follow-up Trust Task the RP expects to be signed by the same
//    session identity must carry a proof whose
//    `verificationMethod = principalDid#<keyId>`. The holder doesn't
//    hold the principal's signing key (it lives at the VTA), so the
//    wallet routes via `vault/sign-trust-task/0.1`: the VTA
//    canonicalises + signs + returns the signed envelope. Same
//    eddsa-jcs-2022 proof shape, just signed by a different key.
//
// Falls back to holder-signing on `asDid` set BUT no matching vault
// entry — easier on the caller than failing, and the resulting
// proof's verificationMethod ≠ asDid will surface as a clear RP-side
// rejection the operator can diagnose.
async function doSignTrustTask(
  vtaDid: string,
  params: SignTrustTaskParams,
  restBaseUrl: string | undefined,
): Promise<SignTrustTaskResult> {
  const envelope = params.envelope;

  if (params.asDid && restBaseUrl) {
    // Principal-signed path: find the matching vault entry, route via VTA.
    const { identity: holder, signing } = await loadHolder(vtaDid);
    const service = await resolveKeyAgreement(vtaDid);
    const listed = await vaultListRest({
      baseUrl: restBaseUrl,
      holder,
      service,
    });
    const match = listed.entries.find(
      (e) =>
        e.principalDid === params.asDid &&
        (e.secretKind === "didSelfIssued" || e.secretKind === "didcommPeer"),
    );
    if (match) {
      // Ensure issuer is set on the envelope — the VTA rejects with
      // envelope_issuer_mismatch if it doesn't already match the
      // entry's principalDid. We don't silently rewrite either (matches
      // the VTA's policy); we just check and surface a clearer error
      // here than the RP-style mismatch reject from the server.
      const issuer = (envelope as { issuer?: unknown }).issuer;
      if (typeof issuer === "string" && issuer !== params.asDid) {
        throw new Error(
          `signTrustTask: envelope.issuer (${issuer}) does not match asDid (${params.asDid}); set envelope.issuer = asDid before calling`,
        );
      }
      const toSign: Record<string, unknown> = {
        ...envelope,
        issuer: params.asDid,
      };
      const { signedEnvelope } = await vaultSignTrustTaskRest({
        baseUrl: restBaseUrl,
        holder,
        service,
        entryId: match.id,
        unsignedEnvelope: toSign,
      });
      return { signedEnvelope, holderDid: params.asDid };
    }
    // Fall through to holder-signing with a warning the operator
    // can spot in the offscreen console.
    console.warn(
      `[pnm] signTrustTask: asDid=${params.asDid} requested but no matching vault entry found; falling back to holder-signed proof (the RP will likely reject)`,
    );
    const signedEnvelope = await signTrustTask({
      envelope: { ...envelope },
      signing,
    });
    return { signedEnvelope, holderDid: signing.did };
  }

  // Holder-signed path: existing default.
  const { signing } = await loadHolder(vtaDid);
  // signTrustTask mutates in place and returns the same reference; clone
  // first so the caller's input is preserved across the IPC boundary
  // (chrome.runtime.sendMessage serializes — a defensive copy is cheap and
  // makes the contract clear).
  const signedEnvelope = await signTrustTask({
    envelope: { ...envelope },
    signing,
  });
  return { signedEnvelope, holderDid: signing.did };
}

// ─── Onboarding: ephemeral did:key → VTA-minted holder did:key ───
// PREPARE resolves the VTA's transports, mints an ephemeral did:key, and
// persists it (so it survives the popup round-trip while the operator grants
// it).
//
// CONNECT authenticates as that ephemeral over DIDComm and runs the
// `provision-integration` flow: the VTA mints a fresh long-term admin DID
// + private keys + authorization VC under its own custody, then ships the
// material HPKE-sealed to the ephemeral did:key. The wallet adopts the
// VTA-minted DID as its holder identity (v4 persisted shape) and discards
// the ephemeral.
//
// Prior to M2C this path used `acl/swap-key` to rotate the ephemeral's ACL
// entry onto a wallet-self-derived `did:peer:2`. That made the wallet the
// minter of its own long-term identity — out of step with the rest of the
// stack (mediator setup, did-hosting setup, etc.) where every consumer's
// long-term identity is VTA-minted. M2C aligns the wallet with that model.

const ONBOARD_KEY = "onboard:pending";

interface PendingOnboard {
  ephemeralSecret: Uint8Array;
  vtaDid: string;
  mediatorDid?: string;
  restBaseUrl?: string;
}

async function doOnboardPrepare(vtaDid: string): Promise<OnboardPrepareResult> {
  const services = await resolveVtaServices(vtaDid);
  if (!services.didcomm && !services.rest) {
    throw new Error(`${vtaDid} advertises no #vta-didcomm or #vta-rest service`);
  }
  const eph = generateSigningIdentity();
  const store = new IndexedDBKVStore();
  const pending: PendingOnboard = {
    ephemeralSecret: eph.privateKey,
    vtaDid,
    ...(services.didcomm ? { mediatorDid: services.didcomm.mediatorDid } : {}),
    ...(services.rest ? { restBaseUrl: services.rest.baseUrl } : {}),
  };
  await store.put(ONBOARD_KEY, pending);
  return {
    ephemeralDid: eph.did,
    // `--expires 1h` so an abandoned onboarding (user prepares but never
    // connects) doesn't leave a permanent admin grant for the ephemeral
    // did:key. On successful connect, swap-acl deletes the row regardless
    // of expiry; if the user takes >1h between Prepare and Connect they
    // re-run Prepare to mint a fresh ephemeral. The acl_sweeper prunes
    // the expired row on its background pass.
    command: `pnm acl create --did ${eph.did} --role admin --expires 1h`,
    ...(services.didcomm ? { mediatorDid: services.didcomm.mediatorDid } : {}),
    ...(services.rest ? { restBaseUrl: services.rest.baseUrl } : {}),
  };
}

interface OnboardConnectParams {
  /** Optional maintainer context override. When omitted, the VTA's
   *  context inference rules pick the target context (single-context
   *  grant → that context; super-admin + single-context VTA → that
   *  context). Operators with multi-context VTAs override via the
   *  popup's "Specify context" toggle. */
  context?: string;
  /** When `true`, asks the VTA to provision the override context inline
   *  if it doesn't yet exist. Only meaningful when `context` is set;
   *  the wallet does not auto-create against an inferred context.
   *  Requires the ephemeral's grant to be super-admin. */
  createIfMissing: boolean;
}

async function doOnboardConnect(params: OnboardConnectParams): Promise<OnboardConnectResult> {
  const store = new IndexedDBKVStore();
  const pending = await store.get<PendingOnboard>(ONBOARD_KEY);
  if (!pending) throw new Error("no pending onboarding — prepare first");
  if (!pending.mediatorDid) {
    // provision-integration is DIDComm-only in this port. REST fallback is
    // doable but doubles the implementation surface for a path the wallet
    // rarely hits (every VTA we ship today advertises #vta-didcomm). Drop
    // back to a clear error rather than silently failing later.
    throw new Error(
      "VTA does not advertise #vta-didcomm — provision-integration requires DIDComm",
    );
  }

  // Reconstruct the operator-granted ephemeral as both an X25519 DIDComm
  // identity (authcrypt sender) AND an Ed25519 signing identity. The
  // SIGNING identity is what signs the BootstrapRequest VP; its Ed25519
  // seed is ALSO the recipient secret the sealed bundle is HPKE-encrypted
  // to (via Montgomery clamping — same derivation @noble/curves and the
  // VTA's Rust side both use). One key, three roles.
  const ephSigning = signingIdentityFromSecret(new Uint8Array(pending.ephemeralSecret));
  const ka = didcommKeyAgreementFromSigning(ephSigning);
  const ephemeral = Identity.fromSecretJwk({
    did: ephSigning.did,
    kid: ka.keyAgreementKid,
    jwk: ka.secretJwk,
  });

  const service = await resolveKeyAgreement(pending.vtaDid);

  // Round-trip: build VP → authcrypt → forward via mediator → open sealed
  // reply → extract MinimalAdminReply. The full pipeline lives in
  // @openvtc/pnm-core/provision; offscreen.ts just wires the mediator session in.
  const conn = await connectMediatorSession({
    holder: ephemeral,
    mediatorDid: pending.mediatorDid,
    vtaDid: pending.vtaDid,
  });
  let adminReply;
  try {
    const bridge = new MediatorSessionBridge(conn);
    adminReply = await runProvisionIntegration({
      bridge,
      ephemeral,
      ephemeralSigning: ephSigning,
      service,
      mediator: conn.mediator,
      vtaDid: pending.vtaDid,
      ...(params.context ? { context: params.context } : {}),
      ...(params.createIfMissing ? { createContext: true } : {}),
      note: "browser-plugin onboarding",
    });
  } finally {
    conn.close();
  }

  // Adopt the VTA-minted identity as the wallet's holder. The adopter
  // decodes the multibase private keys, cross-checks X25519 = Montgomery
  // (Ed25519 seed), cross-checks the did:key identifier matches the
  // Ed25519 pubkey, and produces the seed-only persistence shape v4
  // expects.
  //
  // **Always install plaintext.** Encryption is the popup's job — the
  // post-onboard prompt runs the WebAuthn ceremony in a visible context
  // with a fresh user gesture, then re-wraps the record in place via
  // `rewrapHolderV4Secret`. Trying to encrypt directly from the
  // offscreen document doesn't work: offscreen is hidden by design, so
  // `navigator.credentials.{create,get}` either rejects with
  // NotAllowedError or hangs forever waiting for a user gesture that
  // can never arrive. The previous logic guarded against this by
  // catching a "declined to wrap" error from the underlying wrap, but
  // the multi-VTA wrap reuse (PR 1) changed the failure mode from a
  // synchronous throw into a hanging `.get` ceremony.
  //
  // `secretEncrypted: false` is therefore the unconditional return.
  // The popup compares against `secretEncrypted` in its
  // `pendingConnect` handling and unconditionally surfaces the
  // post-onboard encrypt prompt (PR #32/#35) so the operator can opt
  // into encryption when they choose.
  const holderInputs = holderInputsFromAdminReply(adminReply);
  await installVtaMintedHolder(store, holderInputs);

  await store.delete(ONBOARD_KEY);
  return { holderDid: adminReply.adminDid, role: "admin", secretEncrypted: false };
}

/** Inspect the persisted holder identity without unwrapping the secret. The
 *  popup calls this on mount so it can detect a stale v3 record (pre-M2C
 *  identity migration) and prompt the operator to re-onboard rather than
 *  landing in a half-broken connected view. */
async function doHolderState() {
  return holderIdentityState(new IndexedDBKVStore());
}

/** Seed the in-memory AES cache with the popup-derived PRF output.
 *  After this, `WebAuthnPrfSecretWrap.unwrap()` finds the cached key
 *  and decrypts without prompting — the offscreen ops that load the
 *  holder identity (vault list, login, sign trust task, etc.) start
 *  succeeding. */
async function doUnlockPrf(prfOutput: Uint8Array): Promise<void> {
  if (!(prfOutput instanceof Uint8Array) || prfOutput.length === 0) {
    throw new Error("UNLOCK_PRF: prfOutput missing or not bytes");
  }
  await WebAuthnPrfSecretWrap.seedCachedKeyFromPrfOutput(prfOutput);
}

/** Tell the popup whether the wallet is currently locked.
 *  See `RuntimeWalletLockStateResponse` for the semantics —
 *  `encrypted: false` short-circuits the unlock prompt entirely
 *  (passthrough wallets don't need one).
 *
 *  Multi-VTA: `vtaDid` selects which VTA's record to inspect. The
 *  PRF cache itself is module-scoped (one credential covers every
 *  wallet on this device), so `unlocked` is the same regardless of
 *  which VTA — only `encrypted` differs per record. */
async function doWalletLockState(
  vtaDid?: string,
): Promise<{ encrypted: boolean; unlocked: boolean }> {
  const state = await holderIdentityState(new IndexedDBKVStore(), vtaDid);
  if (state.kind !== "v4") {
    // v3 wallets surface via the migration banner; "none" surfaces
    // via OnboardView. Neither needs an unlock; report unencrypted.
    return { encrypted: false, unlocked: false };
  }
  const encrypted = state.wrapAlgorithm !== "passthrough";
  // Plaintext wallets are never "locked" — the load path doesn't
  // need WebAuthn. Report unlocked for consistency.
  if (!encrypted) return { encrypted: false, unlocked: true };
  return { encrypted: true, unlocked: WebAuthnPrfSecretWrap.isUnlocked() };
}

/** Delete the per-VTA holder record from IndexedDB. The connection
 *  store entry is cleared separately by the popup (zustand local
 *  state); this only handles the IndexedDB row, which the popup
 *  can't reach from a visible context. Idempotent — no-op if the
 *  record was already deleted (the wallet wasn't onboarded at this
 *  VTA, or a parallel Forget already ran). */
async function doForgetHolderRecord(vtaDid: string): Promise<void> {
  await forgetHolderRecord(new IndexedDBKVStore(), vtaDid);
}

/** Re-resolve the VTA's currently-advertised transports by fetching its
 *  DID document. Onboarding bakes `restBaseUrl` + `mediatorDid` into
 *  the persisted `connection` slot once at first connect; a VTA that
 *  later disables a transport leaves the cached value pointing at a
 *  dead endpoint. The popup calls this on mount + on connection change
 *  so the cache stays aligned with what the VTA currently advertises.
 *
 *  Returns the same shape as `doOnboardPrepare`'s services snapshot —
 *  `restBaseUrl` and/or `mediatorDid` each present iff the VTA carries
 *  the matching `#vta-rest` / `#vta-didcomm` service entry. */
async function doRefreshVtaTransports(
  vtaDid: string,
): Promise<{ restBaseUrl?: string; mediatorDid?: string }> {
  const services = await resolveVtaServices(vtaDid);
  return {
    ...(services.rest ? { restBaseUrl: services.rest.baseUrl } : {}),
    ...(services.didcomm ? { mediatorDid: services.didcomm.mediatorDid } : {}),
  };
}

/** Convey a push WakeHandle to the connected VTA via `device/set-wake/0.1`.
 *  The service worker obtained the handle from the gateway (`push/register`);
 *  this step tells the VTA which gateway+handle to provision so the VTA (or
 *  its mediator) can trigger contentless wakes. Runs in offscreen because
 *  set-wake authcrypts to the VTA — the holder identity only unwraps here. */
async function doSetWake(req: OffscreenSetWakeRequest): Promise<{
  pushCapable: boolean;
  triggerPolicy?: { allowedTriggers: string[] };
}> {
  const { identity: holder } = await loadHolder(req.vtaDid);
  const service = await resolveKeyAgreement(req.vtaDid);
  return setDeviceWakeRest({
    baseUrl: req.restBaseUrl,
    holder,
    service,
    ...(req.wakeHandle ? { wakeHandle: req.wakeHandle } : {}),
    ...(req.pushPlatform ? { pushPlatform: req.pushPlatform } : {}),
    ...(req.suggestedTriggers ? { suggestedTriggers: req.suggestedTriggers } : {}),
  });
}

/** List the contexts the wallet's holder has access to at the connected
 *  VTA. The popup's AddEntryForm calls this on mount so the context
 *  dropdown shows the real list (not just contexts already seen on
 *  loaded vault entries). Returns the popup-narrow shape (`id` + `name`)
 *  so the bridge doesn't have to relay BIP-32 paths and timestamps the
 *  UI doesn't use. */
async function doListContexts(req: {
  vtaDid: string;
  restBaseUrl: string;
}): Promise<{ contexts: Array<{ id: string; name: string }> }> {
  const { identity: holder } = await loadHolder(req.vtaDid);
  const service = await resolveKeyAgreement(req.vtaDid);
  const contexts = await vtaListContexts({
    baseUrl: req.restBaseUrl,
    holder,
    service,
  });
  return { contexts: contexts.map((c) => ({ id: c.id, name: c.name })) };
}

/** List the webvh DIDs the VTA hosts, optionally scoped to one context.
 *  The popup's AddEntryForm calls this with the selected context to
 *  populate the Persona-DID dropdown for a did-self-issued entry — these
 *  are the DIDs the VTA can mint a SIOP id_token AS. Returns the
 *  popup-narrow shape (`did` + `contextId`); the wire record carries
 *  more (server_id, scid, …) the UI doesn't use. */
async function doListDids(req: {
  vtaDid: string;
  restBaseUrl: string;
  contextId?: string;
}): Promise<{ dids: Array<{ did: string; contextId: string }> }> {
  const { identity: holder } = await loadHolder(req.vtaDid);
  const service = await resolveKeyAgreement(req.vtaDid);
  const dids = await vtaListDidsRest({
    baseUrl: req.restBaseUrl,
    holder,
    service,
    ...(req.contextId ? { contextId: req.contextId } : {}),
  });
  return { dids: dids.map((d) => ({ did: d.did, contextId: d.context_id })) };
}

/** Create a new context at the connected VTA. Requires the wallet's
 *  holder to be a super-admin; context-admins surface as Forbidden
 *  (the VTA's `SuperAdminAuth` gate rejects). Used by AddEntryForm's
 *  "+ New context…" inline-create path. */
async function doCreateContext(req: {
  vtaDid: string;
  restBaseUrl: string;
  id: string;
  name?: string;
  description?: string;
}): Promise<{ id: string; name: string }> {
  const { identity: holder } = await loadHolder(req.vtaDid);
  const service = await resolveKeyAgreement(req.vtaDid);
  const created = await vtaCreateContext({
    baseUrl: req.restBaseUrl,
    holder,
    service,
    id: req.id,
    ...(req.name ? { name: req.name } : {}),
    ...(req.description ? { description: req.description } : {}),
  });
  return { id: created.id, name: created.name };
}

/** Resolve a DID and return the plausible `signingKeyId` candidates.
 *  did:key is purely lexical; did:peer / did:webvh / did:web walk the
 *  network resolver. Never throws — the result carries an `error`
 *  string on failure so the popup can render it without crashing. */
async function doDeriveSigningKeyId(did: string) {
  return deriveSigningKeyId(did);
}

// ─── Warm mediator-session pool ───
// One authenticated, live-delivery session per mediator DID, reused for every
// operation against that mediator (DIDComm login, step-up, and the
// RP-initiated inbound `confirm` path). This eliminates the per-operation
// connect+auth+resolve+teardown that made DIDComm slower than REST — after the
// first connect, a round-trip is just pack → WS send → WS recv → unpack.
//
// Sessions are held at module scope so neither they nor their WebSockets are
// GC'd while the offscreen doc lives. The DID resolutions they perform
// (mediator + VTA) are cached in vti-didcomm-js, so even a cold reconnect is
// cheap on the second hit.
type MediatorState = "connecting" | "live" | "closed";
// Pool key is `${mediatorDid}|${vtaDid}` (a composite). The same
// mediator can host sessions for multiple holder DIDs — one per VTA
// the wallet has onboarded — so a mediator-only key would collide.
// The separator `|` is OK because DIDs never contain it.
const POOL_KEY_SEP = "|";
function poolKey(mediatorDid: string, vtaDid: string): string {
  return mediatorDid + POOL_KEY_SEP + vtaDid;
}
function parsePoolKey(key: string): { mediatorDid: string; vtaDid: string } {
  const idx = key.indexOf(POOL_KEY_SEP);
  return { mediatorDid: key.slice(0, idx), vtaDid: key.slice(idx + 1) };
}
const warmPool = new Map<string, Promise<MediatorConnection>>();
const mediatorState = new Map<string, MediatorState>();
const INBOUND_RECONNECT_MS = 2_000;

// The wallet's inbox mediator DID is configurable; cache it once so the
// per-session "is this our inbox mediator?" check stays synchronous in the
// onClose closure.
let _walletMediatorDid: string | undefined;
async function walletMediatorDid(): Promise<string> {
  if (!_walletMediatorDid) _walletMediatorDid = await getWalletMediatorDid();
  return _walletMediatorDid;
}

/** Snapshot of every known mediator session's state, for the demo UI.
 *  Multi-VTA: now one entry per (mediator, vtaDid) pair, not just per
 *  mediator. The demo UI groups by `mediatorDid` for display. */
function statusSnapshot(): { mediatorDid: string; vtaDid: string; state: MediatorState }[] {
  return [...mediatorState.entries()].map(([key, state]) => {
    const { mediatorDid, vtaDid } = parsePoolKey(key);
    return { mediatorDid, vtaDid, state };
  });
}

/** Get (or lazily open) the warm session for a `(mediator, vtaDid)`
 *  pair. The session authenticates AS the holder of `vtaDid`; multi-VTA
 *  installs run one session per VTA (each holder DID needs its own
 *  authenticated channel with the mediator). Reuses a live session;
 *  transparently reconnects one that has dropped. */
async function getWarmSession(
  mediatorDid: string,
  vtaDid: string,
): Promise<MediatorConnection> {
  const key = poolKey(mediatorDid, vtaDid);
  const existing = warmPool.get(key);
  if (existing) {
    const conn = await existing.catch(() => null);
    if (conn && conn.isOpen) return conn;
    warmPool.delete(key); // stale/closed — fall through to reconnect
  }

  mediatorState.set(key, "connecting");
  const pending = createWarmSession(mediatorDid, vtaDid).then(
    (conn) => {
      mediatorState.set(key, "live");
      return conn;
    },
    (err) => {
      mediatorState.set(key, "closed");
      warmPool.delete(key);
      throw err;
    },
  );
  warmPool.set(key, pending);
  return pending;
}

async function createWarmSession(
  mediatorDid: string,
  vtaDid: string,
): Promise<MediatorConnection> {
  const { identity } = await loadHolder(vtaDid);
  const isInbox = mediatorDid === (await walletMediatorDid());
  const key = poolKey(mediatorDid, vtaDid);
  const conn = await connectMediatorSession({
    holder: identity,
    mediatorDid,
    // No fixed peer for a shared session; the session resolves each reply's
    // sender on demand. Seed with our own DID (harmless) to satisfy the API;
    // each operation resolves its real VTA target separately (cached).
    vtaDid: identity.did,
    onClose: () => {
      warmPool.delete(key);
      mediatorState.set(key, "closed");
      // Keep the inbound path alive: re-arm THIS VTA's inbox session
      // under the same holder. Multi-VTA: each holder has its own
      // session, so the re-arm targets the specific (mediator, vtaDid)
      // that dropped, not the aggregate.
      if (isInbox) setTimeout(() => void startInbound(vtaDid), INBOUND_RECONNECT_MS);
    },
  });
  // Attach the inbound confirm handler whenever this is the wallet's inbox
  // mediator — regardless of which operation first opened the session.
  if (isInbox) {
    conn.onInbound((message) => void handleInbound(conn, identity, message));
  }
  return conn;
}

/** Ensure the warm session to the wallet's inbox mediator is live for
 *  a single holder identity (one VTA). Idempotent. Used by the
 *  re-arm-on-drop path in `createWarmSession.onClose` and by
 *  `reconcileInbound` for each VTA in the desired set.
 *
 *  Failure modes — `loadHolder` throwing `WalletLockedError` when the
 *  holder is encrypted but the cache is empty (cold-start before
 *  unlock) — are logged but not propagated. The next unlock + a
 *  subsequent reconcile will pick up the missed listener. */
async function startInbound(vtaDid: string): Promise<void> {
  try {
    const mediatorDid = await walletMediatorDid();
    await getWarmSession(mediatorDid, vtaDid);
    console.info(
      "[pnm inbound] listening for confirm requests via",
      mediatorDid,
      "as",
      vtaDid,
    );
  } catch (e) {
    console.error("[pnm inbound] failed to start inbound session:", e);
  }
}

/** Multi-VTA inbound reconcile: ensure the wallet has one warm inbox
 *  session per VTA in `vtaDids`, and close any existing inbound
 *  sessions whose `vtaDid` is no longer in the desired set. Called on
 *  service-worker boot AND whenever the operator adds / forgets a VTA
 *  (chrome.storage watcher in background).
 *
 *  Multi-VTA invariant: each holder DID needs its own authenticated
 *  channel with the mediator (the mediator routes inbound messages by
 *  the recipient holder's DID, which is bound to the session's
 *  authenticating identity). One mediator can host many holder
 *  sessions concurrently. */
async function reconcileInbound(vtaDids: readonly string[]): Promise<void> {
  const mediatorDid = await walletMediatorDid();
  const wanted = new Set(vtaDids);

  // Open missing — concurrent across VTAs, individual failures stay
  // contained (loadHolder may throw for a locked wallet; the rest
  // still come up).
  await Promise.allSettled(vtaDids.map((vtaDid) => startInbound(vtaDid)));

  // Close extras: any pool entry whose mediator matches our inbox AND
  // whose vtaDid is no longer wanted (operator forgot it). The pool
  // also holds outbound sessions to OTHER mediators (the VTA's
  // mediator, not the wallet's) — those are filtered out by the
  // mediator check.
  for (const [key, sessionPromise] of warmPool) {
    const parsed = parsePoolKey(key);
    if (parsed.mediatorDid !== mediatorDid) continue; // outbound; leave it
    if (wanted.has(parsed.vtaDid)) continue; // still wanted
    // No longer wanted. Drop the pool entry first so a race that
    // calls getWarmSession during close doesn't reuse this conn.
    warmPool.delete(key);
    mediatorState.set(key, "closed");
    void sessionPromise.then(
      (conn) => conn.close(),
      () => undefined, // already failed → nothing to close
    );
    console.info("[pnm inbound] closed listener for forgotten VTA", parsed.vtaDid);
  }
}

async function handleInbound(
  conn: MediatorConnection,
  identity: Parameters<typeof buildConfirmResponse>[0]["holder"],
  message: Record<string, unknown>,
): Promise<void> {
  const parsed = parseConfirmRequest(message);
  if (!parsed) return; // not a confirm/1.0 — ignore other traffic

  // De-dup: the mediator replays un-acked messages on every reconnect, and
  // the MV3 worker respawns the offscreen session often. Skip a confirm we've
  // already handled so a replay doesn't pop a second consent prompt. Marked
  // before prompting so a replay during the consent window is also skipped.
  // Persisted (survives respawns — exactly when replays arrive).
  const messageId = typeof message.id === "string" ? message.id : undefined;
  if (messageId) {
    const isNew = await markInboundHandled(new IndexedDBKVStore(), messageId);
    if (!isNew) {
      console.info("[pnm inbound] skipping replayed confirm:", messageId);
      return;
    }
  }
  try {
    // Ask the background to prompt the user (consent UI is a background API).
    const consent = (await chrome.runtime.sendMessage({
      type: RUNTIME_INBOUND_CONSENT,
      rpDid: parsed.rpDid,
      action: parsed.request.action,
      ...(parsed.request.rpName ? { rpName: parsed.request.rpName } : {}),
    })) as { approved?: boolean } | undefined;
    const approved = consent?.approved === true;

    const rp = await resolveKeyAgreement(parsed.rpDid);
    const outer = await buildConfirmResponse({
      holder: identity,
      rp,
      mediator: conn.mediator,
      approved,
      challenge: parsed.request.challenge,
      thid: parsed.thid,
    });
    conn.send(outer);
    console.info("[pnm inbound] confirm responded:", approved ? "approved" : "denied");
  } catch (e) {
    console.error("[pnm inbound] confirm handling failed:", e);
  }
}

async function doRestLogin(
  req: OffscreenRestLoginRequest,
): Promise<RuntimeLoginResponse> {
  // REST SIOPv2 login moved off the background SW into offscreen so
  // the holder's signing key is accessible — background's module
  // scope has no PRF AES cache, so `loadHolder` from there throws
  // `WalletLockedError` on encrypted wallets. Same flow as before
  // (challenge → issueIdToken → authenticate), just running in the
  // context that owns the cache.
  const { signing } = await loadHolder(req.vtaDid);
  const tokens = await loginViaSiop({
    baseUrl: req.params.baseUrl,
    rpDid: req.params.rpDid,
    signing,
  });
  return { ok: true, result: { ...tokens, holderDid: signing.did } };
}

async function doDidcommLogin(
  req: OffscreenDidcommLoginRequest,
): Promise<RuntimeLoginResponse> {
  // Same IndexedDB-backed holder the popup/background use (shared extension
  // origin), so the DID is identical to the REST path.
  const sw = createStopwatch();
  const { identity, signing } = await loadHolder(req.vtaDid);
  sw.mark("load holder");

  // Reuse the warm session (instant if already live); resolve the VTA target
  // separately (cached). No per-op connect/teardown.
  const conn = await getWarmSession(req.params.mediatorDid, req.vtaDid);
  sw.mark("warm session");
  const service = await resolveKeyAgreement(req.params.controlDid);
  sw.mark("resolve vta");

  const bridge = new MediatorSessionBridge(conn);
  const tokens = await loginViaDidcomm({
    bridge,
    holder: identity,
    service,
    mediator: conn.mediator,
  });
  sw.mark("authenticate (didcomm)");
  return {
    ok: true,
    result: {
      accessToken: tokens.accessToken,
      refreshToken: tokens.refreshToken,
      sessionId: tokens.sessionId,
      holderDid: signing.did,
      timings: sw.marks,
    },
  };
}

async function doStepUpVta(
  req: OffscreenStepUpVtaRequest,
): Promise<RuntimeLoginResponse> {
  // Same IndexedDB-backed holder the popup/background use, so the DID is
  // identical to the base-login path being elevated.
  const sw = createStopwatch();
  const { identity, signing } = await loadHolder(req.params.vtaDid);
  sw.mark("load holder");

  // 1. RP start (REST) → nonce.
  const nonce = await stepUpVtaStart(req.params.baseUrl, req.params.accessToken);
  sw.mark("rp start (nonce)");

  // 2. VTA approve (DIDComm) → approval token. Reuse the warm session.
  const conn = await getWarmSession(req.params.vtaMediatorDid, req.params.vtaDid);
  sw.mark("warm session");
  const service = await resolveKeyAgreement(req.params.vtaDid);
  sw.mark("resolve vta");
  const bridge = new MediatorSessionBridge(conn);
  const approvalToken = await requestVtaApproval({
    bridge,
    holder: identity,
    service,
    mediator: conn.mediator,
    rpDid: req.params.rpDid,
    nonce,
  });
  sw.mark("vta approve");

  // 3. RP finish (REST) → elevated session tokens.
  const tokens = await stepUpVtaFinish(
    req.params.baseUrl,
    req.params.accessToken,
    approvalToken,
  );
  sw.mark("rp finish (elevate)");
  return {
    ok: true,
    result: {
      accessToken: tokens.accessToken,
      refreshToken: tokens.refreshToken,
      sessionId: tokens.sessionId,
      holderDid: signing.did,
      timings: sw.marks,
    },
  };
}
