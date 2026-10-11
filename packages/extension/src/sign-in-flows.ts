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
//   grant    the grant digest goes to the passkey (C6); the VTA signs the grant
//            with that decision; `respond` carries it. K_a is then discarded.
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
//   - anything else (a VTC, `VTCRest`): not one of your communities. Joining
//     a VTC is its own application process, and this window does not run it.
//
// Declining or closing at that point sends nothing to the site.
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
  type ParsedTriggerLink,
  type TriggerLinkReason,
  type SigningIdentity,
  type AuthenticatorAssertionResponseLogin,
  type WebauthnUvKeyEnrolment,
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
  OobRefusedError,
  OOB_REPLY_INVALID,
  type OobDocument,
  type OobStep1,
  type OobStep2,
  type OobGrantPayload,
  type OobDecision,
  type SignInServices,
} from "@openvtc/pnm-core/vtc";
import type {
  SignInFailureParty,
  SignInFailureStage,
  SignInIdentityView,
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
   *  the grant digest D and the passkey's assertion over it; the caller wraps
   *  them in the device-signed `task-consent/decision/0.2` the VTA requires. */
  signGrant(
    entryId: string,
    unsigned: OobDocument,
    uv?: {
      payloadDigest: string;
      assertion: AuthenticatorAssertionResponseLogin;
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
  /** `device/heartbeat` ext `org.openvtc.uv-key`, over the device's session. */
  enrolUvKey(enrolment: WebauthnUvKeyEnrolment): Promise<void>;
  /**
   * Make sure this browser is registered as one of the member's devices at
   * the VTA (`device/register`, once per holder). The VTA signs sign-in
   * documents only for an enrolled device, so this runs before anything is
   * sent to the community; a failure here is not final, because signing
   * `identify` registers and retries once on `oobNotEnrolledDevice`.
   */
  ensureDevice?(): Promise<void>;
  /** The credential id of the UV passkey the VTA holds for this browser's
   *  current holder, if this wallet enrolled one there. */
  enrolledUvCredential?(): Promise<string | undefined>;
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
export type SiteKind = "did-hosting" | "other";

/** The service type a DID hosting service publishes (affinidi-webvh-service
 *  `add_webvh_hosting_service`, the VTA's `did-host-http` templates). It is
 *  also what a VTA's `servers add` reads to accept a server as a DID host. */
export const WEBVH_HOSTING_SERVICE_TYPE = "WebVHHosting";

/** Read from the **verified** document, matched on `type` (VTI-LNK-053). */
export function siteKindOf(doc: unknown): SiteKind {
  const services = (doc as { service?: unknown })?.service;
  if (!Array.isArray(services)) return "other";
  const hosting = services.some((s) => {
    const t = (s as { type?: unknown } | null)?.type;
    return t === WEBVH_HOSTING_SERVICE_TYPE || (Array.isArray(t) && t.includes(WEBVH_HOSTING_SERVICE_TYPE));
  });
  return hosting ? "did-hosting" : "other";
}

/** The host of an origin, for a sentence ("Use <host> …"). */
function hostOf(origin: string): string {
  try {
    return new URL(origin).hostname || origin;
  } catch {
    return origin;
  }
}

/** The last segment of a refusal code: `auth/oob/claim:alreadyClaimed` →
 *  `alreadyClaimed`. The services send the family-qualified code (C9); the
 *  segment after the colon is the stable name within it. */
function oobCode(code: string): string {
  return code.slice(code.lastIndexOf(":") + 1);
}

interface Flow {
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
  kA?: SigningIdentity;
  entry?: SignInIdentityView;
  step1?: OobStep1;
  step2Doc?: OobDocument<OobStep2>;
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
    "Your agent doesn't hold this browser's sign-in passkey yet. " +
    "Refresh the code on the website and approve again to set it up.",
  [OOB_UV_INVALID]:
    "Your agent didn't accept the passkey approval. Refresh the code on the website and try again.",
};

const refused = (reason: TriggerLinkReason): SignInStepResult => {
  const outcome = outcomeOf(reason);
  // `pass-on` never reaches a flow: the background does not open one for it.
  const shown = outcome === "pass-on" ? "invalid" : outcome;
  return {
    kind: "refused",
    outcome: shown,
    message: triggerLinkMessage(shown)!,
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
        case "claim":
          return await this.claim(req.flowId, flow, req.entryId);
        case "prove":
          return await this.prove(flow, req.enteredNumber);
        case "grant-digest":
          return await this.grantChallenge(flow);
        case "enrol-uv":
          if (flow.phase !== "identified") throw outOfOrder();
          flow.at = "enrol-uv";
          await flow.vta.enrolUvKey(req.enrolment);
          return { kind: "uv-enrolled" };
        case "respond":
          return await this.respond(
            flow,
            req.decision,
            req.decision === "approve" ? req.assertion : undefined,
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
    if (!parsed.ok) return refused(parsed.reason);
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
    if (!resolved.ok) return refused(resolved.reason);
    const selected = selectSignInServices(resolved.doc);
    if (!selected.ok) return refused(selected.reason);

    // C3 step 4: the page the link was clicked on must be the portal.
    if (!origin || !originMatchesPortal(origin, selected.services.portalOrigin))
      return refused("wrong-origin");

    const kind = siteKindOf(resolved.doc);
    if (identities.length === 0) {
      const { portalOrigin } = selected.services;
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
    if (flow.phase !== "joining") throw outOfOrder();
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
    const reply = await sendOob<OobStep2>(
      flow.kA,
      buildProve(flow.kA, flow.vtcDid, signed, flow.link.id),
      this.sendOpts(flow),
      "auth/oob/prove",
    );
    const step2 = checkStep2(reply.payload, flow.step1, flow.entry.did);
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
    });
  }

  /** Build the unsigned approval and hand its digest to the window for the
   *  passkey. The grant itself stays here: the window signs a digest, it does
   *  not get to supply the document. */
  private async grantChallenge(flow: Flow): Promise<SignInStepResult> {
    if (flow.phase !== "identified" || !flow.kA || !flow.step2Doc)
      throw outOfOrder();
    flow.at = "grant-digest";
    flow.unsignedGrant = await this.buildGrantFor(flow, "approve");
    flow.grantDigest = await grantDigest(flow.unsignedGrant);
    // Which passkey the VTA holds for this device, so the window enrols this
    // browser's passkey first when it holds none (or another).
    const uvCredentialId = await flow.vta
      .enrolledUvCredential?.()
      .catch(() => undefined);
    // The passkey signs the UTF-8 bytes of the digest string (contract C9).
    return {
      kind: "uv-challenge",
      challenge: bytesToBase64url(uvChallengeBytes(flow.grantDigest)),
      ...(uvCredentialId ? { uvCredentialId } : {}),
    };
  }

  private async respond(
    flow: Flow,
    decision: OobDecision,
    assertion: AuthenticatorAssertionResponseLogin | undefined,
  ): Promise<SignInStepResult> {
    if (flow.phase !== "identified" || !flow.kA || !flow.entry)
      throw outOfOrder();
    let unsigned: OobDocument<OobGrantPayload>;
    let uv:
      | {
          payloadDigest: string;
          assertion: AuthenticatorAssertionResponseLogin;
        }
      | undefined;
    if (decision === "approve") {
      if (!flow.unsignedGrant || !flow.grantDigest || !assertion)
        throw outOfOrder();
      unsigned = flow.unsignedGrant;
      uv = { payloadDigest: flow.grantDigest, assertion };
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
      buildRespond(flow.kA, flow.vtcDid, signed, flow.link.id),
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

/**
 * The community's own name for itself, when it is a different human name
 * from the one this wallet holds (VTI-LNK-104) — else `undefined`.
 *
 * A VTC with no name configured fills `service.name` with its DID
 * (verifiable-trust-infrastructure `oob_tasks.rs`), so an empty name, its own
 * DID, or any `did:` string is the absence of a name rather than a different
 * one, and flagging it would warn every member of an unnamed community on
 * every sign-in — which teaches them to ignore the warning that matters.
 */
export function communityNameMismatch(
  theirs: unknown,
  serviceDid: unknown,
  ours: string,
): string | undefined {
  if (typeof theirs !== "string") return undefined;
  const trimmed = theirs.trim();
  if (trimmed === "") return undefined;
  if (typeof serviceDid === "string" && trimmed === serviceDid.trim())
    return undefined;
  if (/^did:/i.test(trimmed)) return undefined;
  return foldName(theirs) === foldName(ours) ? undefined : theirs;
}
