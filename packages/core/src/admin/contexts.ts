// Context deletion — the destructive half of context management.
//
// Listing and creating contexts live in `vta/contexts.ts`, because the wallet
// itself needs them (the vault's add-entry form picks a context). Deletion does
// not belong in a wallet at all, so it lives here with the rest of the
// administration surface.
//
// Unlike the `acl/*` family these bodies are **not** camelCase — `vta_sdk`'s
// `context_management::delete` declares no `rename_all`, so the wire is
// snake_case. Both fields happen to be single words, which is exactly the kind
// of coincidence that hides a casing bug until someone adds `dry_run`.

import type { TaskParty, TrustTaskSender } from "../vta/channel.js";
import { buildTrustTask } from "../vta/trust-task.js";

import {
  TYPE_URI as TASK_CONTEXTS_DELETE,
  type VTAContextsDeleteResponsePayload,
} from "@openvtc/trust-tasks/vta/contexts/delete/1.0/payload";
import { TYPE_URI as TASK_CONTEXTS_PREVIEW_DELETE } from "@openvtc/trust-tasks/vta/contexts/preview-delete/1.0/payload";

export interface ContextDeleteParams {
  holder: TaskParty;
  service: TaskParty;
  /** Context id (full path for a nested context). */
  id: string;
  /** Delete even when the context still holds keys or DIDs. Default false. */
  force?: boolean;
}

/** The delete response, from the binding. The hand-written copy omitted
 *  `ext`, which SPEC §4.5.1 lets any agent send. */
export type ContextDeleteResult = VTAContextsDeleteResponsePayload;

/** What deleting a context would destroy, as the agent reports it. */
export interface ContextDeletePreview {
  id: string;
  keys: string[];
  webvhDids: string[];
  /** Subjects whose ACL entry disappears entirely — this context (or the
   *  subtree with it) was the only scope they held. */
  aclEntriesRemoved: string[];
  /** Subjects who keep an entry, with this scope removed from it. */
  aclEntriesUpdated: string[];
  didTemplates: string[];
}

/**
 * What deleting this context would destroy.
 *
 * Worth calling first, every time: the keys and DIDs a context holds do not
 * come back, and `force` exists precisely because the agent refuses to take
 * them with it by accident. Show the operator this list, then delete.
 *
 * **Every array covers the whole subtree**, because the deletion does — the
 * agent counts the sub-contexts' keys, DIDs and grants alongside this
 * context's own. What it does not yet report is *which* sub-contexts those
 * are; `vta/contexts/preview-delete/1.0` has no member for that, so a
 * consumer wanting to name them derives them from the context list.
 *
 * This returned three of the six arrays until now. `aclEntriesRemoved` in
 * particular is the one an operator most needs — it names the subjects about
 * to lose their authority outright — and dropping it here meant no consumer
 * could show it however carefully it was rendered.
 */
export async function contextPreviewDelete(
  sender: TrustTaskSender,
  params: Omit<ContextDeleteParams, "force">,
): Promise<ContextDeletePreview> {
  const envelope = buildTrustTask(
    TASK_CONTEXTS_PREVIEW_DELETE,
    { id: params.id },
    { issuer: params.holder.did, recipient: params.service.did },
  );
  const payload = await sender.send<{
    id: string;
    keys?: string[];
    webvhDids?: string[];
    aclEntriesRemoved?: string[];
    aclEntriesUpdated?: string[];
    didTemplates?: string[];
    /** Pre-fold spellings, still sent by an agent that has not taken the
     *  camelCase change. Accepted on read; never emitted. */
    webvh_dids?: string[];
    acl_entries_removed?: string[];
    acl_entries_updated?: string[];
    did_templates?: string[];
  }>(envelope, {
    expectedResponseType: `${TASK_CONTEXTS_PREVIEW_DELETE}#response`,
    operationLabel: "vta/contexts/preview-delete/1.0",
  });
  return {
    id: payload.id,
    keys: payload.keys ?? [],
    webvhDids: payload.webvhDids ?? payload.webvh_dids ?? [],
    aclEntriesRemoved: payload.aclEntriesRemoved ?? payload.acl_entries_removed ?? [],
    aclEntriesUpdated: payload.aclEntriesUpdated ?? payload.acl_entries_updated ?? [],
    didTemplates: payload.didTemplates ?? payload.did_templates ?? [],
  };
}

/** Delete a context. Irreversible; see {@link contextPreviewDelete} first. */
export async function contextDelete(
  sender: TrustTaskSender,
  params: ContextDeleteParams,
): Promise<ContextDeleteResult> {
  const envelope = buildTrustTask(
    TASK_CONTEXTS_DELETE,
    { id: params.id, force: params.force ?? false },
    { issuer: params.holder.did, recipient: params.service.did },
  );
  const payload = await sender.send<{ id: string; deleted?: boolean }>(envelope, {
    expectedResponseType: `${TASK_CONTEXTS_DELETE}#response`,
    operationLabel: "vta/contexts/delete/1.0",
  });
  return { id: payload.id, deleted: payload.deleted ?? false };
}
