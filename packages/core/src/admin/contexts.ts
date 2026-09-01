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

const TASK_CONTEXTS_DELETE = "https://trusttasks.org/spec/vta/contexts/delete/1.0";
const TASK_CONTEXTS_PREVIEW_DELETE =
  "https://trusttasks.org/spec/vta/contexts/preview-delete/1.0";

export interface ContextDeleteParams {
  holder: TaskParty;
  service: TaskParty;
  /** Context id (full path for a nested context). */
  id: string;
  /** Delete even when the context still holds keys or DIDs. Default false. */
  force?: boolean;
}

export interface ContextDeleteResult {
  id: string;
  deleted: boolean;
}

/**
 * What deleting this context would destroy.
 *
 * Worth calling first, every time: the keys and DIDs a context holds do not
 * come back, and `force` exists precisely because the agent refuses to take
 * them with it by accident. Show the operator this list, then delete.
 */
export async function contextPreviewDelete(
  sender: TrustTaskSender,
  params: Omit<ContextDeleteParams, "force">,
): Promise<{ id: string; keys: string[]; webvhDids: string[] }> {
  const envelope = buildTrustTask(
    TASK_CONTEXTS_PREVIEW_DELETE,
    { id: params.id },
    { issuer: params.holder.did, recipient: params.service.did },
  );
  const payload = await sender.send<{
    id: string;
    keys?: string[];
    webvhDids?: string[];
    /** Pre-fold spelling, still sent by an agent that has not taken the
     *  camelCase change. Accepted on read; never emitted. */
    webvh_dids?: string[];
  }>(envelope, {
    expectedResponseType: `${TASK_CONTEXTS_PREVIEW_DELETE}#response`,
    operationLabel: "vta/contexts/preview-delete/1.0",
  });
  return {
    id: payload.id,
    keys: payload.keys ?? [],
    webvhDids: payload.webvhDids ?? payload.webvh_dids ?? [],
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
