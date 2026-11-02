// The wallet's own windows for a member's election (`elections-page.ts`): taking
// a ticket, and the ballot window — which asks to reach the ballot box if it
// must, says so if this wallet voted already, takes the ballot, and then stays
// open showing each step of the cast until the ballot box's receipt is kept.
// The portal never draws these. Its page is the community's own code and knows who is signed in,
// so the member's choices exist only here and in their VTA: the community is
// never trusted to learn how anyone voted (VTI-VOT-001).
//
// Every word of the election — titles, questions, options — is the community's
// text, rendered as text. The ballot is checked here by the ballot box's own
// rules before it can be sent, and checked again by the background, the VTA and
// the ballot box.

import { useEffect, useMemo, useRef, useState } from "react";

import { ballotOf, ballotRefusal, textReleaseWarning, type ElectionAnswer } from "@openvtc/pnm-core/vtc";

import { CONSENT_KEEPALIVE_PORT, type PageElectionView } from "./bridge-protocol.js";
import {
  CAST_STEPS,
  ELECTION_CONSENT_PREFIX,
  ELECTION_PROGRESS_PREFIX,
  type CastProgress,
  type CastStep,
  type ElectionConsentView,
  type RememberedVote,
} from "./elections-page.js";
import { requestOriginPermission } from "./host-permissions.js";
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

/** `keepOpen`: the ballot window stays to show the cast (`consent-result.ts`). */
export type ElectionDecision = (d: { approved: boolean; ballot?: unknown; keepOpen?: boolean }) => void;

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
  if (view.kind === "ballot") return <BallotWindow consentId={consentId} view={view} decide={decide} />;
  return <CastWindow view={view} done={() => decide({ approved: true })} />;
}

