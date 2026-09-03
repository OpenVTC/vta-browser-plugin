/// <reference types="chrome" />

// The console's `TrustTaskSender` — the chrome-facing half.
//
// All the reasoning about what may cross the bridge, and what a consent refusal
// means, lives in `carrier.ts`, which is free of relative imports so it can be
// unit-tested in plain Node. This file is the wiring: put the two permitted
// members on a runtime message, and interpret what comes back.
//
// What routing through the wallet's own relay buys, with no change to
// `offscreen.ts`: transport selection and fallback (TSP > DIDComm > REST),
// `TransportHealth` recording, outbound signing, and the same-browser approver
// ceremony on a `consentRequired`.

import type { SendOpts, TrustTask, TrustTaskSender } from "@openvtc/pnm-core";
import { RUNTIME_MANAGER_TASK, type RuntimeManagerTaskResponse } from "../bridge-protocol.js";
import { sendToBackground } from "../send-message.js";
import { carrierParams, interpretOutcome } from "./carrier.js";

/**
 * A `TrustTaskSender` backed by the wallet's runtime bridge.
 *
 * Stateless and cheap — construct one per pane or share one, it makes no
 * difference. The session it ultimately runs on is the offscreen document's
 * warm one, pooled there and shared with the wallet's own traffic.
 */
export class ManagerTaskSender implements TrustTaskSender {
  async send<Res>(envelope: TrustTask<unknown>, opts?: SendOpts): Promise<Res> {
    const reply = await sendToBackground<RuntimeManagerTaskResponse>({
      type: RUNTIME_MANAGER_TASK,
      // The carrier is unpacked here and nowhere else.
      params: carrierParams(envelope),
    });
    return interpretOutcome<Res>(
      envelope.type,
      opts?.operationLabel ?? envelope.type,
      reply,
    );
  }
}

/** One shared instance; the class holds nothing worth having twice. */
export const managerSender = new ManagerTaskSender();
