/// <reference types="chrome" />

// The sign-in window for a trigger link (contract C3, base design §6 and §14).
//
// Opened by the background after a person clicked a sign-in code on a page.
// It names its flow by id and nothing else; every screen comes from the
// offscreen document, which runs the protocol and holds `K_a`. Three screens a
// person acts on, in order, and each one is a gate:
//
//   1. "Sign in to <community> at <portal>?" — the community's name from this
//      wallet's own record, the portal origin from its verified DID document.
//      Pick an identity, then Continue. Nothing has been sent to the
//      community before this press.
//   2. "Type the number on the screen." A different name in the community's
//      own reply is flagged here (VTI-LNK-104).
//   3. "Request from <browser> on <os> · near <location> · <network>". Approve
//      runs the passkey over the grant digest (C6); Decline needs none.
//
// A refused link shows only the VTI-LNK-021 message for its outcome.
//
// ## Layout
//
// Every screen is one `Screen`: the wallet's mark, then a header naming the
// community (the wallet's record) and the portal origin with its host set
// loud — the host is the thing the person has to check against the address
// bar — then a card with the screen's content and its action row. Enter runs
// the primary action and Escape the secondary one (decline or close), wherever
// focus is, except on a control that answers Enter itself.
//
// The header takes a `subtitle` line under the community name for a sign-in
// that is more than a member's (an operator console, say); nothing sets it
// yet.

import { useEffect, useState, type CSSProperties, type ReactNode } from "react";

import {
  RUNTIME_SIGN_IN_STEP,
  type RuntimeSignInStepResponse,
  type SignInIdentityView,
  type SignInStep,
  type SignInStepResult,
  type SignInUvEnrolmentView,
} from "./bridge-protocol.js";
import { PrfUnlockError } from "./webauthn-prf-unlock.js";
import { assertUvPasskey, createUvPasskey, rememberUvEnrolment, storedUvEnrolment } from "./uv-passkey.js";
import { c, t, font, radius, microLabel, button, type ButtonKind } from "./theme.js";
import { Mark, Note } from "./ui.js";
import { collapseDid, type DidPart } from "./did-display.js";
import { failureDetails } from "./sign-in-failure.js";

/** The UV passkey operations the window needs. Injected for tests. */
export interface UvPasskeyOps {
  /** This browser's passkey, as enrolled — kept whole so it can be enrolled
   *  at another agent without creating a second one. */
  stored: () => Promise<SignInUvEnrolmentView | undefined>;
  create: typeof createUvPasskey;
  remember: (enrolment: SignInUvEnrolmentView) => Promise<void>;
  assert: (credentialId: string, challengeB64u: string) => ReturnType<typeof assertUvPasskey>;
}

const browserUv: UvPasskeyOps = {
  stored: storedUvEnrolment,
  create: () => createUvPasskey(),
  remember: rememberUvEnrolment,
  assert: (id, c) => assertUvPasskey(id, c),
};

export interface SignInViewProps {
  flowId: string;
  /** Send one step. Injected so the view can be rendered in a test. */
  send?: (step: SignInStep) => Promise<RuntimeSignInStepResponse>;
  /** The passkey operations. Injected for the same reason. */
  uv?: UvPasskeyOps;
  close?: () => void;
  /** Epoch ms. Injected so a test (or a screenshot) can hold the clock. */
  now?: () => number;
}

// ── Presentation ─────────────────────────────────────────────────────────────

/** Long values — a community's self-given name, a DID — wrap anywhere rather
 *  than push the window sideways. */
const wrap: CSSProperties = { overflowWrap: "anywhere", minWidth: 0 };

const ROLE_STYLE: Record<DidPart["role"], CSSProperties> = {
  method: { color: c.faint },
  opaque: { color: c.muted },
  host: { color: c.text, fontWeight: 620 },
  path: { color: c.faint },
};

/**
 * A DID shortened in the middle — the SCID gives way, the host never does
 * (`collapseDid`) — with the whole value in its tooltip, and, where there is
 * room for a control, a "Show full" toggle.
 */
