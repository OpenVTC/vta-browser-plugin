// A step-up handed to the person by a `step-up` trigger link (VTI-LNK-125 –
// 131): the wallet's half, in the offscreen document.
//
// Someone acting for the person with a key they delegated — an assistant over
// `vtc-mcp`, say — was refused a gated act. The community gave it a single-use
// handle, and it showed the person a link. The background asks this module to
// read the step-up and, once the person has approved through the approver
// prompt, to answer it:
//
//   read    parse the link (step-up only) → is the community one the wallet
//           holds an identity at (VTI-LNK-128; nothing is sent to one that is
//           not) → resolve and verify its DID document → `requests/show` from
//           a key made for this read (VTI-LNK-054, 129) → the reply's request
//           is the community's, to its subject, unexpired, and bound to the
//           returned operation (VTI-LNK-130) → the subject is one of the
//           wallet's identities there.
//   answer  the approve-response, signed by the person's agent as the subject,
//           sent to the community directly — never back to whoever made the
//           link (VTI-LNK-131).
//
// What the person is shown comes from the community's signed request and the
// operation it returned, and from the wallet's own records — never from the
// link or from the party that made it. Nothing of the link is logged.

import {
  parseTriggerLink,
  contactIdentity,
  CONTACT_METHODS,
  proofPurposeForDocumentType,
  type ContactMethodRegistry,
  type TriggerLinkReason,
} from "@openvtc/pnm-core";
import {
  resolveCommunityDocument,
  selectSignInServices,
  newApproverKey,
  sendOob,
  postCommunityTask,
  assertSignedAsSent,
  buildStepUpShow,
  checkStepUpShown,
  buildStepUpAnswer,
  OobRefusedError,
  StepUpHandoffError,
  type OobDocument,
  type ShownStepUp,
} from "@openvtc/pnm-core/vtc";

import { isEntryFor, type SignInVaultEntry, type SignInVta } from "./sign-in-flows.js";

/** The community's refusal of a handle it cannot answer (requests/show 0.1). */
export const STEP_UP_NOT_FOUND = "auth/step-up/requests/show:notFound";

export interface StepUpFlowDeps {
  /** Epoch milliseconds. */
  now: () => number;
  vta: (vtaDid: string, restBaseUrl?: string) => Pick<SignInVta, "listIdentities" | "signTask">;
  resolveDid?: (did: string) => Promise<unknown>;
  fetch?: typeof fetch;
  contactMethods?: ContactMethodRegistry;
}

/** What the approver prompt shows, and what it is checked against. */
export interface StepUpReadView {
  flowId: string;
  /** The community: its DID, the audience the approver signs for. */
  vtcDid: string;
  /** The name the wallet's own record holds for the identity at that
   *  community — never a name from the link or the community. */
  identityLabel: string;
  /** The portal origin the community's verified document names. */
  portalOrigin: string;
  /** The approve-request payload, as the community signed it. */
  request: ShownStepUp["request"];
  operation: ShownStepUp["operation"];
}

export type StepUpReadResult =
  | { ok: true; view: StepUpReadView }
  | { ok: false; reason: TriggerLinkReason };

export type StepUpAnswerResult = { ok: true } | { ok: false; reason: TriggerLinkReason | "refused"; code?: string };

interface Flow {
  vtaDid: string;
  restBaseUrl?: string;
  vtcDid: string;
  vtcDocument: Record<string, unknown>;
  trustTaskEndpoint: string;
  entry: SignInVaultEntry;
  shown: ShownStepUp;
}

export class StepUpFlows {
  private readonly flows = new Map<string, Flow>();

  constructor(private readonly deps: StepUpFlowDeps) {}

