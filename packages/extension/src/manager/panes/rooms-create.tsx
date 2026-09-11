// Making a room: an identity, then a host, then what that host may see.
//
// **A room is a DID, not a row in a host's table.** That is the whole reason
// this form has more than one step. The room's own identity issues the
// credentials that govern it, and a host authorises every operation against
// those credentials rather than against anything it stores — so the room is
// portable. Re-point it at another host and the room has moved, with no
// credential reissued and nothing to migrate.
//
// Which is why the identity is minted (or supplied) **first**, and the host is
// told about a room that already exists. The reverse order would be a host
// handing out an identifier, and a room whose name came from its host is a room
// that cannot leave.
//
// ## Why it is laid out as numbered steps
//
// It used to be one wrap of fields under a paragraph, and the two things an
// operator most needed to find were the two they missed: which mediator to
// name, and that a host DID can be minted here at all (a quiet "Mint one" beside
// the field, read as a label). So each step now says what it decides and why
// before it asks, and each way through a step is a **peer choice** with its
// consequence written beside it — never a primary field with an alternative
// hiding next to it. Nothing is written until the last button, and the list
// above that button says what pressing it will do.
//
// ## The mediator is offered, not typed
//
// `vta/services/list` names the mediator the agent's DIDComm and TSP transports
// route through, so the usual answer is already known and typing a DID is the
// exception. It is offered as what the agent *routes through*, never as what
// works: advertisement is not availability. The listing is admin-gated and a
// context-scoped caller may be refused — that is a failure to ask, not an agent
// without a mediator, so the form says so and falls back to the typed field.
//
// ## The pair, and why both halves are asked for
//
// Minting returns `did` **and** `signingKeyId`, and every `rooms/owner/*` task
// needs both: the VTA signs *as* the room with a key it holds, and the key is
// **named, not looked up** — nothing maps a DID to the key it was minted with,
// and a mapping invented for convenience is one that goes stale after a
// rotation. So a DID without its key identifier is a room that cannot invite
// anyone, and the "already minted" path asks for both rather than pretending
// the DID alone is enough.
//
// ## The failure that matters
//
// Minting succeeds and registration fails. The DID exists, it is real, and it is
// the only copy of something the operator cannot re-derive — so the form must
// not swallow it. `Minted` stays on screen with both halves after any failure
// below it, and the flow switches to the existing-identity path pre-filled, so
// the retry registers the room that was minted rather than minting a second one.

import { useCallback, useEffect, useId, useState, type ReactNode } from "react";
import { roomsOwnerRegister } from "@openvtc/pnm-core/rooms";
import { webvhDidCreate, webvhServerList } from "@openvtc/pnm-core/webvh";
import type { WebvhServerRecord } from "@openvtc/pnm-core/webvh";
import { servicesList, type ServiceState } from "@openvtc/pnm-core/admin";
import type { ContextRecord } from "@openvtc/pnm-core";
import { Button, Did, Note, Panel } from "../../ui.js";
import { c, t, font } from "../../theme.js";
import { managerSender } from "../sender.js";
import { ConsentRequiredError } from "../carrier.js";
import { ConsentCeremony, runMutation } from "../destructive.js";
import { contextHeading } from "../format.js";
import type { Parties } from "../use-vta.js";

const fieldStyle: React.CSSProperties = {
  boxSizing: "border-box",
  padding: "6px 9px",
  background: c.ground,
  color: c.text,
  border: `1px solid ${c.line}`,
  borderRadius: "var(--w-r-sm)",
  fontSize: t.sm,
  maxWidth: "100%",
};

/** The two halves of a room's identity. Neither is useful alone. */
export interface RoomIdentity {
  did: string;
  signingKeyId: string;
}

type Visibility = "open" | "attributed" | "private";

const VISIBILITY: { value: Visibility; title: string; detail: string }[] = [
  {
    value: "private",
    title: "Private",
    detail: "The host cannot see who the members are. The right default unless you have a reason.",
  },
  {
    value: "attributed",
    title: "Attributed",
    detail: "The host sees which member wrote each record.",
  },
  {
    value: "open",
    title: "Open",
    detail: "The host stores records in the clear and can read all of them.",
  },
];

const KIND_LABEL: Record<ServiceState["kind"], string> = {
  didcomm: "DIDComm",
  tsp: "TSP",
  rest: "REST",
  webauthn: "WebAuthn",
};

