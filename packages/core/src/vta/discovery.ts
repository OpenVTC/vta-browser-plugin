// `trust-task-discovery/0.1` — asking an agent what it actually supports.
//
// Framework-reserved, so this is not a VTA feature but a Trust Tasks one: any
// conformant responder answers it, which is what makes it worth having in a
// wallet. A wallet and the agents it talks to are separately deployed and
// separately versioned, so at any moment this code can be meeting agents both
// ahead of and behind it. Everywhere else in this package that gap is
// discovered the expensive way — send the task, read the refusal, hope the
// refusal is legible. Discovery turns it into a question asked once.
//
// **What it is not.** The answer is a *claim about capability*, not a grant and
// not a promise. An agent that lists a Type URI may still refuse the task on
// policy, ACL, or consent grounds, and one that omits a URI it does support has
// only under-reported. So the honest use is negative: do not offer the user a
// flow the agent has not claimed. Treating a listed type as "this will work"
// re-introduces the failure this exists to avoid, one step later.

import type { Identity } from "../didcomm/index.js";
import type { TrustTaskSender } from "./channel.js";
import type { RemoteDidcommEndpoint } from "./didcomm.js";
import { VtaClientError } from "./errors.js";
import { buildTrustTask } from "./trust-task.js";

import {
  TYPE_URI as DISCOVERY,
  RESPONSE_TYPE_URI as DISCOVERY_RESPONSE,
  type TrustTaskDiscoveryPayload,
  type TrustTaskDiscoveryResponsePayload,
} from "@openvtc/trust-tasks/trust-task-discovery/0.1/payload";

/**
 * The specification's own ceiling on `patterns` — 16, declared as parser
 * hardening (SPEC §10.2) rather than as a capability limit.
 *
 * The reasoning is worth keeping visible at the call site: matching an
 * unbounded pattern list against every published slug is work a responder does
 * on an *unauthenticated* request. A discoverer that wants more asks for `*`
 * and filters locally, which is what {@link discoverSupportedTypes} does when
 * given no patterns at all.
 */
export const MAX_DISCOVERY_PATTERNS = 16;

export interface DiscoveryParams {
  /** Envelope `issuer`. Discovery is answerable unauthenticated by design, but
   *  this package always names an issuer — a transport that authenticates in
   *  the envelope (TSP, DIDComm) has one regardless. */
  holder: Identity;
  /** The responder — envelope `recipient`. */
  service: RemoteDidcommEndpoint;
  /**
   * Slug-glob patterns, ORed: a slug matches if at least one pattern does.
   *
   * Omitted or empty means `['*']` — every supported task — which the
   * responder is required to treat identically.
   */
  patterns?: readonly string[];
}

/** One entry of a discovery answer, normalized out of the wire's two forms. */
export interface DiscoveredType {
  /** Bare Type URI — no `#request` / `#response` fragment. A responder listing
   *  it supports both variants. */
  type: string;
  /**
   * Reverse-DNS `ext` namespaces this responder requires on inbound documents
   * of this type as local policy (SPEC §4.5.1, §7.2).
   *
   * Empty when the responder declared none. **Non-empty is load-bearing**: a
   * producer that does not populate every listed namespace gets a
   * `malformedRequest`, and nothing else on the wire would have told it why.
   */
  requiredExt: readonly string[];
}

export interface DiscoveryResult {
  supportedTypes: DiscoveredType[];
  /**
   * The MAJOR.MINOR framework version the responder targets, when it said.
   *
   * Optional in 0.1 and RECOMMENDED later, so absence means "did not say",
   * never "old". Use it for the §5.2 forward-minor reasoning it is there for;
   * do not gate a flow on it, or every responder that stays silent is locked
   * out of features it supports.
   */
  frameworkVersion?: string;
}

/**
 * Ask a responder which Trust Tasks it supports.
 *
 * ```ts
 * const { supportedTypes } = await discoverSupportedTypes(channel, {
 *   holder, service, patterns: ["vault/*"],
 * });
 * ```
 */
export async function discoverSupportedTypes(
  sender: TrustTaskSender,
  params: DiscoveryParams,
): Promise<DiscoveryResult> {
  const patterns = params.patterns ?? [];
  if (patterns.length > MAX_DISCOVERY_PATTERNS) {
    // Refused here rather than sent and refused there. The responder's own
    // rejection would be a `malformedRequest` with no indication of which
    // limit was passed, and this one names it.
    throw new VtaClientError(
      "e.client.parse",
      `trust-task-discovery accepts at most ${MAX_DISCOVERY_PATTERNS} patterns ` +
        `(SPEC §10.2); ${patterns.length} given. Ask for "*" and filter locally.`,
    );
  }

  // The generated type spells `maxItems: 16` as a union of 17 tuple arities,
  // which no ordinary array literal satisfies. The bound is checked above, so
  // the assertion asserts something already true rather than papering over it.
  const payload: TrustTaskDiscoveryPayload =
    patterns.length > 0
      ? { patterns: [...patterns] as NonNullable<TrustTaskDiscoveryPayload["patterns"]> }
      : {};

  const envelope = buildTrustTask(DISCOVERY, payload, {
    issuer: params.holder.did,
    recipient: params.service.did,
  });
  const res = await sender.send<TrustTaskDiscoveryResponsePayload>(envelope, {
    expectedResponseType: DISCOVERY_RESPONSE,
    operationLabel: "trust-task-discovery/0.1",
  });

  return {
    supportedTypes: (res.supportedTypes ?? []).map(normalizeEntry),
    ...(typeof res.frameworkVersion === "string"
      ? { frameworkVersion: res.frameworkVersion }
      : {}),
  };
}

/**
 * Whether `type` appears in a discovery answer.
 *
 * Compares the **bare** Type URI: a `#response` fragment is stripped first, so
 * passing either a request or a response URI answers the same question, which
 * is the one the responder actually answered — it lists a bare URI to mean it
 * supports both variants.
 */
export function supportsType(result: DiscoveryResult, type: string): boolean {
  const bare = type.split("#")[0];
  return result.supportedTypes.some((entry) => entry.type === bare);
}

/**
 * Flatten the wire's two entry forms into one.
 *
 * An entry is either a bare string or an object carrying `requiredExt`. A
 * consumer that handles only the string form silently drops every `requiredExt`
 * declaration — and those are exactly the responders whose tasks will fail
 * unless the producer acts on them.
 */
function normalizeEntry(
  entry: TrustTaskDiscoveryResponsePayload["supportedTypes"][number],
): DiscoveredType {
  if (typeof entry === "string") return { type: entry, requiredExt: [] };
  return { type: entry.type, requiredExt: entry.requiredExt ?? [] };
}
