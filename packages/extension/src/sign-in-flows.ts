// Wallet sign-in started by a trigger link: the flow, step by step.
//
// Runs in the offscreen document, which is where the holder's VTA session
// lives and where `K_a` is held — in memory, for one flow, never stored. The
// sign-in window drives it one person-action at a time (`RUNTIME_SIGN_IN_STEP`
// via the background); each call returns the next screen.
//
// The order is contract C3, and every arrow is a gate:
//
//   prepare  parse the link (C1) → is this one of the wallet's communities
//            (VTI-LNK-101; nothing is sent to one that is not) → resolve and
//            verify its DID document → the clicked page's origin must be the
//            portal's (VTI-LNK-105) → "Sign in to <name> at <origin>?"
//   join     only for a site the wallet does not know (see below).
//   linkage  only for a domain-linked contact (a DID that names no host,
//            dtgwg-vti-spec #58): after Continue, before the claim, the
//            portal's DIF DID Configuration must link its origin to the DID,
//            or the flow ends `domain-not-linked` with nothing sent. Which
//            route a contact takes is the contact-method registry's
//            (`CONTACT_METHODS`); today every registered method is host-named.
//   claim    the member chose an identity and pressed Continue. Only now is
//            K_a generated and anything sent to the community (C3 step 7).
//   prove    the typed number, and `identify` signed by the VTA.
//   review   step 2: where the request came from.
//   grant    the window runs the wallet passkey's ceremony bound to the grant
//            digest; its PRF output unseals this browser's UV key, which
//            (enrolled at the VTA first, when it is not yet) signs the
//            decision (C6); the VTA signs the grant with it; `respond` carries
//            it. K_a is then discarded.
//
// ## A site the wallet does not know
//
// Nothing is sent to it (VTI-LNK-101) until the person agrees, but its DID
// document is still resolved and verified, and the page must still be its
// portal, before anything is offered — the offer names the verified origin,
// never the link's text. Then the document's services say what it is:
//
//   - `WebVHHosting`: a DID hosting service. "Use <host> to host your DIDs?"
//     with the agent's DIDs to choose from; `join` records the choice the way
//     the legacy first-use prompt always has (`bindProfile`: a `didSelfIssued`
//     entry targeting the portal origin and the service DID), and the flow
//     goes straight on to `confirm` for the same link. The service admits only
//     DIDs its operator put on its access list, so a `notAuthorized` to the
//     proof is shown as exactly that, with the DID to send them.
//   - `VTCRest`: a community (VTC). "Join <host>?" — and still nothing is sent
//     until the person continues. Then, in order:
//       join-manifest  the community's join manifest, asked for as a throwaway
//                      `did:key`: what it admits under and what it asks
//                      applicants to say. Nothing about the person is sent.
//                      A community that asks for evidence this wallet cannot
//                      assemble (a credential, an invitation, vetting) is
//                      said so plainly (`join-elsewhere`) and the flow ends.
//       join-submit    the person chose an identity and answered. The vault
//                      entry is recorded first, in the shape every member's
//                      has (`bindProfile`, as for a DID hosting service),
//                      because the VTA signs only as a vault entry's principal
//                      and the community reads the applicant from that
//                      signature. Then `vtc/join-requests/submit/0.3`:
//                        allow        admitted: straight on to `confirm` for
//                                     the same link.
//                        refer /      pending (`join-pending`): the entry stays,
//                        requestMore  as the request is open under that DID;
//                                     the flow ends and no sign-in document is
//                                     sent.
//                        deny, or a   the entry is removed again and the
//                        refusal      reason is shown.
//   - anything else: not one of your communities.
//
// Declining or closing at any point before the request is sent sends nothing
// about the person to the site.
//
// The community's *own* name for itself is never what the member is asked to
// trust: the confirm screen shows the wallet's record, and a different name in
// step 1 is flagged (VTI-LNK-104). The link's fields are never shown as a
// statement of what the exchange is (VTI-LNK-052), and nothing of the link is
// logged (VTI-LNK-073) — this module does not log at all. A failure carries
// the exchange it happened in, who refused and the stable code
// (`sign-in-failure.ts`); the background logs those, and nothing else.

import {
  parseTriggerLink,
  outcomeOf,
  triggerLinkMessage,
  contactDomainLabel,
  bytesToBase64url,
  base64urlToBytes,
  type ParsedTriggerLink,
  type TriggerLinkReason,
  type SigningIdentity,
  uvChallengeBytes,
  vaultOobRefusal,
  OOB_NOT_ENROLLED_DEVICE,
  OOB_DEVICE_DISABLED,
  OOB_NO_UV_KEY,
  OOB_UV_INVALID,
  CONTACT_METHODS,
  type ContactMethodRegistry,
  type ContactRoute,
} from "@openvtc/pnm-core";
import {
  resolveCommunityDocument,
  selectSignInServices,
  originMatchesPortal,
  newApproverKey,
  buildClaim,
  buildIdentify,
  buildProve,
  buildGrant,
  buildRespond,
  buildCancel,
  sendOob,
  checkStep1,
  checkStep2,
  deadlineMs,
  assertSignedAsSent,
  contextDigest,
  grantDigest,
  networkLine,
  sessionAudienceOf,
  verifyDomainLinkage,
  postCommunityTask,
  buildJoinManifestRequest,
  checkJoinManifest,
  planJoin,
  buildJoinSubmit,
  joinOutcomeOf,
  VTC_REST_SERVICE_TYPE,
  type JoinPlan,
  type JoinManifestVersion,
  OobRefusedError,
  OOB_REPLY_INVALID,
  type OobDocument,
  type OobStep1,
  type OobStep2,
  type OobGrantPayload,
  type OobDecision,
  type OobReply,
  type OobVersion,
  type SignInServices,
} from "@openvtc/pnm-core/vtc";
import type {
  SignInFailureParty,
  SignInFailureStage,
  SignInPersonaView,
  SignInIdentityView,
  SignInRefusalDetail,
  SignInStep,
  SignInStepResult,
} from "./bridge-protocol.js";
import { safeCode } from "./sign-in-failure.js";

/** A vault entry, as far as finding a community's identities needs it. */
/** A DID the member's agent hosts — a candidate when starting to use a DID
 *  hosting service. */
export interface SignInPersona {
  did: string;
  contextId: string;
}