/** A mediator the agent's own transports route through. */
interface AgentMediator {
  did: string;
  kinds: string[];
  /** Whether any transport using it is currently advertised. */
  enabled: boolean;
}

/**
 * The distinct mediators in a services listing, advertised ones first.
 *
 * DIDComm and TSP usually share one mediator, and offering it twice would read
 * as a choice between two things that are the same.
 */
function agentMediators(services: ServiceState[]): AgentMediator[] {
  const byDid = new Map<string, AgentMediator>();
  for (const s of services) {
    if (!s.mediatorDid) continue;
    const m = byDid.get(s.mediatorDid) ?? { did: s.mediatorDid, kinds: [], enabled: false };
    m.kinds.push(KIND_LABEL[s.kind] ?? s.kind);
    m.enabled ||= s.enabled;
    byDid.set(s.mediatorDid, m);
  }
  return [...byDid.values()].sort((a, b) => Number(b.enabled) - Number(a.enabled));
}

function Label({ children, hint }: { children: string; hint?: string | undefined }) {
  return (
    <span style={{ fontSize: t.xs, color: c.muted }}>
      {children}
      {hint ? <span style={{ color: c.faint }}> {hint}</span> : null}
    </span>
  );
}

function Field({
  label,
  hint,
  grow,
  children,
}: {
  label: string;
  hint?: string | undefined;
  grow?: string | undefined;
  children: ReactNode;
}) {
  return (
    <label style={{ display: "grid", gap: 4, flex: grow ?? "0 1 auto", minWidth: 0 }}>
      <Label hint={hint}>{label}</Label>
      {children}
    </label>
  );
}

const row: React.CSSProperties = { display: "flex", gap: 10, flexWrap: "wrap", alignItems: "flex-end" };
const choices: React.CSSProperties = {
  display: "grid",
  gridTemplateColumns: "repeat(auto-fit, minmax(min(100%, 17rem), 1fr))",
  gap: 8,
};

/**
 * One way through a step, with what it means written beside it.
 *
 * A bordered card rather than a bare radio because the description is the
 * point: "mint a host DID" next to a field is a label nobody reads, and the same
 * words as an option with a sentence under them are a decision.
 */
function Choice({
  name,
  value,
  checked,
  onSelect,
  title,
  children,
}: {
  name: string;
  value: string;
  checked: boolean;
  onSelect: () => void;
  title: ReactNode;
  children?: ReactNode;
}) {
  return (
    <label
      style={{
        display: "flex",
        gap: 10,
        alignItems: "flex-start",
        padding: "9px 12px",
        border: `1px solid ${checked ? c.accent : c.line}`,
        background: checked ? c.accentSoft : c.ground,
        borderRadius: "var(--w-r-sm)",
        cursor: "pointer",
        minWidth: 0,
      }}
    >
      <input
        type="radio"
        name={name}
        value={value}
        checked={checked}
        onChange={onSelect}
        style={{ margin: "3px 0 0" }}
      />
      <span style={{ display: "grid", gap: 3, minWidth: 0 }}>
        <span style={{ fontSize: t.sm, fontWeight: 600, color: c.text }}>{title}</span>
        {children && (
          <span style={{ display: "grid", gap: 2, fontSize: t.xs, color: c.muted, lineHeight: 1.5 }}>
            {children}
          </span>
        )}
      </span>
    </label>
  );
}

/**
 * A numbered step: what it decides, why, then the controls.
 *
 * The tick says the step has what it needs — not that anything was written.
 * Nothing is, until the button at the end.
 */
