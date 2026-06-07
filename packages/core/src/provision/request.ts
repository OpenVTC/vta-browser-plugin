// Build + sign the BootstrapRequest VP the wallet hands the VTA when
// onboarding. The VP is a W3C VC Data Model 2.0 Verifiable Presentation
// with `nonce` / `validUntil` / `label` / `ask` carried alongside the
// standard VP fields and covered by the same `eddsa-jcs-2022` Data
// Integrity proof.
//
// Wire shape mirrors
// `verifiable-trust-infrastructure/vta-sdk/src/provision_integration/request.rs`
// (`BootstrapRequest::sign`). This client now targets the canonical Trust
// Task URI `https://trusttasks.org/spec/provision/integration/0.1` (see
// `send.ts`); the VTA dual-registers it alongside the legacy FPN type, so
// both validate during the FPN deprecation window.

import { base64url } from "@openvtc/vti-didcomm-js";
import type { SigningIdentity } from "../siop/self-issued.js";
import { signTrustTask } from "../trust-tasks/sign.js";

const VC_V2_CONTEXT_URL = "https://www.w3.org/ns/credentials/v2";
const BOOTSTRAP_CONTEXT_URL = "https://openvtc.org/contexts/bootstrap-v1";

/** A reference to a DID template the maintainer has registered. Inline
 *  template definitions are rejected — the operator uploads via
 *  `pnm did-templates create` first, then names the template here. */
export interface DidTemplateRef {
  name: string;
  vars?: Record<string, unknown>;
}

/** What the holder is asking the VTA to do. Tagged on `type`.
 *
 *  `templateBootstrap` is for full integration bootstrap (mediator,
 *  did-hosting host, etc.). `adminRotation` is what the wallet uses — it
 *  asks the VTA to mint a fresh long-term admin DID + keys without
 *  rendering any integration template. The browser plugin has no
 *  integration-side identity to advertise, so adminRotation is the right
 *  ask for M2C.
 *
 *  Tag casing is the `provision/integration/0.2` lowerCamelCase form. The
 *  tag is signed inside the VP, and the VTA verifies the proof over the
 *  received bytes (it accepts the 0.1 `AdminRotation`/`TemplateBootstrap`
 *  casing via serde aliases, but 0.2 clients sign the camelCase form). */
export type BootstrapAsk =
  | {
      type: "templateBootstrap";
      contextHint?: string;
      template: DidTemplateRef;
      adminTemplate?: DidTemplateRef;
      note?: string;
    }
  | {
      type: "adminRotation";
      contextHint?: string;
      adminTemplate: DidTemplateRef;
      note?: string;
    };

/** The signed VP the wallet ships in the provision-integration message body. */
export interface BootstrapRequestVp {
  "@context": string[];
  type: string[];
  id: string;
  holder: string;
  /** 16 random bytes, base64url-no-pad (22 chars). Re-decoded by the VTA
   *  and used as the sealed-bundle `bundleId`. */
  nonce: string;
  validUntil: string;
  label?: string;
  ask: BootstrapAsk;
  proof: unknown;
}

export interface BuildBootstrapRequestOptions {
  /** Ephemeral signing identity — the operator-granted `did:key` whose
   *  Ed25519 private key signs the proof. The matching X25519 derivation
   *  is the bundle's HPKE recipient. */
  ephemeral: SigningIdentity;
  /** Tagged-union intent. */
  ask: BootstrapAsk;
  /** Validity window in milliseconds. Default 15 minutes — matches the
   *  Rust default; the VTA enforces ±5min skew on validUntil. */
  validityMs?: number;
  /** Optional human-readable label written into the maintainer's audit log. */
  label?: string;
}

/** Build a 16-byte nonce + signed BootstrapRequest VP, returning both.
 *
 *  The caller persists the nonce alongside the bundle so it can verify
 *  `summary.bundleIdHex` (the VTA echoes the nonce back as the bundle id
 *  in hex) on the reply. */
export async function buildBootstrapRequest(
  opts: BuildBootstrapRequestOptions,
): Promise<{ vp: BootstrapRequestVp; nonce: Uint8Array }> {
  const nonce = new Uint8Array(16);
  crypto.getRandomValues(nonce);

  const now = new Date();
  const validUntil = new Date(now.getTime() + (opts.validityMs ?? 15 * 60_000));

  const vp: BootstrapRequestVp = {
    "@context": [VC_V2_CONTEXT_URL, BOOTSTRAP_CONTEXT_URL],
    type: ["VerifiablePresentation", "BootstrapRequest"],
    id: `urn:uuid:${crypto.randomUUID()}`,
    holder: opts.ephemeral.did,
    nonce: base64url.encode(nonce),
    validUntil: validUntil.toISOString(),
    ...(opts.label ? { label: opts.label } : {}),
    ask: opts.ask,
    proof: null,
  };

  // The wallet's existing eddsa-jcs-2022 signer covers JCS canonicalisation
  // + SHA-256(proofConfig) || SHA-256(doc-minus-proof) + Ed25519 sign +
  // multibase proofValue exactly as the Rust side does. Here we pass
  // `authentication` rather than the default `assertionMethod` because the
  // VP holder is proving CONTROL of the ephemeral did:key, not vouching
  // for a claim about it — same distinction the Rust `BootstrapRequest::
  // sign` makes via `SignOptions::with_proof_purpose("authentication")`.
  await signTrustTask({
    envelope: vp as unknown as Record<string, unknown>,
    signing: opts.ephemeral,
    proofPurpose: "authentication",
  });

  return { vp, nonce };
}
