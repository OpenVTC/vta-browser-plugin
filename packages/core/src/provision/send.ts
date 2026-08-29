// The provision-integration round-trip, as an ordinary Trust Task.
//
// This used to be a bespoke DIDComm protocol message: authcrypt-inner +
// authcrypt-forward-outer packed here, correlated by `thid`, with a
// problem-report as its error channel. It is now `buildTrustTask` +
// `sender.send`, exactly like every other VTA operation — which means it runs
// over whichever transport the VTA advertises, priority TSP > DIDComm > REST,
// rather than requiring a reachable DIDComm mediator.
//
// **Why it moved.** The VTA has served provision-integration through the shared
// Trust-Task dispatcher for some time (`TASK_PROVISION_INTEGRATION_0_3` →
// `trust_tasks/provision_integration.rs`), taking the same request body and
// returning the same response body as the bespoke DIDComm handler beside it.
// The wallet was using the bespoke one, and paid for it twice:
//
//   1. Provisioning was the one VTA operation with no transport chain — a
//      wallet connected over TSP still had to open a DIDComm mediator session
//      to onboard, and a VTA that advertised no DIDComm could not be onboarded
//      at all.
//   2. The bespoke handler labels its reply from a hand-written version→URI
//      map, and that map was not moved when the router cut over to 0.3. It
//      answered `provision/integration/0.1#response` carrying a 0.3 body, so a
//      provisioning that had fully succeeded — bundle sealed, admin rolled
//      over — was rejected here as an unexpected reply type (VTI #1202). The
//      dispatcher has no such map: it sets the `#response` fragment on the
//      request URI it just parsed, so that class of bug cannot arise there.
//
// **Casing.** The option fields are lowerCamelCase (`createContext`, not
// `create_context`) — the canonical 0.2+ wire form the registry declares, and
// what the generated payload type below enforces. The Rust struct still carries
// snake_case `alias`es, so the old spelling would also be accepted; that is a
// fold on the VTA's side, not a reason to keep sending the legacy form. The
// signed `request` VP is passed through untouched: it carries a proof over its
// own bytes, and re-casing anything inside it breaks that.

import type { TrustTaskSender } from "../vta/channel.js";
import { VtaClientError } from "../vta/errors.js";
import { buildTrustTask } from "../vta/trust-task.js";

import type { BootstrapRequestVp } from "./request.js";

import {
  TYPE_URI as PROVISION_INTEGRATION,
  RESPONSE_TYPE_URI as PROVISION_INTEGRATION_RESULT,
  type ProvisionIntegrationPayload,
  type ProvisionIntegrationResponsePayload,
  type ProvisionSummary,
} from "@openvtc/trust-tasks/provision/integration/0.3/payload";

const DEFAULT_TIMEOUT_MS = 60_000;

/**
 * The VTA could not infer which context to provision into, and is handing back
 * the candidates for a human to pick from.
 *
 * Spelled as the registry declares it (lowerCamelCase, SPEC §4.10 rule 4 —
 * trustoverip/dtgwg-trust-tasks-tf#279). Compared with `===`: every agent this
 * package talks to emits the #279 spelling, so the both-spellings fold that
 * used to live here has been removed rather than carried indefinitely.
 */
export const PROVISION_CONTEXT_REQUIRED = "provision/integration:contextRequired";

/**
 * A refusal the VTA described with a code its own specification declares,
 * rather than one of the framework's standard ones.
 *
 * The only such code on this task today is {@link PROVISION_CONTEXT_REQUIRED},
 * which the wallet has a recovery UX for: it shows `candidates` as a picker so
 * the operator chooses a context and retries inside the ephemeral grant's TTL.
 */
export interface ProvisionRefusal {
  /** The specification-extended code, verbatim. */
  code: string;
  /** The VTA's human-readable explanation. */
  message: string;
  /** For {@link PROVISION_CONTEXT_REQUIRED}, the contexts to choose between.
   *  Empty for any other code, and possibly empty even for this one — a refusal
   *  with no candidates is still a refusal. */
  candidates: string[];
}

