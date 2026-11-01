// The wallet's own windows for a member's election (`elections-page.ts`): taking
// a ticket, filling in the ballot, and how the vote went. The portal never
// draws these. Its page is the community's own code and knows who is signed in,
// so the member's choices exist only here and in their VTA: the community is
// never trusted to learn how anyone voted (VTI-VOT-001).
//
// Every word of the election — titles, questions, options — is the community's
// text, rendered as text. The ballot is checked here by the ballot box's own
// rules before it can be sent, and checked again by the background, the VTA and
// the ballot box.

import { useEffect, useMemo, useState } from "react";

import { ballotOf, ballotRefusal, type ElectionAnswer } from "@openvtc/pnm-core/vtc";

import type { PageElectionView } from "./bridge-protocol.js";
import { ELECTION_CONSENT_PREFIX, type ElectionConsentView } from "./elections-page.js";
import { Did } from "./ui.js";

function originHost(o: string): string {
  try {
    return new URL(o).host;
  } catch {
    return o;
  }
}

function when(iso: string): string {
  const d = new Date(iso);
  return Number.isNaN(d.getTime()) ? iso : d.toLocaleString();
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

const warn: React.CSSProperties = {
  ...card,
  borderColor: "var(--w-warn, #b7791f)",
  lineHeight: 1.45,
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

const muted: React.CSSProperties = { color: "var(--w-muted)", lineHeight: 1.45, margin: 0 };

export type ElectionDecision = (d: { approved: boolean; ballot?: unknown }) => void;

export function ElectionConsent({ consentId, decide }: { consentId: string; decide: ElectionDecision }) {
  const [view, setView] = useState<ElectionConsentView | null>(null);
  useEffect(() => {
    const key = `${ELECTION_CONSENT_PREFIX}${consentId}`;
    void chrome.storage.session.get(key).then((v: Record<string, unknown>) => {
      setView((v[key] as ElectionConsentView) ?? null);
    });
  }, [consentId]);

  if (!view) return <div style={{ padding: 20, fontSize: 13 }}>Loading…</div>;
  if (view.kind === "ticket") return <TicketWindow view={view} decide={decide} />;
  if (view.kind === "ballot") return <BallotWindow view={view} decide={decide} />;
  return <CastWindow view={view} done={() => decide({ approved: true })} />;
}

/** How the election is run, as the community publishes it (VTI-VOT-090). */
export function Disclosure({ election }: { election: PageElectionView }) {
  const d = election.disclosure;
  return (
    <div style={{ ...card, display: "grid", gap: 6 }} data-testid="election-disclosure">
      <div>
        Voting {when(election.votingOpensAt)} – {when(election.votingClosesAt)}
      </div>
      <div>
        The ballot box is run by <strong>{d.ballotBoxOperator}</strong>.{" "}
        {d.boardVisibility === "public" ? "Anyone can read its board." : "Only the community and its auditors read its board."}
      </div>
      <div>
        {election.secrecy === "open"
          ? "Ballots are on the board as cast, under keys that do not name you."
          : "Ballots are encrypted until the election's trustees open them together."}{" "}
        {d.revote === "replace" ? "A later vote replaces an earlier one." : "You can vote only once."}
      </div>
      <div style={{ color: "var(--w-muted)" }}>
        You can prove how you voted, so this election cannot protect you against being made to vote a certain way.
      </div>
      {d.sameOperator && (
        <div style={warn} data-testid="election-same-operator">
          The same operator runs this community and its ballot box: together they could link your ticket to your
          ballot.
        </div>
      )}
    </div>
  );
}

function TicketWindow({ view, decide }: { view: Extract<ElectionConsentView, { kind: "ticket" }>; decide: ElectionDecision }) {
  const title = view.election.title ?? view.election.electionId;
  return (
    <div style={{ padding: 20, fontSize: 13, display: "grid", gap: 14 }}>
      <strong style={{ fontSize: 14 }}>Take your ticket for {title}?</strong>
      <div style={{ display: "grid", gap: 6 }}>
        {view.fromVote && (
          <p style={muted} data-testid="election-ticket-first">
            You need a ticket before you can vote. Take it now, and come back to vote later.
          </p>
        )}
        <p style={muted}>
          {view.communityName} signs your ticket without seeing it, so it never knows which ballot is yours. Your
          ticket lets you vote once in this election.
        </p>
        <p style={muted}>
          Vote later rather than straight away: {view.communityName} knows when it gave you your ticket, and the
          ballot box knows when your vote arrives.
        </p>
        <p style={muted}>Asked for by {originHost(view.origin)}.</p>
      </div>
      <Disclosure election={view.election} />
      <div>
        <div style={label}>Your ticket is for</div>
        <div style={card}>
          <Did value={view.member} />
        </div>
      </div>
      <div style={{ display: "flex", justifyContent: "flex-end", gap: 8, marginTop: 8 }}>
        <button autoFocus onClick={() => decide({ approved: false })} style={{ padding: "8px 16px", fontSize: 13 }}>
          Cancel
        </button>
        <button onClick={() => decide({ approved: true })} style={primary}>
          Take my ticket
        </button>
      </div>
    </div>
  );
}

type Given = Record<string, Omit<ElectionAnswer, "question">>;

function BallotWindow({ view, decide }: { view: Extract<ElectionConsentView, { kind: "ballot" }>; decide: ElectionDecision }) {
  const [given, setGiven] = useState<Given>({});
  const ballot = useMemo(() => ballotOf(view.manifest, view.manifestDigest, given), [view, given]);
  const problem = ballotRefusal(view.manifest, view.manifestDigest, ballot);
  const set = (key: string, answer: Omit<ElectionAnswer, "question"> | undefined) =>
    setGiven((g) => {
      const next = { ...g };
      if (answer === undefined) delete next[key];
      else next[key] = answer;
      return next;
    });
  const title = view.election.title ?? view.election.electionId;
  const minutesSinceTicket =
    view.ticketTakenAt !== undefined ? Math.max(0, Math.floor((Date.now() - view.ticketTakenAt) / 60000)) : undefined;

  return (
    <div style={{ padding: 20, fontSize: 13, display: "grid", gap: 14 }}>
      <strong style={{ fontSize: 14 }}>{title}</strong>
      {view.election.description && <p style={{ ...muted, whiteSpace: "pre-wrap" }}>{view.election.description}</p>}
      <p style={muted}>
        Only your wallet sees your choices. Your agent seals them under a key made for this vote alone, and the
        wallet sends them to the ballot box — never through {view.communityName} — within 20 seconds.
      </p>
      {minutesSinceTicket !== undefined && (
        <div style={warn} data-testid="election-recent-ticket">
          You took your ticket{" "}
          {minutesSinceTicket < 1
            ? "just now"
            : `${minutesSinceTicket} minute${minutesSinceTicket === 1 ? "" : "s"} ago`}
          . Voting this
          soon after lets {view.communityName} and the ballot box pair your ticket with your vote by time. Close this
          window and vote later to avoid that.
        </div>
      )}
      <Disclosure election={view.election} />
      {view.election.questions.map((q) => {
        const m = view.manifest.questions.find((x) => x.key === q.key);
        return (
          <fieldset key={q.key} style={{ ...card, display: "grid", gap: 6, margin: 0 }} data-testid={`question-${q.key}`}>
            <legend style={{ fontWeight: 700, padding: "0 4px" }}>
              {q.text ?? q.key}
              {q.optional ? <span style={{ color: "var(--w-muted)", fontWeight: 400 }}> (optional)</span> : null}
            </legend>
            {m && <QuestionInput question={m} answer={given[q.key]} onChange={(a) => set(q.key, a)} />}
          </fieldset>
        );
      })}
      {problem && (
        <p style={{ ...muted, color: "var(--w-danger, #c53030)" }} role="status" data-testid="ballot-problem">
          {problem}
        </p>
      )}
      <div>
        <div style={label}>Voting as</div>
        <div style={card}>
          <Did value={view.member} />
        </div>
      </div>
      <div style={{ display: "flex", justifyContent: "flex-end", gap: 8, marginTop: 8 }}>
        <button autoFocus onClick={() => decide({ approved: false })} style={{ padding: "8px 16px", fontSize: 13 }}>
          Cancel
        </button>
        <button
          onClick={() => decide({ approved: true, ballot })}
          style={{ ...primary, opacity: problem ? 0.5 : 1 }}
          disabled={problem !== null}
          data-testid="ballot-cast"
        >
          Cast my vote
        </button>
      </div>
    </div>
  );
}

type ManifestQuestion = Extract<ElectionConsentView, { kind: "ballot" }>["manifest"]["questions"][number];

function optionText(o: { key: string; label?: string }): string {
  return o.label ?? o.key;
}

function QuestionInput({
  question: q,
  answer,
  onChange,
}: {
  question: ManifestQuestion;
  answer: Omit<ElectionAnswer, "question"> | undefined;
  onChange: (a: Omit<ElectionAnswer, "question"> | undefined) => void;
}) {
  switch (q.type) {
    case "choice": {
      const picked = answer?.choice ?? [];
      const single = q.maxSelections === 1;
      return (
        <>
          {q.options.map((o) => (
            <label key={o.key} style={{ display: "flex", gap: 8, alignItems: "center" }}>
              <input
                type={single ? "radio" : "checkbox"}
                name={`q-${q.key}`}
                checked={picked.includes(o.key)}
                onChange={(e) => {
                  const next = single
                    ? [o.key]
                    : e.target.checked
                      ? [...picked, o.key]
                      : picked.filter((k) => k !== o.key);
                  onChange(next.length ? { choice: next } : undefined);
                }}
              />
              {optionText(o)}
            </label>
          ))}
          {!single && (
            <span style={{ color: "var(--w-muted)" }}>
              Choose {q.minSelections === q.maxSelections ? q.minSelections : `${q.minSelections}–${q.maxSelections}`}.
            </span>
          )}
        </>
      );
    }
    case "ranking": {
      const ranked = answer?.ranking ?? [];
      return (
        <>
          <span style={{ color: "var(--w-muted)" }}>
            Click options in your order of preference{q.partial ? "; you need not rank them all" : ""}. Click again to
            remove one.
          </span>
          {q.options.map((o) => {
            const at = ranked.indexOf(o.key);
            return (
              <button
                key={o.key}
                type="button"
                onClick={() => {
                  const next = at >= 0 ? ranked.filter((k) => k !== o.key) : [...ranked, o.key];
                  onChange(next.length ? { ranking: next } : undefined);
                }}
                style={{ textAlign: "left", padding: "6px 8px", fontSize: 13 }}
                aria-pressed={at >= 0}
              >
                <strong style={{ display: "inline-block", width: 22 }}>{at >= 0 ? `${at + 1}.` : "–"}</strong>
                {optionText(o)}
              </button>
            );
          })}
        </>
      );
    }
    case "score": {
      const scores = answer?.scores ?? {};
      const values: number[] = [];
      for (let v = q.min; v <= q.max && values.length <= 101; v++) values.push(v);
      return (
        <>
          {q.options.map((o) => (
            <label key={o.key} style={{ display: "flex", gap: 8, alignItems: "center", justifyContent: "space-between" }}>
              {optionText(o)}
              <select
                value={scores[o.key] ?? ""}
                onChange={(e) => {
                  const next = { ...scores };
                  if (e.target.value === "") delete next[o.key];
                  else next[o.key] = Number(e.target.value);
                  onChange(Object.keys(next).length ? { scores: next } : undefined);
                }}
              >
                <option value="">—</option>
                {values.map((v) => (
                  <option key={v} value={v}>
                    {v}
                  </option>
                ))}
              </select>
            </label>
          ))}
        </>
      );
    }
    case "text":
      return (
        <textarea
          rows={3}
          value={answer?.text ?? ""}
          onChange={(e) => onChange(e.target.value === "" ? undefined : { text: e.target.value })}
          placeholder={`At most ${q.maxLength} characters`}
        />
      );
    default:
      return <span>This wallet cannot answer this kind of question.</span>;
  }
}

function CastWindow({ view, done }: { view: Extract<ElectionConsentView, { kind: "cast" }>; done: () => void }) {
  const o = view.outcome;
  return (
    <div style={{ padding: 20, fontSize: 13, display: "grid", gap: 14 }}>
      <strong style={{ fontSize: 14 }}>{o.ok ? `You voted in ${view.electionTitle}` : `Your vote in ${view.electionTitle} was not cast`}</strong>
      {o.ok ? (
        <p style={muted} data-testid="election-cast-ok">
          The ballot box {o.status === "replaced" ? "replaced your earlier vote with this one" : "counted your vote"}
          {o.leafIndex !== undefined ? ` (board entry ${o.leafIndex})` : ""}, and your agent keeps its signed receipt.{" "}
          {view.communityName} was not told.
        </p>
      ) : (
        <p style={muted} data-testid="election-cast-failed">
          {o.error} If you are not sure whether it was counted, vote again from {view.communityName}&rsquo;s portal:
          the ballot box never counts one ticket twice.
        </p>
      )}
      <div style={{ display: "flex", justifyContent: "flex-end" }}>
        <button autoFocus onClick={done} style={primary}>
          Done
        </button>
      </div>
    </div>
  );
}
