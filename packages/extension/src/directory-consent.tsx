// The wallet's own window for publishing a member's directory card
// (`directory-page.ts`). The page never draws this: it is how the person sees,
// before anything is signed, that anyone — outside the community too — will be
// able to read the card, and every value it carries (VTI-REG-004 item 2).
//
// Every line is the wallet's, built from the member's card; the values are the
// member's own and the field labels the community's, so all of it is rendered
// as text, never markup. There is nothing to remember: every publication is
// asked for afresh.
//
// It also asks, once per community, whether that community's portal may show
// and change the member's own marks on other members — stars, petnames, lists
// (`directory-page.ts`). That answer is remembered until the member withdraws
// it, because asking on every star would make the marks unusable.

import { useEffect, useState } from "react";

import {
  DIRECTORY_CONSENT_PREFIX,
  type DirectoryMarksConsentView,
  type DirectoryPublishConsentView,
} from "./directory-page.js";
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

export function DirectoryConsent({
  consentId,
  decide,
}: {
  consentId: string;
  decide: (approved: boolean) => void;
}) {
  const [view, setView] = useState<DirectoryPublishConsentView | DirectoryMarksConsentView | null>(null);
  useEffect(() => {
    const key = `${DIRECTORY_CONSENT_PREFIX}${consentId}`;
    void chrome.storage.session.get(key).then((v: Record<string, unknown>) => {
      setView((v[key] as DirectoryPublishConsentView | DirectoryMarksConsentView) ?? null);
    });
  }, [consentId]);

  if (!view) return <div style={{ padding: 20, fontSize: 13 }}>Loading request…</div>;
  if (view.kind === "marksAccess") return <MarksAccess view={view} decide={decide} />;
  return (
    <div style={{ padding: 20, fontSize: 13, display: "grid", gap: 14 }}>
      <strong style={{ fontSize: 14 }}>Publish your card from {view.communityName}?</strong>
      <div style={{ color: "var(--w-muted)", lineHeight: 1.45 }} data-testid="directory-consent-meaning">
        {view.meaning.map((l) => (
          <p key={l} style={{ margin: "0 0 6px" }}>
            {l}
          </p>
        ))}
        <p style={{ margin: 0 }}>Asked for by {originHost(view.origin)}.</p>
      </div>
      <div>
        <div style={label}>What anyone will be able to read</div>
        <div style={{ ...card, whiteSpace: "pre-wrap", wordBreak: "break-word" }} data-testid="directory-consent-values">
          {view.values.length === 0 ? (
            <span>Nothing: none of your card is shown to anyone.</span>
          ) : (
            view.values.map((l) => <div key={l}>{l}</div>)
          )}
        </div>
      </div>
      <div>
        <div style={label}>Signed as</div>
        <div style={card}>
          <Did value={view.member} />
        </div>
      </div>
      <p style={{ color: "var(--w-muted)", lineHeight: 1.45, margin: 0 }}>{view.closing}</p>
      <div style={{ display: "flex", justifyContent: "flex-end", gap: 8, marginTop: 8 }}>
        <button autoFocus onClick={() => decide(false)} style={{ padding: "8px 16px", fontSize: 13 }}>
          Don&rsquo;t publish
        </button>
        <button
          onClick={() => decide(true)}
          style={{
            padding: "8px 18px",
            fontSize: 13,
            fontWeight: 700,
            border: "none",
            borderRadius: 8,
            color: "var(--w-accent-ink)",
            background: "var(--w-accent)",
            cursor: "pointer",
          }}
        >
          Sign and publish
        </button>
      </div>
    </div>
  );
}

/** Whether a community's portal may show and change the member's own marks. */
function MarksAccess({
  view,
  decide,
}: {
  view: DirectoryMarksConsentView;
  decide: (approved: boolean) => void;
}) {
  return (
    <div style={{ padding: 20, fontSize: 13, display: "grid", gap: 14 }}>
      <strong style={{ fontSize: 14 }}>Show your stars and lists on {view.communityName}&rsquo;s portal?</strong>
      <div style={{ color: "var(--w-muted)", lineHeight: 1.45 }} data-testid="directory-marks-meaning">
        <p style={{ margin: "0 0 6px" }}>
          Your stars, the names you give people and your lists are yours: your wallet keeps them, not{" "}
          {view.communityName}.
        </p>
        <p style={{ margin: "0 0 6px" }}>
          To show them beside its directory, {originHost(view.origin)} asks to read and change the ones you keep
          for this community&rsquo;s members. The portal is {view.communityName}&rsquo;s own page, so allowing
          this means {view.communityName} could see them.
        </p>
        <p style={{ margin: 0 }}>
          Your wallet won&rsquo;t ask again for this community. You can withdraw it any time under People in the
          wallet.
        </p>
      </div>
      <div style={{ display: "flex", justifyContent: "flex-end", gap: 8, marginTop: 8 }}>
        <button autoFocus onClick={() => decide(false)} style={{ padding: "8px 16px", fontSize: 13 }}>
          Don&rsquo;t allow
        </button>
        <button
          onClick={() => decide(true)}
          style={{
            padding: "8px 18px",
            fontSize: 13,
            fontWeight: 700,
            border: "none",
            borderRadius: 8,
            color: "var(--w-accent-ink)",
            background: "var(--w-accent)",
            cursor: "pointer",
          }}
        >
          Allow for {view.communityName}
        </button>
      </div>
    </div>
  );
}
