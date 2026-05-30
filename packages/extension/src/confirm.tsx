/// <reference types="chrome" />

import { StrictMode, useEffect, useState } from "react";
import { createRoot } from "react-dom/client";
import {
  RUNTIME_CONSENT_RESULT,
  RUNTIME_VERIFY_RP_DID,
  type RuntimeVerifyRpDidResponse,
  type VerifyRpDidResult,
} from "./bridge-protocol.js";

// Consent prompt shown in a popup window before the wallet logs into an RP.
// The background opens it with the request details as query params and
// awaits a RUNTIME_CONSENT_RESULT message keyed by `cid`.
//
// After render, the popup asks the background to resolve + verify the rpDid
// and shows a verification badge. did:webvh resolution is cryptographic
// (SCID + hash chain + every log proof) — a green ✓ means the RP's identity
// has been verified against its hosted log, not just "the page told us so".

const params = new URLSearchParams(window.location.search);
const consentId = params.get("cid") ?? "";
const origin = params.get("origin") ?? "";
// May be absent for page-initiated actions (e.g. `vaultList()`) that have
// no specific relying party — the RP card + resolution are then omitted.
const rpDid = params.get("rpDid");
const holderDid = params.get("holder");
// When present, this prompt is an RP-initiated action to confirm (inbound),
// not an outbound login.
const action = params.get("action");
// M5: when set, the rpDid this origin previously used. Render a
// louder warning so the operator sees the swap and decides
// whether to approve it.
const changedFromRpDid = params.get("changedFrom");

function decide(approved: boolean): void {
  chrome.runtime.sendMessage({ type: RUNTIME_CONSENT_RESULT, consentId, approved });
  window.close();
}

function originHostname(o: string): string | undefined {
  try {
    return new URL(o).hostname;
  } catch {
    return undefined;
  }
}

type OriginMatch = "match" | "subdomain" | "mismatch" | "not-applicable";

function compareOriginToDomain(
  originHost: string | undefined,
  domain: string | undefined,
): OriginMatch {
  if (!domain) return "not-applicable";
  if (!originHost) return "mismatch";
  if (originHost === domain) return "match";
  if (originHost.endsWith(`.${domain}`)) return "subdomain";
  return "mismatch";
}

// ─── Visual primitives ───
// Co-located rather than spun out into separate files because the confirm
// popup is a single screen and the styles are only used here.

const colours = {
  bg: "#f6f7f9",
  card: "#ffffff",
  border: "#e3e5ea",
  text: "#1d1f24",
  textMuted: "#6b7280",
  textSubtle: "#9aa0a6",
  primary: "#1f6feb",
  primaryHover: "#1959c4",
  ok: "#1f8a4c",
  okBg: "#e9f7ef",
  warn: "#a87015",
  warnBg: "#fff5e1",
  danger: "#b3261e",
  dangerBg: "#fdecea",
  mono: "ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, monospace",
};

function Badge({
  tone,
  children,
}: {
  tone: "ok" | "warn" | "danger" | "neutral";
  children: React.ReactNode;
}) {
  const palette = {
    ok: { fg: colours.ok, bg: colours.okBg, border: "#bfe5cd" },
    warn: { fg: colours.warn, bg: colours.warnBg, border: "#f1d9a6" },
    danger: { fg: colours.danger, bg: colours.dangerBg, border: "#f1b8b3" },
    neutral: { fg: colours.textMuted, bg: "#eef0f3", border: "#dadde3" },
  }[tone];
  return (
    <span
      style={{
        display: "inline-flex",
        alignItems: "center",
        gap: 4,
        padding: "2px 8px",
        borderRadius: 10,
        fontSize: 11,
        fontWeight: 600,
        background: palette.bg,
        color: palette.fg,
        border: `1px solid ${palette.border}`,
        lineHeight: 1.4,
        whiteSpace: "nowrap",
      }}
    >
      {children}
    </span>
  );
}

function shortenDid(did: string): string {
  // did:peer:2.E…V…S… is huge — show the first ~16 and last ~10 chars so the
  // operator can sanity-check both ends without the full string wrapping six
  // lines. The expand toggle reveals the full identifier when they need it.
  if (did.length <= 48) return did;
  return `${did.slice(0, 22)}…${did.slice(-12)}`;
}

