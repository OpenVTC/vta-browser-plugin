// DID templates — `vta/did-templates/*` at 2.0.
//
// A template is the shape an agent stamps DIDs from: the document skeleton plus
// the variables a caller must supply. Managing them is operator work, and
// `didTemplateRender` is the safe way to find out what a template would produce
// before anything is published — the same substitution the agent would perform,
// with nothing created.
//
// **2.0, not 1.0.** Both exist in the bindings; `vta-sdk` declares only the 2.0
// URIs, so that is what the agent answers. The conformance test would catch the
// mistake, but it is worth knowing that a 1.0 import here compiles fine and
// fails at the agent.
//
// Scope is part of a record's identity, not decoration: a template is `builtin`,
// `global`, or bound to one `context`. Passing `contextId` on these calls scopes
// the operation to that context's templates; omitting it addresses the global
// set. The two are different namespaces, and a name can exist in both.

import type { Identity } from "../didcomm/index.js";
import type { TrustTaskSender } from "../vta/channel.js";
import type { RemoteDidcommEndpoint } from "../vta/didcomm.js";
import { buildTrustTask } from "../vta/trust-task.js";

import {
  TYPE_URI as TPL_CREATE,
  RESPONSE_TYPE_URI as TPL_CREATE_RESPONSE,
  type VTADIDTemplateCreatePayload,
  type DidTemplate,
  type DidTemplateRecord,
} from "@openvtc/trust-tasks/vta/did-templates/create/2.0/payload";
import {
  TYPE_URI as TPL_GET,
  RESPONSE_TYPE_URI as TPL_GET_RESPONSE,
  type VTADIDTemplateGetPayload,
} from "@openvtc/trust-tasks/vta/did-templates/get/2.0/payload";
import {
  TYPE_URI as TPL_LIST,
  RESPONSE_TYPE_URI as TPL_LIST_RESPONSE,
  type VTADIDTemplateListPayload,
  type VTADIDTemplateListResponsePayload,
} from "@openvtc/trust-tasks/vta/did-templates/list/2.0/payload";
import {
  TYPE_URI as TPL_UPDATE,
  RESPONSE_TYPE_URI as TPL_UPDATE_RESPONSE,
  type VTADIDTemplateUpdatePayload,
} from "@openvtc/trust-tasks/vta/did-templates/update/2.0/payload";
import {
  TYPE_URI as TPL_DELETE,
  RESPONSE_TYPE_URI as TPL_DELETE_RESPONSE,
  type VTADIDTemplateDeletePayload,
  type VTADIDTemplateDeleteResponsePayload,
} from "@openvtc/trust-tasks/vta/did-templates/delete/2.0/payload";
import {
  TYPE_URI as TPL_RENDER,
  RESPONSE_TYPE_URI as TPL_RENDER_RESPONSE,
  type VTADIDTemplateRenderPayload,
  type VTADIDTemplateRenderResponsePayload,
} from "@openvtc/trust-tasks/vta/did-templates/render/2.0/payload";

export type { DidTemplate, DidTemplateRecord };

export interface DidTemplateCallerParams {
  holder: Identity;
  service: RemoteDidcommEndpoint;
  /** Scope the call to one context's templates. Omit for the global set —
   *  a different namespace, in which the same name may also exist. */
  contextId?: string;
}

export interface DidTemplateCreateParams extends DidTemplateCallerParams {
  template: DidTemplate;
}

/** Create a template. */
export async function didTemplateCreate(
  sender: TrustTaskSender,
  params: DidTemplateCreateParams,
): Promise<DidTemplateRecord> {
  const payload: VTADIDTemplateCreatePayload = {
    ...(params.contextId ? { contextId: params.contextId } : {}),
    template: params.template,
  };
  const envelope = buildTrustTask(TPL_CREATE, payload, {
    issuer: params.holder.did,
    recipient: params.service.did,
  });
  return sender.send<DidTemplateRecord>(envelope, {
    expectedResponseType: TPL_CREATE_RESPONSE,
    operationLabel: "vta/did-templates/create/2.0",
  });
}

export interface DidTemplateNameParams extends DidTemplateCallerParams {
  name: string;
}

