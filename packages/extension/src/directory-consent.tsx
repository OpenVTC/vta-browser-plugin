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
//
// And it is where the member chooses a credential to verify directory fields
// with: which credential, the fields it fills and every claim it discloses to
// the community, and — when the credential cannot hide the rest — those claims
// too, before anything is presented. Nothing is remembered: every presentation
// is asked for afresh.

import { useEffect, useState } from "react";

import {
  DIRECTORY_CONSENT_PREFIX,
  type DirectoryConsentView,
  type DirectoryMarksConsentView,
  type DirectoryOverDiscloseConsentView,
  type DirectoryPresentConsentView,
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
  decide: (approved: boolean, selectedCredential?: string) => void;
}) {
  const [view, setView] = useState<DirectoryConsentView | null>(null);
  useEffect(() => {
    const key = `${DIRECTORY_CONSENT_PREFIX}${consentId}`;
    void chrome.storage.session.get(key).then((v: Record<string, unknown>) => {
      setView((v[key] as DirectoryConsentView) ?? null);
    });
  }, [consentId]);

  if (!view) return <div style={{ padding: 20, fontSize: 13 }}>Loading request…</div>;
  if (view.kind === "marksAccess") return <MarksAccess view={view} decide={decide} />;
  if (view.kind === "presentCredential") return <PresentCredential view={view} decide={decide} />;
  if (view.kind === "presentOverDisclose") return <PresentOverDisclose view={view} decide={decide} />;
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

function dateOnly(iso: string | undefined): string | null {
  if (!iso) return null;
  const d = new Date(iso);
  return Number.isNaN(d.getTime()) ? null : d.toISOString().slice(0, 10);
}

/** Which credential to present, what it fills and what it discloses. */
function PresentCredential({
  view,
  decide,
}: {
  view: DirectoryPresentConsentView;
  decide: (approved: boolean, selectedCredential?: string) => void;
}) {
  const [chosen, setChosen] = useState<string | null>(view.candidates.length === 1 ? view.candidates[0]!.id : null);
  return (
    <div style={{ padding: 20, fontSize: 13, display: "grid", gap: 14 }}>
      <strong style={{ fontSize: 14 }}>Verify your card in {view.communityName} with a credential?</strong>
      <div style={{ color: "var(--w-muted)", lineHeight: 1.45 }} data-testid="directory-present-meaning">
        <p style={{ margin: "0 0 6px" }}>
          Your agent presents the credential you choose to {view.communityName}, signed as you, for this one
          request. {view.communityName} keeps only what the fields read, shown with the credential&rsquo;s
          issuer, and not the credential.
        </p>
        <p style={{ margin: 0 }}>Asked for by {originHost(view.origin)}.</p>
      </div>
      <div>
        <div style={label}>Fields it fills</div>
        <div style={card} data-testid="directory-present-fields">
          {view.fields.map((f) => (
            <div key={f.key}>{f.label}</div>
          ))}
        </div>
      </div>
      <div>
        <div style={label}>What {view.communityName} is shown</div>
        <div style={card} data-testid="directory-present-claims">
          {view.claims.map((c) => (
            <div key={c}>{c}</div>
          ))}
        </div>
      </div>
      <div>
        <div style={label}>Credential</div>
        <div style={{ ...card, display: "grid", gap: 8 }} data-testid="directory-present-candidates">
          {view.candidates.map((c) => (
            <label key={c.id} style={{ display: "flex", gap: 8, alignItems: "flex-start", cursor: "pointer" }}>
              <input
                type="radio"
                name="credential"
                checked={chosen === c.id}
                onChange={() => setChosen(c.id)}
              />
              <span style={{ display: "grid", gap: 2 }}>
                <span>{c.types.filter((t) => t !== "VerifiableCredential").join(", ") || "Credential"}</span>
                <span style={{ color: "var(--w-muted)" }}>
                  {c.issuerDid ? <Did value={c.issuerDid} /> : "Issuer not recorded"}
                  {dateOnly(c.validUntil) ? ` · valid until ${dateOnly(c.validUntil)}` : ""}
                </span>
              </span>
            </label>
          ))}
        </div>
      </div>
      <div>
        <div style={label}>Signed as</div>
        <div style={card}>
          <Did value={view.member} />
        </div>
      </div>
      <div style={{ display: "flex", justifyContent: "flex-end", gap: 8, marginTop: 8 }}>
        <button autoFocus onClick={() => decide(false)} style={{ padding: "8px 16px", fontSize: 13 }}>
          Don&rsquo;t present
        </button>
        <button
          disabled={!chosen}
          onClick={() => chosen && decide(true, chosen)}
          style={{ ...primary, ...(chosen ? {} : { opacity: 0.5, cursor: "default" }) }}
        >
          Present
        </button>
      </div>
    </div>
  );
}

/** The chosen credential cannot hide claims the fields do not read. */
function PresentOverDisclose({
  view,
  decide,
}: {
  view: DirectoryOverDiscloseConsentView;
  decide: (approved: boolean) => void;
}) {
  return (
    <div style={{ padding: 20, fontSize: 13, display: "grid", gap: 14 }}>
      <strong style={{ fontSize: 14 }}>This credential shows more than the fields ask for</strong>
      <div style={{ color: "var(--w-muted)", lineHeight: 1.45 }} data-testid="directory-overdisclose-meaning">
        <p style={{ margin: "0 0 6px" }}>
          This credential cannot hide what it says beyond the fields, so presenting it also shows these to{" "}
          {view.communityName}. {view.communityName} keeps only what the fields read.
        </p>
        <p style={{ margin: 0 }}>Asked for by {originHost(view.origin)}.</p>
      </div>
      <div>
        <div style={label}>Also shown</div>
        <div style={card} data-testid="directory-overdisclose-claims">
          {view.undisclosed.map((c) => (
            <div key={c}>{c}</div>
          ))}
        </div>
      </div>
      <div style={{ display: "flex", justifyContent: "flex-end", gap: 8, marginTop: 8 }}>
        <button autoFocus onClick={() => decide(false)} style={{ padding: "8px 16px", fontSize: 13 }}>
          Don&rsquo;t present
        </button>
        <button onClick={() => decide(true)} style={primary}>
          Present anyway
        </button>
      </div>
    </div>
  );
}
