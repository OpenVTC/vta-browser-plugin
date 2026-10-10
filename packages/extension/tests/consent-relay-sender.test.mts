// The same-browser approver relay sends the approver's decision AS the
// approver.
//
// The VTA acts on a DIDComm document only when its proven signer is the
// authcrypt sender (VTI #1739). The relay carries the approver's
// `task-consent/decision` over the worker's mediator session, so the worker
// sends the outer forward and the approver authcrypts the inner message. Packed
// as the worker, the decision is refused as `identityMismatch`, after the
// human approved it. `buildTaskConsentDecision` refuses that mismatch itself;
// this pins that the relay asks for the right sender.

import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

test("the relay packs the decision as the approver, over the worker's session", () => {
  const offscreen = readFileSync(
    fileURLToPath(new URL("../src/offscreen.ts", import.meta.url)),
    "utf8",
  );
  const fn = /async function maybeRelayConsentLocally\([\s\S]*?\n}\n/.exec(offscreen)?.[0] ?? "";
  assert.ok(fn, "maybeRelayConsentLocally not found");
  const call = /buildTaskConsentDecision\(\{[\s\S]*?\}\);/.exec(fn)?.[0] ?? "";
  assert.ok(call, "the relay no longer builds a decision");
  assert.match(call, /sender: approver\.identity/);
  assert.match(call, /signing: approver\.signing/);
});