/** How the election is run, as the community publishes it (VTI-VOT-090). */
export function Disclosure({ election }: { election: PageElectionView }) {
  const d = election.disclosure;
  // From the manifest: the community's disclosure has no member for it.
  const textRelease = textReleaseWarning(election.textReleaseThreshold);
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
      {textRelease && (
        <div style={warn} data-testid="election-text-release">
          {textRelease}
        </div>
      )}
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
        <div style={{ ...card, display: "grid", gap: 6 }}>
          <Did value={view.member} />
          <p style={{ ...muted, fontSize: 12 }} data-testid="election-ticket-identity">
            {view.communityName} gives the ticket to this identity, so it knows you hold one. Your vote will not carry
            this identity: it goes with the blind ticket and a key made for that vote alone.
          </p>
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

type BallotView = Extract<ElectionConsentView, { kind: "ballot" }>;

/** Where the ballot window is: asking to reach the ballot box, saying this
 *  wallet voted already, taking the ballot, or showing the cast. */
type Stage = "reach" | "voted" | "form" | "progress";

function BallotWindow({ consentId, view, decide }: { consentId: string; view: BallotView; decide: ElectionDecision }) {
  const [reachable, setReachable] = useState(!view.needsReach);
  const [stage, setStage] = useState<Stage>(view.voted ? "voted" : view.needsReach ? "reach" : "form");
  const title = view.election.title ?? view.election.electionId;
  const boxHost = originHost(view.boxOrigin);

  return (
    <div style={{ padding: 20, fontSize: 13, display: "grid", gap: 14 }}>
      <strong style={{ fontSize: 14 }}>{title}</strong>
      {stage === "voted" && view.voted && (
        <VotedView
          view={view}
          voted={view.voted}
          change={() => setStage(reachable ? "form" : "reach")}
          close={() => decide({ approved: false })}
        />
      )}
      {stage === "reach" && (
        <ReachView
          boxOrigin={view.boxOrigin}
          granted={() => {
            setReachable(true);
            setStage("form");
          }}
          cancel={() => decide({ approved: false })}
        />
      )}
      {stage === "form" && (
        <BallotForm
          view={view}
          cancel={() => decide({ approved: false })}
          cast={(ballot) => {
            setStage("progress");
            decide({ approved: true, ballot, keepOpen: true });
          }}
        />
      )}
      {stage === "progress" && (
        <CastProgressView consentId={consentId} communityName={view.communityName} boxHost={boxHost} />
      )}
    </div>
  );
}

function whenAt(at: number): string {
  return new Date(at).toLocaleString();
}

/** "counted (board entry 4)" / "replaced your earlier vote (board entry 4)". */
function outcomeWords(v: { status: string; leafIndex?: number }): string {
  const what = v.status === "replaced" ? "the ballot box replaced your earlier vote with it" : "the ballot box counted it";
  return `${what}${v.leafIndex !== undefined ? ` (board entry ${v.leafIndex})` : ""}`;
}

function VotedView({
  view,
  voted,
  change,
  close,
}: {
  view: BallotView;
  voted: RememberedVote;
  change: () => void;
  close: () => void;
}) {
  return (
    <>
      <div style={{ ...card, display: "flex", gap: 10, alignItems: "flex-start" }} data-testid="election-voted">
        <Badge state="done" />
        <div style={{ display: "grid", gap: 4 }}>
          <strong>You voted on {whenAt(voted.at)}</strong>
          <span style={muted}>{outcomeWords(voted).replace(/^t/, "T")}.</span>
        </div>
      </div>
      {view.canRevote ? (
        <p style={muted}>
          This election lets a later vote replace an earlier one. Change your vote and the ballot box counts only the
          new one.
        </p>
      ) : (
        <p style={muted} data-testid="election-no-revote">
          {view.election.disclosure.revote === "replace"
            ? "Voting in this election is not open now, so your vote cannot be changed."
            : "This election does not let you change a vote once it is cast."}
        </p>
      )}
      <p style={{ ...muted, fontSize: 11.5 }}>
        This is what this browser&rsquo;s wallet remembers. {view.communityName} is not told whether you voted.
      </p>
      <div style={{ display: "flex", justifyContent: "flex-end", gap: 8, marginTop: 8 }}>
        <button autoFocus onClick={close} style={view.canRevote ? { padding: "8px 16px", fontSize: 13 } : primary}>
          Close
        </button>
        {view.canRevote && (
          <button onClick={change} style={primary} data-testid="election-change-vote">
            Change my vote
          </button>
        )}
      </div>
    </>
  );
}

function ReachView({ boxOrigin, granted, cancel }: { boxOrigin: string; granted: () => void; cancel: () => void }) {
  const [refused, setRefused] = useState(false);
  return (
    <>
      <div style={{ ...card, display: "grid", gap: 8 }} data-testid="election-needs-reach">
        <strong>One thing first</strong>
        <p style={muted}>
          To vote, your wallet sends your ballot straight to the ballot box at <strong>{originHost(boxOrigin)}</strong>.
          Allow the wallet to reach it.
        </p>
        <p style={{ ...muted, fontSize: 11.5 }}>
          Your browser asks you to confirm. The wallet reaches only this one site for it, and you can take the
          permission back from the wallet&rsquo;s popup at any time.
        </p>
      </div>
      {refused && (
        <p style={{ ...muted, color: "var(--w-danger)" }} role="status">
          The wallet was not allowed to reach {originHost(boxOrigin)}, so it cannot send your ballot. Allow it to vote.
        </p>
      )}
      <div style={{ display: "flex", justifyContent: "flex-end", gap: 8, marginTop: 8 }}>
        <button onClick={cancel} style={{ padding: "8px 16px", fontSize: 13 }}>
          Cancel
        </button>
        <button
          autoFocus
          style={primary}
          data-testid="election-allow-box"
          onClick={() => {
            // First statement of the click: the browser asks only while the
            // gesture is live (`host-permissions.ts`).
            void requestOriginPermission(boxOrigin).then((ok) => (ok ? granted() : setRefused(true)));
          }}
        >
          Allow
        </button>
      </div>
    </>
  );
}

function BallotForm({
  view,
  cancel,
  cast,
}: {
  view: BallotView;
  cancel: () => void;
  cast: (ballot: ReturnType<typeof ballotOf>) => void;
}) {
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
  const minutesSinceTicket =
    view.ticketTakenAt !== undefined ? Math.max(0, Math.floor((Date.now() - view.ticketTakenAt) / 60000)) : undefined;

  return (
    <>
      {view.election.description && <p style={{ ...muted, whiteSpace: "pre-wrap" }}>{view.election.description}</p>}
      <p style={muted}>
        Only your wallet sees your choices. Your agent seals them under a key made for this vote alone, and the
        wallet sends them straight to the ballot box at {originHost(view.boxOrigin)} — never through{" "}
        {view.communityName} — within 20 seconds.
      </p>
      {view.voted && (
        <p style={muted} data-testid="election-replacing">
          This vote replaces the one you cast on {whenAt(view.voted.at)}.
        </p>
      )}
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
        <div style={label}>Your ticket</div>
        <div style={{ ...card, display: "grid", gap: 6 }}>
          <Did value={view.member} />
          <p style={{ ...muted, fontSize: 12 }} data-testid="election-ticket-explainer">
            Your ticket was taken as this identity. Your vote is sent with that blind ticket and a key made for this
            vote alone: it does not carry this identity, and neither {view.communityName} nor the ballot box can tell
            it is yours.
          </p>
        </div>
      </div>
      <div style={{ display: "flex", justifyContent: "flex-end", gap: 8, marginTop: 8 }}>
        <button autoFocus onClick={cancel} style={{ padding: "8px 16px", fontSize: 13 }}>
          Cancel
        </button>
        <button
          onClick={() => cast(ballot)}
          style={{ ...primary, opacity: problem ? 0.5 : 1 }}
          disabled={problem !== null}
          data-testid="ballot-cast"
        >
          Cast my vote
        </button>
      </div>
    </>
  );
}

type StepState = "pending" | "active" | "done" | "failed";

/** A step's mark: a hollow ring, a pulsing ring, a check, or a cross. */
function Badge({ state }: { state: StepState }) {
  const size = 20;
  const base: React.CSSProperties = {
    flex: "0 0 auto",
    width: size,
    height: size,
    borderRadius: "50%",
    display: "inline-flex",
    alignItems: "center",
    justifyContent: "center",
    fontSize: 12,
    fontWeight: 800,
    lineHeight: 1,
    boxSizing: "border-box",
  };
  if (state === "done") {
    return (
      <span className="w-step-done" style={{ ...base, background: "var(--w-ok)", color: "var(--w-surface)" }} aria-label="done">
        ✓
      </span>
    );
  }
  if (state === "failed") {
    return (
      <span style={{ ...base, background: "var(--w-danger)", color: "var(--w-surface)" }} aria-label="failed">
        ✕
      </span>
    );
  }
  if (state === "active") {
    return (
      <span
        className="w-step-active"
        style={{ ...base, border: "2px solid var(--w-accent)", background: "var(--w-accent-soft)" }}
        aria-label="in progress"
      >
        <span style={{ width: 6, height: 6, borderRadius: "50%", background: "var(--w-accent)" }} />
      </span>
    );
  }
  return <span style={{ ...base, border: "2px solid var(--w-line)" }} aria-label="to do" />;
}

function stepWords(step: CastStep, boxHost: string): string {
  switch (step) {
    case "check":
      return "Checking your ballot against the election’s rules";
    case "seal":
      return "Your agent seals your ballot with a one-time key";
    case "wait":
      return "Waiting a few seconds so your vote can’t be timed to your ticket";
    case "send":
      return `Sending it straight to the ballot box at ${boxHost}`;
    case "receipt":
      return "The ballot box counted it — checking its signed receipt";
  }
}

/** Each step's state, from the background's last report. A `wait` past its end
 *  is the post under way: the two run in one offscreen call. */
export function castStepStates(p: CastProgress | null, now: number): Record<CastStep, StepState> {
  const out = Object.fromEntries(CAST_STEPS.map((s) => [s, "pending"])) as Record<CastStep, StepState>;
  if (!p) {
    out.check = "active";
    return out;
  }
  if (p.phase === "done") {
    for (const s of CAST_STEPS) out[s] = "done";
    return out;
  }
  let at: CastStep = p.step;
  if (p.phase === "running" && at === "wait" && p.waitUntil !== undefined && now >= p.waitUntil) at = "send";
  const i = CAST_STEPS.indexOf(at);
  CAST_STEPS.forEach((s, j) => {
    out[s] = j < i ? "done" : j === i ? (p.phase === "failed" ? "failed" : "active") : "pending";
  });
  return out;
}

function CastProgressView({ consentId, communityName, boxHost }: { consentId: string; communityName: string; boxHost: string }) {
  const [progress, setProgress] = useState<CastProgress | null>(null);
  const [now, setNow] = useState(() => Date.now());
  const finished = progress?.phase === "done" || progress?.phase === "failed";

  // The background writes each step to session storage; read what is there and
  // follow it.
  useEffect(() => {
    const key = `${ELECTION_PROGRESS_PREFIX}${consentId}`;
    const isProgress = (v: unknown): v is CastProgress => !!v && typeof v === "object";
    const onChanged = (changes: Record<string, { newValue?: unknown }>, area: string) => {
      const v = area === "session" && key in changes ? changes[key]!.newValue : undefined;
      if (!isProgress(v)) return;
      setProgress(v);
      setNow(Date.now());
    };
    chrome.storage.onChanged?.addListener(onChanged);
    // What was written before the listener: never over a later change.
    void chrome.storage.session.get(key).then((got: Record<string, unknown>) => {
      const v = got[key];
      if (isProgress(v)) setProgress((p) => p ?? v);
    });
    return () => chrome.storage.onChanged?.removeListener(onChanged);
  }, [consentId]);

  // Holds the service worker awake while the cast is under way.
  const port = useRef<chrome.runtime.Port | null>(null);
  useEffect(() => {
    if (finished) return;
    try {
      port.current = chrome.runtime.connect?.({ name: CONSENT_KEEPALIVE_PORT }) ?? null;
    } catch {
      port.current = null;
    }
    return () => {
      try {
        port.current?.disconnect();
      } catch {
        // Already gone.
      }
      port.current = null;
    };
  }, [finished]);

  // The countdown.
  const waiting = progress?.phase === "running" && progress.step === "wait" && progress.waitUntil !== undefined;
  useEffect(() => {
    if (!waiting) return;
    const t = setInterval(() => setNow(Date.now()), 250);
    return () => clearInterval(t);
  }, [waiting]);

  const states = castStepStates(progress, now);
  const secondsLeft =
    progress?.phase === "running" && progress.waitUntil !== undefined
      ? Math.max(0, Math.ceil((progress.waitUntil - now) / 1000))
      : undefined;

  return (
    <>
      <ol style={{ listStyle: "none", margin: 0, padding: 0, display: "grid", gap: 10 }} data-testid="cast-progress">
        {CAST_STEPS.map((s) => (
          <li
            key={s}
            data-step={s}
            data-state={states[s]}
            style={{
              display: "flex",
              gap: 10,
              alignItems: "center",
              color: states[s] === "pending" ? "var(--w-muted)" : "var(--w-text)",
              fontWeight: states[s] === "active" ? 700 : 400,
            }}
          >
            <Badge state={states[s]} />
            <span>
              {stepWords(s, boxHost)}
              {s === "wait" && states[s] === "active" && secondsLeft !== undefined && (
                <span style={{ color: "var(--w-accent)", fontVariantNumeric: "tabular-nums" }} data-testid="cast-countdown">
                  {" "}
                  — {secondsLeft}s
                </span>
              )}
            </span>
          </li>
        ))}
      </ol>
      {progress?.phase === "done" && (
        <div style={{ ...card, borderColor: "var(--w-ok)", background: "var(--w-ok-soft)", display: "grid", gap: 6 }} data-testid="election-cast-ok">
          <strong style={{ fontSize: 14 }}>Your vote is in</strong>
          <span>
            At {whenAt(progress.at)}, {outcomeWords(progress)}. Your agent keeps its signed receipt. {communityName} was
            not told.
          </span>
          {progress.receiptNotKept && (
            <span style={muted}>
              Your agent could not keep the receipt ({progress.receiptNotKept}). The ballot box counted the vote all the
              same.
            </span>
          )}
        </div>
      )}
      {progress?.phase === "failed" && (
        <div style={{ ...card, borderColor: "var(--w-danger)", background: "var(--w-danger-soft)", display: "grid", gap: 6 }} data-testid="election-cast-failed">
          <strong style={{ fontSize: 14 }}>Your vote was not cast</strong>
          <span>
            {progress.error} If you are not sure whether it was counted, vote again from {communityName}&rsquo;s portal:
            the ballot box never counts one ticket twice.
          </span>
        </div>
      )}
      {!finished && (
        <p style={{ ...muted, fontSize: 11.5 }}>You can close this window: your vote goes on without it.</p>
      )}
      <div style={{ display: "flex", justifyContent: "flex-end" }}>
        <button autoFocus={finished} onClick={() => window.close()} style={finished ? primary : { padding: "8px 16px", fontSize: 13 }}>
          Close
        </button>
      </div>
    </>
  );
}

type ManifestQuestion = BallotView["manifest"]["questions"][number];

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