function ShortDid({ value, toggle = false }: { value: string; toggle?: boolean }) {
  const [full, setFull] = useState(false);
  const parts = full ? [{ text: value, role: "opaque" as const }] : collapseDid(value);
  const shortened = parts.map((p) => p.text).join("") !== value;
  return (
    <span style={wrap}>
      <span title={value} style={{ fontFamily: font.mono, fontSize: t.sm, ...wrap }}>
        {parts.map((p, i) => (
          <span key={i} style={full ? { color: c.text } : ROLE_STYLE[p.role]}>
            {p.text}
          </span>
        ))}
      </span>
      {toggle && (shortened || full) && (
        <button
          type="button"
          onClick={() => setFull((v) => !v)}
          aria-expanded={full}
          style={{ ...button("quiet"), padding: "0 4px", fontSize: t.xs, color: c.accent, marginLeft: 4 }}
        >
          {full ? "Show less" : "Show full"}
        </button>
      )}
    </span>
  );
}

/** A value someone else chose: a DID gets `ShortDid`, anything else is set
 *  in bold and wraps. */
function Claimed({ value }: { value: string }) {
  return value.startsWith("did:") ? <ShortDid value={value} toggle /> : <strong style={wrap}>{value}</strong>;
}

/** An origin with its host loud and its scheme and port quiet. The text reads
 *  back as the origin exactly, so it can be compared and copied whole. */
function Origin({ origin, testId }: { origin: string; testId?: string }) {
  let scheme = "";
  let host = origin;
  let port = "";
  try {
    const u = new URL(origin);
    scheme = `${u.protocol}//`;
    host = u.hostname;
    port = u.port ? `:${u.port}` : "";
  } catch {
    // Not a URL: shown as given, all of it loud.
  }
  return (
    <span data-testid={testId} title={origin} style={{ ...wrap, fontSize: t.md }}>
      <span style={{ color: c.faint }}>{scheme}</span>
      <span style={{ color: c.text, fontWeight: 650 }}>{host}</span>
      <span style={{ color: c.faint }}>{port}</span>
    </span>
  );
}

/** The community this window is about, as the wallet knows it. */
interface Who {
  community: string;
  origin: string;
  /** A line under the community name, e.g. "Operator console". */
  subtitle?: ReactNode;
}

function Header({ who }: { who: Who | undefined }) {
  return (
    <header style={{ display: "grid", gap: 14, marginBottom: 14 }}>
      <div style={{ display: "flex", alignItems: "center", gap: 9 }}>
        <Mark />
        <span style={{ fontWeight: 640, fontSize: t.sm, letterSpacing: "-0.01em" }}>VTA Wallet</span>
        <span style={{ marginLeft: "auto", fontSize: t.xs, color: c.faint }}>Sign-in request</span>
      </div>
      {who && (
        <div style={{ display: "grid", gap: 3, minWidth: 0 }}>
          <div style={microLabel}>Community · your wallet's record</div>
          <div data-testid="community" style={{ fontSize: t.lg, fontWeight: 650, lineHeight: 1.25, ...wrap }}>
            {who.community}
          </div>
          {who.subtitle && (
            <div data-testid="subtitle" style={{ fontSize: t.sm, color: c.muted, ...wrap }}>
              {who.subtitle}
            </div>
          )}
          <div style={{ display: "flex", alignItems: "baseline", gap: 6, flexWrap: "wrap", marginTop: 4, minWidth: 0 }}>
            <span style={{ fontSize: t.sm, color: c.muted }}>at</span>
            <Origin origin={who.origin} testId="portal" />
          </div>
          <div style={{ fontSize: t.xs, color: c.faint }}>From its verified DID document. Check it matches the website's address.</div>
        </div>
      )}
    </header>
  );
}

interface Action {
  label: string;
  run: () => void;
  disabled?: boolean;
  testId?: string;
  kind?: ButtonKind;
}

/** Enter runs the primary action and Escape the secondary one. A focused
 *  button, link or disclosure keeps Enter for itself — pressing Enter on
 *  Decline declines. */
function useKeys(primary: Action | undefined, secondary: Action | undefined) {
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.defaultPrevented || e.isComposing || e.altKey || e.ctrlKey || e.metaKey) return;
      if (e.key === "Escape" && secondary && !secondary.disabled) {
        e.preventDefault();
        secondary.run();
      } else if (e.key === "Enter" && primary && !primary.disabled) {
        const target = e.target as Element | null;
        if (target?.closest?.("button, a, summary, textarea, select")) return;
        e.preventDefault();
        primary.run();
      }
    };
    addEventListener("keydown", onKey);
    return () => removeEventListener("keydown", onKey);
  }, [primary, secondary]);
}

