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
//            verify its DID document (allowed before the tap only because it
//            is known, VTI-LNK-051) → the clicked page's origin must be the
//            portal's (VTI-LNK-105) → "Sign in to <name> at <origin>?"
//   claim    the member chose an identity and pressed Continue. Only now is
//            K_a generated and anything sent to the community (C3 step 7).
//   prove    the typed number, and `identify` signed by the VTA.
//   review   step 2: where the request came from.
//   grant    the grant digest goes to the passkey (C6); the VTA signs the grant
//            with that decision; `respond` carries it. K_a is then discarded.
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
    uv?: { payloadDigest: string; assertion: AuthenticatorAssertionResponseLogin },
  ): Promise<unknown>;
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

type Phase = "prepared" | "claimed" | "identified" | "ended";

interface Flow {
  phase: Phase;
  link: ParsedTriggerLink;
  vta: SignInVta;
  vtcDid: string;
  vtcDocument: Record<string, unknown>;
  services: SignInServices;
  communityName: string;
  identities: SignInIdentityView[];
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
  return { kind: "refused", outcome: shown, message: triggerLinkMessage(shown)! };
};

export class SignInFlows {
  private readonly flows = new Map<string, Flow>();
  constructor(private readonly deps: SignInFlowDeps) {}

  /** Whether a flow is still held (for tests and for the abort path). */
  has(flowId: string): boolean {
    return this.flows.has(flowId);
  }

  async step(
    req: { flowId: string; vtaDid: string; restBaseUrl?: string; link?: string; origin?: string } & SignInStep,
  ): Promise<SignInStepResult> {
    if (req.step === "prepare") return this.prepare(req.flowId, req.link, req.origin, req.vtaDid, req.restBaseUrl);
    const flow = this.flows.get(req.flowId);
    if (!flow || flow.phase === "ended") {
      return { kind: "failed", code: SIGN_IN_OUT_OF_ORDER, message: ENDED_MESSAGE };
    }
    try {
      switch (req.step) {
        case "claim":
          return await this.claim(flow, req.entryId);
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
          return await this.respond(flow, req.decision, req.decision === "approve" ? req.assertion : undefined);
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
    if (this.flows.has(flowId)) return { kind: "failed", code: SIGN_IN_OUT_OF_ORDER, message: ENDED_MESSAGE };
    // C3 step 1, parsed again here: the background's parse chose the window,
    // this one is the one the flow acts on.
    const parsed = parseTriggerLink(linkText ?? "", { now: Math.floor(this.deps.now() / 1000) });
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
    if (identities.length === 0) {
      const contactLabel = contactDomainLabel(link.from);
      return { kind: "not-member", ...(contactLabel ? { contactLabel } : {}) };
    }

    // C3 step 3: resolve and verify, afresh.
    const resolved = await resolveCommunityDocument(vtcDid, {
      ...(this.deps.resolveDid ? { resolveDid: this.deps.resolveDid } : {}),
    });
    if (!resolved.ok) return refused(resolved.reason);
    const selected = selectSignInServices(resolved.doc);
    if (!selected.ok) return refused(selected.reason);

    // C3 step 4: the page the link was clicked on must be the portal.
    if (!origin || !originMatchesPortal(origin, selected.services.portalOrigin)) return refused("wrong-origin");

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
    });
    return { kind: "confirm", communityName, portalOrigin: selected.services.portalOrigin, identities };
  }

  // ── claim ──────────────────────────────────────────────────────────────────

  private async claim(flow: Flow, entryId: string): Promise<SignInStepResult> {
    if (flow.phase !== "prepared") throw outOfOrder();
    const entry = flow.identities.find((i) => i.entryId === entryId);
    if (!entry) throw outOfOrder();
    // C3 step 7: only now.
    const kA = newApproverKey();
    flow.kA = kA;
    flow.entry = entry;
    flow.at = "claim";
    const reply = await sendOob<OobStep1>(kA, buildClaim(kA, flow.vtcDid, flow.link.id), this.sendOpts(flow), "auth/oob/claim");
    flow.phase = "claimed";
    flow.step1 = checkStep1(reply.payload, {
      requestId: flow.link.id,
      vtcDid: flow.vtcDid,
      portalOrigin: flow.services.portalOrigin,
      now: this.deps.now(),
    });
    const theirs = communityNameMismatch(flow.step1.service.name, flow.step1.service.did, flow.communityName);
    return {
      kind: "enter-number",
      decisionDeadline: deadlineMs(flow.step1.decisionDeadline)!,
      ...(theirs !== undefined ? { nameMismatch: theirs } : {}),
    };
  }

  // ── prove ──────────────────────────────────────────────────────────────────