function DidField({
  label,
  value,
  rightSlot,
}: {
  label: string;
  value: string;
  rightSlot?: React.ReactNode;
}) {
  const [expanded, setExpanded] = useState(false);
  const [copied, setCopied] = useState(false);
  const longish = value.length > 48;

  async function copy() {
    try {
      await navigator.clipboard.writeText(value);
      setCopied(true);
      window.setTimeout(() => setCopied(false), 1200);
    } catch {
      // Clipboard can fail in restricted contexts; silently swallow — the
      // operator can still select the text manually.
    }
  }

  return (
    <div style={{ marginBottom: 12 }}>
      <div
        style={{
          display: "flex",
          alignItems: "center",
          justifyContent: "space-between",
          marginBottom: 4,
          gap: 8,
        }}
      >
        <span style={{ color: colours.textMuted, fontSize: 11, fontWeight: 600, letterSpacing: 0.3, textTransform: "uppercase" }}>
          {label}
        </span>
        {rightSlot}
      </div>
      <div
        style={{
          fontFamily: colours.mono,
          fontSize: 11.5,
          lineHeight: 1.5,
          background: "#f3f4f6",
          border: `1px solid ${colours.border}`,
          borderRadius: 6,
          padding: "8px 10px",
          wordBreak: "break-all",
          color: colours.text,
        }}
        title={value}
      >
        {expanded || !longish ? value : shortenDid(value)}
      </div>
      <div style={{ display: "flex", gap: 12, marginTop: 4 }}>
        {longish && (
          <button
            type="button"
            onClick={() => setExpanded((v) => !v)}
            style={linkButtonStyle}
          >
            {expanded ? "Show less" : "Show full"}
          </button>
        )}
        <button type="button" onClick={copy} style={linkButtonStyle}>
          {copied ? "Copied ✓" : "Copy"}
        </button>
      </div>
    </div>
  );
}

const linkButtonStyle: React.CSSProperties = {
  background: "none",
  border: "none",
  padding: 0,
  color: colours.primary,
  cursor: "pointer",
  fontSize: 11,
  fontWeight: 600,
};

// ─── Verification badge ───
// Renders the "is this RP DID resolvable + consistent with the page origin"
// status. State machine: pending → ok/warn/error.

type VerificationState =
  | { kind: "pending" }
  | { kind: "ok"; result: VerifyRpDidResult; originMatch: OriginMatch }
  | { kind: "warn"; result: VerifyRpDidResult; originMatch: OriginMatch }
  | { kind: "error"; message: string };

function VerificationBadge({ state }: { state: VerificationState }) {
  if (state.kind === "pending") {
    return <Badge tone="neutral">Verifying…</Badge>;
  }
  if (state.kind === "error") {
    return <Badge tone="danger">Verification failed</Badge>;
  }
  if (state.kind === "warn") {
    return <Badge tone="warn">Resolved · origin mismatch</Badge>;
  }
  // ok
  if (state.originMatch === "not-applicable") {
    return <Badge tone="ok">Resolved ✓</Badge>;
  }
  return <Badge tone="ok">Resolved · origin matches ✓</Badge>;
}

function VerificationDetails({
  state,
  originHost,
}: {
  state: VerificationState;
  originHost: string | undefined;
}) {
  if (state.kind === "pending") {
    return (
      <p style={{ margin: 0, fontSize: 11.5, color: colours.textMuted }}>
        Resolving the relying-party DID and verifying its log…
      </p>
    );
  }
  if (state.kind === "error") {
    return (
      <p style={{ margin: 0, fontSize: 11.5, color: colours.danger }}>
        Could not resolve this DID: {state.message}
      </p>
    );
  }
  const { result, originMatch } = state;
  const lines: React.ReactNode[] = [];
  lines.push(
    <span key="method" style={{ color: colours.textMuted }}>
      Method: <strong style={{ color: colours.text }}>did:{result.method}</strong>
      {result.method === "webvh" && " — log chain + proofs verified"}
      {(result.method === "peer" || result.method === "key") && " — self-certifying identifier"}
    </span>,
  );
  if (result.domain) {
    lines.push(
      <span key="domain" style={{ color: colours.textMuted }}>
        Domain: <strong style={{ color: colours.text, fontFamily: colours.mono }}>{result.domain}</strong>
      </span>,
    );
  }
  if (originMatch === "mismatch") {
    lines.push(
      <span key="origin" style={{ color: colours.warn }}>
        ⚠ Page origin <strong style={{ fontFamily: colours.mono }}>{originHost ?? "(unknown)"}</strong> does not match the DID's domain.
      </span>,
    );
  } else if (originMatch === "subdomain") {
    lines.push(
      <span key="origin" style={{ color: colours.textMuted }}>
        Page origin is a subdomain of the DID's domain.
      </span>,
    );
  } else if (originMatch === "match") {
    lines.push(
      <span key="origin" style={{ color: colours.textMuted }}>
        Page origin matches the DID's domain exactly.
      </span>,
    );
  }
  return (
    <div style={{ display: "grid", gap: 4, fontSize: 11.5 }}>{lines}</div>
  );
}

// ─── Main view ───