/** Fetch one template, document skeleton included. */
export async function didTemplateGet(
  sender: TrustTaskSender,
  params: DidTemplateNameParams,
): Promise<DidTemplateRecord> {
  const payload: VTADIDTemplateGetPayload = {
    ...(params.contextId ? { contextId: params.contextId } : {}),
    name: params.name,
  };
  const envelope = buildTrustTask(TPL_GET, payload, {
    issuer: params.holder.did,
    recipient: params.service.did,
  });
  return sender.send<DidTemplateRecord>(envelope, {
    expectedResponseType: TPL_GET_RESPONSE,
    operationLabel: "vta/did-templates/get/2.0",
  });
}

/** List templates in scope. */
export async function didTemplateList(
  sender: TrustTaskSender,
  params: DidTemplateCallerParams,
): Promise<DidTemplateRecord[]> {
  const payload: VTADIDTemplateListPayload = {
    ...(params.contextId ? { contextId: params.contextId } : {}),
  };
  const envelope = buildTrustTask(TPL_LIST, payload, {
    issuer: params.holder.did,
    recipient: params.service.did,
  });
  const res = await sender.send<VTADIDTemplateListResponsePayload>(envelope, {
    expectedResponseType: TPL_LIST_RESPONSE,
    operationLabel: "vta/did-templates/list/2.0",
  });
  return res.templates ?? [];
}

export interface DidTemplateUpdateParams extends DidTemplateNameParams {
  /** The replacement. This is a whole-template write, not a patch — anything
   *  omitted from `template` is omitted from the stored record. */
  template: DidTemplate;
}

/** Replace a template. */
export async function didTemplateUpdate(
  sender: TrustTaskSender,
  params: DidTemplateUpdateParams,
): Promise<DidTemplateRecord> {
  const payload: VTADIDTemplateUpdatePayload = {
    ...(params.contextId ? { contextId: params.contextId } : {}),
    name: params.name,
    template: params.template,
  };
  const envelope = buildTrustTask(TPL_UPDATE, payload, {
    issuer: params.holder.did,
    recipient: params.service.did,
  });
  return sender.send<DidTemplateRecord>(envelope, {
    expectedResponseType: TPL_UPDATE_RESPONSE,
    operationLabel: "vta/did-templates/update/2.0",
  });
}

/** Delete a template. Reports `deleted: false` for one that was not there. */
export async function didTemplateDelete(
  sender: TrustTaskSender,
  params: DidTemplateNameParams,
): Promise<VTADIDTemplateDeleteResponsePayload> {
  const payload: VTADIDTemplateDeletePayload = {
    ...(params.contextId ? { contextId: params.contextId } : {}),
    name: params.name,
  };
  const envelope = buildTrustTask(TPL_DELETE, payload, {
    issuer: params.holder.did,
    recipient: params.service.did,
  });
  return sender.send<VTADIDTemplateDeleteResponsePayload>(envelope, {
    expectedResponseType: TPL_DELETE_RESPONSE,
    operationLabel: "vta/did-templates/delete/2.0",
  });
}

export interface DidTemplateRenderParams extends DidTemplateNameParams {
  /** Values for the template's variables. */
  vars?: Record<string, unknown>;
}

/**
 * Render a template without creating anything.
 *
 * The agent performs the same substitution it would when stamping a real DID
 * and hands back the resulting document. Show this to an operator before they
 * commit: a template is a thing that will be published under their identity,
 * and reading the rendered document is the only way to see what that means.
 */
export async function didTemplateRender(
  sender: TrustTaskSender,
  params: DidTemplateRenderParams,
): Promise<VTADIDTemplateRenderResponsePayload["document"]> {
  const payload: VTADIDTemplateRenderPayload = {
    ...(params.contextId ? { contextId: params.contextId } : {}),
    name: params.name,
    ...(params.vars !== undefined ? { vars: params.vars } : {}),
  };
  const envelope = buildTrustTask(TPL_RENDER, payload, {
    issuer: params.holder.did,
    recipient: params.service.did,
  });
  const res = await sender.send<VTADIDTemplateRenderResponsePayload>(envelope, {
    expectedResponseType: TPL_RENDER_RESPONSE,
    operationLabel: "vta/did-templates/render/2.0",
  });
  return res.document;
}
