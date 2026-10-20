/// <reference types="chrome" />

// Settings → Advanced → "Sign-in approval": how this browser approves wallet
// sign-ins at each agent it is connected to, and changing that.
//
// The kinds are the agent's UV key kinds for this device: a passkey
// (`prfSealedKey`), a PIN the agent checks (`vtaPin`), or the person's phone
// (`remoteApprover`). Changing away from a PIN needs the current PIN: the
// agent will not replace it otherwise, and counts a wrong one against the same
// lock as a sign-in. Everything goes through the background to the offscreen
// document (`RUNTIME_UV_SETTINGS`); a PIN is sent once per change and kept in
// this page's state only until the change is sent.

import { useEffect, useState } from "react";

import {
  RUNTIME_UV_SETTINGS,
  type RuntimeUvSettingsResponse,
  type SignInUvApproverView,
  type SignInUvMethod,
  type UvSettingsAgent,
  type UvSettingsOp,
} from "./bridge-protocol.js";
import { sendToBackground } from "./send-message.js";
import { DEVICE_UV_REFUSAL_MESSAGES, UV_APPROVER_HELP } from "./sign-in-uv-messages.js";

const PIN_MIN = 6;

export type UvSettingsSend = (op: UvSettingsOp) => Promise<RuntimeUvSettingsResponse>;

const defaultSend: UvSettingsSend = (op) =>
  sendToBackground<RuntimeUvSettingsResponse>({ type: RUNTIME_UV_SETTINGS, ...op });

export const METHOD_LABEL: Readonly<Record<SignInUvMethod, string>> = {
  prfSealedKey: "Passkey",
  vtaPin: "PIN",
  remoteApprover: "Your phone",
};

const box: React.CSSProperties = {
  marginTop: 16,
  padding: 14,
  border: "1px solid var(--w-line)",
  borderRadius: 8,
  background: "var(--w-surface)",
};
const input: React.CSSProperties = {
  width: "100%",
  boxSizing: "border-box",
  padding: "7px 10px",
  background: "var(--w-ground)",
  color: "var(--w-text)",
  border: "1px solid var(--w-line)",
  borderRadius: 6,
  fontSize: 13,
};
const smallButton: React.CSSProperties = {
  padding: "6px 12px",
  background: "none",
  color: "var(--w-accent)",
  border: "1px solid var(--w-line)",
  borderRadius: 6,
  cursor: "pointer",
  fontSize: 12,
  fontWeight: 600,
};

/** A refusal in words: a wrong PIN with the tries left, or the lock. */
export function refusalText(res: Extract<RuntimeUvSettingsResponse, { ok: false }>): string {
  if (res.code === "uvPinWrong") {
    const left = res.attemptsRemaining;
    return left === undefined
      ? "Wrong PIN."
      : `Wrong PIN. ${left === 1 ? "1 try" : `${left} tries`} left before it locks.`;
  }
  if (res.code === "uvKeyLocked") {
    return res.lockedUntil !== undefined
      ? `Too many wrong PINs. Locked until ${new Date(res.lockedUntil).toLocaleString()}.`
      : "Too many wrong PINs. Try again later.";
  }
  return (res.code && DEVICE_UV_REFUSAL_MESSAGES[res.code]) ?? res.error;
}

type Editing =
  | { vtaDid: string; to: "vtaPin" }
  | { vtaDid: string; to: "remoteApprover"; approvers?: SignInUvApproverView[]; error?: string };

