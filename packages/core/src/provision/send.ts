// DIDComm round-trip for the provision-integration flow.
//
// Mirrors `packages/core/src/onboarding/swap.ts` — same authcrypt-inner +
// authcrypt-forward-outer + send-and-await-reply shape. The only thing
// that differs is the message type URI and the body wire shape.
//
// Wire URIs — the canonical Trust Task spec URIs, version 0.2:
//   request:  https://trusttasks.org/spec/provision/integration/0.2
//   reply:    https://trusttasks.org/spec/provision/integration/0.2#response
// The VTA dual-accepts 0.1 + 0.2 and `result_uri_for` echoes the request
// version into the `#response` (a 0.2 request gets the 0.2 reply). The legacy
// firstperson.network type was retired VTA-side; this client is fully off it.
//
// Body field naming on the wire stays `snake_case`: the VTA's 0.1/0.2 paths
// share one handler that deserializes the same `ProvisionIntegrationRequest`
// (snake_case) struct, and the response summary is snake_case on both. The
// 0.2 delta is purely the camelCase `ask.type` discriminator inside the SIGNED
// BootstrapRequest VP (`adminRotation` vs 0.1 `AdminRotation`) — see
// `request.ts`. The VTA verifies the VP proof over the received bytes and
// accepts the camelCase tag via a serde alias.

import { packAuthcrypt, packAuthcryptJson, wrapForward, type Identity } from "../didcomm/index.js";
import type { RemoteDidcommEndpoint } from "../vta/didcomm.js";
import type { DidcommMessageBridge } from "../vta/transport.js";

import type { BootstrapRequestVp } from "./request.js";

const PROVISION_INTEGRATION =
  "https://trusttasks.org/spec/provision/integration/0.2";
const PROVISION_INTEGRATION_RESULT =
  "https://trusttasks.org/spec/provision/integration/0.2#response";
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
