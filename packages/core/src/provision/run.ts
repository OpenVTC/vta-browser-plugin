// Top-level orchestrator for the wallet's provision-integration flow.
//
// One call drives the full onboarding round-trip:
//   1. Build + sign a BootstrapRequest VP for the AdminRotation ask.
//   2. Ship it as a Trust Task over whichever transport the VTA advertises.
//   3. Open the HPKE-sealed reply with the wallet's ephemeral Ed25519 seed.
//   4. Cross-check that the bundle's `bundleIdHex` matches the request nonce.
//   5. Return the minimal admin reply (DID + private keys) the wallet adopts
//      as its long-term holder identity.
//
// Step 2 is a `TrustTaskSender`, not a DIDComm bridge — see `send.ts` for why it
// moved. Every other step is transport-independent and always was: the VP, the
// HPKE open, the nonce cross-check and the key extraction are the same work
// whichever channel carried the bytes.

import type { SigningIdentity } from "../siop/self-issued.js";
import type { TrustTaskSender } from "../vta/channel.js";

import { openAdminRotationBundle } from "./open.js";
import { buildBootstrapRequest, type BootstrapAsk } from "./request.js";
import { sendProvisionIntegration, type AdminScope, type ProvisionSummary } from "./send.js";
import type { AdminRotationPayload } from "./types.js";

export interface RunProvisionIntegrationOptions {
  /** Any transport that can carry a Trust Task, whose identity is the
   *  operator-granted ephemeral did:key. A `VtaSession` gives the full
   *  TSP > DIDComm > REST chain; a single channel works too. */
  sender: TrustTaskSender;
  /** Signing identity for the ephemeral did:key — signs the BootstrapRequest
   *  VP, and its DID is the envelope `issuer`. The Ed25519 seed in
   *  `signing.privateKey` is also the recipient secret the wallet uses to open
   *  the sealed bundle. */
  ephemeralSigning: SigningIdentity;
  /** The VTA's DID — the envelope `recipient`. */
  vtaDid: string;
  /** The maintainer context to provision the admin DID into.
   *
   *  **Required here, though the wire member is OPTIONAL.** The spec lets a
   *  caller omit it and lets the VTA infer, and this package deliberately
   *  does not take that option: inference resolves to a context the reply
   *  does not have to name, so a wallet that omitted it could finish
   *  provisioning without knowing where its own configuration now lives. The
   *  reply's `summary.context` closes that on agents new enough to echo it,
   *  which is not a floor this package can assume — and naming it costs one
   *  question the operator can answer.
   *
   *  It is required in **both** admin scopes. An unrestricted admin reaches
   *  every context, and still keeps its configuration in exactly one; see
   *  {@link adminScope}. */
  context: string;
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
  /** How wide the ACL entry the VTA writes for the minted admin should be.
   *
   *  Default `"context"` — the admin acts in {@link context} and nowhere
   *  else, which is what a wallet operating as a party inside one context
   *  wants. `"unrestricted"` is what an operator console asks for.
   *
   *  Orthogonal to {@link context}, which is still where the admin DID is
   *  minted and where this wallet keeps its own configuration. See
   *  {@link AdminScope}. */
  adminScope?: AdminScope;
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
  /** The context the admin was actually provisioned into, as the VTA reported
   *  it — or, from an agent that does not echo it, the one this call named.
   *
   *  Never `undefined`: this package requires {@link
   *  RunProvisionIntegrationOptions.context}, so there is always an answer,
   *  and the echo is preferred because it is the agent's account rather than
   *  ours. */
  context: string;
  /** The scope of the ACL entry the VTA actually wrote — **not** the one this
   *  call asked for.
   *
   *  An agent that does not implement `adminScope` ignores the ask and writes
   *  a context-scoped entry while replying success, so a wallet that recorded
   *  its own request would show the holder authority they do not have. Absent
   *  from the reply therefore reads as `"context"`. */
  adminScope: AdminScope;
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
    // contextHint is a hint embedded in the signed VP; the wire
    // `payload.context` below is what the VTA acts on. Both are sent and both
    // say the same thing, which is the point — the VTA cross-checks them and
    // refuses a disagreement rather than silently normalising one away.
    contextHint: opts.context,
    adminTemplate: { name: opts.adminTemplateName ?? "vta-admin", vars: {} },
    ...(opts.note ? { note: opts.note } : {}),
  };
  const { vp, nonce } = await buildBootstrapRequest({
    ephemeral: opts.ephemeralSigning,
    ask,
    ...(opts.note ? { label: opts.note } : {}),
  });

  // 2. Trust-Task round-trip over whatever `sender` carries.
  const reply = await sendProvisionIntegration({
    sender: opts.sender,
    ephemeralDid: opts.ephemeralSigning.did,
    vtaDid: opts.vtaDid,
    body: {
      request: vp,
      // Always sent, so the VTA's inference rules never run and
      // `provision/integration:contextRequired` is unreachable from here. The
      // caller has already decided where this wallet lives; letting the agent
      // pick would mean finishing onboarding without being told which context
      // that was.
      context: opts.context,
      // Omitted when it is the default, so the common request stays the
      // minimal document — and so an agent that predates the member sees no
      // difference for the ask it can actually satisfy.
      ...(opts.adminScope && opts.adminScope !== "context"
        ? { adminScope: opts.adminScope }
        : {}),
      // `createContext` defaults to false on the wire; only emit it when the
      // caller actually asked for an inline create, so the common request
      // stays the minimal document.
      ...(opts.createContext ? { createContext: true } : {}),
    },
    ...(opts.timeoutMs !== undefined ? { timeoutMs: opts.timeoutMs } : {}),
  });

  // 3. Cross-check the bundle id BEFORE opening. The maintainer echoes
  //    the VP nonce as `summary.bundleIdHex` (lowercase hex of the 16
  //    nonce bytes); a mismatch means the bundle is for a different
  //    request, which is a serious wire-shape failure. The HPKE open
  //    would also fail (the AAD binds the bundle id), but catching it
  //    here gives a cleaner error.
  const expectedHex = toLowerHex(nonce);
  if (reply.summary.bundleIdHex !== expectedHex) {
    throw new Error(
      `provision-integration: bundleIdHex mismatch — expected ${expectedHex}, got ${reply.summary.bundleIdHex}`,
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
  // contract, but verifying summary.adminDid matches what we extract
  // catches the case where a malicious / buggy maintainer ships a
  // summary that doesn't agree with the sealed bundle.
  if (reply.summary.adminDid && reply.summary.adminDid !== admin.did) {
    throw new Error(
      `provision-integration: summary.adminDid (${reply.summary.adminDid}) ` +
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
    // The agent's account of what it did, preferred over ours. They agree on
    // every current agent; where they cannot both be had, what the agent says
    // it wrote is the thing the holder's authority actually depends on.
    context: reply.summary.context ?? opts.context,
    // Absent reads as "context" — see `MinimalAdminReply.adminScope`. Not
    // `?? opts.adminScope`: that would echo the ask back and call it the
    // outcome, which is the one mistake this member exists to prevent.
    adminScope: reply.summary.adminScope ?? "context",
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
