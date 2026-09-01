/// <reference types="chrome" />

// The console shell: act rail, context tree, pane.
//
// Three columns, and the middle one is the idea. Sections answer "what am I
// looking at"; the context tree answers "about which compartment", and it
// persists across sections because `contextId` is a filter on Keys, DIDs,
// Access and Audit alike. Folding the tree into a Contexts *page* would force
// the operator to re-answer the second question every time they changed the
// first.
//
// Routing is on `location.hash`, matching `app-shell.tsx`, so a pane is
// linkable and a reload lands where the operator was.

import { useCallback, useEffect, useMemo, useState } from "react";
import { contextsList, type ContextRecord } from "@openvtc/pnm-core";
import { c, t } from "../theme.js";
import { Note } from "../ui.js";
import { ContextTree, type ContextSelection } from "./context-column.js";
import { WhoamiBanner } from "./whoami-banner.js";
import { ContextsPane } from "./panes/contexts.js";
import { KeysPane } from "./panes/keys.js";
import { DidsPane } from "./panes/dids.js";
import { AccessPane } from "./panes/access.js";
import { SessionsPane } from "./panes/sessions.js";
import { ApprovalsPane } from "./panes/approvals.js";
import { PolicyPane } from "./panes/policy.js";
import { ServicesPane } from "./panes/services.js";
import { AuditPane } from "./panes/audit.js";
import { managerSender } from "./sender.js";
import { useVta, type Parties } from "./use-vta.js";

/** Section ids double as the URL hash. */
export type SectionId =
  | "contexts"
  | "keys"
  | "dids"
  | "services"
  | "audit"
  | "access"
  | "sessions"
  | "approvals"
  | "policy";

interface Act {
  title: string;
  /** CSS custom property holding this act's colour. */
  colour: string;
  soft: string;
  sections: { id: SectionId; label: string }[];
}

// The deck's three acts. The grouping is not decorative — each answers a
// different question, and the colour is how the rail says which one you are in.
const ACTS: Act[] = [
  {
    title: "Identity & custody",
    colour: "var(--m-act-identity)",
    soft: "var(--m-act-identity-soft)",
    sections: [
      { id: "contexts", label: "Contexts" },
      { id: "keys", label: "Keys" },
      { id: "dids", label: "DIDs" },
    ],
  },
  {
    title: "Wire & execution",
    colour: "var(--m-act-wire)",
    soft: "var(--m-act-wire-soft)",
    sections: [
      { id: "services", label: "Transports" },
      { id: "audit", label: "Audit" },
    ],
  },
  {
    title: "Authority & graph",
    colour: "var(--m-act-graph)",
    soft: "var(--m-act-graph-soft)",
    sections: [
      { id: "access", label: "Access" },
      { id: "approvals", label: "Approvals" },
      { id: "policy", label: "Policy" },
      { id: "sessions", label: "Sessions" },
    ],
  },
];

