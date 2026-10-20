// Settings → Advanced → "Sign-in approval", rendered.
//
// Pinned: each agent shows its approval method; changing a PIN asks for the
// current one and the new one twice; switching from a PIN to the phone asks
// for the current PIN, from anything else it does not; a wrong current PIN
// says the tries left; no phone known says how to connect one.

import { test } from "node:test";
import assert from "node:assert/strict";
import { h, render } from "./harness/dom.mjs";
import { SignInApprovalSettings } from "../src/sign-in-approval-settings.js";
import type { RuntimeUvSettingsResponse, UvSettingsAgent, UvSettingsOp } from "../src/bridge-protocol.js";

const A = "did:webvh:QmA:agent-a.example";
const B = "did:webvh:QmB:agent-b.example";

function agent(agents: UvSettingsAgent[], answer: (op: UvSettingsOp) => RuntimeUvSettingsResponse | undefined = () => undefined) {
  const ops: UvSettingsOp[] = [];
  const send = async (op: UvSettingsOp): Promise<RuntimeUvSettingsResponse> => {
    ops.push(op);
    if (op.op === "status") return { ok: true, result: { op: "status", agents } };
    const a = answer(op);
    if (a) return a;
    if (op.op === "approvers") return { ok: true, result: { op: "approvers", approvers: [{ did: "did:key:z6MkPhone", displayName: "Alice's iPhone" }] } };
    if (op.op === "use-pin") return { ok: true, result: { op: "use-pin", agent: { vtaDid: op.vtaDid, method: "vtaPin" } } };
    return { ok: true, result: { op: "use-phone", agent: { vtaDid: op.vtaDid, method: "remoteApprover", approver: op.approver } } };
  };
  return { ops, send };
}

type Screen = Awaited<ReturnType<typeof render>>;
const within = (screen: Screen, i: number, id: string) =>
  screen.all('[data-testid="uv-agent"]')[i]!.querySelector(`[data-testid="${id}"]`) as HTMLElement | null;
const $ = (screen: Screen, id: string) => screen.container.querySelector(`[data-testid="${id}"]`) as HTMLElement | null;

test("each agent shows how this browser approves there", async () => {
  const { send } = agent([{ vtaDid: A, method: "vtaPin" }, { vtaDid: B }]);
  const screen = await render(h(SignInApprovalSettings, { send }));
  await screen.settle();
  assert.equal(within(screen, 0, "uv-method")!.textContent, "PIN");
  assert.match(within(screen, 1, "uv-method")!.textContent!, /Not set up/);
  assert.equal(within(screen, 0, "uv-to-pin")!.textContent, "Change PIN");
  assert.equal(within(screen, 1, "uv-to-pin")!.textContent, "Switch to PIN");
  await screen.unmount();
});

test("changing the PIN: the current one, the new one twice", async () => {
  const { ops, send } = agent([{ vtaDid: A, method: "vtaPin" }]);
  const screen = await render(h(SignInApprovalSettings, { send }));
  await screen.settle();
  await screen.click(within(screen, 0, "uv-to-pin")!);
  const save = () => $(screen, "uv-save") as HTMLButtonElement;
  await screen.type($(screen, "new-pin")!, "new passphrase");
  await screen.type($(screen, "new-pin-again")!, "new passphrase");
  assert.equal(save().disabled, true, "the current PIN first");
  await screen.type($(screen, "current-pin")!, "246810");
  assert.equal(save().disabled, false);
  await screen.click(save());
  await screen.settle();
  assert.deepEqual(ops.at(-1), { op: "use-pin", vtaDid: A, newPin: "new passphrase", currentPin: "246810" });
  assert.equal($(screen, "uv-status")!.textContent, "PIN changed.");
  await screen.unmount();
});

test("a wrong current PIN says how many tries are left", async () => {
  const { send } = agent([{ vtaDid: A, method: "vtaPin" }], (op) =>
    op.op === "use-phone" ? { ok: false, error: "device:uvPinWrong", code: "uvPinWrong", attemptsRemaining: 3 } : undefined,
  );
  const screen = await render(h(SignInApprovalSettings, { send }));
  await screen.settle();
  await screen.click(within(screen, 0, "uv-to-phone")!);
  await screen.settle();
  await screen.type($(screen, "current-pin")!, "000000");
  await screen.click($(screen, "uv-save")!);
  await screen.settle();
  assert.equal($(screen, "uv-status")!.textContent, "Wrong PIN. 3 tries left before it locks.");
  assert.equal(within(screen, 0, "uv-method")!.textContent, "PIN", "unchanged");
  await screen.unmount();
});

test("from a passkey to the phone: no PIN asked, the phone picked", async () => {
  const { ops, send } = agent([{ vtaDid: A, method: "prfSealedKey" }]);
  const screen = await render(h(SignInApprovalSettings, { send }));
  await screen.settle();
  assert.equal(within(screen, 0, "uv-method")!.textContent, "Passkey");
  await screen.click(within(screen, 0, "uv-to-phone")!);
  await screen.settle();
  assert.equal($(screen, "current-pin"), null);
  assert.match(screen.text(), /Alice's iPhone/);
  await screen.click($(screen, "uv-save")!);
  await screen.settle();
  assert.deepEqual(ops.at(-1), { op: "use-phone", vtaDid: A, approver: "did:key:z6MkPhone" });
  assert.match(within(screen, 0, "uv-method")!.textContent!, /Your phone/);
  assert.equal(within(screen, 0, "uv-to-phone"), null, "already the phone");
  await screen.unmount();
});

test("no phone known: says how to connect one", async () => {
  const { send } = agent([{ vtaDid: A }], (op) =>
    op.op === "approvers" ? { ok: true, result: { op: "approvers", approvers: [] } } : undefined,
  );
  const screen = await render(h(SignInApprovalSettings, { send }));
  await screen.settle();
  await screen.click(within(screen, 0, "uv-to-phone")!);
  await screen.settle();
  assert.match($(screen, "no-phones")!.textContent!, /make that phone this browser's approver/);
  assert.equal(($(screen, "uv-save") as HTMLButtonElement).disabled, true);
  await screen.unmount();
});

test("a phone the agent will not let approve, and a change without the PIN, are said plainly", async () => {
  const { send } = agent([{ vtaDid: A, method: "prfSealedKey" }], (op) =>
    op.op === "use-phone" ? { ok: false, error: "device/heartbeat refused: uvApproverNotPermitted", code: "uvApproverNotPermitted" } : undefined,
  );
  const screen = await render(h(SignInApprovalSettings, { send }));
  await screen.settle();
  await screen.click(within(screen, 0, "uv-to-phone")!);
  await screen.settle();
  await screen.click($(screen, "uv-save")!);
  await screen.settle();
  assert.match($(screen, "uv-status")!.textContent!, /ask an administrator of the agent to make that phone this browser's approver/);
  await screen.unmount();
});
