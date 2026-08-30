/// <reference types="chrome" />

import { StrictMode, useEffect, useState } from "react";
import { createRoot } from "react-dom/client";
import { collapseDid, splitDid, type DidPart } from "./did-display.js";
import { extractAgentNames, withoutScheme } from "./agent-name.js";
import "./theme.css";
import {
  RUNTIME_CONSENT_RESULT,
  RUNTIME_LIST_DIDS,
  RUNTIME_VERIFY_RP_DID,
  type DidRecordView,
  type RuntimeListDidsResponse,
  type RuntimeVerifyRpDidResponse,
  type VerifyRpDidResult,
} from "./bridge-protocol.js";
import {
  effectDiffView,
  matchCodeFromDigest,
  MATCH_CODE_LEN,
  ABSENT_VALUE,
  type ConsentEffect,
} from "@openvtc/pnm-core";
import { base64url } from "@openvtc/vti-didcomm-js";
import { runApproverUnlockCeremony } from "./webauthn-prf-unlock.js";

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
// The biometric-gated approver surface: Approve must run a fresh WebAuthn
// gesture bound to this decision's payloadDigest before it signs.
const isApproverConsent = params.get("approver") === "1";
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
// Session step-up (aal1 → aal2). The background sets these only after the
// offscreen has verified the signed approve-request, so `reason` — when
// present — is RP-authored prose from *inside* that signature (spec:
// "consumers MUST verify the proof BEFORE surfacing the reason"). It is
// attributed, not trusted: rendered as plain text, never markup.
const isStepUp = params.get("stepUp") === "1";
const stepUpReason = params.get("reason");
// First sign-in at this site: no persona is bound to it yet, so this prompt
// also asks WHICH persona to use and the background binds the answer as a vault
// entry. The picker is part of the same decision, not a second one — choosing
// the identity a site sees IS the approval, and splitting it into two screens
// would only train the operator to click through both.
const isChooseProfile = params.get("chooseProfile") === "1";
// M5: when set, the rpDid this origin previously used. Render a
// louder warning so the operator sees the swap and decides
// whether to approve it.
const changedFromRpDid = params.get("changedFrom");

function decide(
  approved: boolean,
  remember = false,
  prfOutputB64u?: string,
  selectedDid?: string,
): void {
  chrome.runtime.sendMessage({
    type: RUNTIME_CONSENT_RESULT,
    consentId,
    approved,
    remember,
    ...(prfOutputB64u ? { prfOutputB64u } : {}),
    ...(selectedDid ? { selectedDid } : {}),
  });
  window.close();
}

/** `collapseDid` as a plain string.
 *
 *  An `<option>` renders text and nothing else, so the styled parts the rest of
 *  this surface uses cannot go in one. Joining the parts keeps the same
 *  elision — SCID shortened, host and path intact — rather than falling back to
 *  a head-and-tail slice that would drop the host, which is the one segment a
 *  human can actually check. */
function collapsedDidText(did: string): string {
  return collapseDid(did)
    .map((p) => p.text)
    .join("");
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
  bg: "var(--w-raised)",
  card: "var(--w-surface)",
  border: "var(--w-line)",
  // Body text. Was mis-set to --w-surface, which rendered the heading,
  // the DID host and the Deny label as white-on-white.
  text: "var(--w-text)",
  textMuted: "var(--w-faint)",
  textSubtle: "var(--w-muted)",
  primary: "var(--w-accent)",
  primaryHover: "var(--w-accent)",
  ok: "var(--w-ok)",
  okBg: "var(--w-ok-soft)",
  warn: "var(--w-warn)",
  warnBg: "var(--w-warn-soft)",
  danger: "var(--w-danger)",
  dangerBg: "var(--w-danger-soft)",
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
    bannerBg: "var(--w-accent-soft)",
    bannerFg: "var(--w-accent)",
    accent: colours.primary,
    accentHover: colours.primaryHover,
    pageTint: "var(--w-accent-wash)",
  },
  approver: {
    label: "APPROVER",
    tagline: "You are authorizing a change — read it before you approve",
    icon: "🛡️",
    bannerBg: "var(--w-danger-soft)",
    bannerFg: "var(--w-danger)",
    accent: colours.danger,
    accentHover: "var(--w-danger)",
    pageTint: "var(--w-danger-wash)",
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
    ok: { fg: colours.ok, bg: colours.okBg, border: "var(--w-ok)" },
    warn: { fg: colours.warn, bg: colours.warnBg, border: "var(--w-warn)" },
    danger: { fg: colours.danger, bg: colours.dangerBg, border: "var(--w-danger)" },
    neutral: { fg: colours.textMuted, bg: "var(--w-raised)", border: "var(--w-line)" },
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
          background: "var(--w-raised)",
          border: `1px solid ${colours.border}`,
          borderRadius: 6,
          padding: "8px 10px",
          wordBreak: "break-all",
          color: colours.text,
        }}
        title={value}
      >
        {/* Collapsed or not, the host is always rendered in full and at full
            weight. The previous head-and-tail truncation could hide it
            outright — for `did:webvh:<scid>:<host>:contexts:acme` the tail is
            the path — which put the one segment this prompt asks the operator
            to verify off screen. */}
        <DidParts parts={expanded || !longish ? splitDid(value) : collapseDid(value)} />
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