function ActionButton({ action, kind }: { action: Action; kind: ButtonKind }) {
  return (
    <button
      type="button"
      data-testid={action.testId}
      disabled={action.disabled}
      onClick={action.run}
      style={{
        ...button(action.kind ?? kind),
        fontSize: t.base,
        padding: "9px 18px",
        minWidth: 104,
        ...(action.disabled ? { opacity: 0.5, cursor: "default" } : {}),
      }}
    >
      {action.label}
    </button>
  );
}

function Screen({
  who,
  title,
  icon,
  primary,
  secondary,
  escape,
  children,
}: {
  who?: Who | undefined;
  title: string;
  icon?: ReactNode;
  primary?: Action;
  secondary?: Action;
  /** What Escape does when there is no secondary button — closing, on a
   *  screen whose only button is Close. */
  escape?: Action;
  children?: ReactNode;
}) {
  useKeys(primary, secondary ?? escape);
  return (
    <div
      style={{
        maxWidth: 520,
        margin: "0 auto",
        padding: "18px 20px 24px",
        boxSizing: "border-box",
        fontSize: t.base,
        lineHeight: 1.5,
        color: c.text,
        minWidth: 0,
      }}
    >
      <Header who={who} />
      <main
        style={{
          background: c.surface,
          border: `1px solid ${c.line}`,
          borderRadius: radius.lg,
          padding: "18px 20px",
          display: "grid",
          gap: 14,
          minWidth: 0,
        }}
      >
        <div style={{ display: "flex", alignItems: "center", gap: 10, minWidth: 0 }}>
          {icon}
          <h1 style={{ fontSize: t.md, fontWeight: 650, margin: 0, lineHeight: 1.3, ...wrap }}>{title}</h1>
        </div>
        {children}
        {(primary || secondary) && (
          <footer
            style={{
              display: "flex",
              justifyContent: "flex-end",
              gap: 10,
              flexWrap: "wrap",
              borderTop: `1px solid ${c.lineSoft}`,
              paddingTop: 14,
              marginTop: 2,
            }}
          >
            {secondary && <ActionButton action={secondary} kind="default" />}
            {primary && <ActionButton action={primary} kind="primary" />}
          </footer>
        )}
      </main>
    </div>
  );
}

function Message({ children, muted = false }: { children: ReactNode; muted?: boolean }) {
  return (
    <p data-testid="message" style={{ margin: 0, color: muted ? c.muted : c.text, ...wrap }}>
      {children}
    </p>
  );
}

function StatusIcon({ tone }: { tone: "ok" | "warn" | "danger" | "off" }) {
  const colour = tone === "ok" ? c.ok : tone === "warn" ? c.warn : tone === "danger" ? c.danger : c.faint;
  const soft = tone === "ok" ? c.okSoft : tone === "warn" ? c.warnSoft : tone === "danger" ? c.dangerSoft : c.raised;
  return (
    <span
      aria-hidden
      style={{ width: 26, height: 26, borderRadius: 999, background: soft, display: "grid", placeItems: "center", flex: "none" }}
    >
      <svg width="14" height="14" viewBox="0 0 14 14" fill="none" stroke={colour} strokeWidth="2" strokeLinecap="round">
        {tone === "ok" ? (
          <path d="M3 7.5l2.5 2.5L11 4.5" />
        ) : tone === "off" ? (
          <path d="M4 7h6" />
        ) : (
          <>
            <path d="M7 3.5v4.5" />
            <path d="M7 10.5v.01" />
          </>
        )}
      </svg>
    </span>
  );
}

/** Time left to decide, as m:ss, ticking. Past the deadline it says so: the
 *  community decides whether to accept a late answer, not this window. */
function Countdown({ deadline, now }: { deadline: number; now: () => number }) {
  const [at, setAt] = useState(now);
  useEffect(() => {
    const id = setInterval(() => setAt(now()), 1000);
    return () => clearInterval(id);
  }, [now]);
  const left = Math.max(0, Math.ceil((deadline - at) / 1000));
  if (left === 0) {
    return (
      <div data-testid="countdown" style={{ fontSize: t.sm, color: c.warn, textAlign: "center" }}>
        The time to decide has passed. If the website refuses, refresh the code there.
      </div>
    );
  }
  const mmss = `${Math.floor(left / 60)}:${String(left % 60).padStart(2, "0")}`;
  return (
    <div data-testid="countdown" style={{ fontSize: t.sm, color: left <= 20 ? c.warn : c.muted, textAlign: "center" }}>
      Time left to decide <span style={{ fontVariantNumeric: "tabular-nums", fontWeight: 600 }}>{mmss}</span>
    </div>
  );
}