export interface SignInVaultEntry {
  id: string;
  label: string;
  secretKind: string;
  principalDid?: string;
  targets: ReadonlyArray<{ kind: string; did?: string }>;
}

/** The member's own agent, for one flow. */
export interface SignInVta {
  /** Every `didSelfIssued` entry. Listed whole and matched here, so the
   *  community's DID is not sent to the VTA as a filter before the person has
   *  decided anything (VTI-LNK-073). */
  listIdentities(): Promise<SignInVaultEntry[]>;
  /** `vault/sign-trust-task` for `auth/oob/identify` (no user verification). */
  signIdentify(entryId: string, unsigned: OobDocument): Promise<unknown>;
  /** `vault/sign-trust-task` for `auth/oob/grant`. For an approval, `uv` is
   *  the grant digest D and the PRF output of the passkey ceremony bound to
   *  it; the caller unseals the UV key with it and has that key sign the
   *  `task-consent/decision/0.2` the VTA requires. */
  signGrant(
    entryId: string,
    unsigned: OobDocument,
    uv?: {
      payloadDigest: string;
      prfOutput: Uint8Array;
    },
  ): Promise<unknown>;
  /** The DIDs the agent hosts, across every context (`vta/webvh/list`): what
   *  the person may choose from when they start using a DID hosting service. */
  listPersonas(): Promise<SignInPersona[]>;
  /**
   * Record that `did` is who the member is at the site at `origin` whose DID
   * is `rpDid`: the same `didSelfIssued` vault entry the legacy first-use
   * prompt creates (`bindProfile` in `first-use-profile.ts`). Returns the new
   * entry's id and label.
   */
  bindIdentity(binding: {
    origin: string;
    did: string;
    rpDid: string;
  }): Promise<{ entryId: string; label: string }>;
  /** `vault/sign-trust-task` for any other document the member sends as the
   *  entry's principal (a join request). Returns the document with its proof. */
  signTask(entryId: string, unsigned: OobDocument): Promise<unknown>;
  /** Remove an entry this flow recorded and no longer needs (`vault/delete`). */
  unbindIdentity(entryId: string): Promise<void>;
  /**
   * Make sure the VTA holds this browser's UV key: unseal it with `prfOutput`
   * (minting it, the first time) and, unless the VTA already holds it for this
   * holder, enrol it (`device/heartbeat` ext `org.openvtc.uv-key`, over the
   * device's session).
   */
  enrolUvKey(prfOutput: Uint8Array): Promise<void>;
  /**
   * Make sure this browser is registered as one of the member's devices at
   * the VTA (`device/register`, once per holder). The VTA signs sign-in
   * documents only for an enrolled device, so this runs before anything is
   * sent to the community; a failure here is not final, because signing
   * `identify` registers and retries once on `oobNotEnrolledDevice`.
   */
  ensureDevice?(): Promise<void>;
}

export interface SignInFlowDeps {
  /** Epoch milliseconds. */
  now: () => number;
  vta: (vtaDid: string, restBaseUrl?: string) => SignInVta;
  resolveDid?: (did: string) => Promise<unknown>;
  fetch?: typeof fetch;
  /** The contact methods this reader takes. Defaults to the shared registry
   *  (`did:webvh` and `did:web`, both host-named). */
  contactMethods?: ContactMethodRegistry;
  /**
   * How long the grant lets the browser act as the member (`notAfter`).
   *
   * Base design §14 step 12 says "the member session limit", which is the
   * community's and is not published anywhere the wallet can read. The VTC
   * ends the session at the earlier of this and its own limit (§7.6), so this
   * is a ceiling the member grants, not the session's length.
   */
  grantLifetimeMs: number;
}

type Phase = "joining" | "prepared" | "claimed" | "identified" | "ended";

/** What a verified DID document says the site is. */
export type SiteKind = "did-hosting" | "community" | "other";

/** The service type a DID hosting service publishes (affinidi-webvh-service
 *  `add_webvh_hosting_service`, the VTA's `did-host-http` templates). It is
 *  also what a VTA's `servers add` reads to accept a server as a DID host. */
export const WEBVH_HOSTING_SERVICE_TYPE = "WebVHHosting";

/** Read from the **verified** document, matched on `type` (VTI-LNK-053). A
 *  document that publishes both is a DID hosting service first. */
export function siteKindOf(doc: unknown): SiteKind {
  const services = (doc as { service?: unknown })?.service;
  if (!Array.isArray(services)) return "other";
  const has = (wanted: string) =>
    services.some((s) => {
      const t = (s as { type?: unknown } | null)?.type;
      return t === wanted || (Array.isArray(t) && t.includes(wanted));
    });
  if (has(WEBVH_HOSTING_SERVICE_TYPE)) return "did-hosting";
  return has(VTC_REST_SERVICE_TYPE) ? "community" : "other";
}

/** The host of an origin, for a sentence ("Use <host> …"). */
function hostOf(origin: string): string {
  try {
    return new URL(origin).hostname || origin;
  } catch {
    return origin;
  }
}

/** A DID the agent hosts, with the sites it already signs in to. */
function personaView(p: SignInPersona, entries: readonly SignInVaultEntry[]): SignInPersonaView {
  const usedAt = [
    ...new Set(
      entries
        .filter((e) => e.secretKind === "didSelfIssued" && e.principalDid === p.did)
        .map((e) => e.label),
    ),
  ];
  return { did: p.did, contextId: p.contextId, ...(usedAt.length ? { usedAt } : {}) };
}

/** The last segment of a refusal code: `auth/oob/claim:alreadyClaimed` →
 *  `alreadyClaimed`. The services send the family-qualified code (C9); the
 *  segment after the colon is the stable name within it. */
function oobCode(code: string): string {
  return code.slice(code.lastIndexOf(":") + 1);
}

