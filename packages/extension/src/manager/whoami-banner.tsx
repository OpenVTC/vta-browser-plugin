// Who this console is, to this agent.
//
// Always visible, and refetched after every mutation. `whoAmI` re-resolves
// roles and scopes at call time rather than reading them out of the access
// token — a role change or a revocation since the token was minted is visible
// immediately, and that is the only reason to call it at all. Pinning it to the
// top of every pane means an operator never has to wonder which identity a
// change they are about to make will be attributed to.

import { Did, Pill } from "../ui.js";
import { c, t } from "../theme.js";
import type { Authority } from "./use-vta.js";

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

export function WhoamiBanner({
  agentDid,
  authority,
  error,
}: {
  agentDid: string;
  authority: Authority | null;
  error: string | null;
}) {
  return (
    <header
      style={{
        display: "flex",
        alignItems: "center",
        gap: 28,
        flexWrap: "wrap",
        padding: "12px 22px",
        borderBottom: `1px solid ${c.line}`,
        background: c.surface,
      }}
    >
      <Field label="Agent">
        <Did value={agentDid} />
      </Field>

      {authority ? (
        <>
          <Field label="Acting as">
            <Did value={authority.session.subject} />
          </Field>
          <Field label="Roles">
            {authority.roles.length ? (
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
              <span style={{ color: c.warn }}>none held at this agent</span>
            )}
          </Field>
          <Field label="Scopes">
            <span style={{ color: c.muted }}>
              {authority.scopes.length ? authority.scopes.join(" · ") : "—"}
            </span>
          </Field>
          <Field label="Session expires">
            <span style={{ color: c.muted }}>
              {new Date(authority.session.expiresAt).toLocaleString()}
            </span>
          </Field>
        </>
      ) : error ? (
        // An ACL rejection is an answer: this caller's authority really is
        // gone, or was never granted. Say which agent refused, and stop short
        // of guessing why.
        <Field label="Authority">
          <span style={{ color: c.danger }}>
            The agent would not introspect this session — {error}
          </span>
        </Field>
      ) : (
        <Field label="Authority">
          <span style={{ color: c.faint }}>resolving…</span>
        </Field>
      )}
    </header>
  );
}