function Step({
  n,
  title,
  why,
  done,
  last = false,
  children,
}: {
  n: number;
  title: string;
  why: ReactNode;
  done: boolean;
  last?: boolean;
  children: ReactNode;
}) {
  return (
    <section style={{ display: "grid", gridTemplateColumns: "22px minmax(0, 1fr)", columnGap: 14 }}>
      <div style={{ display: "grid", gridTemplateRows: "22px 1fr", justifyItems: "center" }}>
        <span
          role="img"
          aria-label={done ? `Step ${n}, ready` : `Step ${n}`}
          style={{
            width: 22,
            height: 22,
            borderRadius: 999,
            display: "inline-flex",
            alignItems: "center",
            justifyContent: "center",
            fontSize: t.xs,
            fontWeight: 700,
            background: done ? c.ok : c.accent,
            color: c.accentInk,
          }}
        >
          {done ? (
            <svg width="12" height="12" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth={2.2} strokeLinecap="round" strokeLinejoin="round"><path d="M3 8.5 6.5 12 13 4.5" /></svg>
          ) : (
            n
          )}
        </span>
        {!last && <span style={{ width: 1, background: c.line, marginTop: 6 }} />}
      </div>
      <div style={{ display: "grid", gap: 10, paddingBottom: last ? 4 : 24, minWidth: 0 }}>
        <div style={{ display: "grid", gap: 3 }}>
          <h3 style={{ margin: 0, fontSize: t.base, fontWeight: 640, lineHeight: "22px" }}>{title}</h3>
          <p style={{ margin: 0, fontSize: t.sm, color: c.muted, lineHeight: 1.55, maxWidth: "82ch" }}>
            {why}
          </p>
        </div>
        {children}
      </div>
    </section>
  );
}

function ContextSelect({
  name,
  contexts,
  value,
  onChange,
}: {
  name: string;
  contexts: ContextRecord[];
  value: string;
  onChange: (id: string) => void;
}) {
  return (
    <select aria-label={name} style={fieldStyle} value={value} onChange={(e) => onChange(e.target.value)}>
      <option value="">Choose…</option>
      {contexts.map((ctx) => (
        <option key={ctx.id} value={ctx.id}>
          {contextHeading(ctx, ctx.id)}
        </option>
      ))}
    </select>
  );
}

function ServerSelect({
  name,
  servers,
  value,
  onChange,
}: {
  name: string;
  servers: WebvhServerRecord[] | null;
  value: string;
  onChange: (id: string) => void;
}) {
  return (
    <select
      aria-label={name}
      style={fieldStyle}
      value={value}
      onChange={(e) => onChange(e.target.value)}
      disabled={servers === null}
    >
      <option value="">{servers === null ? "Reading…" : "Choose…"}</option>
      {(servers ?? []).map((s) => (
        <option key={s.id} value={s.id}>
          {s.label ? `${s.label} (${s.id})` : s.id}
        </option>
      ))}
    </select>
  );
}

/**
 * The agent's own mediator as a choice, or a different one typed.
 *
 * `typing` is its own state rather than read off `value`, because "a different
 * mediator, not typed yet" and "nothing chosen" are both the empty string, and
 * only one of them should show the field.
 */
function MediatorPicker({
  name,
  value,
  onChange,
  known,
  knownError,
}: {
  name: string;
  value: string;
  onChange: (did: string) => void;
  known: AgentMediator[] | null;
  knownError: string | null;
}) {
  const group = useId();
  const [typing, setTyping] = useState(false);
  const list = known ?? [];
  const other = typing || (value !== "" && !list.some((m) => m.did === value));

  const input = (
    <input
      aria-label={name}
      style={{ ...fieldStyle, width: "100%" }}
      value={value}
      placeholder="did:…"
      onChange={(e) => onChange(e.target.value)}
    />
  );

  if (knownError) {
    return (
      <div style={{ display: "grid", gap: 6 }}>
        <Note tone="warn">
          Your agent&apos;s transports could not be read ({knownError}), so its mediator cannot be
          offered here. That is a failure to ask, not an agent without one — enter the mediator&apos;s
          DID instead. The Transports pane shows it, if you can read that pane.
        </Note>
        {input}
      </div>
    );
  }
  if (known === null) {
    return <span style={{ fontSize: t.sm, color: c.faint }}>Asking your agent which mediator it uses…</span>;
  }
  if (list.length === 0) {
    return (
      <div style={{ display: "grid", gap: 6 }}>
        <span style={{ fontSize: t.xs, color: c.muted }}>
          Your agent routes nothing through a mediator — it is reached over REST alone — so there is
          none to offer. Enter the DID of the mediator to use.
        </span>
        {input}
      </div>
    );
  }

  return (
    <div style={{ display: "grid", gap: 8 }}>
      <div style={choices}>
        {list.map((m) => (
          <Choice
            key={m.did}
            name={group}
            value={m.did}
            checked={!other && value === m.did}
            onSelect={() => {
              setTyping(false);
              onChange(m.did);
            }}
            title={list.length > 1 ? `Your agent's ${m.kinds.join(" / ")} mediator` : "Your agent's mediator"}
          >
            <Did value={m.did} size={t.xs} />
            <span>
              {m.enabled
                ? `Your agent routes ${m.kinds.join(" and ")} through it — the usual choice.`
                : `Your agent has ${m.kinds.join(" and ")} switched off, so it is not advertising this one right now.`}
            </span>
          </Choice>
        ))}
        <Choice
          name={group}
          value="other"
          checked={other}
          onSelect={() => {
            setTyping(true);
            if (list.some((m) => m.did === value)) onChange("");
          }}
          title="A different mediator"
        >
          Name any mediator by its DID.
        </Choice>
      </div>
      {other && input}
    </div>
  );
}

