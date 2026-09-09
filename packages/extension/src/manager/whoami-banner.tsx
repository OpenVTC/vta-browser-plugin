// Who this console is, to this agent.
//
// Always visible, and refetched after every mutation. `whoAmI` re-resolves
// roles and scopes at call time rather than reading them out of the access
// token — a role change or a revocation since the token was minted is visible
// immediately, and that is the only reason to call it at all. Pinning it to the
// top of every pane means an operator never has to wonder which identity a
// change they are about to make will be attributed to.

import { Did, DidNamed, Pill } from "../ui.js";
import { c, t } from "../theme.js";
import { formatInstant } from "./format.js";
import type { Authority } from "./use-vta.js";
import { useAgentNames } from "../use-agent-names.js";
import { displayAgentName, type AgentName } from "../agent-name.js";
import { readAllVtaDids, setActiveVtaDid } from "../active-vta.js";
import { useEffect, useState } from "react";
import { Icon } from "./icons.js";

function Field({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div style={{ display: "grid", gap: 2, minWidth: 0 }}>
      <span style={{ fontSize: t.xs, color: c.faint, textTransform: "uppercase", letterSpacing: 0.4 }}>
        {label}
      </span>
      <span style={{ fontSize: t.sm, color: c.text, minWidth: 0 }}>{children}</span>
    </div>
  );
}


/**
 * Switch the console to another onboarded agent.
 *
 * Only rendered where there is somewhere to switch *to* — one agent means no
 * control, rather than a select with a single option that does nothing.
 *
 * **Switching reloads the page**, deliberately. Thirteen panes each hold their
 * own fetched state, and propagating a change of agent through all of them is
 * thirteen chances to leave one holding the previous agent's keys, credentials
 * or ACL under the new agent's name in the header. That is not a stale-data
 * annoyance — it is the console telling the operator something false about who
 * they are administering, on the surface whose whole job is to answer that. A
 * reload is provably clean and costs a second.
 */
function SwitchAgent({
  current,
  names,
}: {
  current: string;
  names: Record<string, AgentName | undefined>;
}) {
  const [dids, setDids] = useState<string[]>([]);

  useEffect(() => {
    void readAllVtaDids().then(setDids);
  }, []);

  if (dids.length < 2) return null;

  const label = (did: string) => {
    const n = names[did];
    if (n) return displayAgentName(n);
    // No published name — the tail of a `did:webvh` is its host and label,
    // which is the most recognisable part and is not a derived *name*: it is
    // the identifier itself, shortened.
    const tail = did.split(":").slice(-2).join(":");
    return tail.length < did.length ? `…${tail}` : did;
  };

  return (
    <select
      value={current}
      aria-label="Switch agent"
      onChange={(e) => {
        const next = e.target.value;
        if (next === current) return;
        void setActiveVtaDid(next).then((ok) => {
          if (ok) window.location.reload();
        });
      }}
      style={{
        fontSize: t.xs,
        color: c.muted,
        background: c.ground,
        border: `1px solid ${c.line}`,
        borderRadius: "var(--w-r-sm)",
        padding: "2px 6px",
        maxWidth: 260,
      }}
    >
      {dids.map((d) => (
        <option key={d} value={d}>
          {label(d)}
        </option>
      ))}
    </select>
  );
}

/**
 * Who this console is, to this agent — one line, with the rest on request.
 *
 * This used to be four labelled fields across a full row on all fifteen panes:
 * agent, acting-as, roles, scopes, session expiry. None of them changes during
 * a session, so it was ~50px of fixed furniture above every screen, repeated
 * fifteen times.
 *
 * What stays out is what an operator might act on: **which agent** they are
 * administering, and **what they may do there**. Those are the two facts that
 * make a destructive button safe to press. The rest — the subject DID, the
 * scopes, the expiry — is reference material, and it is one click away.
 *
 * **An authority error is never folded away.** A console that hid "the agent
 * refused to introspect this session" behind a disclosure would be hiding the
 * reason every button below is about to fail.
 */
export function WhoamiBanner({
  agentDid,
  authority,
  error,
}: {
  agentDid: string;
  authority: Authority | null;
  error: string | null;
}) {
  const agentNames = useAgentNames([agentDid]);
  const [open, setOpen] = useState(false);

  return (
    <header
      style={{
        display: "grid",
        gap: 8,
        padding: "8px 22px",
        borderBottom: `1px solid ${c.line}`,
        background: c.surface,
      }}
    >
      <div style={{ display: "flex", alignItems: "center", gap: 14, flexWrap: "wrap", minHeight: 24 }}>
        {/* A name, where the agent publishes one.
            `useAgentNames` reads `alsoKnownAs` off the DID document and
            verifies it — it never derives a name from the DID's host or path.
            That distinction is the whole point: a derived name is a guess
            dressed as an identity, and this banner is the line an operator
            reads to check they are administering the agent they think they
            are. No claim, no name — the DID stands on its own, which is the
            honest fallback rather than an inferred one. */}
        <DidNamed
          value={agentDid}
          verified
          {...(agentNames[agentDid] ? { agentName: agentNames[agentDid] } : {})}
        />
        <SwitchAgent current={agentDid} names={agentNames} />

        {authority ? (
          authority.roles.length ? (
            <span style={{ display: "inline-flex", gap: 5, flexWrap: "wrap" }}>
              {authority.roles.map((r) => (
                <Pill key={r} tone="accent">
                  {r}
                </Pill>
              ))}
            </span>
          ) : (
            // Not the same as "unknown". The agent answered, and the answer
            // was none — so every manage-gated task below will be refused,
            // and saying so here is cheaper than thirteen refusals.
            <span style={{ fontSize: t.sm, color: c.warn }}>no role held at this agent</span>
          )
        ) : error ? (
          // An ACL rejection is an answer: this caller's authority really is
          // gone, or was never granted. Say which agent refused, and stop short
          // of guessing why. Never behind the disclosure.
          <span style={{ fontSize: t.sm, color: c.danger }}>
            The agent would not introspect this session — {error}
          </span>
        ) : (
          <span style={{ fontSize: t.sm, color: c.faint }}>resolving…</span>
        )}

        {authority && (
          <button
            onClick={() => setOpen((v) => !v)}
            aria-expanded={open}
            style={{
              marginLeft: "auto",
              border: "none",
              background: "transparent",
              color: c.faint,
              fontSize: t.xs,
              cursor: "pointer",
              display: "inline-flex",
              alignItems: "center",
              gap: 5,
              padding: "2px 4px",
            }}
          >
            {open ? "Less" : "Session details"}
            <Icon name="chevron" size={12} style={{ transform: `rotate(${open ? 270 : 90}deg)` }} />
          </button>
        )}
      </div>

      {open && authority && (
        <div style={{ display: "flex", gap: 28, flexWrap: "wrap", paddingBottom: 4 }}>
          <Field label="Acting as">
            <Did value={authority.session.subject} />
          </Field>
          <Field label="Scopes">
            <span style={{ color: c.muted }}>
              {authority.scopes.length ? authority.scopes.join(" · ") : "—"}
            </span>
          </Field>
          <Field label="Session expires">
            <span style={{ color: c.muted }}>{formatInstant(authority.session.expiresAt)}</span>
          </Field>
        </div>
      )}
    </header>
  );
}