function Confirm() {
  const [verification, setVerification] = useState<VerificationState>({ kind: "pending" });
  const originHost = originHostname(origin);

  useEffect(() => {
    // No relying party to resolve (e.g. a `vaultList()` consent) — skip.
    if (!rpDid) return;
    let cancelled = false;
    chrome.runtime
      .sendMessage({ type: RUNTIME_VERIFY_RP_DID, did: rpDid })
      .then((reply: RuntimeVerifyRpDidResponse) => {
        if (cancelled) return;
        if (!reply.ok) {
          setVerification({ kind: "error", message: reply.error });
          return;
        }
        const match = compareOriginToDomain(originHost, reply.result.domain);
        if (!reply.result.resolved) {
          setVerification({
            kind: "error",
            message: reply.result.error ?? "Unknown resolution error",
          });
          return;
        }
        if (match === "mismatch") {
          setVerification({ kind: "warn", result: reply.result, originMatch: match });
          return;
        }
        setVerification({ kind: "ok", result: reply.result, originMatch: match });
      })
      .catch((e: unknown) => {
        if (cancelled) return;
        setVerification({
          kind: "error",
          message: e instanceof Error ? e.message : String(e),
        });
      });
    return () => {
      cancelled = true;
    };
  }, [originHost]);

  const isAction = !!action;
  const title = isAction ? "Confirmation request" : "Sign-in request";
  const subtitle = isAction ? (
    <>
      {originHost ? (
        <strong style={{ fontFamily: colours.mono }}>{originHost}</strong>
      ) : (
        "An unknown page"
      )}{" "}
      is asking you to confirm: <strong>{action}</strong>
    </>
  ) : originHost ? (
    <>
      <strong style={{ fontFamily: colours.mono }}>{originHost}</strong> wants you to sign in.
    </>
  ) : (
    <>An unknown page is requesting sign-in.</>
  );

  return (
    <div style={{ padding: 16, color: colours.text }}>
      {/* Header */}
      <div
        style={{
          display: "flex",
          alignItems: "center",
          justifyContent: "space-between",
          marginBottom: 8,
        }}
      >
        <div style={{ fontSize: 11, fontWeight: 700, color: colours.textSubtle, letterSpacing: 0.5, textTransform: "uppercase" }}>
          VTA Wallet
        </div>
        <Badge tone="neutral">{isAction ? "Inbound" : "Outbound"}</Badge>
      </div>

      <h1 style={{ fontSize: 18, margin: "0 0 4px", fontWeight: 700 }}>{title}</h1>
      <p style={{ margin: "0 0 14px", color: colours.textMuted, fontSize: 13 }}>{subtitle}</p>

      {/* Pinned-RP-changed warning (keeps M5 behaviour, styled to match the new card UI). */}
      {changedFromRpDid && (
        <div
          role="alert"
          style={{
            border: `1px solid #f1b8b3`,
            background: colours.dangerBg,
            color: "#7a1a13",
            padding: 12,
            margin: "0 0 14px",
            borderRadius: 8,
          }}
        >
          <strong style={{ display: "block", marginBottom: 4 }}>
            ⚠ Relying-party identity changed
          </strong>
          <div style={{ marginBottom: 6, fontSize: 12 }}>
            This site previously asked you to sign in to a different RP. Verify the new RP is
            correct before approving.
          </div>
          <div style={{ color: colours.textMuted, fontSize: 11, marginBottom: 2 }}>Previously:</div>
          <div style={{ wordBreak: "break-all", fontSize: 11, fontFamily: colours.mono }}>
            {changedFromRpDid}
          </div>
        </div>
      )}

      {/* RP card — omitted for actions with no specific relying party. */}
      {rpDid && (
        <div
          style={{
            background: colours.card,
            border: `1px solid ${colours.border}`,
            borderRadius: 10,
            padding: 14,
            marginBottom: 12,
          }}
        >
          <DidField
            label="Relying party"
            value={rpDid}
            rightSlot={<VerificationBadge state={verification} />}
          />
          <VerificationDetails state={verification} originHost={originHost} />
        </div>
      )}

      {/* Holder card */}
      {holderDid && (
        <div
          style={{
            background: colours.card,
            border: `1px solid ${colours.border}`,
            borderRadius: 10,
            padding: 14,
            marginBottom: 14,
          }}
        >
          <DidField label={isAction ? "Acting as" : "Sign in as"} value={holderDid} />
        </div>
      )}

      {/* Buttons. Deny gets the autoFocus — safest default for a security prompt
          (Enter = Deny). */}
      <div style={{ display: "flex", gap: 8 }}>
        <button
          autoFocus
          onClick={() => decide(false)}
          style={{
            flex: 1,
            padding: "10px 0",
            border: `1px solid ${colours.border}`,
            background: "#fff",
            color: colours.text,
            borderRadius: 8,
            fontSize: 13,
            fontWeight: 600,
            cursor: "pointer",
          }}
        >
          Deny
        </button>
        <button
          onClick={() => decide(true)}
          style={{
            flex: 1,
            padding: "10px 0",
            border: "none",
            background: colours.primary,
            color: "#fff",
            borderRadius: 8,
            fontSize: 13,
            fontWeight: 600,
            cursor: "pointer",
          }}
          onMouseEnter={(e) => {
            (e.currentTarget as HTMLButtonElement).style.background = colours.primaryHover;
          }}
          onMouseLeave={(e) => {
            (e.currentTarget as HTMLButtonElement).style.background = colours.primary;
          }}
        >
          Approve
        </button>
      </div>
    </div>
  );
}

const root = document.getElementById("root");
if (root) {
  createRoot(root).render(
    <StrictMode>
      <Confirm />
    </StrictMode>,
  );
}
