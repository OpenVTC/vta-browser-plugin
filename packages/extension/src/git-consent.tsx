// The wallet's own window for a member's forge account at a community
// (`git-page.ts`). The page never draws this: it is how the person sees, before
// anything is signed, which forge, which identity and what the community will
// do with the account — and, once a link is begun, where to authorise it and
// the code to type, which never reach the page.
//
// Every line is the wallet's; the community's name is the member's own label
// for it and the URL the community's answer, checked to be `https:`, so all of
// it is rendered as text. There is nothing to remember: every link is asked for
// afresh.

import { useEffect, useState } from "react";

import { GIT_CONSENT_PREFIX, type GitConsentView } from "./git-page.js";
import { Did } from "./ui.js";

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

const primary: React.CSSProperties = {
  padding: "8px 18px",
  fontSize: 13,
  fontWeight: 700,
  border: "none",
  borderRadius: 8,
  color: "var(--w-accent-ink)",
  background: "var(--w-accent)",
  cursor: "pointer",
};

export function GitConsent({ consentId, decide }: { consentId: string; decide: (approved: boolean) => void }) {
  const [view, setView] = useState<GitConsentView | null>(null);
  useEffect(() => {
    const key = `${GIT_CONSENT_PREFIX}${consentId}`;
    void chrome.storage.session.get(key).then((v: Record<string, unknown>) => {
      setView((v[key] as GitConsentView) ?? null);
    });
  }, [consentId]);

  if (!view) return <div style={{ padding: 20, fontSize: 13 }}>Loading request…</div>;
  if (view.kind === "authorise") return <Authorise view={view} done={() => decide(true)} />;

  const linking = view.kind === "linkAccount";
  return (
    <div style={{ padding: 20, fontSize: 13, display: "grid", gap: 14 }}>
      <strong style={{ fontSize: 14 }}>
        {linking ? `Link your ${view.forge} account to ${view.communityName}?` : `Unlink your ${view.forge} account from ${view.communityName}?`}
      </strong>
      <div style={{ color: "var(--w-muted)", lineHeight: 1.45 }} data-testid="git-consent-meaning">
        {linking ? (
          <>
            <p style={{ margin: "0 0 6px" }}>
              {view.communityName} will give the account you authorise on {view.forge} the roles your rights
              on its repositories call for, and take them away when your rights end.
            </p>
            <p style={{ margin: "0 0 6px" }}>
              The wallet opens {view.forge} for you to authorise it. Sign in there with your own account only.
            </p>
          </>
        ) : (
          <p style={{ margin: "0 0 6px" }}>
            {view.communityName} will stop treating the account as yours and withdraw the roles it gave it
            on {view.forge}. Your rights stay as they are.
          </p>
        )}
        <p style={{ margin: 0 }}>Asked for by {originHost(view.origin)}.</p>
      </div>
      <div>
        <div style={label}>Signed as</div>
        <div style={card}>
          <Did value={view.member} />
        </div>
      </div>
      <div style={{ display: "flex", justifyContent: "flex-end", gap: 8, marginTop: 8 }}>
        <button autoFocus onClick={() => decide(false)} style={{ padding: "8px 16px", fontSize: 13 }}>
          Cancel
        </button>
        <button onClick={() => decide(true)} style={primary}>
          {linking ? "Sign and link" : "Sign and unlink"}
        </button>
      </div>
    </div>
  );
}

function Authorise({ view, done }: { view: Extract<GitConsentView, { kind: "authorise" }>; done: () => void }) {
  return (
    <div style={{ padding: 20, fontSize: 13, display: "grid", gap: 14 }}>
      <strong style={{ fontSize: 14 }}>Authorise the link on {view.forge}</strong>
      <p style={{ color: "var(--w-muted)", lineHeight: 1.45, margin: 0 }}>
        The wallet opened {view.forge} in a new tab.
        {view.userCode ? " Enter this code there:" : " Approve the request there."}
      </p>
      {view.userCode && (
        <div
          style={{ ...card, fontSize: 22, fontWeight: 700, letterSpacing: 2, textAlign: "center", fontFamily: "monospace" }}
          data-testid="git-consent-code"
        >
          {view.userCode}
        </div>
      )}
      <p style={{ color: "var(--w-muted)", lineHeight: 1.45, margin: 0 }}>
        Do it before {new Date(view.expiresAt).toLocaleTimeString()}. {view.communityName}&rsquo;s portal shows
        when the link is done. Never type this code anywhere but {view.forge}.
      </p>
      <div style={{ ...card, wordBreak: "break-all" }}>
        <a href={view.url} target="_blank" rel="noopener noreferrer">
          {view.url}
        </a>
      </div>
      <div style={{ display: "flex", justifyContent: "flex-end" }}>
        <button autoFocus onClick={done} style={primary}>
          Done
        </button>
      </div>
    </div>
  );
}