interface Flow {
  /** The member's VTA this flow signs at. */
  vtaDid: string;
  phase: Phase;
  link: ParsedTriggerLink;
  vta: SignInVta;
  vtcDid: string;
  vtcDocument: Record<string, unknown>;
  services: SignInServices;
  communityName: string;
  identities: SignInIdentityView[];
  kind: SiteKind;
  /** How the contact qualifies (dtgwg-vti-spec #58). A `domain-linked` one
   *  is held to the portal's DID Configuration before anything is sent. */
  route: ContactRoute;
  /** The portal origin's linkage to the contact's DID was confirmed. */
  linked?: boolean;
  /** The agent's DIDs, while `joining`. */
  personas?: SignInPersona[];
  /** Every `didSelfIssued` entry, read at `prepare`: which sites a DID is
   *  already used at, for the community join offer. */
  entries?: SignInVaultEntry[];
  /** A community's join manifest, as far as the wallet can apply under it. */
  joinPlan?: Extract<JoinPlan, { ok: true }>;
  kA?: SigningIdentity;
  entry?: SignInIdentityView;
  step1?: OobStep1;
  step2Doc?: OobDocument<OobStep2>;
  /** The `prove` / `grant` / `respond` version this exchange runs at: 0.2
   *  unless the community refused it. */
  version?: OobVersion;
  unsignedGrant?: OobDocument<OobGrantPayload>;
  grantDigest?: string;
  /** The exchange in progress, for a failure's details. Set before each call
   *  out; read only by `fail`. */
  at?: SignInFailureStage;
}

/** Stable code for a step the flow is not ready for (R3.7). */
export const SIGN_IN_OUT_OF_ORDER = "sign-in/out-of-order";

export const ALREADY_CLAIMED_MESSAGE =
  "This code was already used by another device. If that wasn't you, cancel on the website.";
export const ENDED_MESSAGE = "Refresh the code on the website and try again.";

/** Stable code: recording a DID hosting service in the vault failed. */
export const SIGN_IN_JOIN_FAILED = "sign-in/join-failed";

/** Stable code: the community decided against a join request (`deny`). */
export const SIGN_IN_JOIN_DECLINED = "sign-in/join-declined";

/** What the person is told for a community's refusal of a join request, by
 *  the code's stable name (C9: the segment after the family). */
export const JOIN_REFUSAL_MESSAGES: Readonly<Record<string, (host: string) => string>> = {
  notAccepting: (host) => `${host} isn't accepting new members right now.`,
  attributesMissing: (host) => `${host} needs details this request didn't include. Try again and fill in every required field.`,
  attributesUnrequested: (host) => `${host} didn't ask for some of the details sent. Try again.`,
  criterionUnknown: (host) => `${host} changed what it requires to join. Try again.`,
  presentationInvalid: (host) => `${host} didn't accept the request as sent.`,
  permissionDenied: (host) => `${host} doesn't share how to join with people who aren't members.`,
};

/** Stable code, and the spec's reason: a domain-linked contact's portal
 *  origin is not linked to its DID (outcome `invalid`). Nothing was sent. */
export const SIGN_IN_DOMAIN_NOT_LINKED = "domain-not-linked";

/** What the member is told when the portal is not linked to the community's
 *  DID. */
export const DOMAIN_NOT_LINKED_MESSAGE =
  "This code can't be used. Your wallet couldn't confirm that this website belongs to the community that made the code.";

/** What the member is told when a DID hosting service has not put their DID
 *  on its access list. */
export const notListedMessage = (host: string): string =>
  `${host} hasn't added you yet. Send this DID to its operator:`;

/** What the member is told when their own VTA refused to sign, by its code. */
export const VTA_REFUSAL_MESSAGES: Readonly<Record<string, string>> = {
  [OOB_NOT_ENROLLED_DEVICE]:
    "This browser isn't registered as one of your devices with your agent, and registering it didn't work. " +
    "Check that the wallet can reach your agent, then refresh the code on the website and try again.",
  [OOB_DEVICE_DISABLED]:
    "This browser has been disabled as one of your devices at your agent, so it can't sign you in. " +
    "Sign in from another device, or connect this browser to your agent again.",
  [OOB_NO_UV_KEY]:
    "Your agent doesn't hold this browser's sign-in approval key yet. " +
    "Refresh the code on the website and approve again to set it up.",
  [OOB_UV_INVALID]:
    "Your agent didn't accept this browser's approval. Refresh the code on the website and try again.",
};

const refused = (reason: TriggerLinkReason, detail?: SignInRefusalDetail): SignInStepResult => {
  const outcome = outcomeOf(reason);
  // `pass-on` never reaches a flow: the background does not open one for it.
  const shown = outcome === "pass-on" ? "invalid" : outcome;
  return {
    kind: "refused",
    outcome: shown,
    message: triggerLinkMessage(shown)!,
    ...(detail ? { detail } : {}),
  };
};

export class SignInFlows {
  private readonly flows = new Map<string, Flow>();
  constructor(private readonly deps: SignInFlowDeps) {}

  /** Whether a flow is still held (for tests and for the abort path). */
  has(flowId: string): boolean {
    return this.flows.has(flowId);
  }

  async step(
    req: {
      flowId: string;
      vtaDid: string;
      restBaseUrl?: string;
      link?: string;
      origin?: string;
    } & SignInStep,
  ): Promise<SignInStepResult> {
    if (req.step === "prepare")
      return this.prepare(
        req.flowId,
        req.link,
        req.origin,
        req.vtaDid,
        req.restBaseUrl,
      );
    const flow = this.flows.get(req.flowId);
    if (!flow || flow.phase === "ended") {
      return {
        kind: "failed",
        code: SIGN_IN_OUT_OF_ORDER,
        message: ENDED_MESSAGE,
      };
    }
    try {
      switch (req.step) {
        case "join":
          return await this.join(req.flowId, flow, req.did);
        case "join-manifest":
          return await this.joinManifest(req.flowId, flow);
        case "join-submit":
          return await this.joinSubmit(req.flowId, flow, req);
        case "claim":
          return await this.claim(req.flowId, flow, req.entryId);
        case "prove":
          return await this.prove(flow, req.enteredNumber);
        case "grant-digest":
          return await this.grantChallenge(flow);
        case "respond":
          return await this.respond(
            flow,
            req.decision,
            req.decision === "approve" ? req.prfOutputB64u : undefined,
          );
        case "cancel":
          return await this.cancel(req.flowId, flow);
      }
    } catch (err) {
      return await this.fail(req.flowId, flow, err);
    }
  }

  /** The window went away: cancel at the community if a claim is held, and
   *  forget `K_a`. Never throws. */
  async abort(flowId: string): Promise<void> {
    const flow = this.flows.get(flowId);
    if (!flow) return;
    await this.cancel(flowId, flow).catch(() => undefined);
  }

  // ── prepare ────────────────────────────────────────────────────────────────

