// Top-level orchestrator for the wallet's provision-integration flow.
//
// One call drives the full onboarding round-trip:
//   1. Build + sign a BootstrapRequest VP for the AdminRotation ask.
//   2. Ship it via DIDComm (authcrypt → forward via VTA's mediator).
//   3. Open the HPKE-sealed reply with the wallet's ephemeral Ed25519 seed.
//   4. Cross-check that the bundle's `bundleIdHex` matches the request nonce.
//   5. Return the minimal admin reply (DID + private keys) the wallet adopts
//      as its long-term holder identity.
//
// The wallet's existing onboarding code (`offscreen.ts`) currently calls
// `swapAclDidcomm` here — M2C-C swaps that call site to `runProvisionIntegration`.

import type { Identity } from "../didcomm/index.js";
import type { SigningIdentity } from "../siop/self-issued.js";
import type { RemoteDidcommEndpoint } from "../vta/didcomm.js";
import type { DidcommMessageBridge } from "../vta/transport.js";

import { openAdminRotationBundle } from "./open.js";
import { buildBootstrapRequest, type BootstrapAsk } from "./request.js";
import { sendProvisionIntegration, type ProvisionSummary } from "./send.js";
import type { AdminRotationPayload } from "./types.js";

export interface RunProvisionIntegrationOptions {
  /** Mediator-backed DIDComm bridge for the round-trip. */
  bridge: DidcommMessageBridge;
  /** Authcrypt sender X25519 identity for the ephemeral did:key. */
  ephemeral: Identity;
  /** Signing identity for the SAME ephemeral did:key — used to sign the
   *  BootstrapRequest VP. The Ed25519 seed in `signing.privateKey` is also
   *  the recipient secret the wallet uses to open the sealed bundle. */
  ephemeralSigning: SigningIdentity;
  /** The VTA's DID + keyAgreement key (inner authcrypt recipient and
   *  expected `from` on the reply). */
  service: RemoteDidcommEndpoint;
  /** The VTA's mediator (forward target). Omit for direct DIDComm. */
  mediator?: RemoteDidcommEndpoint;
  /** The VTA's DID — passed to send.ts for the reply sender assertion. */
  vtaDid: string;
  /** The maintainer context to provision the admin DID into. **Optional**
   *  per the canonical Trust Task spec — when omitted, the VTA infers
   *  from the relayer's ACL grant or its own contexts state (single-
   *  context grant → that context; super-admin + single-context VTA →
   *  that context; ambiguous → error). Wallet-class callers SHOULD
   *  omit; integration-class callers SHOULD specify. */
  context?: string;
  /** Admin template the VTA renders. Default `vta-admin` — the built-in
   *  no-frills `did:key` admin template every VTA ships with. Override if
   *  the operator has uploaded a custom admin template. */
  adminTemplateName?: string;
  /** Free-form note for the VTA's audit log. */
  note?: string;
  /** When `true`, asks the VTA to provision the target context inline if
   *  it does not already exist. Requires the relayer (the ephemeral
   *  did:key after the operator's grant) to hold **super-admin** role at
   *  the VTA — context-admin grants get rejected with
   *  `provision/integration:forbidden`. Defaults to `false`; callers
   *  that target an established context leave this off. */
  createContext?: boolean;
  /** Send-side timeout. Default 60s (sendProvisionIntegration). */
  timeoutMs?: number;
}

/** Minimal admin material the wallet adopts after a successful onboarding.
 *
 *  The wallet stores `adminDid` as its new holder identity. The Ed25519
 *  private key (multibase-encoded) is what signs subsequent trust tasks
 *  + SIOP id_tokens; the X25519 private key is what unpacks DIDComm
 *  authcrypt envelopes targeted at the wallet. The auth VC + VTA trust
 *  bundle are NOT kept — the steady-state authority is the ACL row the
 *  VTA wrote at provisioning, not the VC, and the wallet verifies the
 *  VTA's identity via DID resolution on every subsequent connect rather
 *  than caching the trust bundle. */
export interface MinimalAdminReply {
  /** The freshly-minted long-term admin DID (a `did:key:z6Mk…`). */
  adminDid: string;
  /** Multibase-encoded Ed25519 private key (`z`-prefixed multikey).
   *  The wallet decodes this and stores it as the new holder's signing key. */
  adminSigningPrivateMultibase: string;
  /** Multibase-encoded X25519 private key. The wallet decodes + stores
   *  this as the new holder's keyAgreement key. */
  adminKaPrivateMultibase: string;
  /** Echo of the VTA's own DID (cross-check vs `service.did`). */
  vtaDid: string;
  /** REST base URL the VTA advertised, if any. */
  vtaUrl?: string;
  /** Bundle metadata for audit / debug. */
  summary: ProvisionSummary;
}

/** Drive the full provision-integration round-trip and return the minimal
 *  admin material the wallet should adopt. */
