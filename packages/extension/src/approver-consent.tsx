/// <reference types="chrome" />

// The step-up approver's prompt — the last screen before the wallet's approver
// for a community signs a statement.
//
// It is the APPROVER surface (red, biometric-gated), not the worker one: the
// statement is the user's own re-authentication, and one gesture commits it.
// Approve runs a fresh user-verification WebAuthn gesture; its PRF output is
// what unwraps the approver key, so nothing is signed without it, and a
// cancelled gesture leaves the window open rather than counting as a refusal.
//
// What is drawn, and from where:
//
//   - **The community** (the audience) — the relying party the page's origin is
//     pinned to; the background refused anything else before opening this.
//   - **The operation** — type and payload, rendered whole. This is the one
//     part that is *checked*: the background recomputed the request's `boundTo`
//     from exactly this operation, so the statement can bind nothing else.
//   - **The reason** — the community's words, carried by the page. Nobody has
//     verified it, and it is labelled so; the operation is the truth.

import { useEffect, useState } from "react";
import { base64url } from "@openvtc/vti-didcomm-js";

import {
  APPROVER_CONSENT_PREFIX,
  approverGestureBinding,
  renderOperationPayload,
  type ApproverConsentRequest,
} from "./approver-policy.js";
import { runApproverUnlockCeremony } from "./webauthn-prf-unlock.js";
import { Did } from "./ui.js";

function taskLabel(typeUri: string): string {
  const m = /\/spec\/(.+)\/[\d.]+$/.exec(typeUri);
  return m?.[1] ?? typeUri;
}

function originHost(o: string): string {
  try {
    return new URL(o).host;
  } catch {
    return o;
  }
}

const label: React.CSSProperties = {
  fontSize: 10.5,
  fontWeight: 700,
  letterSpacing: 0.6,
  textTransform: "uppercase",
  color: "var(--w-muted)",
  marginBottom: 4,
};

const card: React.CSSProperties = {
  border: "1px solid var(--w-line)",
  borderRadius: 6,
  padding: 10,
  background: "var(--w-raised)",
};

export function ApproverConsent({
  consentId,
  decide,
}: {
  consentId: string;
  decide: (approved: boolean, prfOutputB64u?: string) => void;
}) {
  const [request, setRequest] = useState<ApproverConsentRequest | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    void chrome.storage.session
      .get(`${APPROVER_CONSENT_PREFIX}${consentId}`)
      .then((v: Record<string, unknown>) => {
        setRequest((v[`${APPROVER_CONSENT_PREFIX}${consentId}`] as ApproverConsentRequest) ?? null);
      });
  }, [consentId]);

  if (!request) {
    return <div style={{ padding: 20, fontSize: 13 }}>Loading request…</div>;
  }

  async function approve(req: ApproverConsentRequest): Promise<void> {
    setBusy(true);
    setError(null);
    try {
      const { prfOutput } = await runApproverUnlockCeremony(
        chrome.runtime.id,
        approverGestureBinding(req),
      );
      decide(true, base64url.encode(prfOutput));
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  }

  const heading =
    request.kind === "stepUp"
      ? "Approve this action with your approver?"
      : request.kind === "enrol"
        ? "Enrol this wallet's approver?"
        : "Set up step-up approval in this wallet?";

  return (
    <div
      style={{
        padding: 20,
        background: "var(--w-danger-wash)",
        minHeight: "100vh",
        color: "var(--w-text)",
        fontSize: 13,
      }}
    >
      <div
        style={{
          display: "flex",
          alignItems: "center",
          gap: 10,
          background: "var(--w-danger-soft)",
          color: "var(--w-danger)",
          padding: "11px 16px",
          margin: "-20px -20px 16px",
          borderBottom: "3px solid var(--w-danger)",
        }}
      >
        <span style={{ fontSize: 20, lineHeight: 1 }} aria-hidden>
          🛡️
        </span>
        <div style={{ display: "grid", gap: 1 }}>
          <span style={{ fontSize: 12, fontWeight: 800, letterSpacing: 1.2 }}>APPROVER MODE</span>
          <span style={{ fontSize: 11, opacity: 0.85 }}>
            You are re-authenticating — read it before you approve
          </span>
        </div>
      </div>

      <div style={{ display: "grid", gap: 14 }}>
        <strong style={{ fontSize: 14 }}>{heading}</strong>

        <div>
          <div style={label}>Community</div>
          <Did value={request.audience} />
          <div style={{ fontSize: 11, color: "var(--w-muted)", marginTop: 4 }}>
            Asked from <strong>{originHost(request.origin)}</strong>, which you signed in to this
            community from.
          </div>
        </div>

        {request.kind === "stepUp" && request.operation ? (
          <>
            {request.reason ? (
              <div>
                <div style={label}>The community's reason (not verified by the wallet)</div>
                <div style={{ ...card, whiteSpace: "pre-wrap", wordBreak: "break-word" }}>
                  {request.reason}
                </div>
              </div>
            ) : null}
            <div>
              <div style={label}>The action this approves — and nothing else</div>
              <div style={card}>
                <code style={{ fontSize: 12 }}>{taskLabel(request.operation.type)}</code>
                <div
                  style={{ fontSize: 10.5, color: "var(--w-muted)", wordBreak: "break-all", marginTop: 2 }}
                >
                  {request.operation.type}
                </div>
                <pre
                  style={{
                    margin: "8px 0 0",
                    maxHeight: 220,
                    overflow: "auto",
                    fontSize: 11,
                    whiteSpace: "pre-wrap",
                    wordBreak: "break-all",
                  }}
                >
                  {renderOperationPayload(request.operation.payload)}
                </pre>
              </div>
            </div>
          </>
        ) : null}

        {request.kind === "enrol" ? (
          <div style={{ color: "var(--w-muted)", lineHeight: 1.45 }}>
            This proves to the community that this wallet holds the approver below, so it can be
            bound to you as a step-up factor. Bound to{" "}
            <code style={{ fontSize: 11, wordBreak: "break-all" }}>{request.boundTo}</code>.
          </div>
        ) : null}

        {request.kind === "setup" ? (
          <div style={{ color: "var(--w-muted)", lineHeight: 1.45 }}>
            This creates the key that protects this wallet's step-up approvers — one per
            community, so communities cannot recognise you by it. It signs nothing.
          </div>
        ) : null}

        {request.subject ? (
          <div>
            <div style={label}>On behalf of</div>
            <Did value={request.subject} />
          </div>
        ) : null}

        {request.approverDid ? (
          <div>
            <div style={label}>Approver (this wallet, for this community only)</div>
            <Did value={request.approverDid} />
          </div>
        ) : null}

        {error ? (
          <div style={{ color: "var(--w-danger)", fontSize: 12, lineHeight: 1.4 }}>
            Not signed: {error}
          </div>
        ) : null}

        <div style={{ display: "flex", gap: 8, justifyContent: "flex-end", marginTop: 4 }}>
          <button autoFocus onClick={() => decide(false)} style={{ padding: "8px 16px", fontSize: 13 }}>
            Deny
          </button>
          <button
            disabled={busy}
            onClick={() => void approve(request)}
            style={{
              padding: "8px 18px",
              fontSize: 13,
              fontWeight: 700,
              border: "none",
              borderRadius: 8,
              color: "var(--w-accent-ink)",
              background: "var(--w-danger)",
              opacity: busy ? 0.45 : 1,
              cursor: busy ? "not-allowed" : "pointer",
            }}
          >
            {busy ? "Waiting for authenticator…" : "Approve with biometric"}
          </button>
        </div>
      </div>
    </div>
  );
}
