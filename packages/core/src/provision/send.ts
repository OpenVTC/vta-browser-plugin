// DIDComm round-trip for the provision-integration flow.
//
// Mirrors `packages/core/src/onboarding/swap.ts` — same authcrypt-inner +
// authcrypt-forward-outer + send-and-await-reply shape. The only thing
// that differs is the message type URI and the body wire shape.
//
// Wire URIs (pre-spec-migration — see trust-tasks #51 for the canonical
// Trust Task URI that the VTA will accept once implementation lands):
//   request:  https://firstperson.network/protocols/provision-integration/1.0/provision-integration
//   reply:    https://firstperson.network/protocols/provision-integration/1.0/provision-integration-result
//
// Body field naming on the wire matches the existing Rust types in
// `vta-sdk::provision_integration::http` — `snake_case` for now. The
// canonical Trust Task spec uses `camelCase`; that migration is a
// separate downstream change that will keep both shapes accepted during
// the deprecation window.

import { packAuthcrypt, packAuthcryptJson, wrapForward, type Identity } from "../didcomm/index.js";
import type { RemoteDidcommEndpoint } from "../vta/didcomm.js";
import type { DidcommMessageBridge } from "../vta/transport.js";

import type { BootstrapRequestVp } from "./request.js";

const PROVISION_INTEGRATION =
  "https://firstperson.network/protocols/provision-integration/1.0/provision-integration";
const PROVISION_INTEGRATION_RESULT =
  "https://firstperson.network/protocols/provision-integration/1.0/provision-integration-result";
const PROBLEM_REPORT_TYPE = "https://didcomm.org/report-problem/2.0/problem-report";

const DEFAULT_TIMEOUT_MS = 60_000;

/** Parsed DIDComm problem-report body. Mirrors the wire shape
 *  emitted by the VTA's `app_err_to_response`. */
export interface ProblemReportPayload {
  code: string;
  comment: string;
  /** Structured arguments — task-specific. For
   *  `provision/integration:context_required` this carries the
   *  candidates list. */
  args: string[];
}

/** Thrown by `sendProvisionIntegration` when the VTA replies with a
 *  DIDComm problem-report rather than a success result. Carries the
 *  structured fields so callers can branch on the code (e.g. the
 *  popup's context-required recovery picker that reads
 *  `report.args` as the candidates list). */
export class ProvisionProblemReportError extends Error {
  readonly report: ProblemReportPayload;
  constructor(report: ProblemReportPayload) {
    super(`provision-integration: ${report.code} — ${report.comment}`);
    this.name = "ProvisionProblemReportError";
    this.report = report;
  }
}

/** Body of the inbound `provision-integration` message. Mirrors
 *  `vta_sdk::provision_integration::http::ProvisionIntegrationRequest`. */
export interface ProvisionIntegrationRequestBody {
  request: BootstrapRequestVp;
  /** Optional per the canonical Trust Task spec. When omitted, the VTA
   *  infers the target context from the relayer's ACL grant + its own
   *  contexts state. See vta-sdk's `ProvisionIntegrationRequest::context`
   *  doc-comment for the full inference rules. */
  context?: string;
  assertion?: "did-signed" | "pinned-only";
  /** Caller-preferred VC validity in seconds. Capped server-side. */
  vc_validity_seconds?: number;
  /** Super-admin only: create the context inline if missing. */
  create_context?: boolean;
}

/** Body of the outbound `provision-integration-result` reply. Mirrors
 *  `vta_sdk::provision_integration::http::ProvisionIntegrationResponse`. */
export interface ProvisionIntegrationResponseBody {
  bundle: string;
  digest: string;
  summary: ProvisionSummary;
}

export interface ProvisionSummary {
  client_did: string;
  admin_did?: string;
  admin_rolled_over?: boolean;
  integration_did?: string;
  template_name?: string;
  template_kind?: string;
  admin_template_name?: string | null;
  bundle_id_hex: string;
  secret_count: number;
  output_count: number;
  webvh_server_id?: string | null;
  context_created?: boolean;
}