  private async prepare(
    flowId: string,
    linkText: string | undefined,
    origin: string | undefined,
    vtaDid: string,
    restBaseUrl: string | undefined,
  ): Promise<SignInStepResult> {
    if (this.flows.has(flowId))
      return {
        kind: "failed",
        code: SIGN_IN_OUT_OF_ORDER,
        message: ENDED_MESSAGE,
      };
    // C3 step 1, parsed again here: the background's parse chose the window,
    // this one is the one the flow acts on.
    const methods = this.deps.contactMethods ?? CONTACT_METHODS;
    const parsed = parseTriggerLink(linkText ?? "", {
      now: Math.floor(this.deps.now() / 1000),
      contactMethods: methods,
    });
    if (!parsed.ok) {
      // A link field's failure stays vague (VTI-LNK-021); a contact method
      // the flow does not take is named, for the operator's Details.
      return parsed.reason === "from-not-allowed" && parsed.method
        ? refused(parsed.reason, { reason: parsed.reason, method: parsed.method })
        : refused(parsed.reason);
    }
    const link = parsed.link;
    if (!link.flow) return refused("untyped");
    if (link.flow.spec.name !== "sign-in") return refused("unknown-flow");
    const vtcDid = link.from.value;

    // C3 step 2 / VTI-LNK-101: one of this wallet's communities, or nothing is
    // sent to it.
    const vta = this.deps.vta(vtaDid, restBaseUrl);
    // This browser is one of the member's devices; the VTA signs sign-in
    // documents only for an enrolled one. Best effort here — `identify`
    // enrols and retries once if this did not take.
    await vta.ensureDevice?.().catch(() => undefined);
    const entries = await vta.listIdentities();
    const identities: SignInIdentityView[] = entries
      .filter(
        (e) =>
          e.secretKind === "didSelfIssued" &&
          typeof e.principalDid === "string" &&
          e.targets.some((t) => t.kind === "did" && t.did === vtcDid),
      )
      .map((e) => ({ entryId: e.id, did: e.principalDid!, label: e.label }));

    // C3 step 3: resolve and verify, afresh — for a site the wallet does not
    // know too, so that what it is offered is the verified document's account
    // of the site and never the link's.
    const resolved = await resolveCommunityDocument(vtcDid, {
      ...(this.deps.resolveDid ? { resolveDid: this.deps.resolveDid } : {}),
      contactMethods: methods,
    });
    if (!resolved.ok) {
      return resolved.reason === "unsupported-vid"
        ? refused(resolved.reason, { reason: resolved.reason, method: link.from.kind })
        : refused(resolved.reason, { reason: "did-document-unverified", did: vtcDid });
    }
    const selected = selectSignInServices(resolved.doc);
    if (!selected.ok) {
      return refused(selected.reason, {
        reason: selected.reason === "no-portal-service" ? "no-portal-service" : "no-common-transport",
        did: vtcDid,
        service: selected.service,
        ...(selected.unusable ? { unusable: true as const } : {}),
      });
    }

    // C3 step 4: the page the link was clicked on must be the portal.
    if (!origin || !originMatchesPortal(origin, selected.services.portalOrigin))
      return refused("wrong-origin", {
        reason: "wrong-origin",
        did: vtcDid,
        ...(origin ? { pageOrigin: origin } : {}),
        portalOrigin: selected.services.portalOrigin,
      });

    const kind = siteKindOf(resolved.doc);
    if (identities.length === 0) {
      const { portalOrigin } = selected.services;
      if (kind === "community") {
        // A community: offer to join it. Nothing is sent to it yet.
        const host = hostOf(portalOrigin);
        this.flows.set(flowId, {
          vtaDid,
          phase: "joining",
          link,
          vta,
          vtcDid,
          vtcDocument: resolved.doc,
          services: selected.services,
          communityName: host,
          identities: [],
          kind,
          route: resolved.route,
          entries,
        });
        return { kind: "join-community", host, portalOrigin };
      }
      if (kind !== "did-hosting") {
        const contactLabel = contactDomainLabel(link.from, methods);
        return {
          kind: "not-member",
          ...(contactLabel ? { contactLabel } : {}),
          portalOrigin,
        };
      }
      // A DID hosting service: offer to use it. Still nothing is sent to it.
      const personas = await vta.listPersonas();
      const host = hostOf(portalOrigin);
      this.flows.set(flowId, {
        vtaDid,
        phase: "joining",
        link,
        vta,
        vtcDid,
        vtcDocument: resolved.doc,
        services: selected.services,
        communityName: host,
        identities: [],
        kind,
        route: resolved.route,
        personas,
      });
      return {
        kind: "join-hosting",
        host,
        portalOrigin,
        identities: personas.map((p) => ({ did: p.did, contextId: p.contextId })),
      };
    }

    // C3 step 5: the name from the wallet's own record.
    const communityName = identities[0]!.label;
    this.flows.set(flowId, {
      vtaDid,
      phase: "prepared",
      link,
      vta,
      vtcDid,
      vtcDocument: resolved.doc,
      services: selected.services,
      communityName,
      identities,
      kind,
      route: resolved.route,
    });
    return {
      kind: "confirm",
      communityName,
      portalOrigin: selected.services.portalOrigin,
      identities,
    };
  }

  // ── join (an unknown DID hosting service) ──────────────────────────────────

  private async join(
    flowId: string,
    flow: Flow,
    did: string,
  ): Promise<SignInStepResult> {
    if (flow.phase !== "joining" || flow.kind !== "did-hosting") throw outOfOrder();
    if (!flow.personas?.some((p) => p.did === did)) throw outOfOrder();
    // The person agreed: a domain-linked site is held to its DID
    // Configuration before anything is recorded or sent.
    const unlinked = await this.confirmLinkage(flowId, flow);
    if (unlinked) return unlinked;
    flow.at = "join";
    let bound: { entryId: string; label: string };
    try {
      bound = await flow.vta.bindIdentity({
        origin: flow.services.portalOrigin,
        did,
        rpDid: flow.vtcDid,
      });
    } catch (err) {
      // Nothing was sent to the site; the flow simply ends here.
      this.end(flow);
      this.flows.delete(flowId);
      const message = err instanceof Error ? err.message : String(err);
      return {
        kind: "failed",
        code: SIGN_IN_JOIN_FAILED,
        message: `Your wallet couldn't record ${flow.communityName}: ${message}`,
        stage: "join",
      };
    }
    const identity: SignInIdentityView = {
      entryId: bound.entryId,
      did,
      label: bound.label,
    };
    flow.identities = [identity];
    flow.communityName = bound.label;
    delete flow.personas;
    flow.phase = "prepared";
    // Straight on to the ordinary confirm (C3 step 5) for the same link: the
    // website does not need clicking again.
    return {
      kind: "confirm",
      communityName: flow.communityName,
      portalOrigin: flow.services.portalOrigin,
      identities: flow.identities,
    };
  }