export async function runProvisionIntegration(
  opts: RunProvisionIntegrationOptions,
): Promise<MinimalAdminReply> {
  // 1. Build + sign the VP with an AdminRotation ask. The wallet only
  //    needs a long-term admin DID at this VTA; it does NOT need an
  //    integration DID minted (TemplateBootstrap), which is what
  //    mediator / did-hosting integrations consume.
  const ask: BootstrapAsk = {
    type: "adminRotation",
    // contextHint is just a hint embedded in the VP — only meaningful
    // when the caller actually knows the context. When omitted, the
    // VTA's authoritative context resolution runs (inference rules).
    ...(opts.context ? { contextHint: opts.context } : {}),
    adminTemplate: { name: opts.adminTemplateName ?? "vta-admin", vars: {} },
    ...(opts.note ? { note: opts.note } : {}),
  };
  const { vp, nonce } = await buildBootstrapRequest({
    ephemeral: opts.ephemeralSigning,
    ask,
    ...(opts.note ? { label: opts.note } : {}),
  });

  // 2. DIDComm round-trip. Body field names are snake_case to match the
  //    existing FPN protocol the VTA speaks today (see send.ts header for
  //    the migration plan).
  const reply = await sendProvisionIntegration({
    bridge: opts.bridge,
    ephemeral: opts.ephemeral,
    service: opts.service,
    ...(opts.mediator ? { mediator: opts.mediator } : {}),
    vtaDid: opts.vtaDid,
    body: {
      request: vp,
      // context is optional on the wire. When omitted, the VTA's
      // inference rules pick the target context (single-context grant
      // → use it; super-admin + single-context VTA → use it;
      // ambiguous → e.p.msg.context_required). Wallet-class callers
      // typically omit; integration-class callers send explicitly.
      ...(opts.context ? { context: opts.context } : {}),
      // create_context defaults to false on the wire; only emit when the
      // caller actually asked for inline create so older VTAs that
      // pre-date the field don't have to deal with an unexpected key.
      ...(opts.createContext ? { create_context: true } : {}),
    },
    ...(opts.timeoutMs !== undefined ? { timeoutMs: opts.timeoutMs } : {}),
  });

  // 3. Cross-check the bundle id BEFORE opening. The maintainer echoes
  //    the VP nonce as `summary.bundle_id_hex` (lowercase hex of the 16
  //    nonce bytes); a mismatch means the bundle is for a different
  //    request, which is a serious wire-shape failure. The HPKE open
  //    would also fail (the AAD binds the bundle id), but catching it
  //    here gives a cleaner error.
  const expectedHex = toLowerHex(nonce);
  if (reply.summary.bundle_id_hex !== expectedHex) {
    throw new Error(
      `provision-integration: bundle_id_hex mismatch — expected ${expectedHex}, got ${reply.summary.bundle_id_hex}`,
    );
  }

  // 4. Open the sealed bundle with the wallet's Ed25519 seed. The opener
  //    derives the X25519 recipient secret via Montgomery clamping
  //    (matching the Rust seal-side `ed25519_seed_to_x25519_secret`).
  if (opts.ephemeralSigning.privateKey.length !== 32) {
    throw new Error("provision-integration: ephemeral Ed25519 seed must be 32 bytes");
  }
  const opened = await openAdminRotationBundle(reply.bundle, opts.ephemeralSigning.privateKey);

  // 5. Extract the minimal admin material the wallet keeps.
  const admin = opened.payload.admin;
  if (!admin || !admin.did) {
    throw new Error("provision-integration: AdminRotation payload missing admin.did");
  }
  if (!admin.signing_key?.private_key_multibase || !admin.ka_key?.private_key_multibase) {
    throw new Error(
      "provision-integration: AdminRotation payload missing admin signing/ka private key",
    );
  }
  // Defence-in-depth: the open-time digest check is the maintainer's
  // contract, but verifying summary.admin_did matches what we extract
  // catches the case where a malicious / buggy maintainer ships a
  // summary that doesn't agree with the sealed bundle.
  if (reply.summary.admin_did && reply.summary.admin_did !== admin.did) {
    throw new Error(
      `provision-integration: summary.admin_did (${reply.summary.admin_did}) ` +
        `disagrees with sealed admin.did (${admin.did})`,
    );
  }

  return {
    adminDid: admin.did,
    adminSigningPrivateMultibase: admin.signing_key.private_key_multibase,
    adminKaPrivateMultibase: admin.ka_key.private_key_multibase,
    vtaDid: opened.payload.vta_trust?.vta_did ?? opts.vtaDid,
    ...(opened.payload.vta_url ? { vtaUrl: opened.payload.vta_url } : {}),
    summary: reply.summary,
  };
}

function toLowerHex(bytes: Uint8Array): string {
  let s = "";
  for (let i = 0; i < bytes.length; i++) {
    s += (bytes[i] as number).toString(16).padStart(2, "0");
  }
  return s;
}

// Re-export the AdminRotationPayload type at this layer so call sites that
// only depend on `runProvisionIntegration` don't reach into `types.ts`.
export type { AdminRotationPayload };
