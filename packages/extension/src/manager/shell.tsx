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

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { contextsList, type ContextRecord } from "@openvtc/pnm-core";
import { c, radius, t } from "../theme.js";
import { Icon, type IconName } from "./icons.js";
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
import { MaintenancePane } from "./panes/maintenance.js";
import { AuditPane } from "./panes/audit.js";
import { CredentialsPane } from "./panes/credentials.js";
import { MemoryPane } from "./panes/memory.js";
import { PersonaPane } from "./panes/persona.js";
import { AppStatePane } from "./panes/app-state.js";
import { RoomsPane } from "./panes/rooms.js";
import { managerSender } from "./sender.js";
import { useVta, type Parties } from "./use-vta.js";
import { contextHeading } from "./format.js";

/** Section ids double as the URL hash. */
export type SectionId =
  | "contexts"
  | "keys"
  | "dids"
  | "credentials"
  | "persona"
  | "memory"
  | "app-state"
  | "rooms"
  | "services"
  | "maintenance"
  | "audit"
  | "access"
  | "sessions"
  | "approvals"
  | "policy";

interface Section {
  id: SectionId;
  label: string;
  /** The glyph the rail draws, and the only thing left of this section once
   *  the rail is collapsed. Declared per section rather than derived from the
   *  id so a rename cannot silently drop it. */
  icon: IconName;
  /**
   * Whether the selected context actually narrows what this pane asks.
   *
   * Declared per section rather than inferred, because getting it wrong is
   * invisible: Transports and Sessions take no `contextId` at all, so with the
   * tree always on screen an operator could pick a context, watch nothing
   * change, and reasonably conclude the filter was broken — or worse, that the
   * list they were reading *was* scoped when it never was. A filter that does
   * not filter is not clutter, it is a false claim about what is on screen.
   *
   * A new pane has to answer this, which is the point.
   */
  contextScoped: boolean;
}

interface Act {
  title: string;
  /** CSS custom property holding this act's colour. */
  colour: string;
  soft: string;
  sections: Section[];
}

// The deck's three acts. The grouping is not decorative — each answers a
// different question, and the colour is how the rail says which one you are in.
const ACTS: Act[] = [
  {
    title: "Identity & custody",
    colour: "var(--m-act-identity)",
    soft: "var(--m-act-identity-soft)",
    sections: [
      { id: "contexts", label: "Contexts", icon: "contexts", contextScoped: true },
      { id: "keys", label: "Keys", icon: "keys", contextScoped: true },
      { id: "dids", label: "DIDs", icon: "dids", contextScoped: true },
    ],
  },
  {
    // A fourth act, not in the deck. The three there answer "who am I", "how do
    // bytes move" and "who may act"; none of them answers "what is stored
    // here", which is the one question credentials, memory and app-state share.
    title: "Data & credentials",
    colour: "var(--m-act-data)",
    soft: "var(--m-act-data-soft)",
    sections: [
      // Issuer-side only, and agent-wide: `vta/credentials` takes no context.
      { id: "credentials", label: "Credentials", icon: "credentials", contextScoped: false },
      // The holder's own identity, and the one pane that is agent-wide because
      // its records sit ABOVE every context rather than outside them. The tree
      // would be a filter that filters nothing — worse here than elsewhere,
      // because a context column beside the attribute pool would suggest the
      // pool has compartments, which is the exact misreading the family's
      // one-way boundary exists to prevent. `persona/binding/set` names a
      // context, and takes it as an argument to the write.
      { id: "persona", label: "Persona", icon: "persona", contextScoped: false },
      // For both of these `contextId` is part of the record's address rather
      // than a filter, so the pane refuses to answer agent-wide. The column is
      // shown because the selection is required, not merely useful.
      { id: "memory", label: "Memory", icon: "memory", contextScoped: true },
      { id: "app-state", label: "App state", icon: "app-state", contextScoped: true },
      // Key custody is held at the agent, not inside a context:
      // `rooms/keys/list` takes no `contextId`, because a room's keys arrive
      // from the room rather than being derived under one of this VTA's
      // hierarchies. A context column here would filter nothing.
      { id: "rooms", label: "Rooms", icon: "rooms", contextScoped: false },
    ],
  },
  {
    title: "Wire & execution",
    colour: "var(--m-act-wire)",
    soft: "var(--m-act-wire-soft)",
    sections: [
      // Transports are agent-wide: `servicesList` takes no context, because a
      // transport is not owned by one.
      { id: "services", label: "Transports", icon: "services", contextScoped: false },
      // Operations whose subject is the agent itself rather than anything it
      // holds — backup and restart. Agent-wide by definition, so no context.
      { id: "maintenance", label: "Maintenance", icon: "maintenance", contextScoped: false },
      { id: "audit", label: "Audit", icon: "audit", contextScoped: true },
    ],
  },
  {
    title: "Authority & graph",
    colour: "var(--m-act-graph)",
    soft: "var(--m-act-graph-soft)",
    sections: [
      { id: "access", label: "Access", icon: "access", contextScoped: true },
      { id: "approvals", label: "Approvals", icon: "approvals", contextScoped: true },
      { id: "policy", label: "Policy", icon: "policy", contextScoped: true },
      // `sessionsList` returns the caller's sessions; a session is held at the
      // agent, not inside a context.
      { id: "sessions", label: "Sessions", icon: "sessions", contextScoped: false },
    ],
  },
];

