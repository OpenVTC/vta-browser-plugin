/// <reference types="chrome" />

import { StrictMode, useEffect, useState } from "react";
import { createRoot } from "react-dom/client";
import {
  RUNTIME_CONSENT_RESULT,
  RUNTIME_VERIFY_RP_DID,
  type RuntimeVerifyRpDidResponse,
  type VerifyRpDidResult,
} from "./bridge-protocol.js";
import { effectDiffView, ABSENT_VALUE, type ConsentEffect } from "@openvtc/pnm-core";

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
// `kind=task` selects the task-execution consent surface, which renders
// VTA-authored effects rather than an RP-authored reason.
const isTaskConsent = params.get("kind") === "task";
// A per-action prompt has nothing to remember; the caller says so explicitly.
const noRemember = params.get("noRemember") === "1";
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

function decide(approved: boolean, remember = false): void {
  chrome.runtime.sendMessage({ type: RUNTIME_CONSENT_RESULT, consentId, approved, remember });
  window.close();
}

function originHostname(o: string): string | undefined {
  try {
    return new URL(o).hostname;
  } catch {
    return undefined;
  }
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

// ─── Mode identity ───
// Two surfaces, two roles, and it must be impossible to confuse them. The WORKER
// surface is your agent asking to *send a request*; the APPROVER surface is *you*
// authorizing a privileged change. They get deliberately different colour, icon,
// and a full-width banner — because approving in the wrong mental model is
// exactly the mistake this ceremony exists to prevent, the more so once the
// approver's key sits behind a biometric and one gesture commits the change.

type Mode = "worker" | "approver";

const modeTheme: Record<
  Mode,
  {
    label: string;
    tagline: string;
    icon: string;
    bannerBg: string;
    bannerFg: string;
    accent: string;
    accentHover: string;
    pageTint: string;
  }
> = {
  worker: {
    label: "WORKER",
    tagline: "Your agent is sending a request on your behalf",
    icon: "🤖",
    bannerBg: "#0e2a4d",
    bannerFg: "#dbe9ff",
    accent: colours.primary,
    accentHover: colours.primaryHover,
    pageTint: "#f5f8fd",
  },
  approver: {
    label: "APPROVER",
    tagline: "You are authorizing a change — read it before you approve",
    icon: "🛡️",
    bannerBg: "#4a1410",
    bannerFg: "#ffe1d9",
    accent: colours.danger,
    accentHover: "#8f1e17",
    pageTint: "#fdf6f4",
  },
};

/** A full-width, unmistakable banner naming the mode the human is acting in.
 *  `pad` matches the host surface's padding so the banner bleeds edge-to-edge. */
function ModeBanner({ mode, pad }: { mode: Mode; pad: number }) {
  const t = modeTheme[mode];
  return (
    <div
      style={{
        display: "flex",
        alignItems: "center",
        gap: 10,
        background: t.bannerBg,
        color: t.bannerFg,
        padding: "11px 16px",
        margin: `-${pad}px -${pad}px 16px`,
        borderBottom: `3px solid ${t.accent}`,
      }}
    >
      <span style={{ fontSize: 20, lineHeight: 1 }} aria-hidden>
        {t.icon}
      </span>
      <div style={{ display: "grid", gap: 1 }}>
        <span style={{ fontSize: 12, fontWeight: 800, letterSpacing: 1.2 }}>
          {t.label} MODE
        </span>
        <span style={{ fontSize: 11, opacity: 0.85 }}>{t.tagline}</span>
      </div>
    </div>
  );
}

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
// Renders whether the relying-party DID *resolves* (and, for did:webvh, that
// its log chain + proofs verify). We intentionally do NOT compare the DID's
// hosting domain against the page origin — a DID's host is unrelated to where
// the RP is served, so that check produced false "origin mismatch" warnings
// and proved nothing. A genuine resolution failure surfaces as the error
// state below.

type VerificationState =
  | { kind: "pending" }
  | { kind: "ok"; result: VerifyRpDidResult }
  | { kind: "error"; message: string };

function VerificationBadge({ state }: { state: VerificationState }) {
  if (state.kind === "pending") {
    return <Badge tone="neutral">Verifying…</Badge>;
  }
  if (state.kind === "error") {
    return <Badge tone="danger">Verification failed</Badge>;
  }
  return <Badge tone="ok">Resolved ✓</Badge>;
}

function VerificationDetails({ state }: { state: VerificationState }) {
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
  const { result } = state;
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
  return (
    <div style={{ display: "grid", gap: 4, fontSize: 11.5 }}>{lines}</div>
  );
}

// ─── Main view ───

function Confirm() {
  const [verification, setVerification] = useState<VerificationState>({ kind: "pending" });
  const [remember, setRemember] = useState(false);
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
        if (!reply.result.resolved) {
          setVerification({
            kind: "error",
            message: reply.result.error ?? "Unknown resolution error",
          });
          return;
        }
        setVerification({ kind: "ok", result: reply.result });
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
    // `rpDid` is a module-level constant (parsed from the URL once), so the
    // resolve runs once on mount.
  }, []);

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
    <div
      style={{
        padding: 16,
        color: colours.text,
        background: modeTheme.worker.pageTint,
        minHeight: "100vh",
      }}
    >
      <ModeBanner mode="worker" pad={16} />
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
          <VerificationDetails state={verification} />
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

      {/* Remember-this-site opt-in. Off by default — ticking it trusts this
          origin so its future login / vaultList / proxyLogin calls skip this
          prompt until revoked (options → Connected sites). Only meaningful
          when we know the origin. */}
      {originHost && !noRemember && (
        <label
          style={{
            display: "flex",
            alignItems: "center",
            gap: 8,
            margin: "0 0 12px",
            fontSize: 12,
            color: colours.textMuted,
            cursor: "pointer",
          }}
        >
          <input
            type="checkbox"
            checked={remember}
            onChange={(e) => setRemember(e.currentTarget.checked)}
          />
          Remember <strong style={{ fontFamily: colours.mono }}>{originHost}</strong> — don't ask
          again for this site
        </label>
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
          onClick={() => decide(true, remember)}
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

// ─── Task-execution consent ───
//
// A different surface from the login/confirm prompt above, and deliberately so.
//
// Everything rendered here is authored by the user's **own VTA** and arrives
// under its signature — verified in the offscreen before this window is opened.
// Nothing a relying party wrote reaches this screen. That is the whole point:
// the requester is the least-trusted component in the system, and if it could
// write the words a human reads, it would be authoring the basis of a decision
// that authorizes it.
//
// There is also no "remember this site". A task-consent approval authorizes one
// payload, once. There is nothing to remember, and a checkbox that implied
// otherwise would be the single most dangerous control in this extension.

interface TaskConsentRequest {
  challenge: string;
  taskType: string;
  payloadDigest: string;
  sideEffects: "none" | "mutating" | "destructive";
  exposure: { discloses: string; actsAsSubject: boolean };
  // The full effect shape the VTA sends — `summary` is the guaranteed line, and
  // `path`/`before`/`after` carry the actual change. Rendering the diff (not just
  // the summary) is what makes this "what you see is what you sign": the approval
  // authorizes the change on screen, so the change must be on screen.
  effects: ConsentEffect[];
  requester: string;
  approverSet: string;
  minApprovals: number;
  excludeRequester: boolean;
  expiresAt: string;
  subject?: string;
  origin?: string;
  statePin?: { resource: string; version: string };
  consequences?: string[];
}

/** The prefix the user matches across two screens for a destructive task. */
const DIGEST_PREFIX_LEN = 6;

function taskLabel(typeUri: string): string {
  // `https://trusttasks.org/spec/webvh/dids/update/1.0` → `webvh/dids/update`
  const m = /\/spec\/(.+)\/[\d.]+$/.exec(typeUri);
  return m?.[1] ?? typeUri;
}

/**
 * The structured before→after change for one effect, shown beneath its summary.
 * The summary says *what* in prose; this shows the actual values so the human
 * consents to the real change, not a description of it. An absent side renders
 * as `∅`, so an addition (∅ → value) and a removal (value → ∅) never look like a
 * plain modification. Nothing renders for a summary-only effect.
 */
function EffectDiff({ effect }: { effect: ConsentEffect }) {
  const view = effectDiffView(effect);
  if (!view) return null;
  const hasValues = view.before !== undefined || view.after !== undefined;
  return (
    <div style={{ marginTop: 5, display: "grid", gap: 3 }}>
      {view.path ? (
        <div
          style={{
            fontFamily: colours.mono,
            fontSize: 10.5,
            color: colours.textSubtle,
            letterSpacing: 0.2,
            wordBreak: "break-all",
          }}
        >
          {view.path}
        </div>
      ) : null}
      {hasValues ? (
        <div
          style={{
            display: "flex",
            alignItems: "center",
            gap: 6,
            flexWrap: "wrap",
            fontFamily: colours.mono,
            fontSize: 11,
          }}
        >
          <span
            style={{
              padding: "1px 6px",
              borderRadius: 4,
              background: colours.dangerBg,
              color: colours.danger,
              textDecoration: view.before === undefined ? "none" : "line-through",
              wordBreak: "break-all",
            }}
          >
            {view.before ?? ABSENT_VALUE}
          </span>
          <span style={{ color: colours.textSubtle }}>→</span>
          <span
            style={{
              padding: "1px 6px",
              borderRadius: 4,
              background: colours.okBg,
              color: colours.ok,
              wordBreak: "break-all",
            }}
          >
            {view.after ?? ABSENT_VALUE}
          </span>
        </div>
      ) : null}
    </div>
  );
}

function TaskConsent() {
  const [request, setRequest] = useState<TaskConsentRequest | null>(null);
  const [typed, setTyped] = useState("");

  useEffect(() => {
    void chrome.storage.session
      .get(`task-consent:${consentId}`)
      .then((v: Record<string, unknown>) => {
        setRequest((v[`task-consent:${consentId}`] as TaskConsentRequest) ?? null);
      });
  }, []);

  if (!request) {
    return <div style={{ padding: 20, fontSize: 13 }}>Loading request…</div>;
  }

  const destructive = request.sideEffects === "destructive";
  const prefix = request.payloadDigest.slice(0, DIGEST_PREFIX_LEN);

  // What the VTA said this will do. `effects` when it dry-ran the handler; the
  // specification's static text when it could not; and — when it has neither —
  // an explicit statement that nobody can say.
  //
  // "No effects" and "effects unknown" would render identically if we let them,
  // and the difference is the entire decision: one means the task is inert, the
  // other means this agent cannot tell you what it does. Presenting the second
  // as the first would show the most dangerous case as the most reassuring one.
  const hasEffects = request.effects.length > 0;
  const consequenceLines = request.consequences ?? [];
  const determined = hasEffects || consequenceLines.length > 0;

  // For a destructive task the user must MATCH the digest, not tap "approve".
  // Checks that assume an honest device catch a hostile page; only a comparison
  // the human performs across two independent screens catches a hostile device,
  // because only that moves the check somewhere the device cannot reach. A tap
  // is a reflex; a comparison is an act of attention.
  const mayApprove = !destructive || typed.trim().toLowerCase() === prefix.toLowerCase();

  return (
    <div
      style={{
        padding: 20,
        background: modeTheme.approver.pageTint,
        minHeight: "100vh",
        color: colours.text,
        fontSize: 13,
      }}
    >
      <ModeBanner mode="approver" pad={20} />
      <div style={{ display: "grid", gap: 14 }}>
      <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
        <span
          style={{
            fontSize: 10,
            fontWeight: 700,
            letterSpacing: 0.6,
            textTransform: "uppercase",
            padding: "3px 7px",
            borderRadius: 4,
            color: "#fff",
            background: destructive
              ? "#b3261e"
              : request.sideEffects === "mutating"
                ? "#8a5a00"
                : "#3a6b35",
          }}
        >
          {request.sideEffects}
        </span>
        <strong style={{ fontSize: 14 }}>Approve this action?</strong>
      </div>

      <div style={{ color: "#555", lineHeight: 1.45 }}>
        Your agent is asking permission to run{" "}
        <code style={{ fontSize: 12 }}>{taskLabel(request.taskType)}</code>
        {request.subject ? (
          <>
            {" "}
            on <code style={{ fontSize: 12 }}>{request.subject}</code>
          </>
        ) : null}
        .
      </div>

      {/* What will actually happen. Authored by the VTA, rendered verbatim. */}
      <div
        style={{
          border: `1px solid ${determined ? "#ddd" : "#b3261e"}`,
          borderRadius: 6,
          padding: 12,
          background: determined ? "#fafafa" : "#fff4f3",
        }}
      >
        <div style={{ fontWeight: 600, marginBottom: 8, fontSize: 12 }}>
          {determined ? "This will:" : "⚠ Consequences unknown"}
        </div>
        {determined ? (
          hasEffects ? (
            <ul style={{ margin: 0, paddingLeft: 18, display: "grid", gap: 10 }}>
              {request.effects.map((e, i) => (
                <li key={i} style={{ lineHeight: 1.4 }}>
                  {e.summary}
                  <EffectDiff effect={e} />
                </li>
              ))}
            </ul>
          ) : (
            <ul style={{ margin: 0, paddingLeft: 18, display: "grid", gap: 6 }}>
              {consequenceLines.map((line, i) => (
                <li key={i} style={{ lineHeight: 1.4 }}>
                  {line}
                </li>
              ))}
            </ul>
          )
        ) : (
          <div style={{ lineHeight: 1.45 }}>
            Your agent could not determine what this task will do. Approving it means
            approving an effect nobody has described to you.
          </div>
        )}
      </div>

      {request.origin ? (
        <div style={{ fontSize: 12, color: "#555" }}>
          Requested by <strong>{originHostname(request.origin) ?? request.origin}</strong>
        </div>
      ) : null}

      {request.statePin ? (
        <div style={{ fontSize: 11, color: "#777" }}>
          Computed against version <code>{request.statePin.version}</code>. If it changes
          before you approve, your agent will ask again.
        </div>
      ) : null}

      {/* The digest. Shown for every task; matched for destructive ones. */}
      <div style={{ fontSize: 11, color: "#777" }}>
        Request code{" "}
        <code style={{ fontSize: 13, letterSpacing: 1.5, color: "#222" }}>{prefix}</code>
      </div>

      {destructive ? (
        <div style={{ display: "grid", gap: 6 }}>
          <label style={{ fontSize: 12, fontWeight: 600 }}>
            This cannot be undone. Type the request code shown where you started this
            action:
          </label>
          <input
            value={typed}
            onChange={(e) => setTyped(e.target.value)}
            placeholder={"·".repeat(DIGEST_PREFIX_LEN)}
            style={{
              padding: "8px 10px",
              fontSize: 15,
              letterSpacing: 2,
              fontFamily: "monospace",
              border: "1px solid #ccc",
              borderRadius: 5,
            }}
          />
        </div>
      ) : null}

      <div style={{ display: "flex", gap: 8, justifyContent: "flex-end", marginTop: 4 }}>
        {/* Deny is focused: the safe answer should be the one you get by
            reflex, and closing this window is a denial too. */}
        <button
          autoFocus
          onClick={() => decide(false)}
          style={{ padding: "8px 16px", fontSize: 13 }}
        >
          Deny
        </button>
        <button
          disabled={!mayApprove}
          onClick={() => decide(true)}
          style={{
            padding: "8px 18px",
            fontSize: 13,
            fontWeight: 700,
            border: "none",
            borderRadius: 8,
            color: "#fff",
            background: modeTheme.approver.accent,
            opacity: mayApprove ? 1 : 0.45,
            cursor: mayApprove ? "pointer" : "not-allowed",
          }}
        >
          Approve
        </button>
      </div>
      </div>
    </div>
  );
}

const root = document.getElementById("root");
if (root) {
  createRoot(root).render(
    <StrictMode>{isTaskConsent ? <TaskConsent /> : <Confirm />}</StrictMode>,
  );
}