/** Render pre-split DID parts with the host leading. Local to the consent
 *  window because it inherits `colours`, which this file scopes to the
 *  prompt's own surface. */
function DidParts({ parts }: { parts: DidPart[] }) {
  const style: Record<DidPart["role"], React.CSSProperties> = {
    method: { color: colours.textMuted },
    opaque: { color: colours.textMuted },
    host: { color: colours.text, fontWeight: 700 },
    path: { color: colours.textMuted },
  };
  return (
    <>
      {parts.map((p, i) => (
        <span key={i} style={style[p.role]}>
          {p.text}
        </span>
      ))}
    </>
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
  // First-use persona picker. `personas === null` means "not loaded yet"; an
  // empty array means the agent hosts none, which is a dead end this prompt has
  // to say out loud rather than render as an empty dropdown.
  const [personas, setPersonas] = useState<DidRecordView[] | null>(null);
  const [personasError, setPersonasError] = useState<string | null>(null);
  const [selectedDid, setSelectedDid] = useState("");
  const originHost = originHostname(origin);

  // Names the RESOLVED DOCUMENT claims. Never inferred from the DID: the
  // name → DID link is a web redirect and is not derivable from DID
  // structure, so anything not backed by `alsoKnownAs` is a guess.
  const verifiedName =
    verification.kind === "ok"
      ? extractAgentNames(verification.result.alsoKnownAs).map(withoutScheme)[0]
      : undefined;

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

  // The personas the agent can mint a SIOP id_token as — it holds their signing
  // keys, so this list is exactly the set of identities this site could be
  // signed into as. Asked for across every context: a persona and its vault
  // entry must share a context, and the record carries its own, so there is
  // nothing for the operator to choose twice.
  useEffect(() => {
    if (!isChooseProfile) return;
    let cancelled = false;
    chrome.runtime
      .sendMessage({ type: RUNTIME_LIST_DIDS })
      .then((reply: RuntimeListDidsResponse) => {
        if (cancelled) return;
        if (!reply.ok) {
          setPersonasError(reply.error);
          return;
        }
        setPersonas(reply.result.dids);
        // One persona is not a choice. Preselect it so the operator is deciding
        // the thing that is actually in question — whether this site gets an
        // identity at all — instead of confirming a dropdown with one row.
        if (reply.result.dids.length === 1) setSelectedDid(reply.result.dids[0]!.did);
      })
      .catch((e: unknown) => {
        if (cancelled) return;
        setPersonasError(e instanceof Error ? e.message : String(e));
      });
    return () => {
      cancelled = true;
    };
  }, []);

  const isAction = !!action;
  const title = isStepUp
    ? "Step-up approval request"
    : isChooseProfile
      ? "First sign-in at this site"
      : isAction
        ? "Confirmation request"
        : "Sign-in request";
  const subtitle = isChooseProfile ? (
    originHost ? (
      <>
        You have not signed in to{" "}
        <strong style={{ fontFamily: colours.mono }}>{originHost}</strong> before. Choose the
        identity it should know you as — the wallet will remember it for this site.
      </>
    ) : (
      <>An unknown page is asking you to sign in for the first time.</>
    )
  ) : isStepUp ? (
    originHost ? (
      <>
        <strong style={{ fontFamily: colours.mono }}>{originHost}</strong> is asking you to
        re-approve your session at a higher assurance level.
      </>
    ) : (
      <>An unknown page is requesting a session step-up.</>
    )
  ) : isAction ? (
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
        {/* A first-use prompt carries an `action` string, but it is not an
            inbound request — it is this browser asking to sign in. Labelling
            it "Inbound" would invert the direction on the one screen whose job
            is telling the operator who is asking whom. */}
        <Badge tone="neutral">{isAction && !isChooseProfile ? "Inbound" : "Outbound"}</Badge>
      </div>

      <h1 style={{ fontSize: 18, margin: "0 0 4px", fontWeight: 700 }}>{title}</h1>
      <p style={{ margin: "0 0 14px", color: colours.textMuted, fontSize: 13 }}>{subtitle}</p>

      {/* Pinned-RP-changed warning (keeps M5 behaviour, styled to match the new card UI). */}
      {changedFromRpDid && (
        <div
          role="alert"
          style={{
            border: `1px solid var(--w-danger)`,
            background: colours.dangerBg,
            color: "var(--w-danger)",
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

      {/* Step-up reason — the RP's stated purpose for wanting elevation,
          pulled from INSIDE its signed approve-request (verified in the
          offscreen before this window existed). Untrusted-but-attributed
          prose: React renders it as text, so it cannot inject markup; the
          background already capped its length and stripped control
          characters, and the render cap below is belt-and-braces. Absent
          reason = this card is absent and the prompt is the plain
          origin/rpDid one. */}
      {isStepUp && stepUpReason && (
        <div
          style={{
            background: colours.card,
            border: `1px solid ${colours.border}`,
            borderLeft: `3px solid ${colours.primary}`,
            borderRadius: 10,
            padding: 14,
            marginBottom: 12,
          }}
        >
          <div
            style={{
              color: colours.textMuted,
              fontSize: 11,
              fontWeight: 600,
              letterSpacing: 0.3,
              textTransform: "uppercase",
              marginBottom: 6,
            }}
          >
            Reason given by the relying party
          </div>
          <div
            style={{
              fontSize: 13,
              lineHeight: 1.5,
              whiteSpace: "pre-wrap",
              overflowWrap: "anywhere",
              maxHeight: 150,
              overflowY: "auto",
            }}
          >
            {stepUpReason.length > 600 ? `${stepUpReason.slice(0, 600)}…` : stepUpReason}
          </div>
          <p style={{ margin: "8px 0 0", fontSize: 11, color: colours.textMuted }}>
            Signature-verified as written by the relying party below. It is their claim —
            approve only if it matches what you were doing.
          </p>
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
          {/* The claimed agent name, shown only when the resolved document
              actually lists it. A name is a peer-supplied string until
              `alsoKnownAs` confirms it, and rendering an unverified one here
              — on the screen whose whole job is "is this who you think it
              is?" — would be the spoof this check exists to stop. */}
          {verifiedName && (
            <div style={{ marginBottom: 10 }}>
              <div
                style={{
                  color: colours.textMuted,
                  fontSize: 11,
                  fontWeight: 600,
                  letterSpacing: 0.3,
                  textTransform: "uppercase",
                  marginBottom: 4,
                }}
              >
                Agent name
              </div>
              <div
                style={{
                  fontFamily: colours.mono,
                  fontSize: 14,
                  fontWeight: 700,
                  color: colours.ok,
                  wordBreak: "break-all",
                }}
              >
                {verifiedName}
              </div>
              <div style={{ fontSize: 11, color: colours.textMuted, marginTop: 2 }}>
                Confirmed by this DID&apos;s own document.
              </div>
            </div>
          )}
          <DidField
            label="Relying party"
            value={rpDid}
            rightSlot={<VerificationBadge state={verification} />}
          />
          <VerificationDetails state={verification} />
        </div>
      )}

      {/* First-use persona picker.
          The "Sign in as" holder card below is replaced by this: on a first
          sign-in there is no answer to show yet, and a card naming the holder
          DID would say the site is about to see the wallet's own address —
          which is exactly what a per-site persona exists to avoid. */}
      {isChooseProfile && (
        <div
          style={{
            background: colours.card,
            border: `1px solid ${colours.border}`,
            borderLeft: `3px solid ${colours.primary}`,
            borderRadius: 10,
            padding: 14,
            marginBottom: 14,
          }}
        >
          <div
            style={{
              color: colours.textMuted,
              fontSize: 11,
              fontWeight: 600,
              letterSpacing: 0.3,
              textTransform: "uppercase",
              marginBottom: 6,
            }}
          >
            Sign in as
          </div>

          {personasError ? (
            <div style={{ fontSize: 12, color: colours.danger }}>
              Could not read your identities: {personasError}
            </div>
          ) : personas === null ? (
            <div style={{ fontSize: 12, color: colours.textMuted }}>Loading your identities…</div>
          ) : personas.length === 0 ? (
            <div style={{ fontSize: 12, color: colours.warn }}>
              Your agent hosts no identities yet, so there is nothing to sign in as. Create one in
              the wallet (Vault → identities) and try again.
            </div>
          ) : (
            <>
              <select
                value={selectedDid}
                onChange={(e) => setSelectedDid(e.currentTarget.value)}
                style={{
                  width: "100%",
                  fontFamily: colours.mono,
                  fontSize: 12,
                  padding: "8px 6px",
                  borderRadius: 6,
                  border: `1px solid ${colours.border}`,
                  background: "var(--w-surface)",
                  color: colours.text,
                }}
              >
                <option value="">Choose an identity…</option>
                {personas.map((d) => (
                  <option key={d.did} value={d.did}>
                    {collapsedDidText(d.did)} · {d.contextId}
                  </option>
                ))}
              </select>
              {selectedDid && (
                <div
                  style={{
                    marginTop: 10,
                    fontFamily: colours.mono,
                    fontSize: 11,
                    wordBreak: "break-all",
                    color: colours.textMuted,
                  }}
                >
                  {selectedDid}
                </div>
              )}
              {/* The ACL caveat. Stated as a fact about the site, not a wallet
                  error, because it is not one: the relying party decides which
                  identities it admits, and nothing this wallet does can add
                  one. Said here rather than after the failure so the operator
                  can copy the DID while it is on screen. */}
              <p style={{ margin: "10px 0 0", fontSize: 11, color: colours.textMuted }}>
                The site has to allow this identity before it will let you in. If sign-in is
                refused, ask{" "}
                {originHost ? (
                  <strong style={{ fontFamily: colours.mono }}>{originHost}</strong>
                ) : (
                  "the site"
                )}{" "}
                to add the identity above to its access list, then try again.
              </p>
              {personas.length > 1 && (
                <p style={{ margin: "6px 0 0", fontSize: 11, color: colours.textMuted }}>
                  Using an identity you already use elsewhere lets both sites work out you are the
                  same person. A fresh one for this site keeps them separate.
                </p>
              )}
            </>
          )}
        </div>
      )}

      {/* Holder card */}
      {holderDid && !isChooseProfile && (
        <div
          style={{
            background: colours.card,
            border: `1px solid ${colours.border}`,
            borderRadius: 10,
            padding: 14,
            marginBottom: 14,
          }}
        >
          <DidField
            label={isStepUp ? "Approving as" : isAction ? "Acting as" : "Sign in as"}
            value={holderDid}
          />
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
            background: "var(--w-surface)",
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
          // A first-use approval that named no persona would leave the
          // background to pick one, which is the wallet deciding who this site
          // knows you as. Disabled until the operator has said.
          disabled={isChooseProfile && !selectedDid}
          onClick={() => decide(true, remember, undefined, selectedDid || undefined)}
          style={{
            flex: 1,
            padding: "10px 0",
            border: "none",
            background: isChooseProfile && !selectedDid ? colours.border : colours.primary,
            color: isChooseProfile && !selectedDid ? colours.textMuted : "var(--w-accent-ink)",
            borderRadius: 8,
            fontSize: 13,
            fontWeight: 600,
            cursor: isChooseProfile && !selectedDid ? "not-allowed" : "pointer",
          }}
          onMouseEnter={(e) => {
            if (isChooseProfile && !selectedDid) return;
            (e.currentTarget as HTMLButtonElement).style.background = colours.primaryHover;
          }}
          onMouseLeave={(e) => {
            if (isChooseProfile && !selectedDid) return;
            (e.currentTarget as HTMLButtonElement).style.background = colours.primary;
          }}
        >
          {isChooseProfile ? "Approve & remember identity" : "Approve"}
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

/**
 * The code the user matches across two screens for a destructive task.
 *
 * `matchCodeFromDigest` decodes the `digestMultibase` and renders the first
 * bytes as hex, rather than slicing the encoded string — every SHA-256
 * `payloadDigest` begins with a constant `zQm`, so a slice of the encoding
 * would spend half the code on a format marker while still looking like six
 * random characters. It also has to agree character-for-character with the
 * mobile approver's `match_code_from_digest`, or the two surfaces show
 * different codes for the same task and the mismatch reads as an attack.
 *
 * Returns `null` when the digest will not decode. That fails the comparison
 * closed: a request whose digest we cannot parse is one whose match code we
 * cannot compute, and rendering *something* would be the one outcome worse than
 * rendering nothing.
 */
function matchCode(payloadDigest: string): string | null {
  try {
    return matchCodeFromDigest(payloadDigest);
  } catch {
    return null;
  }
}

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
  const [bioBusy, setBioBusy] = useState(false);
  const [bioError, setBioError] = useState<string | null>(null);

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
  const prefix = matchCode(request.payloadDigest);

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
  //
  // An undecodable digest (`prefix === null`) blocks approval outright. The
  // comparison is the control; with no code to compare there is nothing left to
  // downgrade to, and letting the tap through would silently convert the
  // strongest check on this screen into the weakest.
  //
  // The code is hex, so the case-insensitive compare is right — it forgives the
  // keyboard without widening the match.
  const mayApprove =
    !destructive || (prefix !== null && typed.trim().toLowerCase() === prefix.toLowerCase());

  // Approve. On the approver surface, the signature is gated behind a fresh
  // WebAuthn gesture whose challenge is THIS payloadDigest — the biometric that
  // authorizes exactly this change. Only a successful gesture returns approval;
  // a cancel keeps the window open so a mis-tap isn't an accidental sign-off.
  const digest = request.payloadDigest;
  async function approve(): Promise<void> {
    if (!isApproverConsent) {
      decide(true);
      return;
    }
    setBioBusy(true);
    setBioError(null);
    try {
      // The per-decision PRF output unwraps the approver key for exactly this
      // signature. Hand it back so the same-browser relay can sign the decision
      // without a pre-unlocked approver session; it is never cached.
      const { prfOutput } = await runApproverUnlockCeremony(chrome.runtime.id, digest);
      decide(true, false, base64url.encode(prfOutput));
    } catch (e) {
      setBioError(e instanceof Error ? e.message : String(e));
    } finally {
      setBioBusy(false);
    }
  }

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
            color: "var(--w-accent-ink)",
            background: destructive
              ? "var(--w-danger)"
              : request.sideEffects === "mutating"
                ? "var(--w-warn)"
                : "var(--w-ok)",
          }}
        >
          {request.sideEffects}
        </span>
        <strong style={{ fontSize: 14 }}>Approve this action?</strong>
      </div>

      <div style={{ color: "var(--w-muted)", lineHeight: 1.45 }}>
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
          border: `1px solid ${determined ? "var(--w-line)" : "var(--w-danger)"}`,
          borderRadius: 6,
          padding: 12,
          background: determined ? "var(--w-raised)" : "var(--w-danger-soft)",
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
        <div style={{ fontSize: 12, color: "var(--w-muted)" }}>
          Requested by <strong>{originHostname(request.origin) ?? request.origin}</strong>
        </div>
      ) : null}

      {request.statePin ? (
        <div style={{ fontSize: 11, color: "var(--w-muted)" }}>
          Computed against version <code>{request.statePin.version}</code>. If it changes
          before you approve, your agent will ask again.
        </div>
      ) : null}

      {/* The digest. Shown for every task; matched for destructive ones.
          When it will not decode we say so instead of rendering a placeholder:
          a human who sees six characters compares them, and six characters we
          invented would be compared successfully against nothing. */}
      {prefix !== null ? (
        <div style={{ fontSize: 11, color: "var(--w-muted)" }}>
          Request code{" "}
          <code style={{ fontSize: 13, letterSpacing: 1.5, color: "var(--w-text)" }}>{prefix}</code>
        </div>
      ) : (
        <div style={{ fontSize: 11, color: colours.danger, lineHeight: 1.4 }}>
          This request carries a digest this wallet cannot read, so there is no code to
          compare. Do not approve it — check that your agent and wallet are on the same
          version.
        </div>
      )}

      {destructive && prefix !== null ? (
        <div style={{ display: "grid", gap: 6 }}>
          <label style={{ fontSize: 12, fontWeight: 600 }}>
            This cannot be undone. Type the request code shown where you started this
            action:
          </label>
          <input
            value={typed}
            onChange={(e) => setTyped(e.target.value)}
            placeholder={"·".repeat(MATCH_CODE_LEN)}
            style={{
              padding: "8px 10px",
              fontSize: 15,
              letterSpacing: 2,
              fontFamily: "monospace",
              border: "1px solid var(--w-line)",
              borderRadius: 5,
            }}
          />
        </div>
      ) : null}

      {bioError ? (
        <div style={{ color: colours.danger, fontSize: 12, lineHeight: 1.4 }}>
          Not signed: {bioError}
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
          disabled={!mayApprove || bioBusy}
          onClick={() => void approve()}
          style={{
            padding: "8px 18px",
            fontSize: 13,
            fontWeight: 700,
            border: "none",
            borderRadius: 8,
            color: "var(--w-accent-ink)",
            background: modeTheme.approver.accent,
            opacity: mayApprove && !bioBusy ? 1 : 0.45,
            cursor: mayApprove && !bioBusy ? "pointer" : "not-allowed",
          }}
        >
          {bioBusy
            ? "Waiting for authenticator…"
            : isApproverConsent
              ? "Approve with biometric"
              : "Approve"}
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