function FailureDetails({ result }: { result: Extract<SignInStepResult, { kind: "failed" }> }) {
  const rows = failureDetails(result);
  return (
    <details data-testid="failure-details" style={{ fontSize: t.xs, color: c.muted }}>
      <summary style={{ cursor: "pointer", color: c.muted, width: "fit-content" }}>Details</summary>
      <dl style={{ display: "grid", gridTemplateColumns: "auto minmax(0, 1fr)", gap: "3px 12px", margin: "8px 0 0" }}>
        {rows.map(([k, v]) => (
          <div key={k} style={{ display: "contents" }}>
            <dt style={{ color: c.faint }}>{k}</dt>
            <dd style={{ margin: 0, fontFamily: k === "Code" || k === "Cause" ? font.mono : undefined, ...wrap }}>{v}</dd>
          </div>
        ))}
      </dl>
    </details>
  );
}

const REFUSED_TITLE: Record<Extract<SignInStepResult, { kind: "refused" }>["outcome"], string> = {
  expired: "Code expired",
  update: "Update needed",
  unreachable: "Community unreachable",
  invalid: "Code not accepted",
};

// ── The window ───────────────────────────────────────────────────────────────

export function SignInView({ flowId, send, uv, close, now }: SignInViewProps) {
  const sendStep =
    send ??
    ((step: SignInStep) =>
      chrome.runtime.sendMessage({ type: RUNTIME_SIGN_IN_STEP, flowId, ...step }) as Promise<RuntimeSignInStepResponse>);
  const passkey = uv ?? browserUv;
  const closeWindow = close ?? (() => window.close());
  const [clock] = useState(() => now ?? Date.now);

  const [screen, setScreen] = useState<SignInStepResult | { kind: "loading" }>({ kind: "loading" });
  const [portalOrigin, setPortalOrigin] = useState("");
  const [communityName, setCommunityName] = useState("");
  const [entryId, setEntryId] = useState("");
  const [identities, setIdentities] = useState<SignInIdentityView[]>([]);
  const [number, setNumber] = useState("");
  const [deadline, setDeadline] = useState<number | undefined>();
  const [busy, setBusy] = useState(false);
  const [note, setNote] = useState<string | undefined>();

  const run = async (step: SignInStep): Promise<SignInStepResult | undefined> => {
    setBusy(true);
    setNote(undefined);
    try {
      const res = await sendStep(step);
      if (!res || !res.ok) {
        setScreen({ kind: "failed", code: "sign-in/failed", message: res?.error ?? "The wallet did not answer." });
        return undefined;
      }
      if (res.result.kind === "confirm") {
        setPortalOrigin(res.result.portalOrigin);
        setCommunityName(res.result.communityName);
        setIdentities(res.result.identities);
        setEntryId(res.result.identities[0]?.entryId ?? "");
      }
      if (res.result.kind === "enter-number") setDeadline(res.result.decisionDeadline);
      if (res.result.kind !== "uv-challenge" && res.result.kind !== "uv-enrolled") setScreen(res.result);
      return res.result;
    } finally {
      setBusy(false);
    }
  };

  useEffect(() => {
    void run({ step: "prepare" });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const approve = async () => {
    // A cancelled gesture leaves the review open: the person may approve again
    // or decline. It is not a decision.
    const cancelled = (e: unknown) =>
      setNote(e instanceof PrfUnlockError && e.reason === "cancelled" ? "Approval cancelled." : String((e as Error).message ?? e));
    let challenge = await run({ step: "grant-digest" });
    if (challenge?.kind !== "uv-challenge") return;
    let enrolment = await passkey.stored();
    if (!enrolment || challenge.uvCredentialId !== enrolment.credentialId) {
      // The VTA holds no passkey for this browser (its first approval, a
      // second agent, or a holder onboarded again): enrol this browser's — a
      // new ES256 one only if it has none (C9) — and remember it only once the
      // VTA accepted it. Each device enrols its own; another device's passkey
      // is never this one's.
      if (!enrolment) {
        try {
          enrolment = await passkey.create();
        } catch (e) {
          cancelled(e);
          return;
        }
      }
      const enrolled = await run({ step: "enrol-uv", enrolment });
      if (enrolled?.kind !== "uv-enrolled") return;
      await passkey.remember(enrolment);
      // A fresh grant: the one above may have aged while the passkey was made.
      challenge = await run({ step: "grant-digest" });
      if (challenge?.kind !== "uv-challenge") return;
    }
    let assertion;
    try {
      assertion = await passkey.assert(enrolment.credentialId, challenge.challenge);
    } catch (e) {
      cancelled(e);
      return;
    }
    await run({ step: "respond", decision: "approve", assertion });
  };

  const who: Who | undefined = communityName ? { community: communityName, origin: portalOrigin } : undefined;
  const closeAction: Action = { label: "Close", run: closeWindow, testId: "close" };
  const declineToClose: Action = {
    label: "Decline",
    run: () => void run({ step: "cancel" }).then(closeWindow),
    disabled: busy,
    testId: "decline",
  };

  switch (screen.kind) {
    case "loading":
      return (
        <Screen title="Checking this sign-in code…">
          <Message muted>Your wallet is checking who sent this code. Nothing has been sent to anyone yet.</Message>
        </Screen>
      );

    case "refused":
      return (
        <Screen title={REFUSED_TITLE[screen.outcome] ?? "Sign in"} icon={<StatusIcon tone="warn" />} primary={closeAction} escape={closeAction}>
          <Message>{screen.message}</Message>
        </Screen>
      );

    case "not-member":
      return (
        <Screen title="Not one of your communities" icon={<StatusIcon tone="off" />} primary={closeAction} escape={closeAction}>
          <Message>
            You're not a member of {screen.contactLabel ? <strong style={wrap}>{screen.contactLabel}</strong> : "this community"}
            {screen.contactLabel ? " (unverified)" : ""}. Nothing was sent to it.
          </Message>
          <p style={{ margin: 0, color: c.muted }}>To sign in here, join the community first.</p>
        </Screen>
      );

    case "confirm":
      return (
        <Screen
          who={{ community: screen.communityName, origin: screen.portalOrigin }}
          title={`Sign in to ${screen.communityName}?`}
          primary={{ label: "Continue", run: () => void run({ step: "claim", entryId }), disabled: busy || !entryId, testId: "continue" }}
          secondary={declineToClose}
        >
          <p style={{ margin: 0, color: c.muted }}>Nothing is sent to the community until you continue.</p>
          <fieldset style={{ border: "none", margin: 0, padding: 0, display: "grid", gap: 8, minWidth: 0 }}>
            <legend style={{ ...microLabel, padding: 0, marginBottom: 8 }}>Sign in as</legend>
            {identities.map((i) => {
              const on = entryId === i.entryId;
              return (
                <label
                  key={i.entryId}
                  style={{
                    display: "grid",
                    gridTemplateColumns: "auto minmax(0, 1fr)",
                    gap: "2px 10px",
                    alignItems: "start",
                    padding: "10px 12px",
                    borderRadius: radius.md,
                    border: `1px solid ${on ? c.accent : c.line}`,
                    background: on ? c.accentSoft : c.surface,
                    cursor: "pointer",
                    minWidth: 0,
                  }}
                >
                  <input
                    type="radio"
                    name="identity"
                    value={i.entryId}
                    checked={on}
                    onChange={() => setEntryId(i.entryId)}
                    style={{ accentColor: c.accent, margin: "3px 0 0", padding: 0 }}
                  />
                  <span style={{ fontWeight: 600, ...wrap }}>{i.label}</span>
                  <span />
                  <ShortDid value={i.did} />
                </label>
              );
            })}
          </fieldset>
        </Screen>
      );

    case "enter-number":
      return (
        <Screen
          who={who}
          title="Type the number on the screen"
          primary={{
            label: "Continue",
            run: () => void run({ step: "prove", enteredNumber: number }),
            disabled: busy || number.length !== 2,
            testId: "prove",
          }}
          secondary={declineToClose}
        >
          {screen.nameMismatch !== undefined && (
            <Note tone="warn">
              <div data-testid="name-mismatch" style={wrap}>
                The community calls itself <Claimed value={screen.nameMismatch} />, but your wallet knows it as{" "}
                <strong style={wrap}>{communityName}</strong>. If you didn't expect that, decline.
              </div>
            </Note>
          )}
          <p style={{ margin: 0, ...wrap }}>
            The website at <Origin origin={portalOrigin} /> is showing a two-digit number. Type it here.
          </p>
          <div style={{ display: "grid", justifyItems: "center", gap: 8, padding: "6px 0 2px" }}>
            <input
              data-testid="number"
              inputMode="numeric"
              pattern="[0-9]*"
              autoComplete="off"
              autoFocus
              maxLength={2}
              aria-label="The two-digit number the website shows"
              value={number}
              onChange={(e) => setNumber(e.target.value.replace(/[^0-9]/g, "").slice(0, 2))}
              style={{
                fontFamily: font.mono,
                fontSize: 40,
                fontWeight: 600,
                fontVariantNumeric: "tabular-nums",
                width: 132,
                padding: "8px 0 8px 0.3em",
                letterSpacing: "0.3em",
                textAlign: "center",
                background: c.ground,
                color: c.text,
                border: `1.5px solid ${number.length === 2 ? c.accent : c.line}`,
                borderRadius: radius.md,
              }}
            />
            {deadline !== undefined && <Countdown deadline={deadline} now={clock} />}
          </div>
        </Screen>
      );

    case "review": {
      const locationUnknown = screen.location === "unknown";
      return (
        <Screen
          who={who}
          title="Approve this sign-in?"
          primary={{ label: "Approve", run: () => void approve(), disabled: busy, testId: "approve" }}
          secondary={{
            label: "Decline",
            run: () => void run({ step: "respond", decision: "decline" }),
            disabled: busy,
            testId: "decline",
          }}
        >
          <div
            style={{
              display: "grid",
              gap: 6,
              padding: "12px 14px",
              borderRadius: radius.md,
              background: c.raised,
              border: `1px solid ${c.lineSoft}`,
              minWidth: 0,
            }}
          >
            <div style={microLabel}>Request from · as the community reports it</div>
            <div data-testid="requester" style={{ fontWeight: 600, ...wrap }}>
              {screen.browser} on {screen.os} · {locationUnknown ? "location unknown" : `near ${screen.location}`} ·{" "}
              {new Date(screen.createdAt).toLocaleTimeString()}
            </div>
            <div
              data-testid="network"
              style={{ fontSize: t.sm, color: screen.network === "different" ? c.warn : screen.network === "same" ? c.ok : c.muted }}
            >
              {screen.network === "same"
                ? "Same network as this browser"
                : screen.network === "different"
                  ? "Not on this browser's network. If you didn't start this sign-in, decline."
                  : "Network: can't tell"}
            </div>
          </div>
          {locationUnknown && <Note tone="warn">The community could not tell where this request came from.</Note>}
          {screen.network === "different" && (
            <Note tone="warn">This request did not come from the network this browser is on.</Note>
          )}
          <p style={{ margin: 0, fontSize: t.sm, color: c.muted, ...wrap }}>
            This signs in that browser at {portalOrigin} as <ShortDid value={screen.identifiedAs} />, for this session
            only. Approving asks for your passkey.
          </p>
          {deadline !== undefined && <Countdown deadline={deadline} now={clock} />}
          {note && <Note tone="danger">{note}</Note>}
        </Screen>
      );
    }

    case "done":
      return screen.decision === "approve" ? (
        <Screen who={who} title="Approved" icon={<StatusIcon tone="ok" />} primary={closeAction} escape={closeAction}>
          <Message>Return to the website to continue.</Message>
        </Screen>
      ) : (
        <Screen who={who} title="Declined" icon={<StatusIcon tone="off" />} primary={closeAction} escape={closeAction}>
          <Message>Nothing was approved. You can close this window.</Message>
        </Screen>
      );

    case "failed":
      return (
        <Screen who={who} title="Sign-in stopped" icon={<StatusIcon tone="danger" />} primary={closeAction} escape={closeAction}>
          <Message>{screen.message}</Message>
          <FailureDetails result={screen} />
        </Screen>
      );

    case "uv-challenge":
    case "uv-enrolled":
      return null;
  }
}