  // ── join (an unknown community) ─────────────────────────────────────────────

  /** The person asked what the community requires. The manifest is asked for
   *  as a throwaway key: the community learns nothing of who is looking. */
  private async joinManifest(
    flowId: string,
    flow: Flow,
  ): Promise<SignInStepResult> {
    if (flow.phase !== "joining" || flow.kind !== "community" || flow.joinPlan)
      throw outOfOrder();
    const unlinked = await this.confirmLinkage(flowId, flow);
    if (unlinked) return unlinked;
    const host = flow.communityName;
    const { portalOrigin } = flow.services;
    flow.at = "join-manifest";
    const key = newApproverKey();
    let plan: JoinPlan;
    try {
      // 0.4 first: it carries what the community's directory would show
      // about the person. A community that predates it refuses the type, and
      // the same question is asked at 0.3.
      const ask = (version: JoinManifestVersion) =>
        sendOob(
          key,
          buildJoinManifestRequest(key.did, flow.vtcDid, version),
          this.sendOpts(flow),
          "vtc/join-requests/manifest",
          "authentication",
        );
      let reply;
      try {
        reply = await ask("0.4");
      } catch (e) {
        if (!(e instanceof OobRefusedError) || !/unsupportedType$/.test(e.code)) throw e;
        reply = await ask("0.3");
      }
      plan = planJoin(checkJoinManifest(reply.payload, flow.vtcDid));
    } catch (err) {
      return this.joinFailed(flowId, flow, err, `Your wallet couldn't ask ${host} how to join`);
    } finally {
      key.privateKey.fill(0);
    }
    const named = plan.displayName !== undefined ? { displayName: plan.displayName } : {};
    if (!plan.ok) {
      this.end(flow);
      this.flows.delete(flowId);
      return { kind: "join-elsewhere", host, portalOrigin, reason: plan.reason, needs: plan.needs, ...named };
    }
    flow.joinPlan = plan;
    flow.personas = await flow.vta.listPersonas();
    return {
      kind: "join-apply",
      host,
      portalOrigin,
      ...named,
      admission: plan.admission,
      attributes: plan.requestedAttributes,
      ...(plan.directory ? { directory: plan.directory } : {}),
      identities: flow.personas.map((p) => personaView(p, flow.entries ?? [])),
    };
  }

  /** The person sent the request, as `did`, with their answers. */
  private async joinSubmit(
    flowId: string,
    flow: Flow,
    req: {
      did: string;
      attributes: Array<{ type: string; value: string }>;
      registryConsent: boolean;
    },
  ): Promise<SignInStepResult> {
    const plan = flow.joinPlan;
    if (flow.phase !== "joining" || flow.kind !== "community" || !plan) throw outOfOrder();
    if (!flow.personas?.some((p) => p.did === req.did)) throw outOfOrder();
    if (typeof req.registryConsent !== "boolean") throw outOfOrder();
    // Only what the community asked for, and every required one, non-empty.
    const asked = new Map(plan.requestedAttributes.map((a) => [a.type, a]));
    const answers: Array<{ type: string; value: string }> = [];
    for (const a of Array.isArray(req.attributes) ? req.attributes : []) {
      if (!asked.has(a?.type) || typeof a.value !== "string") throw outOfOrder();
      if (answers.some((x) => x.type === a.type)) throw outOfOrder();
      const value = a.value.trim();
      if (value !== "") answers.push({ type: a.type, value });
    }
    for (const a of plan.requestedAttributes) {
      if (a.required && !answers.some((x) => x.type === a.type)) throw outOfOrder();
    }
    const host = flow.communityName;
    const { portalOrigin } = flow.services;

    // The entry first: the VTA signs only as a vault entry's principal, and
    // the community takes the applicant from that signature.
    flow.at = "join";
    let bound: { entryId: string; label: string };
    try {
      bound = await flow.vta.bindIdentity({ origin: portalOrigin, did: req.did, rpDid: flow.vtcDid });
    } catch (err) {
      this.end(flow);
      this.flows.delete(flowId);
      const message = err instanceof Error ? err.message : String(err);
      return {
        kind: "failed",
        code: SIGN_IN_JOIN_FAILED,
        message: `Your wallet couldn't record ${host}, so nothing was sent to it: ${message}`,
        stage: "join",
      };
    }
    const unbind = () => flow.vta.unbindIdentity(bound.entryId).catch(() => undefined);

    let outcome: ReturnType<typeof joinOutcomeOf>;
    try {
      const unsigned = buildJoinSubmit(req.did, flow.vtcDid, {
        criterion: plan.criterion,
        attributes: answers,
        registryConsent: req.registryConsent,
      });
      flow.at = "join-sign";
      const signed = assertSignedAsSent(unsigned, await flow.vta.signTask(bound.entryId, unsigned), "authentication");
      flow.at = "join-submit";
      const reply = await postCommunityTask(signed, this.sendOpts(flow), "vtc/join-requests/submit", "authentication");
      outcome = joinOutcomeOf(reply.payload);
    } catch (err) {
      // A request already open under this DID is a pending one: keep the
      // entry it is open under.
      if (err instanceof OobRefusedError && oobCode(err.code) === "requestAlreadyOpen") {
        this.end(flow);
        this.flows.delete(flowId);
        return { kind: "join-pending", host, portalOrigin };
      }
      await unbind();
      return this.joinFailed(flowId, flow, err, `${host} didn't take the request`);
    }

    if (outcome.kind === "admitted") {
      // A member now: on to the ordinary confirm (C3 step 5) for the same link.
      const identity: SignInIdentityView = { entryId: bound.entryId, did: req.did, label: bound.label };
      flow.identities = [identity];
      flow.communityName = bound.label;
      delete flow.personas;
      delete flow.joinPlan;
      delete flow.entries;
      flow.phase = "prepared";
      return {
        kind: "confirm",
        communityName: flow.communityName,
        portalOrigin,
        identities: flow.identities,
      };
    }
    this.end(flow);
    this.flows.delete(flowId);
    if (outcome.kind === "pending") {
      return { kind: "join-pending", host, portalOrigin, ...(outcome.needs ? { needs: outcome.needs } : {}) };
    }
    await unbind();
    return {
      kind: "failed",
      code: SIGN_IN_JOIN_DECLINED,
      message: outcome.reason
        ? `${host} declined your request to join: ${outcome.reason}`
        : `${host} declined your request to join.`,
      stage: "join-submit",
      party: "community",
      ...(outcome.code ? { cause: safeCode(outcome.code) ?? "deny" } : {}),
    };
  }