  /** Read the step-up a link names, and check it (VTI-LNK-128 – 130). */
  async read(link: string, vtaDid: string, restBaseUrl?: string): Promise<StepUpReadResult> {
    const methods = this.deps.contactMethods ?? CONTACT_METHODS;
    const parsed = parseTriggerLink(link, { now: Math.floor(this.deps.now() / 1000), contactMethods: methods });
    if (!parsed.ok) return { ok: false, reason: parsed.reason };
    if (!parsed.link.flow) return { ok: false, reason: "untyped" };
    if (parsed.link.flow.spec.name !== "step-up") return { ok: false, reason: "unknown-flow" };
    const vtcDid = contactIdentity(parsed.link.from);

    // VTI-LNK-128: only a service already in the wallet's records, and nothing
    // sent to one that is not. The entries are listed whole and matched here.
    const vta = this.deps.vta(vtaDid, restBaseUrl);
    const entries = (await vta.listIdentities()).filter((e) => isEntryFor(e, vtcDid));
    if (entries.length === 0) return { ok: false, reason: "not-in-records" };

    const resolved = await resolveCommunityDocument(parsed.link.from.value, {
      ...(this.deps.resolveDid ? { resolveDid: this.deps.resolveDid } : {}),
      contactMethods: methods,
    });
    if (!resolved.ok) return { ok: false, reason: resolved.reason };
    const services = selectSignInServices(resolved.doc);
    if (!services.ok) return { ok: false, reason: services.reason };
    const opts = {
      vtcDid,
      vtcDocument: resolved.doc,
      trustTaskEndpoint: services.services.trustTaskEndpoint,
      ...(this.deps.fetch ? { fetch: this.deps.fetch } : {}),
      now: this.deps.now,
    };

    const kA = newApproverKey();
    let shown: ShownStepUp;
    try {
      const reply = await sendOob<Parameters<typeof checkStepUpShown>[0]>(
        kA,
        buildStepUpShow(kA, vtcDid, parsed.link.id),
        opts,
        "step-up request",
        "authentication",
      );
      shown = await checkStepUpShown(reply.payload, {
        vtcDid,
        vtcDocument: resolved.doc,
        now: this.deps.now(),
      });
    } catch (e) {
      if (e instanceof OobRefusedError && e.code === STEP_UP_NOT_FOUND) return { ok: false, reason: "step-up-gone" };
      if (e instanceof OobRefusedError && (e.code === "network" || e.code === "timeout")) {
        return { ok: false, reason: "no-common-transport" };
      }
      if (e instanceof StepUpHandoffError) return { ok: false, reason: e.reason };
      return { ok: false, reason: "did-document-unverified" };
    }

    // VTI-LNK-130: the subject must be an identity the wallet holds there.
    const entry = entries.find((e) => e.principalDid === shown.subject);
    if (!entry) return { ok: false, reason: "not-the-subject" };

    const flowId = globalThis.crypto.randomUUID();
    this.flows.set(flowId, {
      vtaDid,
      ...(restBaseUrl ? { restBaseUrl } : {}),
      vtcDid,
      vtcDocument: resolved.doc,
      trustTaskEndpoint: services.services.trustTaskEndpoint,
      entry,
      shown,
    });
    return {
      ok: true,
      view: {
        flowId,
        vtcDid,
        identityLabel: entry.label,
        portalOrigin: services.services.portalOrigin,
        request: shown.request,
        operation: shown.operation,
      },
    };
  }

  /** The approver's statement, carried in the approve-response the subject's
   *  agent signs, sent to the community (VTI-LNK-131). Ends the flow. */
  async answer(flowId: string, statement: Record<string, unknown>): Promise<StepUpAnswerResult> {
    const flow = this.flows.get(flowId);
    this.flows.delete(flowId);
    if (!flow) return { ok: false, reason: "step-up-gone" };
    if (flow.shown.expiresAt <= this.deps.now()) return { ok: false, reason: "step-up-gone" };
    const unsigned = buildStepUpAnswer(flow.vtcDid, flow.shown, statement);
    const vta = this.deps.vta(flow.vtaDid, flow.restBaseUrl);
    try {
      // Signed for the purpose the agent signs its type for (an approval is an
      // attestation, `assertionMethod`), checked unchanged.
      const signed = assertSignedAsSent(
        unsigned,
        await vta.signTask(flow.entry.id, unsigned),
        proofPurposeForDocumentType(unsigned.type),
      );
      const reply = await postCommunityTask<{ status?: unknown }>(
        signed as OobDocument,
        {
          vtcDid: flow.vtcDid,
          vtcDocument: flow.vtcDocument,
          trustTaskEndpoint: flow.trustTaskEndpoint,
          ...(this.deps.fetch ? { fetch: this.deps.fetch } : {}),
          now: this.deps.now,
        },
        "step-up answer",
        "authentication",
      );
      return reply.payload?.status === "recorded" ? { ok: true } : { ok: false, reason: "refused" };
    } catch (e) {
      return { ok: false, reason: "refused", ...(e instanceof OobRefusedError ? { code: e.code } : {}) };
    }
  }

  /** Forget a flow the person declined or closed. Nothing was sent for it
   *  beyond the read. */
  end(flowId: string): void {
    this.flows.delete(flowId);
  }
}
