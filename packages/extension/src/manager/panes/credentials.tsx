// Credentials — what this agent issues to others, and takes back.
//
// ## What this pane cannot do, and why it says so
//
// `vta/credentials` declares exactly two tasks: `issue` and `revoke`. There is
// **no list**. So this console can mint a credential and revoke one by id, and
// it genuinely cannot show you what has been issued — not because the pane is
// unfinished, but because the agent exposes no way to ask.
//
// That is stated on the surface rather than hidden behind an empty table. A
// blank list would read as "you have issued nothing", which is a claim this
// console has no basis for and which would be wrong the moment anything had
// been issued. The audit trail is the honest answer for "what happened", and
// the pane points at it.
//
// The holder side — the credentials this agent *holds* — lives in a different
// family again (`vault/credentials/*`), which ships no TypeScript bindings in
// `@openvtc/trust-tasks`. Writing those shapes by hand here is exactly the
// copy-that-drifts this repo already removed once, so that half waits for the
// bindings rather than being approximated.

import { useCallback, useState } from "react";
import { issueCredential, revokeCredential } from "@openvtc/pnm-core/admin";
import { Button, Did, Note, Panel } from "../../ui.js";
import { c, t, font } from "../../theme.js";
import { managerSender } from "../sender.js";
import { ConsentRequiredError } from "../carrier.js";
import { ConsentCeremony, runMutation } from "../destructive.js";
import { hasRole, type Authority, type Parties } from "../use-vta.js";

const DAY = 86400;

const fieldStyle: React.CSSProperties = {
  boxSizing: "border-box",
  padding: "6px 9px",
  background: c.ground,
  color: c.text,
  border: `1px solid ${c.line}`,
  borderRadius: "var(--w-r-sm)",
  fontSize: t.sm,
};

const codeStyle: React.CSSProperties = {
  ...fieldStyle,
  fontFamily: font.mono,
  fontSize: t.xs,
  minHeight: 140,
  width: "100%",
  lineHeight: 1.5,
  resize: "vertical",
};

function Label({ children }: { children: React.ReactNode }) {
  return (
    <span style={{ fontSize: t.xs, color: c.muted, textTransform: "uppercase", letterSpacing: 0.4 }}>
      {children}
    </span>
  );
}