  /** A join step that failed: said plainly, with where and who, and the flow
   *  ends. Nothing further is sent. */
  private joinFailed(
    flowId: string,
    flow: Flow,
    err: unknown,
    lead: string,
  ): SignInStepResult {
    const where = failureWhere(flow.at, err);
    this.end(flow);
    this.flows.delete(flowId);
    const host = flow.communityName;
    if (err instanceof OobRefusedError) {
      const local = oobCode(err.code);
      if (UNREACHED.has(err.code))
        return {
          kind: "failed",
          code: err.code,
          message: `${lead}: it couldn't be reached. Check your connection and try again.`,
          ...where,
        };
      const known = JOIN_REFUSAL_MESSAGES[local];
      return {
        kind: "failed",
        code: err.code,
        message: known ? known(host) : `${lead}. It answered ${err.code}.`,
        ...where,
      };
    }
    const vtaCode = vaultOobRefusal(err) ?? refusalCode(err);
    if (vtaCode && flow.at === "join-sign")
      return {
        kind: "failed",
        code: vtaCode,
        message: `${lead}: your agent didn't sign the request (${vtaCode}).`,
        ...where,
      };
    const code =
      (err as { code?: unknown })?.code === OOB_REPLY_INVALID
        ? OOB_REPLY_INVALID
        : SIGN_IN_JOIN_FAILED;
    const cause = code === SIGN_IN_JOIN_FAILED ? errorCause(err) : undefined;
    return {
      kind: "failed",
      code,
      message:
        code === OOB_REPLY_INVALID
          ? `${lead}: its answer didn't check out, so your wallet stopped.`
          : `${lead}: ${err instanceof Error ? err.message : String(err)}`,
      ...where,
      ...(cause ? { cause } : {}),
    };
  }

  // ── domain linkage (route B) ────────────────────────────────────────────────

  /**
   * For a domain-linked contact, confirm the portal origin is linked to its
   * DID by the portal's DIF DID Configuration. Runs once the person has
   * continued and before anything is sent to the contact's services; on
   * failure the flow ends with `domain-not-linked` and nothing is sent. A
   * host-named contact needs no check (the DID names the host).
   */
  private async confirmLinkage(
    flowId: string,
    flow: Flow,
  ): Promise<SignInStepResult | undefined> {
    if (flow.route !== "domain-linked" || flow.linked) return undefined;
    flow.at = "domain-linkage";
    const linkage = await verifyDomainLinkage({
      did: flow.vtcDid,
      didDocument: flow.vtcDocument,
      origin: flow.services.portalOrigin,
      now: this.deps.now(),
      ...(this.deps.fetch ? { fetch: this.deps.fetch } : {}),
    });
    if (linkage.ok) {
      flow.linked = true;
      return undefined;
    }
    this.end(flow);
    this.flows.delete(flowId);
    return {
      kind: "failed",
      code: SIGN_IN_DOMAIN_NOT_LINKED,
      message: DOMAIN_NOT_LINKED_MESSAGE,
      stage: "domain-linkage",
      detail: { reason: SIGN_IN_DOMAIN_NOT_LINKED, did: flow.vtcDid, portalOrigin: flow.services.portalOrigin },
    };
  }

  // ── claim ──────────────────────────────────────────────────────────────────

  private async claim(
    flowId: string,
    flow: Flow,
    entryId: string,
  ): Promise<SignInStepResult> {
    if (flow.phase !== "prepared") throw outOfOrder();
    const entry = flow.identities.find((i) => i.entryId === entryId);
    if (!entry) throw outOfOrder();
    // Route B: after Continue, before the claim (dtgwg-vti-spec #58).
    const unlinked = await this.confirmLinkage(flowId, flow);
    if (unlinked) return unlinked;
    // C3 step 7: only now.
    const kA = newApproverKey();
    flow.kA = kA;
    flow.entry = entry;
    flow.at = "claim";
    const reply = await sendOob<OobStep1>(
      kA,
      buildClaim(kA, flow.vtcDid, flow.link.id),
      this.sendOpts(flow),
      "auth/oob/claim",
    );
    flow.phase = "claimed";
    flow.step1 = checkStep1(reply.payload, {
      requestId: flow.link.id,
      vtcDid: flow.vtcDid,
      portalOrigin: flow.services.portalOrigin,
      now: this.deps.now(),
    });
    const theirs = communityNameMismatch(
      flow.step1.service.name,
      flow.step1.service.did,
      flow.communityName,
      flow.services.portalOrigin,
    );
    return {
      kind: "enter-number",
      decisionDeadline: deadlineMs(flow.step1.decisionDeadline)!,
      // `checkStep1` refused an audience this wallet does not know.
      audience: sessionAudienceOf(flow.step1)!,
      ...(theirs !== undefined ? { nameMismatch: theirs } : {}),
    };
  }

  // ── prove ──────────────────────────────────────────────────────────────────

  private async prove(
    flow: Flow,
    enteredNumber: string,
  ): Promise<SignInStepResult> {
    if (flow.phase !== "claimed" || !flow.kA || !flow.entry || !flow.step1)
      throw outOfOrder();
    const unsigned = buildIdentify(flow.entry.did, flow.vtcDid, {
      requestId: flow.link.id,
      approverKey: flow.kA.did,
      enteredNumber,
    });
    flow.at = "identify";
    const signed = assertSignedAsSent(
      unsigned,
      await flow.vta.signIdentify(flow.entry.entryId, unsigned),
      "authentication",
    );
    flow.at = "prove";
    // 0.2 first: it lets the community offer a signing scope. A community
    // that predates it refuses the type before reading the identify, and the
    // same identify proves at 0.1.
    let version: OobVersion = "0.2";
    let reply: OobReply<OobStep2>;
    try {
      reply = await sendOob<OobStep2>(
        flow.kA,
        buildProve(flow.kA, flow.vtcDid, signed, flow.link.id, "0.2"),
        this.sendOpts(flow),
        "auth/oob/prove",
      );
    } catch (e) {
      if (!(e instanceof OobRefusedError) || !/unsupportedType$/.test(e.code)) throw e;
      version = "0.1";
      reply = await sendOob<OobStep2>(
        flow.kA,
        buildProve(flow.kA, flow.vtcDid, signed, flow.link.id, "0.1"),
        this.sendOpts(flow),
        "auth/oob/prove",
      );
    }
    const step2 = checkStep2(reply.payload, flow.step1, flow.entry.did);
    flow.version = version;
    flow.step2Doc = reply.doc;
    flow.phase = "identified";
    return {
      kind: "review",
      location: step2.requester.location,
      browser: step2.requester.browser,
      os: step2.requester.os,
      createdAt: step2.requester.createdAt,
      network: networkLine(step2.requester.sameNetwork),
      identifiedAs: step2.identifiedAs,
      // `checkStep2` held it equal to step 1's.
      audience: sessionAudienceOf(step2)!,
      ...(step2.signingScope ? { signingScope: step2.signingScope } : {}),
    };
  }

