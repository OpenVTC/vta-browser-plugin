// `vta/backup/*` — and the deliberate absence of most of it.
//
// The agent dispatches five verbs: initiate-export, complete-export,
// initiate-import, finalize-import, abort. **This module exposes one.**
//
// ## Why export and import are not here
//
// `initiate-export` and `finalize-import` both carry a `password` member: the
// key-derivation input that protects, or unlocks, a complete copy of the agent
// — every key, ACL and trust context it holds. It travels *inbound*, chosen by
// the caller at the moment of asking.
//
// The specification classifies it `ingests: secret` and annotates it
// `writeOnly`, and it says the part that decides this module's shape: the
// password's exposure is settled by **where it is typed**. A browser form is
// reachable by autofill, by a password manager, by any other extension with
// host access, and by screen capture — none of which this wallet controls, and
// none of which a step-up ceremony reaches. A passkey prompt proves a human is
// present for the action; it proves nothing about the field, which was filled
// in before the prompt appeared.
//
// So this is not a "not yet". Adding an export pane would be a decision to
// collect the agent's master password in the least defensible place available,
// and the CLI already collects it in a better one. Operators export and import
// there.
//
// ## Why `abort` is
//
// It carries no secret — one opaque handle in, a boolean out — and it is the
// only way to close a window that is otherwise open until it expires. An
// operator who realises mid-export that the download went somewhere it should
// not have wants the bundle dead now, and the alternative is waiting out the
// slot with a fetchable copy of the agent live at a known address.
//
// It also unwedges: an agent caps how many bundles one operator may hold open,
// so an abandoned bundle costs a slot until expiry.
//
// ## Why there is no bundle list to abort *from*
//
// There is no enumerate verb in the family — the agent offers no way to ask
// what is in flight. So the caller supplies the id the CLI printed. A picker
// would be nicer and cannot be built without a task that does not exist; the
// UI says so rather than implying the console lost it.

import type { TaskParty, TrustTaskSender } from "../vta/channel.js";
import { buildTrustTask } from "../vta/trust-task.js";

import {
  TYPE_URI as BACKUP_ABORT,
  RESPONSE_TYPE_URI as BACKUP_ABORT_RESPONSE,
  type VTABackupAbortPayload,
  type VTABackupAbortResponsePayload,
} from "@openvtc/trust-tasks/vta/backup/abort/1.0/payload";

/** Issued by an operator identity, to the agent holding the bundle. */
export interface BackupCallerParams {
  /** Envelope `issuer`. Must be the identity that initiated the bundle —
   *  the agent checks, and answers a mismatch as not-found rather than as a
   *  refusal, so that a stranger cannot learn a bundle exists by guessing. */
  holder: TaskParty;
  /** The agent — envelope `recipient`. */
  service: TaskParty;
}

export interface BackupAbortParams extends BackupCallerParams {
  /** Handle from an initiate-export or initiate-import descriptor. Either kind
   *  is accepted; the agent already knows which it holds. */
  bundleId: string;
}

/** What the agent did, which is not always what was asked. */
export interface BackupAbortResult {
  bundleId: string;
  /** `false` means the bundle was already terminal — completed, expired, or
   *  aborted by an earlier attempt. A success, not a failure: abort is
   *  idempotent precisely because the situation it exists for (a dropped
   *  connection, an operator unsure whether the cancel landed) is the one that
   *  produces duplicates. Callers should render it as "already closed" rather
   *  than as an error. */
  aborted: boolean;
}

/**
 * Cancel an in-flight export or import bundle and discard its staged bytes.
 *
 * Destructive and irreversible for the bundle: on the export side the
 * encrypted copy is deleted and cannot be re-minted — a new export re-serialises
 * the agent and produces different bytes.
 */
export async function backupAbort(
  sender: TrustTaskSender,
  params: BackupAbortParams,
): Promise<BackupAbortResult> {
  const payload: VTABackupAbortPayload = { bundleId: params.bundleId };
  const envelope = buildTrustTask(BACKUP_ABORT, payload, {
    issuer: params.holder.did,
    recipient: params.service.did,
  });
  const res = await sender.send<VTABackupAbortResponsePayload>(envelope, {
    expectedResponseType: BACKUP_ABORT_RESPONSE,
    operationLabel: "vta/backup/abort/1.0",
  });
  return { bundleId: res.bundleId, aborted: res.aborted };
}