/**
 * Read the structured refusal out of a thrown error, or `undefined` when the
 * error is not one.
 *
 * Reads fields, never the message: `VtaClientError.details` carries the
 * framework's error payload verbatim, so the code and the candidates are both
 * machine-readable (guide rule R3.7). Recovering a candidate list by parsing it
 * back out of a rendered sentence is exactly what the extended code exists to
 * make unnecessary.
 */
export function provisionRefusalOf(e: unknown): ProvisionRefusal | undefined {
  if (!(e instanceof VtaClientError)) return undefined;
  const payload = e.details as
    | { code?: unknown; message?: unknown; details?: { candidates?: unknown } }
    | undefined;
  if (!payload || typeof payload.code !== "string") return undefined;
  const raw = payload.details?.candidates;
  return {
    code: payload.code,
    message: typeof payload.message === "string" ? payload.message : e.message,
    candidates: Array.isArray(raw) ? raw.filter((c): c is string => typeof c === "string") : [],
  };
}

/**
 * Body of the `provision/integration/0.3` request.
 *
 * Taken from the generated binding so the option spellings cannot drift from
 * the registry, with `request` re-typed: the generated `BootstrapRequest` is the
 * schema's view of the VP, and this package builds its own
 * ({@link BootstrapRequestVp}) because the document is signed and travels
 * byte-for-byte.
 */
export type ProvisionIntegrationRequestBody = Omit<ProvisionIntegrationPayload, "request"> & {
  request: BootstrapRequestVp;
};

/**
 * Body of the `provision/integration/0.3#response` reply.
 *
 * From the generated bindings rather than transcribed. **The bundle digest is
 * `digestMultibase`, not the `digest` hex string `0.2` carried** — a
 * self-describing multibase multihash, the same type `task-consent`'s
 * `payloadDigest` uses, so decode it with `../trust-tasks/digest.ts` rather than
 * comparing the encoded strings. It is OPTIONAL: it exists for holders that
 * pinned the bundle out-of-band, and its absence is not a failure. It is taken
 * over the **armored bytes exactly as carried** in `bundle`, not over a
 * canonicalization — re-armoring the same ciphertext need not reproduce the same
 * bytes, so re-deriving it from a round-tripped bundle can legitimately disagree.
 */
export type ProvisionIntegrationResponseBody = ProvisionIntegrationResponsePayload;

export type { ProvisionSummary };

export interface SendProvisionIntegrationOptions {
  /** Any transport that can carry a Trust Task, whose identity is the
   *  **ephemeral** — the operator-granted did:key. The VTA authenticates the
   *  sender the same way on all three transports (`auth_from_did` against its
   *  ACL), so the grant the operator just made is what authorises this call
   *  whichever channel carries it. */
  sender: TrustTaskSender;
  /** The operator-granted ephemeral did:key — the envelope `issuer`, and the
   *  `holder` the BootstrapRequest VP is signed by. */
  ephemeralDid: string;
  /** The VTA's DID — the envelope `recipient`. */
  vtaDid: string;
  /** The request body to ship. */
  body: ProvisionIntegrationRequestBody;
  /** Request-side timeout. Default 60s (matches the Rust SDK constant) — the
   *  handler renders templates, mints keys, writes the webvh log, and seals the
   *  bundle synchronously inside one handler call, so it needs more headroom
   *  than a typical task. */
  timeoutMs?: number;
}

/**
 * Send the provision-integration request and return the reply body.
 *
 * Throws a `VtaClientError` on refusal; pass it to {@link provisionRefusalOf} to
 * recover a specification-declared code such as
 * {@link PROVISION_CONTEXT_REQUIRED}.
 */
export async function sendProvisionIntegration(
  opts: SendProvisionIntegrationOptions,
): Promise<ProvisionIntegrationResponseBody> {
  const envelope = buildTrustTask(PROVISION_INTEGRATION, opts.body, {
    issuer: opts.ephemeralDid,
    recipient: opts.vtaDid,
  });
  return opts.sender.send<ProvisionIntegrationResponseBody>(envelope, {
    expectedResponseType: PROVISION_INTEGRATION_RESULT,
    operationLabel: "provision/integration/0.3",
    timeoutMs: opts.timeoutMs ?? DEFAULT_TIMEOUT_MS,
  });
}
