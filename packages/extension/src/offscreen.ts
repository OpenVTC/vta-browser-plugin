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
  markInboundHandled,
  type MediatorConnection,
  MediatorSessionBridge,
  parseConfirmRequest,
  requestVtaApproval,
  resolveKeyAgreement,
  resolveVtaServices,
  signingIdentityFromSecret,
  stepUpVtaFinish,
  stepUpVtaStart,
  signTrustTask,
  deriveSigningKeyId,
  holderIdentityState,
  holderInputsFromAdminReply,
  installVtaMintedHolder,
  ProvisionProblemReportError,
  runProvisionIntegration,
  vaultDeleteRest,
  vaultListRest,
  vtaCreateContext,
  vtaListContexts,
  vaultProxyLoginRest,
  vaultReleaseRest,
  vaultUpsertRest,
  verifyDid,
} from "@pnm/core";
import { base64url } from "@openvtc/vti-didcomm-js";
import { buildHolderSecretWrap, getWalletMediatorDid, loadHolder } from "./holder.js";
import { WebAuthnPrfSecretWrap } from "./webauthn-prf-wrap.js";
import {
  OFFSCREEN_DIDCOMM_LOGIN,
  OFFSCREEN_GET_STATUS,
  OFFSCREEN_LOCK_WALLET,
  OFFSCREEN_CREATE_CONTEXT,
  OFFSCREEN_DERIVE_SIGNING_KEY_ID,
  OFFSCREEN_HOLDER_STATE,
  OFFSCREEN_LIST_CONTEXTS,
  OFFSCREEN_UNLOCK_PRF,
  OFFSCREEN_REFRESH_VTA_TRANSPORTS,
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
  type OffscreenCreateContextRequest,
  type OffscreenDeriveSigningKeyIdRequest,
  type OffscreenOnboardConnectRequest,
  type OffscreenOnboardPrepareRequest,
  type OffscreenUnlockPrfRequest,
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
  type SignTrustTaskResult,
  type VerifyRpDidResult,
} from "./bridge-protocol.js";

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
  if (msg.type === OFFSCREEN_STEP_UP_VTA) {
    doStepUpVta(message as OffscreenStepUpVtaRequest)
      .then(sendResponse)
      .catch((e: unknown) =>
        sendResponse({ ok: false, error: e instanceof Error ? e.message : String(e) }),
      );
    return true; // async sendResponse
  }
  if (msg.type === OFFSCREEN_START_INBOUND) {
    void startInbound();
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
    doWalletLockState()
      .then((result) => sendResponse({ ok: true, result }))
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
    doSignTrustTask((message as OffscreenSignTrustTaskRequest).params.envelope)
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
  const { identity: holder } = await loadHolder();
  const service = await resolveKeyAgreement(req.vtaDid);
  // The bridge protocol intentionally types filter loosely (string secretKind)
  // so it doesn't have to import @pnm/core's narrowed enums. Cast at this
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

// Vault — upsert. Sealed-secret packing happens inside @pnm/core's
// vaultUpsertRest (uses the holder's X25519 to authcrypt the VaultSecret
// JSON to the VTA's keyAgreement key).
async function doVaultUpsert(req: OffscreenVaultUpsertRequest) {
  const { identity: holder } = await loadHolder();
  const service = await resolveKeyAgreement(req.vtaDid);
  type Opts = Parameters<typeof vaultUpsertRest>[0];
  // The bridge protocol types secretKind / secret loosely (strings) to
  // avoid importing @pnm/core's enums into bridge-protocol.ts. Cast at
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
  const { identity: holder } = await loadHolder();
  const service = await resolveKeyAgreement(req.vtaDid);
  return await vaultDeleteRest({
    baseUrl: req.restBaseUrl,
    holder,
    service,
    ...req.body,
  });
}

// Vault — release. Server returns an authcrypt JWE; @pnm/core's
// vaultReleaseRest unpacks it against the holder's private X25519
// (which lives here in offscreen) and surfaces the cleartext secret.
async function doVaultRelease(req: OffscreenVaultReleaseRequest) {
  const { identity: holder } = await loadHolder();
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
// have to import @pnm/core's narrowed SiteTarget enum; cast at this
// wire boundary — the server-side canonical-schema validation is the
// real authority.
async function doVaultProxyLogin(req: OffscreenVaultProxyLoginRequest) {
  const { identity: holder } = await loadHolder();
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

// Sign a Trust-Task envelope with the wallet's holder did:peer #key-2. The
// caller (typically a Relying Party's web UI via window.vtaWallet.signTrustTask)
// has already populated everything it wants signed — id, type, payload,
// recipient (audience binding). The wallet adds the eddsa-jcs-2022 Data
// Integrity proof and returns the envelope. The RP server resolves the
// did:peer to verify.
async function doSignTrustTask(
  envelope: Record<string, unknown>,
): Promise<SignTrustTaskResult> {
  const { signing } = await loadHolder();
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
  // @pnm/core/provision; offscreen.ts just wires the mediator session in.
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
  const holderInputs = holderInputsFromAdminReply(adminReply);
  const secretWrap = await buildHolderSecretWrap();
  let secretEncrypted = false;
  if (secretWrap) {
    try {
      await installVtaMintedHolder(store, { ...holderInputs, secretWrap });
      secretEncrypted = true;
    } catch (e) {
      // Two ways the PRF wrap can decline: (a) the platform doesn't
      // expose a PRF-capable authenticator (older browser, no
      // platform passkey); (b) the operator dismissed the
      // authenticator prompt. `wrapSecret` surfaces both as
      // "declined to wrap" — fall back to plaintext storage so
      // onboarding completes, log + surface a warning so the
      // operator sees the at-rest weakening they got.
      const msg = e instanceof Error ? e.message : String(e);
      if (msg.includes("declined to wrap")) {
        console.warn(
          "doOnboardConnect: PRF wrap declined; falling back to plaintext holder secret",
        );
        await installVtaMintedHolder(store, holderInputs);
        secretEncrypted = false;
      } else {
        throw e;
      }
    }
  } else {
    // Operator explicitly opted out via the settings page.
    await installVtaMintedHolder(store, holderInputs);
    secretEncrypted = false;
  }

  await store.delete(ONBOARD_KEY);
  // Bridge protocol returns { holderDid, role, secretEncrypted } — the
  // popup uses `secretEncrypted` to surface "wallet encrypted at rest"
  // vs "wallet stored without encryption" so the operator knows what
  // happened at install time (especially the fallback path, which is
  // a silent at-rest weakening if not surfaced).
  return { holderDid: adminReply.adminDid, role: "admin", secretEncrypted };
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
 *  (passthrough wallets don't need one). */
async function doWalletLockState(): Promise<{ encrypted: boolean; unlocked: boolean }> {
  const state = await holderIdentityState(new IndexedDBKVStore());
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
  const { identity: holder } = await loadHolder();
  const service = await resolveKeyAgreement(req.vtaDid);
  const contexts = await vtaListContexts({
    baseUrl: req.restBaseUrl,
    holder,
    service,
  });
  return { contexts: contexts.map((c) => ({ id: c.id, name: c.name })) };
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
  const { identity: holder } = await loadHolder();
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

/** Snapshot of every known mediator's connection state, for the demo UI. */
function statusSnapshot(): { mediatorDid: string; state: MediatorState }[] {
  return [...mediatorState.entries()].map(([mediatorDid, state]) => ({ mediatorDid, state }));
}

/** Get (or lazily open) the warm session for a mediator. Reuses a live
 *  session; transparently reconnects one that has dropped. */
async function getWarmSession(mediatorDid: string): Promise<MediatorConnection> {
  const existing = warmPool.get(mediatorDid);
  if (existing) {
    const conn = await existing.catch(() => null);
    if (conn && conn.isOpen) return conn;
    warmPool.delete(mediatorDid); // stale/closed — fall through to reconnect
  }

  mediatorState.set(mediatorDid, "connecting");
  const pending = createWarmSession(mediatorDid).then(
    (conn) => {
      mediatorState.set(mediatorDid, "live");
      return conn;
    },
    (err) => {
      mediatorState.set(mediatorDid, "closed");
      warmPool.delete(mediatorDid);
      throw err;
    },
  );
  warmPool.set(mediatorDid, pending);
  return pending;
}

async function createWarmSession(mediatorDid: string): Promise<MediatorConnection> {
  const { identity } = await loadHolder();
  const isInbox = mediatorDid === (await walletMediatorDid());
  const conn = await connectMediatorSession({
    holder: identity,
    mediatorDid,
    // No fixed peer for a shared session; the session resolves each reply's
    // sender on demand. Seed with our own DID (harmless) to satisfy the API;
    // each operation resolves its real VTA target separately (cached).
    vtaDid: identity.did,
    onClose: () => {
      warmPool.delete(mediatorDid);
      mediatorState.set(mediatorDid, "closed");
      // Keep the inbound path alive: re-arm the wallet's inbox mediator.
      if (isInbox) setTimeout(() => void startInbound(), INBOUND_RECONNECT_MS);
    },
  });
  // Attach the inbound confirm handler whenever this is the wallet's inbox
  // mediator — regardless of which operation first opened the session.
  if (isInbox) {
    conn.onInbound((message) => void handleInbound(conn, identity, message));
  }
  return conn;
}

/** Ensure the warm session to the wallet's inbox mediator is live so
 *  RP-initiated confirm requests are received. Idempotent. */
async function startInbound(): Promise<void> {
  try {
    const mediatorDid = await walletMediatorDid();
    await getWarmSession(mediatorDid);
    console.info("[pnm inbound] listening for confirm requests via", mediatorDid);
  } catch (e) {
    console.error("[pnm inbound] failed to start inbound session:", e);
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

async function doDidcommLogin(
  req: OffscreenDidcommLoginRequest,
): Promise<RuntimeLoginResponse> {
  // Same IndexedDB-backed holder the popup/background use (shared extension
  // origin), so the DID is identical to the REST path.
  const sw = createStopwatch();
  const { identity, signing } = await loadHolder();
  sw.mark("load holder");

  // Reuse the warm session (instant if already live); resolve the VTA target
  // separately (cached). No per-op connect/teardown.
  const conn = await getWarmSession(req.params.mediatorDid);
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
  const { identity, signing } = await loadHolder();
  sw.mark("load holder");

  // 1. RP start (REST) → nonce.
  const nonce = await stepUpVtaStart(req.params.baseUrl, req.params.accessToken);
  sw.mark("rp start (nonce)");

  // 2. VTA approve (DIDComm) → approval token. Reuse the warm session.
  const conn = await getWarmSession(req.params.vtaMediatorDid);
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