const SECTIONS: Section[] = ACTS.flatMap((a) => a.sections);

/** Whether the context column belongs on screen for `section`. */
function isContextScoped(section: SectionId): boolean {
  return SECTIONS.find((s) => s.id === section)?.contextScoped ?? false;
}

function sectionFromHash(): SectionId {
  const raw = location.hash.replace(/^#/, "");
  const known = SECTIONS.map((s) => s.id);
  return (known as string[]).includes(raw) ? (raw as SectionId) : "contexts";
}

/**
 * Whether the rail is folded to icons, remembered across sessions.
 *
 * `localStorage` rather than a setting at the agent: this is a per-screen
 * preference — the same operator wants it open on a desktop and folded on a
 * laptop — and a round trip to the VTA to find out how wide a column is would
 * be absurd. A throwing accessor (a private window, site data blocked) reads as
 * "expanded", which is the state that needs no explanation.
 */
const RAIL_KEY = "vta-console/rail-collapsed";

function readRailCollapsed(): boolean {
  try {
    return localStorage.getItem(RAIL_KEY) === "1";
  } catch {
    return false;
  }
}

function writeRailCollapsed(v: boolean): void {
  try {
    localStorage.setItem(RAIL_KEY, v ? "1" : "0");
  } catch {
    // Nothing to do and nothing worth saying: the rail still works, it just
    // forgets. Failing the render over a preference would be the bigger fault.
  }
}

function ActRail({
  section,
  onSelect,
  collapsed,
  onToggle,
}: {
  section: SectionId;
  onSelect: (id: SectionId) => void;
  collapsed: boolean;
  onToggle: () => void;
}) {
  return (
    <nav
      aria-label="Sections"
      style={{
        background: "var(--m-rail)",
        borderRight: `1px solid ${c.line}`,
        overflowY: "auto",
        overflowX: "hidden",
        padding: "8px 0 12px",
        display: "grid",
        gridAutoRows: "min-content",
        gap: collapsed ? 10 : 14,
        alignContent: "start",
      }}
    >
      <div style={{ display: "flex", justifyContent: collapsed ? "center" : "flex-end", padding: collapsed ? 0 : "0 10px 2px" }}>
        <button
          onClick={onToggle}
          aria-label={collapsed ? "Expand sections" : "Collapse sections"}
          aria-expanded={!collapsed}
          title={`${collapsed ? "Expand" : "Collapse"} sections (${navigator.platform.startsWith("Mac") ? "\u2318" : "Ctrl+"}\\)`}
          style={{
            border: `1px solid ${c.line}`,
            background: c.surface,
            color: c.muted,
            borderRadius: radius.sm,
            width: 26,
            height: 24,
            display: "grid",
            placeItems: "center",
            cursor: "pointer",
          }}
        >
          <Icon name="chevron" size={14} style={{ transform: collapsed ? undefined : "rotate(180deg)" }} />
        </button>
      </div>

      {ACTS.map((act) => (
        <div
          key={act.title}
          style={
            collapsed
              ? { borderLeft: `3px solid ${act.colour}`, marginLeft: 6, paddingTop: 2 }
              : { borderLeft: `4px solid ${act.colour}`, paddingLeft: 11 }
          }
        >
          {!collapsed && (
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
          )}
          {act.sections.map((sec) => (
            <RailButton
              key={sec.id}
              section={sec}
              act={act}
              active={sec.id === section}
              collapsed={collapsed}
              onSelect={onSelect}
            />
          ))}
        </div>
      ))}
    </nav>
  );
}

/**
 * One section in the rail.
 *
 * Its own component because of the collapsed tooltip: a CSS-only `::after`
 * cannot escape the rail's `overflow: hidden`, and a `title` attribute waits a
 * second and cannot be styled. Hover state here means the label can be drawn
 * `position: fixed`, beside the icon, immediately.
 *
 * **Collapsed, the icon carries the act colour.** The 3px edge alone is too
 * quiet once the heading is gone — which is the same reason the expanded rail
 * colours its headings — and without it the fold turns four labelled groups
 * into fifteen identical grey glyphs.
 */
function RailButton({
  section,
  act,
  active,
  collapsed,
  onSelect,
}: {
  section: Section;
  act: Act;
  active: boolean;
  collapsed: boolean;
  onSelect: (id: SectionId) => void;
}) {
  const [hover, setHover] = useState(false);
  const ref = useRef<HTMLButtonElement | null>(null);
  const rect = hover && collapsed ? ref.current?.getBoundingClientRect() : undefined;

  return (
    <>
      <button
        ref={ref}
        onClick={() => onSelect(section.id)}
        onMouseEnter={() => setHover(true)}
        onMouseLeave={() => setHover(false)}
        onFocus={() => setHover(true)}
        onBlur={() => setHover(false)}
        aria-current={active ? "page" : undefined}
        title={collapsed ? undefined : section.label}
        style={{
          display: "flex",
          alignItems: "center",
          gap: 9,
          width: collapsed ? 38 : "calc(100% - 10px)",
          justifyContent: collapsed ? "center" : "flex-start",
          textAlign: "left",
          border: "none",
          borderRadius: radius.sm,
          padding: collapsed ? "7px 0" : "6px 9px",
          margin: collapsed ? "2px 4px" : "1px 0",
          cursor: "pointer",
          background: active ? act.soft : "transparent",
          color: active ? act.colour : collapsed ? act.colour : c.text,
          fontSize: t.sm,
          fontWeight: active ? 640 : 440,
        }}
      >
        <Icon name={section.icon} size={18} />
        {!collapsed && <span>{section.label}</span>}
      </button>
      {rect && (
        <span
          role="tooltip"
          style={{
            position: "fixed",
            left: rect.right + 8,
            top: rect.top + rect.height / 2,
            transform: "translateY(-50%)",
            background: c.text,
            color: c.ground,
            fontSize: t.xs,
            fontWeight: 600,
            padding: "4px 9px",
            borderRadius: radius.sm,
            whiteSpace: "nowrap",
            pointerEvents: "none",
            zIndex: 60,
          }}
        >
          {section.label}
        </span>
      )}
    </>
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
  const [railCollapsed, setRailCollapsed] = useState(readRailCollapsed);

  const toggleRail = useCallback(() => {
    setRailCollapsed((v) => {
      writeRailCollapsed(!v);
      return !v;
    });
  }, []);

  // The same gesture every editor in this class of app uses for the same
  // thing. Bound on the window rather than the rail so it works wherever the
  // caret is, and guarded on the modifier so a literal backslash still types.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== "\\" || !(e.metaKey || e.ctrlKey)) return;
      e.preventDefault();
      toggleRail();
    };
    addEventListener("keydown", onKey);
    return () => removeEventListener("keydown", onKey);
  }, [toggleRail]);

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

  // One name for the selected context, shared by every pane heading, so a
  // heading can never disagree with the tree entry that produced it.
  const heading = selected
    ? contextHeading(
        contexts.records.find((r) => r.id === selected),
        selected,
      )
    : undefined;

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
        return (
          <KeysPane
            parties={parties}
            authority={vta.authority}
            contextId={selected}
            contextHeading={heading}
          />
        );
      case "dids":
        return (
          <DidsPane
            parties={parties}
            authority={vta.authority}
            contextId={selected}
            contextHeading={heading}
          />
        );
      case "credentials":
        return (
          <CredentialsPane
            parties={parties}
            authority={vta.authority}
            onOpenAudit={() => go("audit")}
          />
        );
      case "persona":
        return (
          <PersonaPane
            parties={parties}
            authority={vta.authority}
            records={contexts.records}
          />
        );
      case "memory":
        return (
          <MemoryPane
            parties={parties}
            authority={vta.authority}
            contextId={selected}
            contextHeading={heading}
          />
        );
      case "app-state":
        return (
          <AppStatePane
            parties={parties}
            authority={vta.authority}
            contextId={selected}
            contextHeading={heading}
          />
        );
      case "rooms":
        return <RoomsPane parties={parties} contexts={contexts.records} />;
      case "services":
        return <ServicesPane parties={parties} authority={vta.authority} />;
      case "maintenance":
        return <MaintenancePane parties={parties} authority={vta.authority} />;
      case "audit":
        return <AuditPane parties={parties} contextId={selected} contextHeading={heading} />;
      case "access":
        return (
          <AccessPane
            parties={parties}
            authority={vta.authority}
            contextId={selected}
            contextHeading={heading}
          />
        );
      case "approvals":
        return (
          <ApprovalsPane
            parties={parties}
            authority={vta.authority}
            contextId={selected}
            contextHeading={heading}
          />
        );
      case "policy":
        return (
          <PolicyPane
            parties={parties}
            authority={vta.authority}
            contextId={selected}
            contextHeading={heading}
          />
        );
      case "sessions":
        return <SessionsPane parties={parties} authority={vta.authority} />;
    }
  }, [vta, parties, section, contexts.records, selected, heading, onChanged, go]);

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

  // The context column appears only where the selection actually narrows the
  // question. On Transports and Sessions it would be a filter that filters
  // nothing — see `Section.contextScoped`.
  const scoped = isContextScoped(section);

  return (
    <div
      style={{
        height: "100%",
        display: "grid",
        gridTemplateColumns: [
          railCollapsed ? "52px" : "186px",
          ...(scoped ? ["244px"] : []),
          "minmax(0, 1fr)",
        ].join(" "),
        gridTemplateRows: "auto minmax(0, 1fr)",
        gridTemplateAreas: scoped
          ? `"rail tree banner" "rail tree pane"`
          : `"rail banner" "rail pane"`,
      }}
    >
      <div style={{ gridArea: "rail", minHeight: 0 }}>
        <ActRail
          section={section}
          onSelect={go}
          collapsed={railCollapsed}
          onToggle={toggleRail}
        />
      </div>

      {scoped && (
        <div style={{ gridArea: "tree", minHeight: 0, display: "grid" }}>
          <ContextTree
            records={contexts.records}
            selected={selected}
            onSelect={setSelected}
            loading={contexts.loading}
            error={contexts.error}
          />
        </div>
      )}

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