/**
 * What was minted, kept on screen.
 *
 * Not a receipt — a recovery. `signingKeyId` is the half an operator does not
 * think to write down, and it is the half that cannot be recovered from the DID
 * document: the document names a verification method, and which *held key* that
 * is, is a fact only the minting response carried.
 */
function Minted({ identity }: { identity: RoomIdentity }) {
  return (
    <Note tone="accent">
      <p style={{ margin: "0 0 6px" }}>
        The room's identity exists. Keep both halves — the key identifier is not
        recoverable from the DID document, and without it nothing can issue in this
        room's name.
      </p>
      <div style={{ display: "grid", gap: 3, fontFamily: font.mono, fontSize: t.xs }}>
        <span style={{ wordBreak: "break-all" }}>{identity.did}</span>
        <span style={{ wordBreak: "break-all" }}>{identity.signingKeyId}</span>
      </div>
    </Note>
  );
}

export function CreateRoom({
  parties,
  contexts,
  onCreated,
}: {
  parties: Parties;
  contexts: ContextRecord[];
  onCreated: () => void;
}) {
  // `mint` or `existing`. The default is `mint` because the common case is a
  // room that does not exist yet, and offering "paste a DID" first invites
  // pasting the *agent's* DID, which would make the agent the room.
  const [source, setSource] = useState<"mint" | "existing">("mint");
  const [contextId, setContextId] = useState("");
  const [serverId, setServerId] = useState("");
  const [mediatorDid, setMediatorDid] = useState("");
  const [existing, setExisting] = useState<RoomIdentity>({ did: "", signingKeyId: "" });

  // `have` or `mint`. Pasting stays the default — a host DID is minted once per
  // deployment, not once per room — but minting is a peer option in plain view,
  // because a first-time operator does not know one can be.
  const [hostSource, setHostSource] = useState<"have" | "mint">("have");
  const [hostDid, setHostDid] = useState("");
  const [hostCtx, setHostCtx] = useState("");
  const [hostServer, setHostServer] = useState("");
  const [hostUrl, setHostUrl] = useState("");
  const [hostMediator, setHostMediator] = useState("");
  const [hostBusy, setHostBusy] = useState(false);
  const [hostError, setHostError] = useState<string | null>(null);
  // Which host DID this form minted, and in which context, so the note saying
  // what is still to do stays attached to that DID and not to one pasted over it.
  const [hostMinted, setHostMinted] = useState<{ did: string; contextId: string } | null>(null);
  const [visibility, setVisibility] = useState<Visibility>("private");
  const [retentionDays, setRetentionDays] = useState("");

  const [servers, setServers] = useState<WebvhServerRecord[] | null>(null);
  const [serversError, setServersError] = useState<string | null>(null);
  const [mediators, setMediators] = useState<AgentMediator[] | null>(null);
  const [mediatorsError, setMediatorsError] = useState<string | null>(null);
  const [minted, setMinted] = useState<RoomIdentity | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [pending, setPending] = useState<ConsentRequiredError | null>(null);

  useEffect(() => {
    let live = true;
    void (async () => {
      try {
        const res = await webvhServerList(managerSender, { ...parties });
        if (live) setServers(res.servers ?? []);
      } catch (e) {
        if (live) setServersError(e instanceof Error ? e.message : String(e));
      }
    })();
    return () => {
      live = false;
    };
  }, [parties]);

  useEffect(() => {
    let live = true;
    void (async () => {
      try {
        const found = agentMediators(await servicesList(managerSender, { ...parties }));
        if (!live) return;
        setMediators(found);
        // Chosen for the operator, visibly — the card is highlighted and one
        // click from "a different mediator". Only an advertised one: preselecting
        // a mediator the agent has switched off would be choosing a dead path.
        const usual = found.find((m) => m.enabled)?.did;
        if (usual) setMediatorDid((p) => p || usual);
      } catch (e) {
        if (live) setMediatorsError(e instanceof Error ? e.message : String(e));
      }
    })();
    return () => {
      live = false;
    };
  }, [parties]);

  const identity: RoomIdentity | null =
    source === "existing"
      ? existing.did.trim() && existing.signingKeyId.trim()
        ? { did: existing.did.trim(), signingKeyId: existing.signingKeyId.trim() }
        : null
      : null;

  const retention = retentionDays.trim();
  const retentionBad = retention !== "" && !/^[1-9]\d*$/.test(retention);

  // Everything the *chosen* path needs, and nothing it does not: a form that
  // greys its button without saying which field is missing is a form people
  // fill in twice.
  const missing =
    source === "mint"
      ? !contextId
        ? "Step 1: choose the context the room's DID belongs to."
        : !serverId
          ? "Step 1: choose a hosting server to publish the DID's log through."
          : !mediatorDid.trim()
            ? "Step 1: the room needs a mediator — it is what makes the room addressable, so an invitation or an epoch notice can reach it."
            : null
      : !identity
        ? "Step 1: a room's identity is a DID and the identifier of the key that signs for it. Both."
        : null;

  const hostMissing = hostSource === "mint"
    ? "Step 2: mint the host's DID, or choose a host that already has one."
    : !hostDid.trim()
      ? "Step 2: name the host that will serve this room's records."
      : null;

  const retentionMissing = retentionBad
    ? "Step 3: retention is a whole number of days, or empty."
    : null;

  const blocked = missing ?? hostMissing ?? retentionMissing;

  // Mint a DID for the host, in a context the host will be granted on.
  //
  // The same `webvh/dids/create` the room's own identity uses, with the
  // `room-host` template — which publishes a DIDComm service pointing at the
  // mediator and a `VTARest` service at the host's URL. A host DID that
  // advertises neither is one no member can reach, which is why the template
  // requires all three vars rather than defaulting them.
  //
  // Deliberately does NOT register the host anywhere or grant it anything. It
  // mints an identity in a context; the host still enrols on its own and an
  // operator still grants it. This removes the step nobody could guess, not the
  // step that is somebody's decision.
  const mintHost = useCallback(async () => {
    setHostBusy(true);
    setHostError(null);
    await runMutation(
      async () => {
        const res = await webvhDidCreate(managerSender, {
          ...parties,
          contextId: hostCtx,
          serverId: hostServer,
          template: "room-host",
          templateVars: {
            WEBVH_SERVER: hostServer,
            URL: hostUrl.trim(),
            MEDIATOR_DID: hostMediator.trim(),
          },
        });
        setHostDid(res.did);
        setHostMinted({ did: res.did, contextId: hostCtx });
        setHostSource("have");
      },
      { onConsent: setPending, onError: setHostError },
    );
    setHostBusy(false);
  }, [parties, hostCtx, hostServer, hostUrl, hostMediator]);

  const hostMintMissing = !hostCtx
    ? "Choose the context the host's DID belongs to — the one it will be granted an application role on."
    : !hostServer
      ? "Choose a hosting server to publish the host DID's log through."
      : !hostUrl.trim()
        ? "The host needs a URL: members that can open one reach its records there."
        : !hostMediator.trim()
          ? "The host needs a mediator — it is how a member that cannot open a URL reaches it at all."
          : null;

  const submit = useCallback(async () => {
    setBusy(true);
    setError(null);
    setPending(null);

    // ── Half one: the identity ──
    let room = identity;
    if (!room) {
      const ok = await runMutation(
        async () => {
          const res = await webvhDidCreate(managerSender, {
            ...parties,
            contextId,
            serverId,
            template: "room",
            // `WEBVH_SERVER` is one of the `room` template's `requiredVars` and
            // its document substitutes it nowhere — so it is passed to satisfy
            // the render, while `serverId` above is what actually decides where
            // the log is published. Dropping either one fails, differently.
            templateVars: { WEBVH_SERVER: serverId, MEDIATOR_DID: mediatorDid.trim() },
          });
          room = { did: res.did, signingKeyId: res.signingKeyId };
          setMinted(room);
        },
        { onConsent: setPending, onError: setError },
      );
      if (!ok || !room) {
        setBusy(false);
        return;
      }
      // Carry the minted pair into the existing-identity path *before* the
      // registration is attempted. If the call below fails, the retry then
      // registers this room rather than minting a second one — which is the
      // difference between one orphaned DID and a new one on every press.
      setExisting(room);
      setSource("existing");
    }

    // ── Half two: tell a host ──
    const ok = await runMutation(
      async () => {
        // Through the agent, not straight at the host. This console addresses
        // every task to the wallet's own VTA — its bridge carries a type and a
        // payload and nothing else — so `rooms/create` composed here would name
        // a host that never travels and land at an agent that does not serve it.
        // `rooms/owner/register` is the same registration asked of the party
        // that can make the call.
        await roomsOwnerRegister(managerSender, {
          ...parties,
          roomId: room!.did,
          host: hostDid.trim(),
          ownerDid: parties.holder.did,
          visibility,
          ...(retention ? { retentionDays: Number(retention) } : {}),
        });
      },
      { onConsent: setPending, onError: setError },
    );
    setBusy(false);
    if (ok) {
      setMinted(null);
      setExisting({ did: "", signingKeyId: "" });
      setSource("mint");
      setHostDid("");
      setHostMinted(null);
      onCreated();
    }
  }, [
    parties, identity, contextId, serverId, mediatorDid, hostDid, visibility, retention,
    onCreated,
  ]);

  const usualMediator = mediators?.find((m) => m.enabled)?.did ?? "";
  const serverName = (id: string) => {
    const s = servers?.find((x) => x.id === id);
    return s?.label ?? id;
  };

  // A step is ticked only once every step before it is, too. Step three is
  // valid on arrival — its defaults are fine — and a green tick on the last step
  // beside two unfinished ones reads as a form filled in out of order.
  const stepOneReady = source === "mint" ? !missing : Boolean(identity);
  const stepTwoReady = stepOneReady && !hostMissing;
  const stepThreeReady = stepTwoReady && !retentionBad;
  const identityGroup = useId();
  const hostGroup = useId();
  const visibilityGroup = useId();

  return (
    <Panel
      title="New room"
      description="Three decisions, in order: the room's own identity, the host that stores its
        records, and how much that host can see. Nothing is written to your agent until you press
        Create room at the end."
    >
      {serversError && (
        <Note tone="warn">
          The list of hosting servers could not be read ({serversError}), so this form cannot
          offer one. That is a failure to ask, not an agent with none registered.
        </Note>
      )}

      <div style={{ display: "grid", marginTop: 4 }}>
        <Step
          n={1}
          title="Give the room its own identity"
          done={stepOneReady}
          why="A room is a DID of its own, not an entry in a host's database. It signs the
            invitations and memberships that govern it, so it can move to another host later
            without reissuing any of them. Your agent keeps its signing key; this console never
            sees it."
        >
          <div style={choices}>
            <Choice
              name={identityGroup}
              value="mint"
              checked={source === "mint"}
              onSelect={() => setSource("mint")}
              title="Mint a new identity"
            >
              Your agent creates a DID for the room and holds its keys. The usual choice.
            </Choice>
            <Choice
              name={identityGroup}
              value="existing"
              checked={source === "existing"}
              onSelect={() => setSource("existing")}
              title="Use one already minted"
            >
              You will need its DID and the identifier of the key that signs for it.
            </Choice>
          </div>

          {source === "mint" ? (
            <>
              <div style={row}>
                <Field label="CONTEXT" hint="— where the room's keys live; deleting it destroys the room's identity">
                  <ContextSelect name="Room context" contexts={contexts} value={contextId} onChange={setContextId} />
                </Field>
                <Field label="HOSTING SERVER" hint="— publishes the DID so anyone can resolve it">
                  <ServerSelect name="Room hosting server" servers={servers} value={serverId} onChange={setServerId} />
                </Field>
              </div>
              <div style={{ display: "grid", gap: 6 }}>
                <Label hint="— how invitations and epoch notices reach the room">MEDIATOR</Label>
                <MediatorPicker
                  name="Room mediator DID"
                  value={mediatorDid}
                  onChange={setMediatorDid}
                  known={mediators}
                  knownError={mediatorsError}
                />
              </div>
            </>
          ) : (
            <div style={row}>
              <Field label="ROOM DID" grow="1 1 22rem">
                <input
                  aria-label="Room DID"
                  style={fieldStyle}
                  value={existing.did}
                  onChange={(e) => setExisting((p) => ({ ...p, did: e.target.value }))}
                />
              </Field>
              <Field label="SIGNING KEY ID" hint="— the held key that signs as the room; not derivable from the DID" grow="1 1 14rem">
                <input
                  aria-label="Signing key ID"
                  style={fieldStyle}
                  value={existing.signingKeyId}
                  onChange={(e) => setExisting((p) => ({ ...p, signingKeyId: e.target.value }))}
                />
              </Field>
            </div>
          )}
        </Step>

        <Step
          n={2}
          title="Choose a host for its records"
          done={stepTwoReady}
          why="The host stores the room's records and serves them to members. It never holds a key.
            A host is identified by a DID of its own, and the room is registered with that DID —
            so if the host is new, mint its DID here first."
        >
          <div style={choices}>
            <Choice
              name={hostGroup}
              value="have-host"
              checked={hostSource === "have"}
              onSelect={() => setHostSource("have")}
              title="Use a host that already has a DID"
            >
              Paste the DID of a room host that is already running.
            </Choice>
            <Choice
              name={hostGroup}
              value="mint-host"
              checked={hostSource === "mint"}
              onSelect={() => {
                // Seeded from the room's choices, because in practice the host
                // lives in the same context on the same server behind the same
                // mediator. Seeded rather than shared: a host may legitimately be
                // elsewhere, and a field that silently tracked the room's would
                // make that impossible to express.
                setHostCtx((p) => p || contextId);
                setHostServer((p) => p || serverId);
                setHostMediator((p) => p || mediatorDid || usualMediator);
                setHostSource("mint");
              }}
              title="Mint a DID for a new host"
            >
              For a host you have not deployed yet. Your agent creates its identity; the host
              service then enrols with it.
            </Choice>
          </div>

          {hostSource === "have" ? (
            <>
              <Field label="HOST DID" hint="— the host's own DID, not its URL" grow="1 1 22rem">
                <input
                  aria-label="Host DID"
                  style={fieldStyle}
                  value={hostDid}
                  onChange={(e) => setHostDid(e.target.value)}
                />
              </Field>
              {hostMinted && hostMinted.did === hostDid.trim() && (
                <Note tone="accent">
                  <strong>Host DID minted.</strong> It is an identity, not a running host. Two things
                  happen outside this form before members can use it: the host service enrols with
                  this DID, and you grant it the <em>application</em> role on{" "}
                  {contextHeading(contexts.find((x) => x.id === hostMinted.contextId), hostMinted.contextId)}{" "}
                  from the Access pane. Registering the room asks the host to accept it, so that
                  fails until the host is up — and if it does, the room&apos;s identity is kept for a
                  retry.
                </Note>
              )}
            </>
          ) : (
            <div
              style={{
                display: "grid",
                gap: 10,
                padding: "12px 14px",
                border: `1px dashed ${c.line}`,
                borderRadius: "var(--w-r-sm)",
              }}
            >
              <p style={{ margin: 0, fontSize: t.sm, color: c.muted, lineHeight: 1.55, maxWidth: "82ch" }}>
                Your agent mints the host&apos;s DID from the <code>room-host</code> template, which
                publishes where members reach it: a REST service at its URL and a DIDComm service
                at its mediator. It does not start, enrol or authorise the host — the host enrols
                itself, and granting it an application role on its context is still your decision.
              </p>
              <div style={row}>
                <Field label="HOST CONTEXT" hint="— where the host will be granted">
                  <ContextSelect name="Host context" contexts={contexts} value={hostCtx} onChange={setHostCtx} />
                </Field>
                <Field label="HOSTING SERVER">
                  <ServerSelect name="Host hosting server" servers={servers} value={hostServer} onChange={setHostServer} />
                </Field>
                <Field label="HOST URL" hint="— where it serves records over HTTPS" grow="1 1 16rem">
                  <input
                    aria-label="Host URL"
                    style={fieldStyle}
                    value={hostUrl}
                    placeholder="https://…"
                    onChange={(e) => setHostUrl(e.target.value)}
                  />
                </Field>
              </div>
              <div style={{ display: "grid", gap: 6 }}>
                <Label hint="— how a member with no reachable URL gets to the host">HOST MEDIATOR</Label>
                <MediatorPicker
                  name="Host mediator DID"
                  value={hostMediator}
                  onChange={setHostMediator}
                  known={mediators}
                  knownError={mediatorsError}
                />
              </div>
              {hostError && <Note tone="warn">{hostError}</Note>}
              <div style={{ display: "flex", gap: 10, alignItems: "center", flexWrap: "wrap" }}>
                <Button onClick={() => void mintHost()} disabled={busy || hostBusy || !!hostMintMissing}>
                  {hostBusy ? "Minting…" : "Mint host DID"}
                </Button>
                {hostMintMissing && (
                  <span style={{ fontSize: t.sm, color: c.muted }}>{hostMintMissing}</span>
                )}
              </div>
            </div>
          )}
        </Step>

        <Step
          n={3}
          title="Decide how much the host can see"
          done={stepThreeReady}
          last
          why="Visibility is fixed per room and decides what the host learns while serving it.
            Private is the right answer unless the room's contents are meant to be public to its host."
        >
          <div style={choices}>
            {VISIBILITY.map((v) => (
              <Choice
                key={v.value}
                name={visibilityGroup}
                value={v.value}
                checked={visibility === v.value}
                onSelect={() => setVisibility(v.value)}
                title={v.title}
              >
                {v.detail}
              </Choice>
            ))}
          </div>
          {visibility === "open" && (
            <Note tone="warn">
              On an <strong>open</strong> room the host stores record bodies in the clear and can
              read every one of them. Choose it when the room's contents are meant to be public to
              its host, not merely when encryption seems like a complication.
            </Note>
          )}
          <Field label="RETENTION DAYS" hint="(optional) — leave empty for the host's default">
            <input
              aria-label="Retention days"
              style={{ ...fieldStyle, width: "7rem" }}
              value={retentionDays}
              inputMode="numeric"
              onChange={(e) => setRetentionDays(e.target.value)}
            />
          </Field>
        </Step>
      </div>

      <div
        style={{
          display: "grid",
          gap: 6,
          padding: "10px 14px",
          background: c.raised,
          border: `1px solid ${c.lineSoft}`,
          borderRadius: "var(--w-r-sm)",
          fontSize: t.sm,
        }}
      >
        <span style={{ fontSize: t.xs, color: c.muted, fontWeight: 600 }}>
          {minted ? "PRESSING “REGISTER WITH THE HOST” WILL" : "PRESSING “CREATE ROOM” WILL"}
        </span>
        <ol style={{ margin: 0, paddingLeft: 20, display: "grid", gap: 4, lineHeight: 1.55 }}>
          <li>
            {source === "mint" ? (
              <>
                Mint the room&apos;s DID in{" "}
                <strong>{contextId ? contextHeading(contexts.find((x) => x.id === contextId), contextId) : "the chosen context"}</strong>{" "}
                and publish it through <strong>{serverId ? serverName(serverId) : "the chosen server"}</strong>.
                This is the step that cannot be taken back.
              </>
            ) : (
              <>Mint nothing — the room uses the identity entered in step 1.</>
            )}
          </li>
          <li>
            Register it with {hostDid.trim() ? <Did value={hostDid.trim()} size={t.xs} /> : "the host"} as
            a <strong>{visibility}</strong> room, owned by you. If this fails, the identity is kept
            and the button retries only this.
          </li>
        </ol>
      </div>

      {minted && <Minted identity={minted} />}
      {error && <Note tone="danger">{error}</Note>}
      {pending && <ConsentCeremony pending={pending} />}

      <div style={{ display: "flex", gap: 10, alignItems: "center", flexWrap: "wrap" }}>
        <Button kind="primary" disabled={busy || Boolean(blocked)} onClick={() => void submit()}>
          {busy ? "Working…" : minted ? "Register with the host" : "Create room"}
        </Button>
        {blocked && <span style={{ fontSize: t.sm, color: c.muted }}>{blocked}</span>}
      </div>
    </Panel>
  );
}