function IssueCredential({
  parties,
  authority,
}: {
  parties: Parties;
  authority: Authority | null;
}) {
  const [holderDid, setHolderDid] = useState("");
  const [credentialType, setCredentialType] = useState("");
  const [claims, setClaims] = useState("{\n  \n}");
  const [validityDays, setValidityDays] = useState("365");
  const [purpose, setPurpose] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [pending, setPending] = useState<ConsentRequiredError | null>(null);
  const [issued, setIssued] = useState<string | null>(null);

  const denied = authority && !hasRole(authority, "admin", "super-admin")
    ? "Issuing a credential needs the admin role at this agent."
    : null;

  const days = Number(validityDays);
  const daysValid = Number.isFinite(days) && days > 0;

  const submit = useCallback(async () => {
    setBusy(true);
    setError(null);
    setPending(null);
    setIssued(null);

    let parsed: Record<string, unknown>;
    try {
      const candidate: unknown = JSON.parse(claims);
      if (candidate === null || typeof candidate !== "object" || Array.isArray(candidate)) {
        setError("Claims must be a JSON object.");
        setBusy(false);
        return;
      }
      parsed = candidate as Record<string, unknown>;
    } catch {
      setError("Claims are not valid JSON.");
      setBusy(false);
      return;
    }

    const ok = await runMutation(
      async () => {
        const res = await issueCredential(managerSender, {
          ...parties,
          holderDid: holderDid.trim(),
          claims: parsed as never,
          validitySeconds: Math.round(days * DAY),
          ...(credentialType.trim() ? { credentialType: credentialType.trim() } : {}),
          ...(purpose.trim() ? { purpose: purpose.trim() } : {}),
        });
        // The id is the only handle revocation has, and there is no list to
        // recover it from later. Surfaced prominently for exactly that reason.
        const id = (res as { credentialId?: string; id?: string }).credentialId
          ?? (res as { id?: string }).id
          ?? null;
        setIssued(id);
      },
      { onConsent: setPending, onError: setError },
    );
    setBusy(false);
    if (ok) {
      setHolderDid("");
      setClaims("{\n  \n}");
    }
  }, [parties, holderDid, claims, days, credentialType, purpose]);

  return (
    <Panel
      title="Issue a credential"
      description="Your agent signs this as issuer. Once it reaches the holder it is theirs to
        present anywhere, to anyone who trusts your agent — revocation is the only way back."
    >
      <div style={{ display: "grid", gap: 10, maxWidth: 680 }}>
        <label style={{ display: "grid", gap: 4 }}>
          <Label>Holder DID</Label>
          <input
            style={{ ...fieldStyle, fontFamily: font.mono }}
            value={holderDid}
            onChange={(e) => setHolderDid(e.target.value)}
            placeholder="did:key:z6Mk…"
          />
        </label>

        <div style={{ display: "flex", gap: 10, flexWrap: "wrap" }}>
          <label style={{ display: "grid", gap: 4, flex: "1 1 220px" }}>
            <Label>Type (optional)</Label>
            <input
              style={fieldStyle}
              value={credentialType}
              onChange={(e) => setCredentialType(e.target.value)}
              placeholder="MembershipCredential"
            />
          </label>
          <label style={{ display: "grid", gap: 4 }}>
            <Label>Valid for (days)</Label>
            <input
              style={{ ...fieldStyle, width: 120 }}
              value={validityDays}
              onChange={(e) => setValidityDays(e.target.value)}
            />
          </label>
          <label style={{ display: "grid", gap: 4, flex: "1 1 200px" }}>
            <Label>Purpose (optional)</Label>
            <input style={fieldStyle} value={purpose} onChange={(e) => setPurpose(e.target.value)} />
          </label>
        </div>

        <label style={{ display: "grid", gap: 4 }}>
          <Label>Claims</Label>
          <textarea
            style={codeStyle}
            value={claims}
            onChange={(e) => setClaims(e.target.value)}
            spellCheck={false}
          />
        </label>
        <span style={{ fontSize: t.xs, color: c.faint }}>
          A JSON object. Everything in here is asserted by your agent and readable by anyone the
          holder shows it to.
        </span>

        {!daysValid && validityDays.trim() !== "" && (
          <Note tone="danger">Validity must be a positive number of days.</Note>
        )}
        {error && <Note tone="danger">{error}</Note>}
        {pending && <ConsentCeremony pending={pending} />}

        {issued !== null && (
          <Note tone="warn">
            <div style={{ display: "grid", gap: 6 }}>
              <strong>Issued. Keep this id.</strong>
              <span style={{ fontFamily: font.mono, fontSize: t.sm, wordBreak: "break-all" }}>
                {issued || "(your agent returned no id)"}
              </span>
              <span>
                It is the only handle revocation has, and your agent offers no way to list
                issued credentials — so if this is lost, the audit trail is the only place it
                can be recovered from.
              </span>
            </div>
          </Note>
        )}

        <div>
          <Button
            kind="primary"
            disabled={busy || !holderDid.trim() || !daysValid || Boolean(denied)}
            {...(denied ? { title: denied } : {})}
            onClick={() => void submit()}
          >
            {busy ? "Issuing…" : "Issue credential"}
          </Button>
        </div>
        {denied && <span style={{ fontSize: t.sm, color: c.muted }}>{denied}</span>}
      </div>
    </Panel>
  );
}