export interface SendProvisionIntegrationOptions {
  /** Mediator-backed bridge — ships the JWE and surfaces the decrypted,
   *  sender-authenticated reply (keyed by `thid`). */
  bridge: DidcommMessageBridge;
  /** Authcrypt sender = the operator-granted ephemeral did:key (X25519
   *  identity matching the BootstrapRequest's `holder`). */
  ephemeral: Identity;
  /** The VTA's DID + keyAgreement key (inner authcrypt recipient). */
  service: RemoteDidcommEndpoint;
  /** The VTA's mediator (forward target). Omit for direct, non-mediated send. */
  mediator?: RemoteDidcommEndpoint;
  /** The VTA's DID — the expected reply `from`. */
  vtaDid: string;
  /** The request body to ship. */
  body: ProvisionIntegrationRequestBody;
  /** Request-side timeout. Default 60s (matches the Rust SDK constant) —
   *  the handler renders templates, mints keys, writes the webvh log, and
   *  seals the bundle synchronously inside one handler call, so it needs
   *  more headroom than a typical authenticate. */
  timeoutMs?: number;
}

/** Pack + send the provision-integration request and return the reply
 *  body. Throws on timeout, wrong reply type, sender mismatch, or any
 *  problem-report from the VTA. */
export async function sendProvisionIntegration(
  opts: SendProvisionIntegrationOptions,
): Promise<ProvisionIntegrationResponseBody> {
  const { bridge, ephemeral, service, mediator, vtaDid, body } = opts;
  const timeoutMs = opts.timeoutMs ?? DEFAULT_TIMEOUT_MS;

  const requestId = globalThis.crypto.randomUUID();
  const message = {
    id: requestId,
    type: PROVISION_INTEGRATION,
    from: ephemeral.did,
    to: [service.did],
    body,
  };

  const inner = await packAuthcrypt(message, ephemeral, [
    { kid: service.keyAgreementKid, jwk: service.keyAgreementPublicJwk },
  ]);

  let outer = inner;
  if (mediator) {
    const forwardJson = wrapForward(service.did, ephemeral.did, mediator.did, inner);
    outer = await packAuthcryptJson(forwardJson, ephemeral, [
      { kid: mediator.keyAgreementKid, jwk: mediator.keyAgreementPublicJwk },
    ]);
  }

  const reply = await bridge.sendAndAwaitReply(outer, requestId, { timeoutMs });

  if (reply.thid !== requestId) {
    throw new Error(
      `provision-integration: reply thid ${reply.thid ?? "(none)"} != request ${requestId}`,
    );
  }
  if (reply.from !== vtaDid) {
    throw new Error(
      `provision-integration: reply from ${reply.from ?? "(none)"} != VTA ${vtaDid}`,
    );
  }
  if (reply.type === PROBLEM_REPORT_TYPE) {
    // Throw a typed error so callers can branch on the code without
    // re-parsing the message string. The canonical case we surface a
    // UX for is `provision/integration:context_required` — the
    // wallet's popup catches the typed shape and shows the candidates
    // (in `report.args`) as a picker so the operator can choose.
    const body = (reply.body ?? {}) as Partial<ProblemReportPayload>;
    throw new ProvisionProblemReportError({
      code: typeof body.code === "string" ? body.code : "(no code)",
      comment: typeof body.comment === "string" ? body.comment : "",
      args: Array.isArray(body.args) ? body.args.filter((a) => typeof a === "string") : [],
    });
  }
  if (reply.type !== PROVISION_INTEGRATION_RESULT) {
    // Unexpected reply type — not a problem-report and not the
    // expected result. Could happen if a future VTA version
    // introduces a new reply type the wallet doesn't know about.
    throw new Error(
      `provision-integration: ${reply.type ?? "(no type)"} — ${JSON.stringify(reply.body ?? {})}`,
    );
  }

  return (reply.body ?? {}) as ProvisionIntegrationResponseBody;
}
