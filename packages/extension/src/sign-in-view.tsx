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
//      own reply is flagged here (VTI-LNK-104). When the community's signed
//      reply says the website asked for its operator console, this screen
//      says so first: "Sign in to <community> operator console at
//      <portal>?" — screen 1 cannot, because nothing has been sent yet.
//   3. "Request from <browser> on <os> · near <location> · <network>". Approve
//      runs the passkey over the grant digest (C6); Decline needs none.
//
// Screens 1 and 2 are skipped when there is nothing to decide (contract C11):
// with one identity (after one per DID) the claim goes out as the window
// opens, and the number comes from the page the code was clicked on, which the
// content script reads once the portal shows it. Screen 1 stays for a choice
// of identities; screen 2 for a portal that does not publish its number, or a
// community name that differs from the wallet's record. In between the window
// says "Signing in to <community>…". Screen 3 — where the request comes from —
// is never skipped.
//
// A refused link shows only the VTI-LNK-021 message for its outcome. When the
// cause is the contact's DID document or the page (never a link field), a
// collapsed "Details" says what is wrong, for the service's operator.
//
// A site the wallet does not know gets one of two screens before screen 1,
// both after its DID document verified and nothing sent to it: a DID hosting
// service is offered ("Use <host> to host your DIDs?" — yes records it and
// goes on to screen 1 for the same code); anything else is "Not one of your
// communities". A DID hosting service that has not put the member's DID on
// its access list ends on a screen with that DID and a Copy button.
//
// A community (VTC) the wallet does not know is offered to join, in two
// screens: "Join <host>?" (nothing sent; continuing asks the community, as a
// throwaway key, what it requires), then "Ask to join <host>" with what it
// asks for — an identity to apply as, the details it requests, and whether to
// be listed in its public registry — and Send request. An immediate admission
// goes on to screen 1 for the same code; a request an administrator has to
// decide ends on "Request sent"; a community that asks for evidence this
// wallet cannot provide ends on a screen that says what it asks for.
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
// that is more than a member's: "Operator console" once the community's signed
// step 1 says the link asks for the console's session.
//
// ## Approving without a passkey
//
// A browser with no PRF passkey (Linux Chromium, 1Password) approves with a
// PIN the agent checks, or on the person's phone. The review screen says which
// one this browser uses at this agent (`uvMethod`):
//
//   - passkey, or nothing set up yet: Approve runs the passkey as above. With
//     nothing set up, "Use a PIN or my phone instead" opens the chooser, and
//     so does Approve itself when the browser has no PRF or the passkey turns
//     out not to support it. The chooser offers "Set a PIN" (entered twice)
//     and "Approve on my phone" (from the phones the agent lists).
//   - PIN: Approve asks for it. A wrong one says how many tries are left; a
//     locked one says until when.
//   - phone: "Approve on your phone", with the code the phone shows, asking
//     again every couple of seconds until the phone answers, the time to
//     decide runs out, or the person cancels.

import { useEffect, useRef, useState, type CSSProperties, type ReactNode } from "react";

import {
  RUNTIME_SIGN_IN_STEP,
  type RuntimeSignInStepResponse,
  type SignInIdentityView,
  type SignInStep,
  type SignInStepResult,
  type SignInUvApproverView,
} from "./bridge-protocol.js";
import {
  PrfUnlockError,
  hasPrfEnrolment,
  runSignInApprovalCeremony,
} from "./webauthn-prf-unlock.js";
import { PrfUnavailableError, browserOffersPrf } from "./webauthn-prf-wrap.js";
import { encryptHolderSecretInPopup } from "./encrypt-holder.js";
import { base64url } from "@openvtc/vti-didcomm-js";
import {
  c,
  t,
  font,
  radius,
  microLabel,
  button,
  type ButtonKind,
} from "./theme.js";
import { Mark, Note } from "./ui.js";
import { collapseDid, type DidPart } from "./did-display.js";
import { failureDetails } from "./sign-in-failure.js";
import { UV_APPROVER_HELP } from "./sign-in-uv-messages.js";

/** The wallet passkey operations the window needs. Injected for tests. */
export interface UvPasskeyOps {
  /** Whether the wallet has its passkey yet. */
  enrolled: () => Promise<boolean>;
  /** Create it: encrypt the wallet at rest for `vtaDid` (one passkey prompt).
   *  The approval key is sealed under the same passkey. */
  enrol: (vtaDid: string) => Promise<void>;
  /** The ceremony bound to the grant; its PRF output. */
  unlock: (challengeB64u: string) => Promise<Uint8Array>;
  /** Whether the browser offers PRF at all (`undefined`: it cannot say).
   *  Defaults to `browserOffersPrf`. */
  offersPrf?: () => Promise<boolean | undefined>;
}

/** The passkey cannot hold the approval key here: no PRF in the browser or
 *  the authenticator. Another way to approve is offered instead. */
function prfUnavailable(e: unknown): boolean {
  return (
    e instanceof PrfUnavailableError ||
    (e instanceof PrfUnlockError && e.reason === "no-prf-output") ||
    (e as { name?: unknown })?.name === "NotSupportedError"
  );
}

/** The shortest PIN or passphrase (`UV_PIN_MIN_LENGTH` in core). */
const PIN_MIN = 6;

/** How often a phone approval asks again. */
const POLL_MS = 2000;

const browserUv: UvPasskeyOps = {
  offersPrf: browserOffersPrf,
  enrolled: hasPrfEnrolment,
  enrol: encryptHolderSecretInPopup,
  unlock: async (challenge) =>
    (await runSignInApprovalCeremony(chrome.runtime.id, challenge)).prfOutput,
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
  /** How long the Approved screen shows before the window closes itself.
   *  Injected so a test need not wait. */
  approvedCloseMs?: number;
  /** How often a phone approval asks again. Injected for the same reason. */
  pollMs?: number;
}

type ReviewResult = Extract<SignInStepResult, { kind: "review" }>;

/** Screens the window shows on its own, before anything is sent. */
type LocalScreen =
  | { kind: "loading" }
  | { kind: "connecting" }
  /** How should this browser approve? `noPrf`: a passkey can't. */
  | { kind: "uv-choose"; noPrf?: boolean }
  | { kind: "uv-set-pin" }
  /** The phones to approve on; `approvers` absent while they load. */
  | { kind: "uv-phone"; approvers?: SignInUvApproverView[]; error?: string };

/** Long enough to read "Approved", short enough that the website — which is
 *  already carrying on — is not left behind a window with nothing to do. */
