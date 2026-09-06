// Shared plumbing for the `persona/*` calls in this directory.

import type { TaskParty, TrustTaskSender } from "../vta/channel.js";
import { buildTrustTask } from "../vta/trust-task.js";

/** Every `persona/*` call this wallet makes is issued by an identity, to an
 *  agent, inside one trust context. */
export interface PersonaCallerParams {
  /** Envelope `issuer` — the wallet's holder identity. */
  holder: TaskParty;
  /** The agent — envelope `recipient`. */
  service: TaskParty;
  /**
   * The trust context this call acts in.
   *
   * Required on every task in this module, and not a filter: the agent refuses
   * a context-scoped persona task that does not name the context, and refuses
   * a caller not authorized in the one it names. Two contexts holding the same
   * persona DID hold two unrelated bindings.
   */
  contextId: string;
}

export async function call<Req, Res>(
  sender: TrustTaskSender,
  caller: Pick<PersonaCallerParams, "holder" | "service">,
  type: string,
  responseType: string,
  label: string,
  payload: Req,
): Promise<Res> {
  const envelope = buildTrustTask(type, payload, {
    issuer: caller.holder.did,
    recipient: caller.service.did,
  });
  return sender.send<Res>(envelope, {
    expectedResponseType: responseType,
    operationLabel: label,
  });
}