function RevokeCredential({
  parties,
  authority,
}: {
  parties: Parties;
  authority: Authority | null;
}) {
  const [credentialId, setCredentialId] = useState("");
  const [reason, setReason] = useState("");
  const [confirming, setConfirming] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [pending, setPending] = useState<ConsentRequiredError | null>(null);
  const [done, setDone] = useState(false);

  const denied = authority && !hasRole(authority, "admin", "super-admin")
    ? "Revoking a credential needs the admin role at this agent."
    : null;

  const submit = useCallback(async () => {
    setBusy(true);
    setError(null);
    setPending(null);
    const ok = await runMutation(
      async () => {
        await revokeCredential(managerSender, {
          ...parties,
          credentialId: credentialId.trim(),
          ...(reason.trim() ? { reason: reason.trim() } : {}),
        });
      },
      { onConsent: setPending, onError: setError },
    );
    setBusy(false);
    if (ok) {
      setDone(true);
      setConfirming(false);
      setCredentialId("");
      setReason("");
    }
  }, [parties, credentialId, reason]);

  return (
    <Panel
      title="Revoke a credential"
      description="By id. There is no list to pick from — your agent exposes no way to enumerate
        what it has issued, so the id has to come from wherever you recorded it, or from the
        audit trail."
    >
      <div style={{ display: "grid", gap: 10, maxWidth: 680 }}>
        <label style={{ display: "grid", gap: 4 }}>
          <Label>Credential id</Label>
          <input
            style={{ ...fieldStyle, fontFamily: font.mono }}
            value={credentialId}
            onChange={(e) => {
              setCredentialId(e.target.value);
              setConfirming(false);
              setDone(false);
            }}
          />
        </label>
        <label style={{ display: "grid", gap: 4 }}>
          <Label>Reason (optional, recorded)</Label>
          <input style={fieldStyle} value={reason} onChange={(e) => setReason(e.target.value)} />
        </label>

        {error && <Note tone="danger">{error}</Note>}
        {pending && <ConsentCeremony pending={pending} />}
        {done && <Note tone="accent">Revoked.</Note>}

        {/* No preview is possible — there is no read task to preview *from*.
            So the confirm step states what cannot be checked rather than
            dressing up a guess as a preview. */}
        {confirming ? (
          <>
            <Note tone="danger">
              <div style={{ display: "grid", gap: 6 }}>
                <strong>Revoking cannot be undone, and cannot be previewed.</strong>
                <span style={{ fontFamily: font.mono, fontSize: t.xs, wordBreak: "break-all" }}>
                  {credentialId.trim()}
                </span>
                <span>
                  Your agent offers no way to read a credential back, so this console cannot show
                  you whose it is or what it says before you revoke it — check the id against
                  your own records first. Whoever holds it stops being able to present it
                  anywhere that checks revocation.
                </span>
              </div>
            </Note>
            <div style={{ display: "flex", gap: 8 }}>
              <Button kind="danger" disabled={busy} onClick={() => void submit()}>
                {busy ? "Revoking…" : "Revoke it"}
              </Button>
              <Button kind="quiet" disabled={busy} onClick={() => setConfirming(false)}>
                Cancel
              </Button>
            </div>
          </>
        ) : (
          <div>
            <Button
              kind="danger"
              disabled={!credentialId.trim() || Boolean(denied)}
              {...(denied ? { title: denied } : {})}
              onClick={() => setConfirming(true)}
            >
              Revoke
            </Button>
          </div>
        )}
        {denied && <span style={{ fontSize: t.sm, color: c.muted }}>{denied}</span>}
      </div>
    </Panel>
  );
}

export function CredentialsPane({
  parties,
  authority,
  onOpenAudit,
}: {
  parties: Parties;
  authority: Authority | null;
  /** Send the operator to the pane that *can* answer "what was issued". */
  onOpenAudit: () => void;
}) {
  return (
    <div style={{ display: "grid", gap: 16, alignContent: "start" }}>
      <Panel
        title="Credentials this agent issues"
        description="Your agent as an issuer: minting credentials for others, and taking them
          back."
      >
        <Note tone="warn">
          <div style={{ display: "grid", gap: 6 }}>
            <strong>There is no list of issued credentials, and this is not an empty one.</strong>
            <span>
              The <code style={{ fontFamily: font.mono }}>vta/credentials</code> family declares
              only <code style={{ fontFamily: font.mono }}>issue</code> and{" "}
              <code style={{ fontFamily: font.mono }}>revoke</code> — your agent exposes no way
              to ask what it has issued, so showing you a table here would mean inventing one.
              The audit trail records every issuance and is the honest place to look.{" "}
              <button
                onClick={onOpenAudit}
                style={{
                  border: "none",
                  background: "none",
                  padding: 0,
                  color: c.accent,
                  cursor: "pointer",
                  font: "inherit",
                  textDecoration: "underline",
                }}
              >
                Open the audit trail
              </button>
              .
            </span>
          </div>
        </Note>
        <div style={{ fontSize: t.sm, color: c.muted, lineHeight: 1.55 }}>
          Issuing as <Did value={parties.service.did} size={t.xs} />
        </div>
      </Panel>

      <IssueCredential parties={parties} authority={authority} />
      <RevokeCredential parties={parties} authority={authority} />

      <Panel
        title="Credentials this agent holds"
        description="Not built yet, and deliberately not approximated."
      >
        <Note tone="accent">
          The holder side lives in a different task family (
          <code style={{ fontFamily: font.mono }}>vault/credentials/*</code>: query, get, receive,
          archive, restore, purge), and that family ships no TypeScript bindings in{" "}
          <code style={{ fontFamily: font.mono }}>@openvtc/trust-tasks</code>. Transcribing those
          shapes by hand is a copy that drifts from the schemas the agent is generated from —
          this repo removed one such copy already — so this half waits for the bindings rather
          than guessing at them.
        </Note>
      </Panel>
    </div>
  );
}