const APPROVED_CLOSE_MS = 1200;

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
function ShortDid({
  value,
  toggle = false,
}: {
  value: string;
  toggle?: boolean;
}) {
  const [full, setFull] = useState(false);
  const parts = full
    ? [{ text: value, role: "opaque" as const }]
    : collapseDid(value);
  const shortened = parts.map((p) => p.text).join("") !== value;
  return (
    <span style={wrap}>
      <span
        title={value}
        style={{ fontFamily: font.mono, fontSize: t.sm, ...wrap }}
      >
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
          style={{
            ...button("quiet"),
            padding: "0 4px",
            fontSize: t.xs,
            color: c.accent,
            marginLeft: 4,
          }}
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
  return value.startsWith("did:") ? (
    <ShortDid value={value} toggle />
  ) : (
    <strong style={wrap}>{value}</strong>
  );
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
    <span
      data-testid={testId}
      title={origin}
      style={{ ...wrap, fontSize: t.md }}
    >
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
        <span
          style={{ fontWeight: 640, fontSize: t.sm, letterSpacing: "-0.01em" }}
        >
          VTA Wallet
        </span>
        <span style={{ marginLeft: "auto", fontSize: t.xs, color: c.faint }}>
          Sign-in request
        </span>
      </div>
      {who && (
        <div style={{ display: "grid", gap: 3, minWidth: 0 }}>
          <div style={microLabel}>Community · your wallet's record</div>
          <div
            data-testid="community"
            style={{
              fontSize: t.lg,
              fontWeight: 650,
              lineHeight: 1.25,
              ...wrap,
            }}
          >
            {who.community}
          </div>
          {who.subtitle && (
            <div
              data-testid="subtitle"
              style={{ fontSize: t.sm, color: c.muted, ...wrap }}
            >
              {who.subtitle}
            </div>
          )}
          <div
            style={{
              display: "flex",
              alignItems: "baseline",
              gap: 6,
              flexWrap: "wrap",
              marginTop: 4,
              minWidth: 0,
            }}
          >
            <span style={{ fontSize: t.sm, color: c.muted }}>at</span>
            <Origin origin={who.origin} testId="portal" />
          </div>
          <div style={{ fontSize: t.xs, color: c.faint }}>
            From its verified DID document. Check it matches the website's
            address.
          </div>
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
      if (
        e.defaultPrevented ||
        e.isComposing ||
        e.altKey ||
        e.ctrlKey ||
        e.metaKey
      )
        return;
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
        <div
          style={{
            display: "flex",
            alignItems: "center",
            gap: 10,
            minWidth: 0,
          }}
        >
          {icon}
          <h1
            style={{
              fontSize: t.md,
              fontWeight: 650,
              margin: 0,
              lineHeight: 1.3,
              ...wrap,
            }}
          >
            {title}
          </h1>
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

function Message({
  children,
  muted = false,
}: {
  children: ReactNode;
  muted?: boolean;
}) {
  return (
    <p
      data-testid="message"
      style={{ margin: 0, color: muted ? c.muted : c.text, ...wrap }}
    >
      {children}
    </p>
  );
}

function StatusIcon({ tone }: { tone: "ok" | "warn" | "danger" | "off" }) {
  const colour =
    tone === "ok"
      ? c.ok
      : tone === "warn"
        ? c.warn
        : tone === "danger"
          ? c.danger
          : c.faint;
  const soft =
    tone === "ok"
      ? c.okSoft
      : tone === "warn"
        ? c.warnSoft
        : tone === "danger"
          ? c.dangerSoft
          : c.raised;
  return (
    <span
      aria-hidden
      style={{
        width: 26,
        height: 26,
        borderRadius: 999,
        background: soft,
        display: "grid",
        placeItems: "center",
        flex: "none",
      }}
    >
      <svg
        width="14"
        height="14"
        viewBox="0 0 14 14"
        fill="none"
        stroke={colour}
        strokeWidth="2"
        strokeLinecap="round"
      >
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
      <div
        data-testid="countdown"
        style={{ fontSize: t.sm, color: c.warn, textAlign: "center" }}
      >
        The time to decide has passed. If the website refuses, refresh the code
        there.
      </div>
    );
  }
  const mmss = `${Math.floor(left / 60)}:${String(left % 60).padStart(2, "0")}`;
  return (
    <div
      data-testid="countdown"
      style={{
        fontSize: t.sm,
        color: left <= 20 ? c.warn : c.muted,
        textAlign: "center",
      }}
    >
      Time left to decide{" "}
      <span style={{ fontVariantNumeric: "tabular-nums", fontWeight: 600 }}>
        {mmss}
      </span>
    </div>
  );
}

function FailureDetails({
  result,
}: {
  result: Extract<SignInStepResult, { kind: "failed" | "refused" }>;
}) {
  const rows = failureDetails(result);
  if (rows.length === 0) return null;
  return (
    <details
      data-testid="failure-details"
      style={{ fontSize: t.xs, color: c.muted }}
    >
      <summary
        style={{ cursor: "pointer", color: c.muted, width: "fit-content" }}
      >
        Details
      </summary>
      <dl
        style={{
          display: "grid",
          gridTemplateColumns: "auto minmax(0, 1fr)",
          gap: "3px 12px",
          margin: "8px 0 0",
        }}
      >
        {rows.map(([k, v]) => (
          <div key={k} style={{ display: "contents" }}>
            <dt style={{ color: c.faint }}>{k}</dt>
            <dd
              style={{
                margin: 0,
                fontFamily:
                  k === "Code" || k === "Cause" ? font.mono : undefined,
                ...wrap,
              }}
            >
              {k === "DID" ? <CopyableDid did={v} testId="details-did" /> : v}
            </dd>
          </div>
        ))}
      </dl>
    </details>
  );
}

/** A DID shown whole, with a button that copies it. */
function CopyableDid({
  did,
  testId = "unlisted-did",
}: {
  did: string;
  testId?: string;
}) {
  const [copied, setCopied] = useState<"yes" | "no" | undefined>();
  const copy = () => {
    const clip = globalThis.navigator?.clipboard;
    if (!clip) {
      setCopied("no");
      return;
    }
    clip.writeText(did).then(
      () => setCopied("yes"),
      () => setCopied("no"),
    );
  };
  return (
    <div
      style={{
        display: "grid",
        gridTemplateColumns: "minmax(0, 1fr) auto",
        gap: 10,
        alignItems: "center",
        padding: "10px 12px",
        borderRadius: radius.md,
        background: c.raised,
        border: `1px solid ${c.lineSoft}`,
        minWidth: 0,
      }}
    >
      <code
        data-testid={testId}
        style={{ fontFamily: font.mono, fontSize: t.sm, ...wrap }}
      >
        {did}
      </code>
      <button
        type="button"
        data-testid="copy-did"
        onClick={copy}
        style={{ ...button("default"), fontSize: t.sm, padding: "5px 12px" }}
      >
        {copied === "yes" ? "Copied" : copied === "no" ? "Copy failed" : "Copy"}
      </button>
    </div>
  );
}

const REFUSED_TITLE: Record<
  Extract<SignInStepResult, { kind: "refused" }>["outcome"],
  string
> = {
  expired: "Code expired",
  update: "Update needed",
  unreachable: "Community unreachable",
  invalid: "Code not accepted",
};

// ── The window ───────────────────────────────────────────────────────────────

export function SignInView({
  flowId,
  send,
  uv,
  close,
  now,
  approvedCloseMs = APPROVED_CLOSE_MS,
  pollMs = POLL_MS,
}: SignInViewProps) {
  const sendStep =
    send ??
    ((step: SignInStep) =>
      chrome.runtime.sendMessage({
        type: RUNTIME_SIGN_IN_STEP,
        flowId,
        ...step,
      }) as Promise<RuntimeSignInStepResponse>);
  const passkey = uv ?? browserUv;
  const closeWindow = close ?? (() => window.close());
  const [clock] = useState(() => now ?? Date.now);

  const [screen, setScreen] = useState<SignInStepResult | LocalScreen>({
    kind: "loading",
  });
  const [review, setReview] = useState<ReviewResult | undefined>();
  const [pin, setPin] = useState("");
  const [pinAgain, setPinAgain] = useState("");
  const [approver, setApprover] = useState("");
  // Bumped to stop a phone approval's polling: a reply to an ask sent before
  // the bump is not shown.
  const pollGen = useRef(0);
  const [portalOrigin, setPortalOrigin] = useState("");
  const [communityName, setCommunityName] = useState("");
  const [entryId, setEntryId] = useState("");
  const [identities, setIdentities] = useState<SignInIdentityView[]>([]);
  const [joinDid, setJoinDid] = useState("");
  const [answers, setAnswers] = useState<Record<string, string>>({});
  const [registryConsent, setRegistryConsent] = useState(false);
  const [number, setNumber] = useState("");
  const [deadline, setDeadline] = useState<number | undefined>();
  const [busy, setBusy] = useState(false);
  const [note, setNote] = useState<string | undefined>();

  const run = async (
    step: SignInStep,
  ): Promise<SignInStepResult | undefined> => {
    setBusy(true);
    setNote(undefined);
    try {
      const res = await sendStep(step);
      if (!res || !res.ok) {
        setScreen({
          kind: "failed",
          code: "sign-in/failed",
          message: res?.error ?? "The wallet did not answer.",
        });
        return undefined;
      }
      if (res.result.kind === "confirm") {
        setPortalOrigin(res.result.portalOrigin);
        setCommunityName(res.result.communityName);
        setIdentities(res.result.identities);
        setEntryId(res.result.identities[0]?.entryId ?? "");
        // One identity is no choice: clicking the code on the verified portal
        // was the person's go-ahead, so the claim goes out without a Continue
        // (contract C3 step 6, as amended). With more than one, they pick.
        const only =
          res.result.identities.length === 1
            ? res.result.identities[0]!
            : undefined;
        if (only) {
          setScreen({ kind: "connecting" });
          return await run({ step: "claim", entryId: only.entryId });
        }
      }
      if (res.result.kind === "join-community")
        setPortalOrigin(res.result.portalOrigin);
      if (res.result.kind === "join-apply") {
        setPortalOrigin(res.result.portalOrigin);
        // Preselect only an identity used nowhere else, and only when it is
        // the one choice: picking for the person would link communities.
        const fresh = res.result.identities.filter((i) => !i.usedAt?.length);
        setJoinDid(
          res.result.identities.length === 1 && fresh.length === 1
            ? fresh[0]!.did
            : "",
        );
      }
      if (res.result.kind === "join-hosting") {
        setPortalOrigin(res.result.portalOrigin);
        setJoinDid(
          res.result.identities.length === 1
            ? res.result.identities[0]!.did
            : "",
        );
      }
      if (
        res.result.kind === "enter-number" ||
        res.result.kind === "review"
      )
        setDeadline(res.result.decisionDeadline);
      if (res.result.kind === "review") setReview(res.result);
      if (res.result.kind !== "uv-challenge" && res.result.kind !== "uv-approvers")
        setScreen(res.result);
      return res.result;
    } finally {
      setBusy(false);
    }
  };

  useEffect(() => {
    void run({ step: "prepare" });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Approved is the end of the person's part: the website redeems the grant on
  // its own, so the window closes itself rather than waiting on a Close click.
  // A decline or a failure stays open — those say something to read.
  const approved = screen.kind === "done" && screen.decision === "approve";
  useEffect(() => {
    if (!approved) return;
    const t = setTimeout(closeWindow, approvedCloseMs);
    return () => clearTimeout(t);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [approved]);

  // A phone approval asks again until the phone answers. Each answer is a new
  // screen object, so this runs once per ask.
  useEffect(() => {
    if (screen.kind !== "uv-pending") return;
    const gen = pollGen.current;
    const timer = setTimeout(() => {
      void (async () => {
        if (gen !== pollGen.current) return;
        if (deadline !== undefined && clock() >= deadline) {
          pollGen.current++;
          await sendStep({ step: "cancel" }).catch(() => undefined);
          setScreen({
            kind: "failed",
            code: "oobUvExpired",
            message:
              "Your phone didn't approve this sign-in in time. Refresh the code on the website and try again.",
          });
          return;
        }
        const res = await sendStep({ step: "respond", decision: "approve", remote: true }).catch(
          () => undefined,
        );
        if (gen !== pollGen.current) return;
        if (!res || !res.ok) {
          setScreen({
            kind: "failed",
            code: "sign-in/failed",
            message: res?.error ?? "The wallet did not answer.",
          });
          return;
        }
        // A fresh object each time, so a second "still waiting" is a new
        // screen and asks again.
        setScreen({ ...res.result });
      })();
    }, pollMs);
    return () => clearTimeout(timer);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [screen]);

  /** Back to the review: the person may approve again, or decline. */
  const backToReview = (message?: string) => {
    pollGen.current++;
    setPin("");
    setPinAgain("");
    if (review) setScreen(review);
    setNote(message);
  };

  const openChooser = (noPrf: boolean) => {
    setNote(undefined);
    setScreen(noPrf ? { kind: "uv-choose", noPrf: true } : { kind: "uv-choose" });
  };

  const approve = async () => {
    const method = review?.uvMethod;
    if (method === "vtaPin") {
      setPin("");
      setNote(undefined);
      setScreen({ kind: "uv-pin" });
      return;
    }
    if (method === "remoteApprover") {
      await approveOnPhone();
      return;
    }
    // A cancelled gesture leaves the review open: the person may approve again
    // or decline. It is not a decision.
    const cancelled = (e: unknown) =>
      setNote(
        e instanceof PrfUnlockError && e.reason === "cancelled"
          ? "Approval cancelled."
          : String((e as Error).message ?? e),
      );
    // Nothing set up, no passkey yet, and a browser that says it has no PRF:
    // a passkey made here could never hold the key, so don't make one.
    if (
      method === undefined &&
      !(await passkey.enrolled()) &&
      (await (passkey.offersPrf ?? browserOffersPrf)()) === false
    ) {
      openChooser(true);
      return;
    }
    const challenge = await run({ step: "grant-digest" });
    if (challenge?.kind !== "uv-challenge") return;
    let prfOutput: Uint8Array;
    try {
      // A wallet without its passkey makes it now: the approval key is sealed
      // under it, and it encrypts this agent's wallet record at rest too.
      if (!(await passkey.enrolled())) await passkey.enrol(challenge.vtaDid);
      prfOutput = await passkey.unlock(challenge.challenge);
    } catch (e) {
      if (method === undefined && prfUnavailable(e)) {
        openChooser(true);
        return;
      }
      cancelled(e);
      return;
    }
    await run({
      step: "respond",
      decision: "approve",
      prfOutputB64u: base64url.encode(prfOutput),
    });
  };

  /** Approve with the PIN typed; `setNew` enrols it first. The PIN goes to
   *  the wallet once and is cleared here. */
  const approveWithPin = async (setNew: boolean) => {
    const value = pin;
    setPin("");
    setPinAgain("");
    const challenge = await run({ step: "grant-digest" });
    if (challenge?.kind !== "uv-challenge") return;
    const r = await run(
      setNew
        ? { step: "respond", decision: "approve", pin: value, setPin: true }
        : { step: "respond", decision: "approve", pin: value },
    );
    if (setNew && r?.kind === "uv-pin" && review) setReview({ ...review, uvMethod: "vtaPin" });
  };

  /** Ask the phone; `chosen` enrols that phone first. */
  const approveOnPhone = async (chosen?: string) => {
    pollGen.current++;
    setNote(undefined);
    const challenge = await run({ step: "grant-digest" });
    if (challenge?.kind !== "uv-challenge") return;
    const r = await run({
      step: "respond",
      decision: "approve",
      remote: true,
      ...(chosen ? { approver: chosen } : {}),
    });
    if (chosen && r?.kind === "uv-pending" && review)
      setReview({ ...review, uvMethod: "remoteApprover" });
  };

  const pickPhone = async () => {
    setNote(undefined);
    setApprover("");
    setScreen({ kind: "uv-phone" });
    const res = await sendStep({ step: "uv-approvers" }).catch(() => undefined);
    if (!res || !res.ok) {
      setScreen({ kind: "uv-phone", approvers: [], error: res?.error ?? "The wallet did not answer." });
      return;
    }
    if (res.result.kind !== "uv-approvers") {
      setScreen(res.result);
      return;
    }
    const list = res.result.approvers;
    if (list.length === 1) setApprover(list[0]!.did);
    setScreen({
      kind: "uv-phone",
      approvers: list,
      ...(res.result.error ? { error: res.result.error } : {}),
    });
  };

  const who: Who | undefined = communityName
    ? { community: communityName, origin: portalOrigin }
    : undefined;
  const consoleWho: Who | undefined = who && {
    ...who,
    subtitle: "Operator console",
  };
  const closeAction: Action = {
    label: "Close",
    run: closeWindow,
    testId: "close",
  };
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
          <Message muted>
            Your wallet is checking who sent this code. Nothing has been sent to
            anyone yet.
          </Message>
        </Screen>
      );

    case "connecting":
      return (
        <Screen who={who} title={`Signing in to ${communityName}…`}>
          <Message muted>
            Matching the number the website shows. You'll approve the sign-in
            next.
          </Message>
        </Screen>
      );

    case "refused":
      return (
        <Screen
          title={REFUSED_TITLE[screen.outcome] ?? "Sign in"}
          icon={<StatusIcon tone="warn" />}
          primary={closeAction}
          escape={closeAction}
        >
          <Message>{screen.message}</Message>
          <FailureDetails result={screen} />
        </Screen>
      );

    case "join-hosting":
      return (
        <Screen
          title={`Use ${screen.host} to host your DIDs?`}
          primary={{
            label: `Use ${screen.host}`,
            run: () => void run({ step: "join", did: joinDid }),
            disabled: busy || !joinDid,
            testId: "join",
          }}
          secondary={{
            label: "Not now",
            run: () => void run({ step: "cancel" }).then(closeWindow),
            disabled: busy,
            testId: "decline",
          }}
        >
          <p style={{ margin: 0, ...wrap }}>
            <Origin origin={screen.portalOrigin} testId="portal" /> is a DID
            hosting service your wallet hasn't used before. Its address is from
            its verified DID document; check it matches the website's.
          </p>
          <p style={{ margin: 0, color: c.muted }}>
            Nothing has been sent to it. If you go ahead, your wallet remembers
            it and signs you in with the identity you choose.
          </p>
          {screen.identities.length === 0 ? (
            <Note tone="warn">
              <div data-testid="no-identities" style={wrap}>
                Your agent hosts no identities yet, so there is nothing to sign
                in as. Create one in the wallet and try again.
              </div>
            </Note>
          ) : (
            <fieldset
              style={{
                border: "none",
                margin: 0,
                padding: 0,
                display: "grid",
                gap: 8,
                minWidth: 0,
              }}
            >
              <legend style={{ ...microLabel, padding: 0, marginBottom: 8 }}>
                Sign in as
              </legend>
              {screen.identities.map((i) => {
                const on = joinDid === i.did;
                return (
                  <label
                    key={i.did}
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
                      name="persona"
                      value={i.did}
                      checked={on}
                      onChange={() => setJoinDid(i.did)}
                      style={{
                        accentColor: c.accent,
                        margin: "3px 0 0",
                        padding: 0,
                      }}
                    />
                    <ShortDid value={i.did} />
                    <span />
                    <span style={{ fontSize: t.xs, color: c.faint, ...wrap }}>
                      {i.contextId}
                    </span>
                  </label>
                );
              })}
            </fieldset>
          )}
          <p style={{ margin: 0, fontSize: t.sm, color: c.muted, ...wrap }}>
            {screen.host} admits only identities its operator has added. If it
            hasn't added this one yet, the wallet will show you the DID to send
            them.
          </p>
        </Screen>
      );

    case "join-community":
      return (
        <Screen
          title={`Join ${screen.host}?`}
          primary={{
            label: "See what it asks",
            run: () => void run({ step: "join-manifest" }),
            disabled: busy,
            testId: "join-manifest",
          }}
          secondary={{
            label: "Not now",
            run: () => void run({ step: "cancel" }).then(closeWindow),
            disabled: busy,
            testId: "decline",
          }}
        >
          <p style={{ margin: 0, ...wrap }}>
            <Origin origin={screen.portalOrigin} testId="portal" /> is a
            community you're not a member of. Its address is from its verified
            DID document; check it matches the website's.
          </p>
          <p style={{ margin: 0, color: c.muted }}>
            Nothing has been sent to it. If you continue, your wallet asks it
            what it requires to join, without saying who you are.
          </p>
        </Screen>
      );

    case "join-apply": {
      const missing = screen.attributes.some(
        (a) => a.required && !(answers[a.type] ?? "").trim(),
      );
      const send = () =>
        void run({
          step: "join-submit",
          did: joinDid,
          attributes: screen.attributes
            .map((a) => ({ type: a.type, value: (answers[a.type] ?? "").trim() }))
            .filter((a) => a.value !== ""),
          registryConsent,
        });
      return (
        <Screen
          title={`Ask to join ${screen.host}`}
          primary={{
            label: "Send request",
            run: send,
            disabled: busy || !joinDid || missing,
            testId: "join-submit",
          }}
          secondary={{
            label: "Not now",
            run: () => void run({ step: "cancel" }).then(closeWindow),
            disabled: busy,
            testId: "decline",
          }}
        >
          <p style={{ margin: 0, ...wrap }}>
            <Origin origin={screen.portalOrigin} testId="portal" />
            {screen.displayName ? (
              <>
                {" "}calls itself{" "}
                <strong data-testid="display-name" style={wrap}>
                  {screen.displayName}
                </strong>{" "}
                (its own word, not checked)
              </>
            ) : null}
            .{" "}
            <span data-testid="admission">
              {screen.admission === "automatic"
                ? "It admits members straight away."
                : "An administrator reviews each request."}
            </span>
          </p>
          {screen.directory ? (
            <section data-testid="directory-disclosure" style={{ display: "grid", gap: 6, minWidth: 0 }}>
              <div style={{ ...microLabel, padding: 0 }}>What the directory will show about you</div>
              <ul style={{ margin: 0, paddingLeft: 18, display: "grid", gap: 4, color: c.muted, ...wrap }}>
                {screen.directory.lines.map((line) => (
                  <li key={line}>{line}</li>
                ))}
              </ul>
            </section>
          ) : null}
          {screen.identities.length === 0 ? (
            <Note tone="warn">
              <div data-testid="no-identities" style={wrap}>
                Your agent hosts no identities yet, so there is nothing to join
                as. Create one in the wallet and try again.
              </div>
            </Note>
          ) : (
            <fieldset
              style={{
                border: "none",
                margin: 0,
                padding: 0,
                display: "grid",
                gap: 8,
                minWidth: 0,
              }}
            >
              <legend style={{ ...microLabel, padding: 0, marginBottom: 8 }}>
                Join as
              </legend>
              {screen.identities.map((i) => {
                const on = joinDid === i.did;
                return (
                  <label
                    key={i.did}
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
                      name="applicant"
                      value={i.did}
                      checked={on}
                      onChange={() => setJoinDid(i.did)}
                      style={{
                        accentColor: c.accent,
                        margin: "3px 0 0",
                        padding: 0,
                      }}
                    />
                    <ShortDid value={i.did} />
                    <span />
                    <span style={{ fontSize: t.xs, color: c.faint, ...wrap }}>
                      {i.usedAt?.length
                        ? `Also used at ${i.usedAt.join(", ")}`
                        : i.contextId}
                    </span>
                  </label>
                );
              })}
            </fieldset>
          )}
          {screen.attributes.length > 0 && (
            <div style={{ display: "grid", gap: 8, minWidth: 0 }}>
              <div style={{ ...microLabel }}>It asks you to tell it</div>
              {screen.attributes.map((a) => (
                <label
                  key={a.type}
                  style={{ display: "grid", gap: 4, minWidth: 0 }}
                >
                  <span style={{ fontSize: t.sm, ...wrap }}>
                    <code style={{ fontFamily: font.mono }}>{a.type}</code>
                    {a.required ? " (required)" : " (optional)"}
                    {a.purpose ? (
                      <span style={{ color: c.muted }}> — {a.purpose}</span>
                    ) : null}
                  </span>
                  <input
                    type="text"
                    data-testid={`attribute-${a.type}`}
                    autoComplete="off"
                    value={answers[a.type] ?? ""}
                    onChange={(e) =>
                      setAnswers((prev) => ({ ...prev, [a.type]: e.target.value }))
                    }
                    style={{
                      font: "inherit",
                      padding: "7px 10px",
                      background: c.ground,
                      color: c.text,
                      border: `1px solid ${c.line}`,
                      borderRadius: radius.md,
                      minWidth: 0,
                    }}
                  />
                </label>
              ))}
              <span style={{ fontSize: t.xs, color: c.faint }}>
                What you type is sent as you typed it, signed by the identity
                you join as.
              </span>
            </div>
          )}
          <label
            style={{
              display: "grid",
              gridTemplateColumns: "auto minmax(0, 1fr)",
              gap: 10,
              alignItems: "start",
              cursor: "pointer",
            }}
          >
            <input
              type="checkbox"
              data-testid="registry-consent"
              checked={registryConsent}
              onChange={(e) => setRegistryConsent(e.target.checked)}
              style={{ accentColor: c.accent, margin: "3px 0 0" }}
            />
            <span style={{ fontSize: t.sm, ...wrap }}>
              List me in {screen.host}'s public member registry
            </span>
          </label>
          <p style={{ margin: 0, fontSize: t.sm, color: c.muted, ...wrap }}>
            Sending the request tells {screen.host} the identity you chose.
            Your wallet remembers {screen.host} for that identity.
          </p>
        </Screen>
      );
    }

    case "join-elsewhere":
      return (
        <Screen
          title={
            screen.reason === "not-accepting"
              ? `${screen.host} isn't taking new members`
              : `${screen.host} needs more than your wallet can send`
          }
          icon={<StatusIcon tone="off" />}
          primary={closeAction}
          escape={closeAction}
        >
          {screen.reason === "not-accepting" ? (
            <Message>
              It isn't accepting requests to join right now. Nothing about you
              was sent to it.
            </Message>
          ) : (
            <>
              <Message>
                To join, it asks for something this wallet can't provide yet.
                Nothing about you was sent to it.
              </Message>
              <ul
                data-testid="join-needs"
                style={{ margin: 0, paddingLeft: 18, color: c.muted, ...wrap }}
              >
                {screen.needs.map((n) => (
                  <li key={n}>{n}</li>
                ))}
              </ul>
              <p style={{ margin: 0, color: c.muted, ...wrap }}>
                Ask the community how to join. Its verified address is{" "}
                <Origin origin={screen.portalOrigin} testId="portal" />.
              </p>
            </>
          )}
        </Screen>
      );

    case "join-pending":
      return (
        <Screen
          title="Request sent"
          icon={<StatusIcon tone="ok" />}
          primary={closeAction}
          escape={closeAction}
        >
          <Message>
            You can sign in once {screen.host} approves it. Nothing else was
            sent.
          </Message>
          {screen.needs?.length ? (
            <>
              <p style={{ margin: 0, color: c.muted, ...wrap }}>
                Before it decides, it asks for:
              </p>
              <ul
                data-testid="join-needs"
                style={{ margin: 0, paddingLeft: 18, color: c.muted, ...wrap }}
              >
                {screen.needs.map((n) => (
                  <li key={n}>{n}</li>
                ))}
              </ul>
            </>
          ) : null}
          <p style={{ margin: 0, color: c.muted, ...wrap }}>
            Sign in from <Origin origin={screen.portalOrigin} testId="portal" />{" "}
            once you're in.
          </p>
        </Screen>
      );

    case "not-member":
      return (
        <Screen
          title="Not one of your communities"
          icon={<StatusIcon tone="off" />}
          primary={closeAction}
          escape={closeAction}
        >
          <Message>
            You're not a member of{" "}
            {screen.contactLabel ? (
              <strong style={wrap}>{screen.contactLabel}</strong>
            ) : (
              "this community"
            )}
            {screen.contactLabel && !screen.portalOrigin ? " (unverified)" : ""}
            . Nothing was sent to it.
          </Message>
          {screen.portalOrigin && (
            <p style={{ margin: 0, color: c.muted, ...wrap }}>
              Its verified sign-in page is{" "}
              <Origin origin={screen.portalOrigin} testId="portal" />.
            </p>
          )}
          <p style={{ margin: 0, color: c.muted }}>
            To sign in here, join the community first.
          </p>
        </Screen>
      );

    case "confirm":
      return (
        <Screen
          who={{ community: screen.communityName, origin: screen.portalOrigin }}
          title={`Sign in to ${screen.communityName}?`}
          primary={{
            label: "Continue",
            run: () => void run({ step: "claim", entryId }),
            disabled: busy || !entryId,
            testId: "continue",
          }}
          secondary={declineToClose}
        >
          <p style={{ margin: 0, color: c.muted }}>
            Nothing is sent to the community until you continue.
          </p>
          <fieldset
            style={{
              border: "none",
              margin: 0,
              padding: 0,
              display: "grid",
              gap: 8,
              minWidth: 0,
            }}
          >
            <legend style={{ ...microLabel, padding: 0, marginBottom: 8 }}>
              Sign in as
            </legend>
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
                    style={{
                      accentColor: c.accent,
                      margin: "3px 0 0",
                      padding: 0,
                    }}
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
          who={screen.audience === "admin" ? consoleWho : who}
          title="Type the number on the screen"
          primary={{
            label: "Continue",
            run: () => void run({ step: "prove", enteredNumber: number }),
            disabled: busy || number.length !== 2,
            testId: "prove",
          }}
          secondary={declineToClose}
        >
          {screen.audience === "admin" && (
            <Note tone="accent">
              <div data-testid="operator-console" style={wrap}>
                This signs you in to the community's{" "}
                <strong>operator console</strong>, not its member portal. Only
                an identity the community holds as an administrator is admitted.
              </div>
            </Note>
          )}
          {screen.nameMismatch !== undefined && (
            <Note tone="warn">
              <div data-testid="name-mismatch" style={wrap}>
                The community calls itself{" "}
                <Claimed value={screen.nameMismatch} />, but your wallet knows
                it as <strong style={wrap}>{communityName}</strong>. If you
                didn't expect that, decline.
              </div>
              {/* The person's answer to the difference: their record takes
                  the community's name, and the sign-in goes on. Never for a
                  name that is a DID: that is shortened, and no one's name. */}
              {!/^did:/i.test(screen.nameMismatch.trim()) && (
                <button
                  type="button"
                  data-testid="adopt-name"
                  disabled={busy}
                  onClick={async () => {
                    const adopted = screen.nameMismatch!.trim().replace(/\s+/g, " ");
                    const r = await run({ step: "adopt-name" });
                    if (r && !(r.kind === "enter-number" && r.adoptFailed))
                      setCommunityName(adopted);
                  }}
                  style={{
                    ...button("default"),
                    marginTop: 8,
                    fontSize: t.sm,
                    padding: "5px 12px",
                    ...wrap,
                  }}
                >
                  Call it {screen.nameMismatch.trim()} in my wallet
                </button>
              )}
              {screen.adoptFailed !== undefined && (
                <div data-testid="adopt-failed" style={{ marginTop: 6, ...wrap }}>
                  Your wallet couldn't rename it: {screen.adoptFailed}
                </div>
              )}
            </Note>
          )}
          <p style={{ margin: 0, ...wrap }}>
            The website at <Origin origin={portalOrigin} /> is showing a
            two-digit number. Type it here.
          </p>
          <div
            style={{
              display: "grid",
              justifyItems: "center",
              gap: 8,
              padding: "6px 0 2px",
            }}
          >
            <input
              data-testid="number"
              inputMode="numeric"
              pattern="[0-9]*"
              autoComplete="off"
              autoFocus
              maxLength={2}
              aria-label="The two-digit number the website shows"
              value={number}
              onChange={(e) =>
                setNumber(e.target.value.replace(/[^0-9]/g, "").slice(0, 2))
              }
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
            {deadline !== undefined && (
              <Countdown deadline={deadline} now={clock} />
            )}
          </div>
        </Screen>
      );

    case "review": {
      const locationUnknown = screen.location === "unknown";
      return (
        <Screen
          who={screen.audience === "admin" ? consoleWho : who}
          title={
            screen.audience === "admin"
              ? "Approve this sign-in to the operator console?"
              : "Approve this sign-in?"
          }
          primary={{
            label: "Approve",
            run: () => void approve(),
            disabled: busy,
            testId: "approve",
          }}
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
            <div style={microLabel}>
              Request from · as the community reports it
            </div>
            <div data-testid="requester" style={{ fontWeight: 600, ...wrap }}>
              {screen.browser} on {screen.os} ·{" "}
              {locationUnknown ? "location unknown" : `near ${screen.location}`}{" "}
              · {new Date(screen.createdAt).toLocaleTimeString()}
            </div>
            <div
              data-testid="network"
              style={{
                fontSize: t.sm,
                color:
                  screen.network === "different"
                    ? c.warn
                    : screen.network === "same"
                      ? c.ok
                      : c.muted,
              }}
            >
              {screen.network === "same"
                ? "Same network as this browser"
                : screen.network === "different"
                  ? "Not on this browser's network. If you didn't start this sign-in, decline."
                  : "Network: can't tell"}
            </div>
          </div>
          {locationUnknown && (
            <Note tone="warn">
              The community could not tell where this request came from.
            </Note>
          )}
          {screen.network === "different" && (
            <Note tone="warn">
              This request did not come from the network this browser is on.
            </Note>
          )}
          <p style={{ margin: 0, fontSize: t.sm, color: c.muted, ...wrap }}>
            This signs in that browser
            {screen.audience === "admin" ? " to the operator console" : ""} at{" "}
            {portalOrigin} as <ShortDid value={screen.identifiedAs} />, for this
            session only.{" "}
            {screen.uvMethod === "vtaPin"
              ? "Approving asks for your PIN."
              : screen.uvMethod === "remoteApprover"
                ? "Approving asks your phone."
                : "Approving asks for your passkey."}
          </p>
          {screen.uvMethod === undefined && (
            <button
              type="button"
              data-testid="uv-other"
              disabled={busy}
              onClick={() => openChooser(false)}
              style={{
                ...button("quiet"),
                justifySelf: "start",
                padding: "0 2px",
                fontSize: t.sm,
                color: c.accent,
              }}
            >
              Use a PIN or my phone instead
            </button>
          )}
          {screen.signingScope && screen.signingScope.length > 0 && (
            <Note tone="accent">
              <span data-testid="signing-scope">
                It also lets that browser act as you, for this session, in:{" "}
                {screen.signingScope.map(scopeLabel).join(", ")}.
              </span>
            </Note>
          )}
          {deadline !== undefined && (
            <Countdown deadline={deadline} now={clock} />
          )}
          {note && <Note tone="danger">{note}</Note>}
        </Screen>
      );
    }

    case "done":
      return screen.decision === "approve" ? (
        <Screen
          who={who}
          title="Approved"
          icon={<StatusIcon tone="ok" />}
          primary={closeAction}
          escape={closeAction}
        >
          <Message>Taking you back to the website…</Message>
        </Screen>
      ) : (
        <Screen
          who={who}
          title="Declined"
          icon={<StatusIcon tone="off" />}
          primary={closeAction}
          escape={closeAction}
        >
          <Message>Nothing was approved. You can close this window.</Message>
        </Screen>
      );

    case "failed":
      if (screen.unlisted)
        return (
          <Screen
            who={who}
            title={`${screen.unlisted.host} hasn't added you yet`}
            icon={<StatusIcon tone="warn" />}
            primary={closeAction}
            escape={closeAction}
          >
            <Message>{screen.message}</Message>
            <CopyableDid did={screen.unlisted.did} />
            <p style={{ margin: 0, color: c.muted, ...wrap }}>
              Once it's on {screen.unlisted.host}'s access list, refresh the
              code on the website and sign in again.
            </p>
            <FailureDetails result={screen} />
          </Screen>
        );
      return (
        <Screen
          who={who}
          title="Sign-in stopped"
          icon={<StatusIcon tone="danger" />}
          primary={closeAction}
          escape={closeAction}
        >
          <Message>{screen.message}</Message>
          <FailureDetails result={screen} />
        </Screen>
      );

    case "uv-choose":
      return (
        <Screen
          who={who}
          title="How should this browser approve sign-ins?"
          secondary={{ label: "Back", run: () => backToReview(), testId: "back" }}
        >
          {screen.noPrf && (
            <Note tone="warn">
              <span data-testid="no-prf">
                This browser can't keep a passkey for approving. Choose another
                way.
              </span>
            </Note>
          )}
          <Choice
            testId="choose-pin"
            title="Set a PIN"
            run={() => {
              setPin("");
              setPinAgain("");
              setScreen({ kind: "uv-set-pin" });
            }}
          >
            You type it each time you approve. Your agent checks it, and locks
            it for a while after 5 wrong tries.
          </Choice>
          <Choice testId="choose-phone" title="Approve on my phone" run={() => void pickPhone()}>
            The wallet app on your phone asks you to approve each sign-in.
          </Choice>
          <p style={{ margin: 0, fontSize: t.sm, color: c.muted }}>
            Your wallet remembers this for your agent. You can change it in
            Settings.
          </p>
        </Screen>
      );

    case "uv-set-pin": {
      const tooShort = pin.normalize("NFC").length < PIN_MIN;
      const differ = pinAgain.length > 0 && pin !== pinAgain;
      return (
        <Screen
          who={who}
          title="Set a PIN"
          primary={{
            label: "Set PIN and approve",
            run: () => void approveWithPin(true),
            disabled: busy || tooShort || pin !== pinAgain,
            testId: "set-pin",
          }}
          secondary={{ label: "Back", run: () => openChooser(false), disabled: busy, testId: "back" }}
        >
          <Message>
            You'll type this PIN each time you approve a sign-in from this
            browser. Use {PIN_MIN} or more characters: digits or a passphrase.
          </Message>
          <PinField testId="pin" label="PIN" value={pin} onChange={setPin} autoFocus />
          <PinField testId="pin-again" label="PIN again" value={pinAgain} onChange={setPinAgain} />
          {differ && (
            <Note tone="danger">
              <span data-testid="pin-mismatch">The two PINs don't match.</span>
            </Note>
          )}
          {deadline !== undefined && <Countdown deadline={deadline} now={clock} />}
          {note && <Note tone="danger">{note}</Note>}
        </Screen>
      );
    }

    case "uv-phone":
      return (
        <Screen
          who={who}
          title="Approve on my phone"
          primary={{
            label: "Use this phone",
            run: () => void approveOnPhone(approver),
            disabled: busy || !approver,
            testId: "use-phone",
          }}
          secondary={{ label: "Back", run: () => openChooser(false), disabled: busy, testId: "back" }}
        >
          {screen.approvers === undefined ? (
            <Message muted>Asking your agent for your phone…</Message>
          ) : screen.approvers.length === 0 ? (
            <Note tone="warn">
              <div data-testid="no-phones" style={wrap}>
                {UV_APPROVER_HELP}
                {screen.error && (
                  <div style={{ marginTop: 6, color: c.muted }}>
                    Your agent said: {screen.error}
                  </div>
                )}
              </div>
            </Note>
          ) : (
            <fieldset
              style={{ border: "none", margin: 0, padding: 0, display: "grid", gap: 8, minWidth: 0 }}
            >
              <legend style={{ ...microLabel, marginBottom: 6 }}>Your phones</legend>
              {screen.approvers.map((a) => (
                <label
                  key={a.did}
                  style={{ display: "flex", gap: 10, alignItems: "center", cursor: "pointer", minWidth: 0 }}
                >
                  <input
                    type="radio"
                    name="approver"
                    data-testid="approver"
                    checked={approver === a.did}
                    onChange={() => setApprover(a.did)}
                  />
                  <span style={{ display: "grid", minWidth: 0 }}>
                    <strong style={wrap}>{a.displayName ?? "Phone"}</strong>
                    <ShortDid value={a.did} />
                  </span>
                </label>
              ))}
            </fieldset>
          )}
          <p style={{ margin: 0, fontSize: t.sm, color: c.muted }}>
            Your phone will ask you to approve this sign-in and each one after
            it from this browser.
          </p>
          {note && <Note tone="danger">{note}</Note>}
        </Screen>
      );

    case "uv-pin": {
      const locked = screen.lockedUntil !== undefined && screen.lockedUntil > clock();
      return (
        <Screen
          who={who}
          title="Enter your PIN"
          primary={{
            label: "Approve",
            run: () => void approveWithPin(false),
            disabled: busy || locked || pin.length === 0,
            testId: "approve-pin",
          }}
          secondary={{ label: "Back", run: () => backToReview(), disabled: busy, testId: "back" }}
        >
          <Message>Type the PIN you set for approving sign-ins from this browser.</Message>
          {screen.attemptsRemaining !== undefined && screen.lockedUntil === undefined && (
            <Note tone="danger">
              <span data-testid="pin-wrong">
                Wrong PIN.{" "}
                {screen.attemptsRemaining === 1
                  ? "1 try left before it locks."
                  : `${screen.attemptsRemaining} tries left before it locks.`}
              </span>
            </Note>
          )}
          {screen.lockedUntil !== undefined && (
            <Note tone="warn">
              <span data-testid="pin-locked">
                Too many wrong PINs. Locked until{" "}
                {new Date(screen.lockedUntil).toLocaleTimeString()}.
              </span>
            </Note>
          )}
          <PinField testId="pin" label="PIN" value={pin} onChange={setPin} autoFocus disabled={locked} />
          {deadline !== undefined && <Countdown deadline={deadline} now={clock} />}
        </Screen>
      );
    }

    case "uv-pending":
      return (
        <Screen
          who={who}
          title="Approve on your phone"
          secondary={{
            label: "Cancel",
            run: () => backToReview("Approval cancelled."),
            testId: "cancel-phone",
          }}
        >
          <Message>
            Your phone is asking you to approve this sign-in. Check it shows
            this code, then approve there.
          </Message>
          {screen.matchCode && (
            <div
              data-testid="match-code"
              style={{
                fontFamily: font.mono,
                fontSize: 36,
                fontWeight: 600,
                letterSpacing: "0.2em",
                textAlign: "center",
                fontVariantNumeric: "tabular-nums",
              }}
            >
              {screen.matchCode}
            </div>
          )}
          <Message muted>Waiting for your phone…</Message>
          {deadline !== undefined && <Countdown deadline={deadline} now={clock} />}
        </Screen>
      );

    case "uv-challenge":
    case "uv-approvers":
      return null;
  }
}

/** One way to approve, on the chooser: a large button with a line under it. */
function Choice({
  title,
  testId,
  run,
  children,
}: {
  title: string;
  testId: string;
  run: () => void;
  children: ReactNode;
}) {
  return (
    <button
      type="button"
      data-testid={testId}
      onClick={run}
      style={{
        ...button("default"),
        display: "grid",
        gap: 4,
        textAlign: "left",
        padding: "12px 14px",
        borderRadius: radius.md,
        minWidth: 0,
      }}
    >
      <strong style={{ fontSize: t.base }}>{title}</strong>
      <span style={{ fontSize: t.sm, color: c.muted, fontWeight: 400, ...wrap }}>{children}</span>
    </button>
  );
}

/** A PIN or passphrase, hidden as it is typed. */
function PinField({
  label,
  value,
  onChange,
  testId,
  autoFocus = false,
  disabled = false,
}: {
  label: string;
  value: string;
  onChange: (v: string) => void;
  testId: string;
  autoFocus?: boolean;
  disabled?: boolean;
}) {
  return (
    <label style={{ display: "grid", gap: 4, minWidth: 0 }}>
      <span style={microLabel}>{label}</span>
      <input
        type="password"
        data-testid={testId}
        autoComplete="off"
        autoFocus={autoFocus}
        disabled={disabled}
        value={value}
        onChange={(e) => onChange(e.target.value)}
        style={{
          fontFamily: font.mono,
          fontSize: t.md,
          padding: "8px 10px",
          background: c.ground,
          color: c.text,
          border: `1.5px solid ${c.line}`,
          borderRadius: radius.md,
          minWidth: 0,
        }}
      />
    </label>
  );
}

/** What a signing-scope family lets the website do, in words. An unknown
 *  family is shown as itself. */
function scopeLabel(family: string): string {
  switch (family) {
    case "vtc/directory":
      return "the member directory (reading it, and editing your own card)";
    case "vtc/groups":
      return "community groups";
    default:
      return family;
  }
}