export function SignInApprovalSettings({ send = defaultSend }: { send?: UvSettingsSend }) {
  const [agents, setAgents] = useState<UvSettingsAgent[] | undefined>();
  const [loadError, setLoadError] = useState<string | undefined>();
  const [editing, setEditing] = useState<Editing | undefined>();
  const [currentPin, setCurrentPin] = useState("");
  const [newPin, setNewPin] = useState("");
  const [newPinAgain, setNewPinAgain] = useState("");
  const [approver, setApprover] = useState("");
  const [busy, setBusy] = useState(false);
  const [status, setStatus] = useState<{ tone: "ok" | "danger"; text: string } | undefined>();

  useEffect(() => {
    void (async () => {
      const res = await send({ op: "status" }).catch((e: unknown) => ({
        ok: false as const,
        error: e instanceof Error ? e.message : String(e),
      }));
      if (res.ok && res.result.op === "status") setAgents(res.result.agents);
      else if (!res.ok) setLoadError(res.error);
    })();
  }, [send]);

  const clear = () => {
    setCurrentPin("");
    setNewPin("");
    setNewPinAgain("");
    setApprover("");
  };

  const start = async (e: Editing) => {
    clear();
    setStatus(undefined);
    setEditing(e);
    if (e.to !== "remoteApprover") return;
    const res = await send({ op: "approvers", vtaDid: e.vtaDid }).catch((err: unknown) => ({
      ok: false as const,
      error: err instanceof Error ? err.message : String(err),
    }));
    const approvers = res.ok && res.result.op === "approvers" ? res.result.approvers : [];
    if (approvers.length === 1) setApprover(approvers[0]!.did);
    setEditing({ ...e, approvers, ...(res.ok ? {} : { error: res.error }) });
  };

  const submit = async (agent: UvSettingsAgent) => {
    if (!editing) return;
    const fromPin = agent.method === "vtaPin";
    const op: UvSettingsOp =
      editing.to === "vtaPin"
        ? { op: "use-pin", vtaDid: agent.vtaDid, newPin, ...(fromPin ? { currentPin } : {}) }
        : { op: "use-phone", vtaDid: agent.vtaDid, approver, ...(fromPin ? { currentPin } : {}) };
    clear();
    setBusy(true);
    setStatus(undefined);
    try {
      const res = await send(op);
      if (!res.ok) {
        setStatus({ tone: "danger", text: refusalText(res) });
        return;
      }
      if (res.result.op === "use-pin" || res.result.op === "use-phone") {
        const next = res.result.agent;
        setAgents((list) => list?.map((a) => (a.vtaDid === next.vtaDid ? next : a)));
        setStatus({
          tone: "ok",
          text: editing.to === "vtaPin" ? (fromPin ? "PIN changed." : "PIN set.") : "Your phone approves sign-ins now.",
        });
        setEditing(undefined);
      }
    } catch (e) {
      setStatus({ tone: "danger", text: e instanceof Error ? e.message : String(e) });
    } finally {
      setBusy(false);
    }
  };

  return (
    <div style={box} data-testid="sign-in-approval">
      <strong style={{ fontSize: 14, color: "var(--w-text)" }}>Sign-in approval</strong>
      <div style={{ marginTop: 8, fontSize: 12, color: "var(--w-muted)", lineHeight: 1.5 }}>
        How this browser approves a website sign-in at each of your agents: a passkey, a PIN your
        agent checks, or your phone. Without a passkey that works here, choose a PIN or your phone.
      </div>
      {loadError && (
        <div style={{ marginTop: 8, fontSize: 12, color: "var(--w-danger)" }}>{loadError}</div>
      )}
      {agents?.length === 0 && (
        <div style={{ marginTop: 8, fontSize: 12, color: "var(--w-muted)" }}>
          Connect to an agent first.
        </div>
      )}
      {agents?.map((agent) => {
        const open = editing?.vtaDid === agent.vtaDid ? editing : undefined;
        const fromPin = agent.method === "vtaPin";
        const pinOk = newPin.normalize("NFC").length >= PIN_MIN && newPin === newPinAgain;
        const ready =
          !busy &&
          (!fromPin || currentPin.length > 0) &&
          (open?.to === "vtaPin" ? pinOk : approver.length > 0);
        return (
          <div
            key={agent.vtaDid}
            data-testid="uv-agent"
            style={{ marginTop: 12, paddingTop: 10, borderTop: "1px solid var(--w-line)" }}
          >
            <code style={{ fontSize: 11, color: "var(--w-muted)", wordBreak: "break-all" }}>
              {agent.vtaDid}
            </code>
            <div data-testid="uv-method" style={{ marginTop: 4, fontSize: 13, color: "var(--w-text)" }}>
              {agent.method ? METHOD_LABEL[agent.method] : "Not set up. Your first sign-in approval sets it up."}
              {agent.approver && (
                <code style={{ marginLeft: 6, fontSize: 11, color: "var(--w-muted)", wordBreak: "break-all" }}>
                  {agent.approver}
                </code>
              )}
            </div>
            {!open && (
              <div style={{ display: "flex", gap: 8, marginTop: 8, flexWrap: "wrap" }}>
                <button
                  type="button"
                  data-testid="uv-to-pin"
                  style={smallButton}
                  onClick={() => void start({ vtaDid: agent.vtaDid, to: "vtaPin" })}
                >
                  {fromPin ? "Change PIN" : "Switch to PIN"}
                </button>
                {agent.method !== "remoteApprover" && (
                  <button
                    type="button"
                    data-testid="uv-to-phone"
                    style={smallButton}
                    onClick={() => void start({ vtaDid: agent.vtaDid, to: "remoteApprover" })}
                  >
                    Switch to phone approval
                  </button>
                )}
              </div>
            )}
            {open && (
              <div style={{ display: "grid", gap: 6, marginTop: 8, maxWidth: 360 }}>
                {fromPin && (
                  <input
                    type="password"
                    data-testid="current-pin"
                    placeholder="Current PIN"
                    autoComplete="off"
                    style={input}
                    value={currentPin}
                    onChange={(e) => setCurrentPin(e.target.value)}
                  />
                )}
                {open.to === "vtaPin" ? (
                  <>
                    <input
                      type="password"
                      data-testid="new-pin"
                      placeholder={`New PIN (${PIN_MIN} or more characters)`}
                      autoComplete="off"
                      style={input}
                      value={newPin}
                      onChange={(e) => setNewPin(e.target.value)}
                    />
                    <input
                      type="password"
                      data-testid="new-pin-again"
                      placeholder="New PIN again"
                      autoComplete="off"
                      style={input}
                      value={newPinAgain}
                      onChange={(e) => setNewPinAgain(e.target.value)}
                    />
                    {newPinAgain.length > 0 && newPin !== newPinAgain && (
                      <small style={{ color: "var(--w-danger)" }}>The two PINs don't match.</small>
                    )}
                  </>
                ) : open.approvers === undefined ? (
                  <small style={{ color: "var(--w-muted)" }}>Asking your agent for your phone…</small>
                ) : open.approvers.length === 0 ? (
                  <small data-testid="no-phones" style={{ color: "var(--w-warn)", lineHeight: 1.5 }}>
                    {UV_APPROVER_HELP}
                    {open.error ? ` (${open.error})` : ""}
                  </small>
                ) : (
                  open.approvers.map((a) => (
                    <label key={a.did} style={{ display: "flex", gap: 8, alignItems: "center", fontSize: 13 }}>
                      <input
                        type="radio"
                        name={`approver-${agent.vtaDid}`}
                        data-testid="approver"
                        checked={approver === a.did}
                        onChange={() => setApprover(a.did)}
                      />
                      <span>
                        {a.displayName ?? "Phone"}{" "}
                        <code style={{ fontSize: 11, color: "var(--w-muted)" }}>{a.did}</code>
                      </span>
                    </label>
                  ))
                )}
                <div style={{ display: "flex", gap: 8, marginTop: 4 }}>
                  <button
                    type="button"
                    data-testid="uv-save"
                    disabled={!ready}
                    style={{ ...smallButton, opacity: ready ? 1 : 0.5 }}
                    onClick={() => void submit(agent)}
                  >
                    {busy ? "Working…" : open.to === "vtaPin" ? "Save PIN" : "Use this phone"}
                  </button>
                  <button
                    type="button"
                    data-testid="uv-cancel"
                    style={smallButton}
                    onClick={() => {
                      clear();
                      setEditing(undefined);
                    }}
                  >
                    Cancel
                  </button>
                </div>
              </div>
            )}
          </div>
        );
      })}
      {status && (
        <div
          data-testid="uv-status"
          style={{ marginTop: 10, fontSize: 12, color: status.tone === "ok" ? "var(--w-ok)" : "var(--w-danger)" }}
        >
          {status.text}
        </div>
      )}
    </div>
  );
}