  // ── grant ──────────────────────────────────────────────────────────────────

  private async buildGrantFor(
    flow: Flow,
    decision: OobDecision,
  ): Promise<OobDocument<OobGrantPayload>> {
    const step2 = flow.step2Doc!.payload;
    return buildGrant(flow.entry!.did, flow.vtcDid, {
      requestId: flow.link.id,
      decision,
      sessionKey: step2.sessionKey,
      approverKey: flow.kA!.did,
      origin: step2.origin,
      contextDigest: await contextDigest(flow.step2Doc!),
      // Integer epoch seconds (contract C9).
      notAfter: Math.floor(
        (this.deps.now() + this.deps.grantLifetimeMs) / 1000,
      ),
      // Step 2's scope, unchanged: the member approved exactly what was shown.
      ...(step2.signingScope ? { signingScope: step2.signingScope } : {}),
    }, flow.version ?? "0.1");
  }

  /** Build the unsigned approval and hand its digest to the window for the
   *  passkey ceremony. The grant itself stays here: the window binds a gesture
   *  to a digest, it does not get to supply the document. */
  private async grantChallenge(flow: Flow): Promise<SignInStepResult> {
    if (flow.phase !== "identified" || !flow.kA || !flow.step2Doc)
      throw outOfOrder();
    flow.at = "grant-digest";
    flow.unsignedGrant = await this.buildGrantFor(flow, "approve");
    flow.grantDigest = await grantDigest(flow.unsignedGrant);
    // The ceremony is bound to the UTF-8 bytes of the digest string (C9).
    return {
      kind: "uv-challenge",
      challenge: bytesToBase64url(uvChallengeBytes(flow.grantDigest)),
      vtaDid: flow.vtaDid,
    };
  }

  private async respond(
    flow: Flow,
    decision: OobDecision,
    prfOutputB64u: string | undefined,
  ): Promise<SignInStepResult> {
    if (flow.phase !== "identified" || !flow.kA || !flow.entry)
      throw outOfOrder();
    let unsigned: OobDocument<OobGrantPayload>;
    let uv: { payloadDigest: string; prfOutput: Uint8Array } | undefined;
    if (decision === "approve") {
      if (!flow.unsignedGrant || !flow.grantDigest || !prfOutputB64u)
        throw outOfOrder();
      unsigned = flow.unsignedGrant;
      uv = { payloadDigest: flow.grantDigest, prfOutput: base64urlToBytes(prfOutputB64u) };
      flow.at = "enrol-uv";
      await flow.vta.enrolUvKey(uv.prfOutput);
    } else {
      // A decline needs no user verification (base design §14 step 12).
      unsigned = await this.buildGrantFor(flow, "decline");
    }
    flow.at = "grant";
    const signed = assertSignedAsSent(
      unsigned,
      await flow.vta.signGrant(flow.entry.entryId, unsigned, uv),
      "assertionMethod",
    );
    flow.at = "respond";
    const reply = await sendOob<{ status?: unknown }>(
      flow.kA,
      buildRespond(flow.kA, flow.vtcDid, signed, flow.link.id, flow.version ?? "0.1"),
      this.sendOpts(flow),
      "auth/oob/respond",
    );
    this.end(flow);
    return {
      kind: "done",
      decision,
      status:
        typeof reply.payload?.status === "string" ? reply.payload.status : "ok",
    };
  }

  // ── cancel / end ───────────────────────────────────────────────────────────

  private async cancel(flowId: string, flow: Flow): Promise<SignInStepResult> {
    // K_a exists only once a claim has been sent, so it marks a claim the
    // community may hold — including one whose reply did not check out.
    const held = flow.phase !== "ended" && flow.kA !== undefined;
    const kA = flow.kA;
    // Marked ended first, so a second cancel (the window closing on top of a
    // Decline) sends nothing; the key is wiped only after the cancel is signed.
    flow.phase = "ended";
    this.flows.delete(flowId);
    if (held && kA) {
      await sendOob(
        kA,
        buildCancel(kA, flow.vtcDid, flow.link.id),
        this.sendOpts(flow),
        "auth/oob/cancel",
      ).catch(() => undefined);
    }
    this.end(flow);
    return { kind: "done", decision: "decline", status: "cancelled" };
  }

  /** Discard `K_a`. Never resend after a request has ended (§14 step 13). */
  private end(flow: Flow): void {
    flow.phase = "ended";
    if (flow.kA) flow.kA.privateKey.fill(0);
    delete flow.kA;
  }