function sectionFromHash(): SectionId {
  const raw = location.hash.replace(/^#/, "");
  const known = ACTS.flatMap((a) => a.sections.map((s) => s.id));
  return (known as string[]).includes(raw) ? (raw as SectionId) : "contexts";
}

function ActRail({
  section,
  onSelect,
}: {
  section: SectionId;
  onSelect: (id: SectionId) => void;
}) {
  return (
    <nav
      aria-label="Sections"
      style={{
        background: "var(--m-rail)",
        borderRight: `1px solid ${c.line}`,
        overflowY: "auto",
        padding: "12px 0",
        display: "grid",
        gridAutoRows: "min-content",
        gap: 14,
      }}
    >
      {ACTS.map((act) => (
        <div key={act.title} style={{ borderLeft: `4px solid ${act.colour}`, paddingLeft: 11 }}>
          <h2
            style={{
              margin: "0 0 5px",
              fontSize: t.xs,
              textTransform: "uppercase",
              letterSpacing: 0.5,
              // The act's own colour, not a neutral. The rail is the only thing
              // saying which of the three questions a section answers, and a
              // 4px edge alone is too quiet to carry it.
              color: act.colour,
              fontWeight: 640,
            }}
          >
            {act.title}
          </h2>
          {act.sections.map((s) => {
            const active = s.id === section;
            return (
              <button
                key={s.id}
                onClick={() => onSelect(s.id)}
                aria-current={active ? "page" : undefined}
                style={{
                  display: "block",
                  width: "calc(100% - 10px)",
                  textAlign: "left",
                  border: "none",
                  borderRadius: "var(--w-r-sm)",
                  padding: "6px 9px",
                  margin: "1px 0",
                  cursor: "pointer",
                  background: active ? act.soft : "transparent",
                  color: active ? act.colour : c.text,
                  fontSize: t.sm,
                  fontWeight: active ? 640 : 440,
                }}
              >
                {s.label}
              </button>
            );
          })}
        </div>
      ))}
    </nav>
  );
}

/** Contexts are fetched once here and handed to both the tree and the pane, so
 *  a rename cannot leave the two showing different names for one context. */
function useContexts(parties: Parties | null) {
  const [records, setRecords] = useState<ContextRecord[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const reload = useCallback(async () => {
    if (!parties) return;
    setLoading(true);
    setError(null);
    try {
      setRecords(await contextsList(managerSender, parties));
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setLoading(false);
    }
  }, [parties]);

  useEffect(() => {
    void reload();
  }, [reload]);

  return { records, loading, error, reload };
}

export function ManagerShell() {
  const vta = useVta();
  const [section, setSection] = useState<SectionId>(sectionFromHash);
  const [selected, setSelected] = useState<ContextSelection>(null);

  useEffect(() => {
    const onHash = () => setSection(sectionFromHash());
    addEventListener("hashchange", onHash);
    return () => removeEventListener("hashchange", onHash);
  }, []);

  const go = useCallback((id: SectionId) => {
    location.hash = id;
    setSection(id);
  }, []);

  const parties = vta.status === "ready" ? vta.parties : null;
  const contexts = useContexts(parties);

  // Every mutation refetches both: the records that were changed, and the
  // authority that change may have altered.
  const onChanged = useCallback(() => {
    void contexts.reload();
    void vta.refreshAuthority();
  }, [contexts, vta]);

  const body = useMemo(() => {
    if (vta.status !== "ready" || !parties) return null;
    switch (section) {
      case "contexts":
        return (
          <ContextsPane
            parties={parties}
            authority={vta.authority}
            records={contexts.records}
            selected={selected}
            onChanged={onChanged}
          />
        );
      case "keys":
        return <KeysPane parties={parties} authority={vta.authority} contextId={selected} />;
      case "dids":
        return <DidsPane parties={parties} authority={vta.authority} contextId={selected} />;
      case "services":
        return <ServicesPane parties={parties} authority={vta.authority} />;
      case "audit":
        return <AuditPane parties={parties} contextId={selected} />;
      case "access":
        return <AccessPane parties={parties} authority={vta.authority} contextId={selected} />;
      case "approvals":
        return <ApprovalsPane parties={parties} authority={vta.authority} contextId={selected} />;
      case "policy":
        return <PolicyPane parties={parties} authority={vta.authority} contextId={selected} />;
      case "sessions":
        return <SessionsPane parties={parties} authority={vta.authority} />;
    }
  }, [vta, parties, section, contexts.records, selected, onChanged]);

  if (vta.status === "loading") {
    return <Centered>Reading your wallet's connection…</Centered>;
  }

  if (vta.status === "disconnected") {
    return (
      <Centered>
        <div style={{ display: "grid", gap: 12, maxWidth: "60ch" }}>
          <strong style={{ fontSize: t.md }}>No agent connected</strong>
          <span style={{ color: c.muted, lineHeight: 1.6 }}>
            This console administers the agent your wallet is onboarded with, and there isn't one
            yet. Open the wallet's setup and connect an agent first.
          </span>
          <div>
            <button
              onClick={() => void chrome.tabs.create({ url: chrome.runtime.getURL("options.html#setup") })}
              style={{
                border: `1px solid ${c.line}`,
                background: c.accent,
                color: "var(--w-accent-ink)",
                borderRadius: "var(--w-r-sm)",
                padding: "7px 13px",
                fontSize: t.sm,
                cursor: "pointer",
              }}
            >
              Open wallet setup
            </button>
          </div>
        </div>
      </Centered>
    );
  }

  return (
    <div
      style={{
        height: "100%",
        display: "grid",
        gridTemplateColumns: "186px 244px minmax(0, 1fr)",
        gridTemplateRows: "auto minmax(0, 1fr)",
        gridTemplateAreas: `"rail tree banner" "rail tree pane"`,
      }}
    >
      <div style={{ gridArea: "rail", minHeight: 0 }}>
        <ActRail section={section} onSelect={go} />
      </div>

      <div style={{ gridArea: "tree", minHeight: 0, display: "grid" }}>
        <ContextTree
          records={contexts.records}
          selected={selected}
          onSelect={setSelected}
          loading={contexts.loading}
          error={contexts.error}
        />
      </div>

      <div style={{ gridArea: "banner" }}>
        <WhoamiBanner
          agentDid={vta.parties.service.did}
          authority={vta.authority}
          error={vta.authorityError}
        />
      </div>

      <main style={{ gridArea: "pane", overflowY: "auto", padding: "20px 24px", minWidth: 0 }}>
        {contexts.error && (
          <div style={{ marginBottom: 16 }}>
            <Note tone="danger">
              Your agent would not list contexts — {contexts.error}
            </Note>
          </div>
        )}
        {body}
      </main>
    </div>
  );
}

function Centered({ children }: { children: React.ReactNode }) {
  return (
    <div
      style={{
        height: "100%",
        display: "grid",
        placeItems: "center",
        padding: 32,
        fontSize: t.base,
        color: c.text,
      }}
    >
      {children}
    </div>
  );
}
