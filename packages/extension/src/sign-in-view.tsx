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

import { useEffect, useState, type ReactNode } from "react";

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
}

const label: React.CSSProperties = {
  fontSize: 10.5,
  fontWeight: 700,
  letterSpacing: 0.6,
  textTransform: "uppercase",
  color: "var(--w-muted)",
  marginBottom: 4,
};
const box: React.CSSProperties = {
  border: "1px solid var(--w-line)",
  borderRadius: 8,
  padding: 12,
  marginBottom: 12,
};
const warn: React.CSSProperties = { ...box, borderColor: "var(--w-warn)", color: "var(--w-warn)" };
const row: React.CSSProperties = { display: "flex", gap: 8, justifyContent: "flex-end", marginTop: 16 };

function Screen({ title, children }: { title: string; children: ReactNode }) {
  return (
    <div style={{ padding: 20, maxWidth: 560, margin: "0 auto" }}>
      <h1 style={{ fontSize: 18, margin: "0 0 14px" }}>{title}</h1>
      {children}
    </div>
  );
}

export function SignInView({ flowId, send, uv, close }: SignInViewProps) {
  const sendStep =
    send ??
    ((step: SignInStep) =>
      chrome.runtime.sendMessage({ type: RUNTIME_SIGN_IN_STEP, flowId, ...step }) as Promise<RuntimeSignInStepResponse>);
  const passkey = uv ?? browserUv;
  const closeWindow = close ?? (() => window.close());

  const [screen, setScreen] = useState<SignInStepResult | { kind: "loading" }>({ kind: "loading" });
  const [portalOrigin, setPortalOrigin] = useState("");
  const [communityName, setCommunityName] = useState("");
  const [entryId, setEntryId] = useState("");
  const [identities, setIdentities] = useState<SignInIdentityView[]>([]);
  const [number, setNumber] = useState("");
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

  switch (screen.kind) {
    case "loading":
      return <Screen title="Checking this sign-in code…">{null}</Screen>;

    case "refused":
      return (
        <Screen title="Sign in">
          <p data-testid="message">{screen.message}</p>
          <div style={row}>
            <button onClick={closeWindow}>Close</button>
          </div>
        </Screen>
      );

    case "not-member":
      return (
        <Screen title="Not one of your communities">
          <p data-testid="message">
            You're not a member of {screen.contactLabel ? <strong>{screen.contactLabel}</strong> : "this community"}
            {screen.contactLabel ? " (unverified)" : ""}. Nothing was sent to it.
          </p>
          <p style={{ color: "var(--w-muted)" }}>To sign in here, join the community first.</p>
          <div style={row}>
            <button onClick={closeWindow}>Close</button>
          </div>
        </Screen>
      );

    case "confirm":
      return (
        <Screen title={`Sign in to ${screen.communityName}?`}>
          <div style={box}>
            <div style={label}>Community (your wallet's record)</div>
            <div data-testid="community">{screen.communityName}</div>
            <div style={{ ...label, marginTop: 10 }}>At (from its verified DID document)</div>
            <div data-testid="portal">{screen.portalOrigin}</div>
          </div>
          <div style={box}>
            <div style={label}>Sign in as</div>
            {identities.map((i) => (
              <label key={i.entryId} style={{ display: "block", padding: "4px 0" }}>
                <input
                  type="radio"
                  name="identity"
                  value={i.entryId}
                  checked={entryId === i.entryId}
                  onChange={() => setEntryId(i.entryId)}
                />{" "}
                {i.label} <code style={{ fontSize: 11, color: "var(--w-muted)" }}>{i.did}</code>
              </label>
            ))}
          </div>
          <div style={row}>
            <button disabled={busy} onClick={() => void run({ step: "cancel" }).then(closeWindow)}>
              Decline
            </button>
            <button data-testid="continue" disabled={busy || !entryId} onClick={() => void run({ step: "claim", entryId })}>
              Continue
            </button>
          </div>
        </Screen>
      );

    case "enter-number":
      return (
        <Screen title="Type the number on the screen">
          {screen.nameMismatch !== undefined && (
            <div style={warn} data-testid="name-mismatch">
              The community calls itself <strong>{screen.nameMismatch}</strong>, not{" "}
              <strong>{communityName}</strong> as your wallet has it. If that is unexpected, decline.
            </div>
          )}
          <p>
            The website at <strong>{portalOrigin}</strong> is showing a two-digit number.
          </p>
          <input
            data-testid="number"
            inputMode="numeric"
            autoFocus
            maxLength={2}
            value={number}
            onChange={(e) => setNumber(e.target.value.replace(/[^0-9]/g, "").slice(0, 2))}
            style={{ fontSize: 28, width: 80, textAlign: "center", letterSpacing: 4 }}
          />
          <div style={row}>
            <button disabled={busy} onClick={() => void run({ step: "cancel" }).then(closeWindow)}>
              Decline
            </button>
            <button
              data-testid="prove"
              disabled={busy || number.length !== 2}
              onClick={() => void run({ step: "prove", enteredNumber: number })}
            >
              Continue
            </button>
          </div>
        </Screen>
      );

    case "review": {
      const locationUnknown = screen.location === "unknown";
      return (
        <Screen title="Approve this sign-in?">
          <div style={box}>
            <div style={label}>Request from (as reported by the community)</div>
            <div data-testid="requester">
              {screen.browser} on {screen.os} · {locationUnknown ? "location unknown" : `near ${screen.location}`} ·{" "}
              {new Date(screen.createdAt).toLocaleTimeString()}
            </div>
            <div data-testid="network" style={{ marginTop: 6 }}>
              {screen.network === "same"
                ? "Same network as this browser"
                : screen.network === "different"
                  ? "Not on this browser's network. If you didn't start this sign-in, decline."
                  : "Network: can't tell"}
            </div>
          </div>
          {locationUnknown && (
            <div style={warn}>The community could not tell where this request came from.</div>
          )}
          {screen.network === "different" && (
            <div style={warn}>This request did not come from the network this browser is on.</div>
          )}
          <p style={{ color: "var(--w-muted)" }}>
            This signs in that browser at {portalOrigin} as {screen.identifiedAs}, for this session only.
          </p>
          {note && <p style={{ color: "var(--w-warn)" }}>{note}</p>}
          <div style={row}>
            <button disabled={busy} onClick={() => void run({ step: "respond", decision: "decline" })}>
              Decline
            </button>
            <button data-testid="approve" disabled={busy} onClick={() => void approve()}>
              Approve
            </button>
          </div>
        </Screen>
      );
    }

    case "done":
      return (
        <Screen title={screen.decision === "approve" ? "Approved" : "Declined"}>
          <p data-testid="message">
            {screen.decision === "approve"
              ? "Return to the website to continue."
              : "Nothing was approved. You can close this window."}
          </p>
          <div style={row}>
            <button onClick={closeWindow}>Close</button>
          </div>
        </Screen>
      );

    case "failed":
      return (
        <Screen title="Sign-in stopped">
          <p data-testid="message">{screen.message}</p>
          <div style={row}>
            <button onClick={closeWindow}>Close</button>
          </div>
        </Screen>
      );

    case "uv-challenge":
    case "uv-enrolled":
      return null;
  }
}