  private async fail(
    flowId: string,
    flow: Flow,
    err: unknown,
  ): Promise<SignInStepResult> {
    if ((err as { code?: string })?.code === SIGN_IN_OUT_OF_ORDER) {
      return {
        kind: "failed",
        code: SIGN_IN_OUT_OF_ORDER,
        message: ENDED_MESSAGE,
        party: "wallet",
      };
    }
    // Read before the cancel below, which sends and so could move it.
    const where = failureWhere(flow.at, err);
    // Once K_a exists the flow is spent: a refused claim, proof or response
    // ends the request at the community, and a reply that did not check out
    // is not one to keep talking to. When the community did not refuse (the
    // wallet did), the claim it still holds is cancelled so the portal stops
    // waiting.
    if (flow.kA) {
      const refusedByCommunity = err instanceof OobRefusedError;
      if (refusedByCommunity) {
        this.end(flow);
        this.flows.delete(flowId);
      } else {
        await this.cancel(flowId, flow).catch(() => undefined);
      }
    }
    if (err instanceof OobRefusedError) {
      const local = oobCode(err.code);
      // A DID hosting service admits only DIDs its operator listed, and its
      // refusal of the proof is the one `notAuthorized` for every reason
      // (deliberately: which check failed is not the caller's to learn). The
      // wallet's own VTA signed this proof and the wallet checked it before
      // sending, so the reason left is the access list — say so, and give the
      // member the DID to send.
      if (
        local === "notAuthorized" &&
        flow.at === "prove" &&
        flow.kind === "did-hosting" &&
        flow.entry
      ) {
        const host = hostOf(flow.services.portalOrigin);
        return {
          kind: "failed",
          code: err.code,
          message: notListedMessage(host),
          ...where,
          unlisted: { host, did: flow.entry.did },
        };
      }
      if (local === "alreadyClaimed")
        return {
          kind: "failed",
          code: err.code,
          message: ALREADY_CLAIMED_MESSAGE,
          ...where,
        };
      if (local === "requestExpired") return refused("expired");
      return {
        kind: "failed",
        code: err.code,
        message: `${triggerLinkMessage("invalid")} ${ENDED_MESSAGE}`,
        ...where,
      };
    }
    // The member's own VTA refused to sign: say why, in its stable code (R3.7).
    const vtaCode = vaultOobRefusal(err);
    const vtaMessage = vtaCode ? VTA_REFUSAL_MESSAGES[vtaCode] : undefined;
    if (vtaCode && vtaMessage)
      return { kind: "failed", code: vtaCode, message: vtaMessage, ...where };
    const code =
      (err as { code?: unknown })?.code === OOB_REPLY_INVALID
        ? OOB_REPLY_INVALID
        : "sign-in/failed";
    const cause = code === "sign-in/failed" ? errorCause(err) : undefined;
    return {
      kind: "failed",
      code,
      message: `${triggerLinkMessage("invalid")} ${ENDED_MESSAGE}`,
      ...where,
      ...(cause ? { cause } : {}),
    };
  }

  private sendOpts(flow: Flow) {
    return {
      vtcDid: flow.vtcDid,
      vtcDocument: flow.vtcDocument,
      trustTaskEndpoint: flow.services.trustTaskEndpoint,
      ...(this.deps.fetch ? { fetch: this.deps.fetch } : {}),
    };
  }
}

function outOfOrder(): Error & { code: string } {
  return Object.assign(new Error("this step is not available now"), {
    code: SIGN_IN_OUT_OF_ORDER,
  });
}

/** `OobRefusedError` codes that mean the community was never heard from. */
const UNREACHED: ReadonlySet<string> = new Set(["network", "timeout"]);

/** The exchanges the member's own VTA answers; the rest go to the community. */
const VTA_STAGES: ReadonlySet<SignInFailureStage> = new Set([
  "join-sign",
  "identify",
  "grant",
  "enrol-uv",
]);

/** Which exchange failed and who refused, for the failure's details. A
 *  failure that is not a refusal (the network, a timeout) names no party:
 *  nobody refused, and saying so would send someone after the wrong side. */
function failureWhere(
  at: SignInFailureStage | undefined,
  err: unknown,
): { stage?: SignInFailureStage; party?: SignInFailureParty } {
  const party: SignInFailureParty | undefined =
    err instanceof OobRefusedError
      ? // `sendOob` reports an unreachable community with these two codes:
        // nobody refused.
        UNREACHED.has(err.code)
        ? undefined
        : "community"
      : (err as { code?: unknown })?.code === OOB_REPLY_INVALID
        ? "wallet"
        : vaultOobRefusal(err) !== undefined ||
            (at !== undefined &&
              VTA_STAGES.has(at) &&
              refusalCode(err) !== undefined)
          ? "vta"
          : undefined;
  return { ...(at ? { stage: at } : {}), ...(party ? { party } : {}) };
}

/** A refusal's stable code, wherever the transport put it. */
function refusalCode(err: unknown): string | undefined {
  const e = err as
    | {
        code?: unknown;
        details?: { code?: unknown; details?: { code?: unknown } };
      }
    | undefined;
  return (
    safeCode(e?.details?.details?.code) ??
    safeCode(e?.details?.code) ??
    safeCode(e?.code)
  );
}

/** What lies under the generic `sign-in/failed`: the refusal's own code if it
 *  has one, else the error's name when that says more than "Error". */
function errorCause(err: unknown): string | undefined {
  const code = refusalCode(err);
  if (code) return code;
  const name = (err as { name?: unknown })?.name;
  return name !== "Error" ? safeCode(name) : undefined;
}

/** Fold a name for comparison: trimmed, inner whitespace collapsed, case
 *  folded. "Test  VTC" and "test vtc" are the same name told twice. */
function foldName(name: string): string {
  return name.trim().replace(/\s+/g, " ").toLowerCase();
}

/** The lower-case host of a portal origin, or `undefined` if it is not a URL. */
function portalHost(origin: string): string | undefined {
  try {
    return new URL(origin).hostname.toLowerCase();
  } catch {
    return undefined;
  }
}

/**
 * The community's own name for itself, when it is a different human name
 * from the one this wallet holds (VTI-LNK-104) — else `undefined`.
 *
 * A VTC with no name configured fills `service.name` with its DID
 * (verifiable-trust-infrastructure `oob_tasks.rs`), so an empty name, its own
 * DID, or any `did:` string is the absence of a name rather than a different
 * one, and flagging it would warn every member of an unnamed community on
 * every sign-in — which teaches them to ignore the warning that matters.
 * The host of the verified portal origin is the same: a service that names
 * itself "webvh.storm.ws" has told us nothing the wallet did not verify.
 */
export function communityNameMismatch(
  theirs: unknown,
  serviceDid: unknown,
  ours: string,
  portalOrigin?: string,
): string | undefined {
  if (typeof theirs !== "string") return undefined;
  const trimmed = theirs.trim();
  if (trimmed === "") return undefined;
  if (typeof serviceDid === "string" && trimmed === serviceDid.trim())
    return undefined;
  if (/^did:/i.test(trimmed)) return undefined;
  if (portalOrigin !== undefined && foldName(theirs) === portalHost(portalOrigin))
    return undefined;
  return foldName(theirs) === foldName(ours) ? undefined : theirs;
}