  private async prove(flow: Flow, enteredNumber: string): Promise<SignInStepResult> {
    if (flow.phase !== "claimed" || !flow.kA || !flow.entry || !flow.step1) throw outOfOrder();
    const unsigned = buildIdentify(flow.entry.did, flow.vtcDid, {
      requestId: flow.link.id,
      approverKey: flow.kA.did,
      enteredNumber,
    });
    flow.at = "identify";
    const signed = assertSignedAsSent(unsigned, await flow.vta.signIdentify(flow.entry.entryId, unsigned), "authentication");
    flow.at = "prove";
    const reply = await sendOob<OobStep2>(flow.kA, buildProve(flow.kA, flow.vtcDid, signed, flow.link.id), this.sendOpts(flow), "auth/oob/prove");
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
    };
  }

  // ── grant ──────────────────────────────────────────────────────────────────

  private async buildGrantFor(flow: Flow, decision: OobDecision): Promise<OobDocument<OobGrantPayload>> {
    const step2 = flow.step2Doc!.payload;
    return buildGrant(flow.entry!.did, flow.vtcDid, {
      requestId: flow.link.id,
      decision,
      sessionKey: step2.sessionKey,
      approverKey: flow.kA!.did,
      origin: step2.origin,
      contextDigest: await contextDigest(flow.step2Doc!),
      // Integer epoch seconds (contract C9).
      notAfter: Math.floor((this.deps.now() + this.deps.grantLifetimeMs) / 1000),
    });
  }

  /** Build the unsigned approval and hand its digest to the window for the
   *  passkey. The grant itself stays here: the window signs a digest, it does
   *  not get to supply the document. */
  private async grantChallenge(flow: Flow): Promise<SignInStepResult> {
    if (flow.phase !== "identified" || !flow.kA || !flow.step2Doc) throw outOfOrder();
    flow.at = "grant-digest";
    flow.unsignedGrant = await this.buildGrantFor(flow, "approve");
    flow.grantDigest = await grantDigest(flow.unsignedGrant);
    // Which passkey the VTA holds for this device, so the window enrols this
    // browser's passkey first when it holds none (or another).
    const uvCredentialId = await flow.vta.enrolledUvCredential?.().catch(() => undefined);
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
    if (flow.phase !== "identified" || !flow.kA || !flow.entry) throw outOfOrder();
    let unsigned: OobDocument<OobGrantPayload>;
    let uv: { payloadDigest: string; assertion: AuthenticatorAssertionResponseLogin } | undefined;
    if (decision === "approve") {
      if (!flow.unsignedGrant || !flow.grantDigest || !assertion) throw outOfOrder();
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
    const reply = await sendOob<{ status?: unknown }>(flow.kA, buildRespond(flow.kA, flow.vtcDid, signed, flow.link.id), this.sendOpts(flow), "auth/oob/respond");
    this.end(flow);
    return { kind: "done", decision, status: typeof reply.payload?.status === "string" ? reply.payload.status : "ok" };
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
      await sendOob(kA, buildCancel(kA, flow.vtcDid, flow.link.id), this.sendOpts(flow), "auth/oob/cancel").catch(
        () => undefined,
      );
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

  private async fail(flowId: string, flow: Flow, err: unknown): Promise<SignInStepResult> {
    if ((err as { code?: string })?.code === SIGN_IN_OUT_OF_ORDER) {
      return { kind: "failed", code: SIGN_IN_OUT_OF_ORDER, message: ENDED_MESSAGE, party: "wallet" };
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
      if (err.code === "alreadyClaimed") return { kind: "failed", code: err.code, message: ALREADY_CLAIMED_MESSAGE, ...where };
      if (err.code === "requestExpired") return refused("expired");
      return { kind: "failed", code: err.code, message: `${triggerLinkMessage("invalid")} ${ENDED_MESSAGE}`, ...where };
    }
    // The member's own VTA refused to sign: say why, in its stable code (R3.7).
    const vtaCode = vaultOobRefusal(err);
    const vtaMessage = vtaCode ? VTA_REFUSAL_MESSAGES[vtaCode] : undefined;
    if (vtaCode && vtaMessage) return { kind: "failed", code: vtaCode, message: vtaMessage, ...where };
    const code = (err as { code?: unknown })?.code === OOB_REPLY_INVALID ? OOB_REPLY_INVALID : "sign-in/failed";
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
  return Object.assign(new Error("this step is not available now"), { code: SIGN_IN_OUT_OF_ORDER });
}

/** `OobRefusedError` codes that mean the community was never heard from. */
const UNREACHED: ReadonlySet<string> = new Set(["network", "timeout"]);

/** The exchanges the member's own VTA answers; the rest go to the community. */
const VTA_STAGES: ReadonlySet<SignInFailureStage> = new Set(["identify", "grant", "enrol-uv"]);

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
        : vaultOobRefusal(err) !== undefined || (at !== undefined && VTA_STAGES.has(at) && refusalCode(err) !== undefined)
          ? "vta"
          : undefined;
  return { ...(at ? { stage: at } : {}), ...(party ? { party } : {}) };
}

/** A refusal's stable code, wherever the transport put it. */
function refusalCode(err: unknown): string | undefined {
  const e = err as { code?: unknown; details?: { code?: unknown; details?: { code?: unknown } } } | undefined;
  return safeCode(e?.details?.details?.code) ?? safeCode(e?.details?.code) ?? safeCode(e?.code);
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
export function communityNameMismatch(theirs: unknown, serviceDid: unknown, ours: string): string | undefined {
  if (typeof theirs !== "string") return undefined;
  const trimmed = theirs.trim();
  if (trimmed === "") return undefined;
  if (typeof serviceDid === "string" && trimmed === serviceDid.trim()) return undefined;
  if (/^did:/i.test(trimmed)) return undefined;
  return foldName(theirs) === foldName(ours) ? undefined : theirs;
}
