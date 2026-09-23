// Mediator Lens — the relay carrying an agent's mail, seen from inside.
//
// Every other pane in this console asks the *agent*. This one asks the
// *mediator*: its `messaging/*` operations surface, run over the session the
// wallet already holds with it for that agent's inbox, authenticated as that
// agent's holder. Three facts shape what is on screen.
//
// **What you may see is the mediator's decision.** The account it returns for
// this holder says `standard`, `admin` or `rootAdmin`, and the pane offers the
// mediator-wide views only to the latter two. The mediator still authorises
// every task; the pane only avoids offering what would be refused.
//
// **The mediator knows accounts by hash.** Every `did`, `from` and `to` it
// reports is `sha256(did)`. The wallet knows the DIDs it manages, so it names
// the ones it can — this wallet, its agents, the relay itself — and leaves the
// rest as hashes, which is the honest answer rather than a gap.
//
// **Advertisement is not availability, here too.** A relay listed below is one
// the wallet has a session record for; `probe` and `account/get` are what say
// the mediator is actually answering.

import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState } from "react";
import {
  accountBook,
  accountHash,
  mediatorAccountGet,
  mediatorAccountList,
  mediatorQueueList,
  mediatorQueueStatus,
  mediatorStats,
  meetsMediatorFloor,
  MEDIATOR_VERSION_FLOOR,
  purgePreview,
  purgeWithPlan,
  saturationOf,
  standingOf,
  type Account,
  type MediatorCaller,
  type MonitorEvent,
  type PeerDepth,
  type PurgePlan,
  type Queue,
  type QueueDepth,
  type QueueSummary,
} from "@openvtc/pnm-core/mediator";
import { auditList, configShow } from "@openvtc/pnm-core/admin";
import type {
  KnownRelay,
  MediatorLocation,
  MediatorProbe,
  MonitorMessage,
} from "../../bridge-protocol.js";
import { Button, CopyButton, Did, Note, Panel, Pill } from "../../ui.js";
import { mediatorGrantCommand } from "../../grant-command.js";
import { c, font, t } from "../../theme.js";
import { Destructive } from "../destructive.js";
import { Loading, LoadError, Table } from "../table.js";
import { useAsync } from "../use-async.js";
import { formatInstant } from "../format.js";
import type { Parties } from "../use-vta.js";
import { MediatorTaskSender, mediatorOp, openMonitorPort } from "../mediator-sender.js";
import {
  ageText,
  bytesText,
  capTape,
  countText,
  didLabel,
  directionGlyph,
  isTrouble,
  lensHref,
  parseLensRoute,
  pressureOf,
  shortHash,
  verificationModeOf,
  type LensRoute,
  type Pressure,
} from "../mediator-lens-model.js";

const PRESSURE_COLOUR: Record<Pressure, string> = {
  ok: c.ok,
  warn: c.warn,
  danger: c.danger,
  unlimited: c.faint,
};

/** hash → a name the wallet can vouch for. */
type Names = Map<string, string>;

function useRoute(): LensRoute {
  const [route, setRoute] = useState(() => parseLensRoute(location.hash));
  useEffect(() => {
    const on = () => setRoute(parseLensRoute(location.hash));
    addEventListener("hashchange", on);
    return () => removeEventListener("hashchange", on);
  }, []);
  return route;
}


/** The relay the tables below are about, so an account in one can link to its
 *  own mail on that relay. */
const PairContext = createContext<{ mediatorDid: string; vtaDid: string } | null>(null);

/** An account, by the name the wallet knows it by or by its hash — and a link
 *  to that account's mail on this relay. */
function Account({ hash, names }: { hash: string | undefined; names: Names }) {
  const pair = useContext(PairContext);
  if (!hash) return <span style={{ color: c.faint }}>—</span>;
  const name = names.get(hash);
  const body = (
    <>
      {name && <span style={{ fontWeight: 600 }}>{name}</span>}
      <span style={{ fontFamily: font.mono, fontSize: t.xs, color: c.faint }}>{shortHash(hash)}</span>
    </>
  );
  const style = { display: "inline-flex", gap: 6, alignItems: "baseline" } as const;
  if (!pair) return <span title={hash} style={style}>{body}</span>;
  return (
    <a
      href={lensHref({ ...pair, account: hash })}
      title={`${hash} — show this account's mail`}
      style={{ ...style, color: "inherit", textDecoration: "none" }}
    >
      {body}
    </a>
  );
}

function Bar({ saturation }: { saturation: number | undefined }) {
  const p = pressureOf(saturation);
  return (
    <div
      role="img"
      aria-label={saturation === undefined ? "no limit" : `${Math.round(saturation * 100)}% of limit`}
      style={{ width: 90, height: 6, borderRadius: 3, background: c.raised, overflow: "hidden" }}
    >
      {saturation !== undefined && (
        <div
          style={{
            width: `${Math.min(100, Math.round(saturation * 100))}%`,
            height: "100%",
            background: PRESSURE_COLOUR[p],
          }}
        />
      )}
    </div>
  );
}

function Tile({ label, value, sub, tone }: { label: string; value: string; sub?: string; tone?: string }) {
  return (
    <div
      style={{
        border: `1px solid ${c.lineSoft}`,
        borderRadius: "var(--w-r-md)",
        padding: "10px 12px",
        background: c.ground,
        display: "grid",
        gap: 2,
      }}
    >
      <span style={{ fontSize: t.xs, color: c.muted }}>{label}</span>
      <span style={{ fontSize: t.lg, fontWeight: 650, fontVariantNumeric: "tabular-nums", color: tone ?? c.text }}>
        {value}
      </span>
      {sub && <span style={{ fontSize: t.xs, color: c.faint }}>{sub}</span>}
    </div>
  );
}

function Tiles({ children }: { children: React.ReactNode }) {
  return (
    <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(150px, 1fr))", gap: 10 }}>
      {children}
    </div>
  );
}

function DepthLine({ label, depth }: { label: string; depth: QueueDepth }) {
  const sat = saturationOf(depth);
  return (
    <div style={{ display: "flex", gap: 12, alignItems: "center", flexWrap: "wrap", fontSize: t.sm }}>
      <span style={{ width: 64, color: c.muted }}>{label}</span>
      <span style={{ fontVariantNumeric: "tabular-nums", minWidth: 90 }}>
        {depth.count}
        {depth.limit !== undefined ? ` / ${depth.limit}` : ""} · {bytesText(depth.bytes)}
      </span>
      <Bar saturation={sat} />
      <span style={{ color: c.faint }}>oldest {ageText(depth.oldestAgeSeconds)}</span>
    </div>
  );
}

// ── The pane ────────────────────────────────────────────────────────────────

export function MediatorPane({ parties }: { parties: Parties }) {
  const route = useRoute();
  const relays = useAsync(() => mediatorOp<KnownRelay[]>({ kind: "relays" }), []);

  // Default: this agent's inbox, then any relay for this agent, then any.
  const pair = useMemo(() => {
    if (route.mediatorDid && route.vtaDid) return { mediatorDid: route.mediatorDid, vtaDid: route.vtaDid };
    const list = relays.data ?? [];
    const pick =
      list.find((r) => r.vtaDid === parties.service.did && r.isInbox) ??
      list.find((r) => r.vtaDid === parties.service.did) ??
      list[0];
    return pick ? { mediatorDid: pick.mediatorDid, vtaDid: pick.vtaDid } : undefined;
  }, [route.mediatorDid, route.vtaDid, relays.data, parties.service.did]);

  const focus = route.did || route.account;

  return (
    <div style={{ display: "grid", gap: 16, alignContent: "start" }}>
      <Panel
        title="Mediator Lens"
        description="The relay that carries your agent's mail, seen from inside: its queues, the
          accounts on it and its live traffic. It runs over the session your wallet already
          holds with that relay, signed in as your wallet — so what you can see is whatever the
          mediator decides your wallet may see."
      >
        {relays.error && <LoadError what="the relays this wallet uses" error={relays.error} />}
        {relays.loading && !relays.data && <Loading what="the relays this wallet uses" />}
        {relays.data && !focus && (
          <RelayPicker relays={relays.data} selected={pair} onReload={relays.reload} />
        )}
        <Locator initial={route.did} />
      </Panel>
      {route.did ? (
        relays.data && (
          <DidMail key={route.did} did={route.did} relays={relays.data} parties={parties} />
        )
      ) : pair ? (
        route.account ? (
          <AccountMail
            key={`${pair.mediatorDid}|${pair.vtaDid}|${route.account}`}
            mediatorDid={pair.mediatorDid}
            vtaDid={pair.vtaDid}
            account={route.account}
            parties={parties}
          />
        ) : (
          <RelayView key={`${pair.mediatorDid}|${pair.vtaDid}`} mediatorDid={pair.mediatorDid} vtaDid={pair.vtaDid} parties={parties} />
        )
      ) : (
        relays.data && (
          <Note tone="warn">
            This wallet holds no session with any mediator yet, so there is no relay to look
            through. Sessions open when the wallet listens for an agent's pushes — check the
            inbox under the wallet's Setup → Message routing.
          </Note>
        )
      )}
    </div>
  );
}

function RelayPicker({
  relays,
  selected,
  onReload,
}: {
  relays: KnownRelay[];
  selected: { mediatorDid: string; vtaDid: string } | undefined;
  onReload: () => void;
}) {
  if (relays.length === 0) return null;
  const key = (r: { mediatorDid: string; vtaDid: string }) => `${r.mediatorDid}|${r.vtaDid}`;
  return (
    <div style={{ display: "flex", gap: 10, alignItems: "center", flexWrap: "wrap" }}>
      <label htmlFor="lens-relay" style={{ fontSize: t.sm, color: c.muted }}>
        Relay
      </label>
      <select
        id="lens-relay"
        value={selected ? key(selected) : ""}
        onChange={(e) => {
          const r = relays.find((x) => key(x) === e.target.value);
          if (r) location.hash = lensHref({ mediatorDid: r.mediatorDid, vtaDid: r.vtaDid });
        }}
        style={{ font: "inherit", fontSize: t.sm, padding: "4px 8px", maxWidth: "100%" }}
      >
        {relays.map((r) => (
          <option key={key(r)} value={key(r)}>
            {didLabel(r.mediatorDid)} — {r.isInbox ? "inbox" : "outbound"} for {didLabel(r.vtaDid)}
            {r.state === "live" ? "" : ` (${r.state})`}
          </option>
        ))}
      </select>
      <Button kind="quiet" onClick={onReload}>
        Refresh
      </Button>
    </div>
  );
}

/** Show any DID's mail: its mediator, and what that mediator holds for it. */
function Locator({ initial }: { initial: string | undefined }) {
  const [did, setDid] = useState(initial ?? "");
  const [error, setError] = useState<string | null>(null);
  useEffect(() => setDid(initial ?? ""), [initial]);
  const go = () => {
    const v = did.trim();
    if (!v.startsWith("did:")) {
      setError("That is not a DID.");
      return;
    }
    setError(null);
    location.hash = lensHref({ did: v });
  };
  return (
    <div style={{ display: "grid", gap: 8, borderTop: `1px solid ${c.lineSoft}`, paddingTop: 10 }}>
      <label htmlFor="lens-locate" style={{ fontSize: t.sm, fontWeight: 600 }}>
        A DID's mail
      </label>
      <div style={{ display: "flex", gap: 8, flexWrap: "wrap" }}>
        <input
          id="lens-locate"
          value={did}
          onChange={(e) => setDid(e.target.value)}
          onKeyDown={(e) => e.key === "Enter" && go()}
          placeholder="did:webvh:…"
          style={{ flex: "1 1 320px", minWidth: 0, font: "inherit", fontFamily: font.mono, fontSize: t.sm, padding: "5px 8px" }}
        />
        <Button onClick={go}>Show its mail</Button>
        {initial && (
          <Button kind="quiet" onClick={() => (location.hash = lensHref({}))}>
            Back to the relay
          </Button>
        )}
      </div>
      {error && <Note tone="danger">{error}</Note>}
    </div>
  );
}

// ── One DID's mail ──────────────────────────────────────────────────────────

/**
 * A DID's mail: find the mediator its document names, then — through a relay
 * this wallet already uses there — show what that mediator holds for it.
 *
 * Never opens standing anywhere new (see `mayOperateMediator`): a DID whose
 * mail goes somewhere this wallet is not signed in is answered by naming the
 * mediator and saying so.
 */
function DidMail({ did, relays, parties }: { did: string; relays: KnownRelay[]; parties: Parties }) {
  const found = useAsync(() => mediatorOp<MediatorLocation>({ kind: "locate", did }), [did]);
  const [hash, setHash] = useState<string>();
  useEffect(() => {
    void accountHash(did).then(setHash);
  }, [did]);

  if (found.error) return <LoadError what="where this DID's mail goes" error={found.error} />;
  if (!found.data || !hash) return <Loading what="where this DID's mail goes" />;
  const mediatorDid = found.data.mediatorDid;
  if (!mediatorDid) {
    return (
      <Note tone="warn">
        <Did value={did} size={t.xs} /> names no mediator — its document has no{" "}
        <code>DIDCommMessaging</code> service pointing at one — so no mediator holds mail for it.
      </Note>
    );
  }
  const here = relays.filter((r) => r.mediatorDid === mediatorDid);
  const pair = here.find((r) => r.vtaDid === parties.service.did) ?? here[0];
  if (!pair) {
    return (
      <Note tone="accent">
        <div style={{ display: "grid", gap: 6 }}>
          <span>
            Mail for <Did value={did} size={t.xs} /> goes to <Did value={mediatorDid} size={t.xs} />.
          </span>
          <span style={{ color: c.muted }}>
            This wallet holds no session there, so it has no standing to look. The lens never signs
            in to a relay the wallet does not already use.
          </span>
        </div>
      </Note>
    );
  }
  return (
    <AccountMail
      mediatorDid={pair.mediatorDid}
      vtaDid={pair.vtaDid}
      account={hash}
      did={did}
      parties={parties}
    />
  );
}

/** One account's mail at one relay, looked through as `vtaDid`'s holder. */
function AccountMail({
  mediatorDid,
  vtaDid,
  account,
  did,
  parties,
}: {
  mediatorDid: string;
  vtaDid: string;
  account: string;
  did?: string;
  parties: Parties;
}) {
  const probe = useAsync(() => mediatorOp<MediatorProbe>({ kind: "probe", mediatorDid, vtaDid }), [mediatorDid, vtaDid]);
  const sender = useMemo(() => new MediatorTaskSender(mediatorDid, vtaDid), [mediatorDid, vtaDid]);
  if (probe.error) return <LoadError what="the relay" error={probe.error} />;
  if (!probe.data) return <Loading what="the relay" />;
  const caller: MediatorCaller = { holder: { did: probe.data.holderDid }, mediator: { did: mediatorDid } };
  return (
    <PairContext.Provider value={{ mediatorDid, vtaDid }}>
      <AccountMailBody sender={sender} caller={caller} account={account} did={did} vtaDid={vtaDid} parties={parties} />
    </PairContext.Provider>
  );
}

function AccountMailBody({
  sender,
  caller,
  account,
  did,
  vtaDid,
  parties,
}: {
  sender: MediatorTaskSender;
  caller: MediatorCaller;
  account: string;
  did: string | undefined;
  vtaDid: string;
  parties: Parties;
}) {
  const names = useNames(caller, vtaDid, parties);
  const mine = useAsync(() => mediatorAccountGet(sender, caller, {}), [sender]);
  const [ownHash, setOwnHash] = useState<string>();
  useEffect(() => {
    void accountHash(caller.holder.did).then(setOwnHash);
  }, [caller.holder.did]);

  if (mine.error) return <LoadError what="this wallet's standing at the relay" error={mine.error} />;
  if (!mine.data || !ownHash) return <Loading what="this wallet's standing at the relay" />;
  const own = account === ownHash;
  const wide = standingOf(mine.data).mediatorWide;
  const label = did ? didLabel(did) : (names.get(account) ?? shortHash(account));
  const relayHref = lensHref({ mediatorDid: caller.mediator.did, vtaDid });

  const header = (
    <div style={{ display: "flex", gap: 8, alignItems: "center", flexWrap: "wrap", fontSize: t.sm }}>
      <strong style={{ fontSize: t.md }}>Mail for {label}</strong>
      <span style={{ color: c.muted }}>at {didLabel(caller.mediator.did)}</span>
      <a href={relayHref} style={{ color: c.accent, fontSize: t.xs }}>
        The whole relay →
      </a>
    </div>
  );

  if (!own && !wide) {
    return (
      <div style={{ display: "grid", gap: 12 }}>
        {header}
        <Note tone="accent">
          <div style={{ display: "grid", gap: 8 }}>
            <span>
              The mediator records this wallet as a <strong>{mine.data.accountType}</strong> account
              here, and a standard account sees only its own mail. To see another account's, the
              mediator's administrator promotes this wallet's account to <code>admin</code>:
            </span>
            <GrantLine holderDid={caller.holder.did} mediatorDid={caller.mediator.did} />
          </div>
        </Note>
      </div>
    );
  }
  return (
    <div style={{ display: "grid", gap: 16 }}>
      {header}
      <MailOf sender={sender} caller={caller} account={account} own={own} names={names} />
      <LiveTraffic
        mediatorDid={caller.mediator.did}
        vtaDid={vtaDid}
        names={names}
        wide={false}
        followDids={[account]}
      />
    </div>
  );
}

/** What the mediator holds for one account: its queues, who has not collected
 *  what it sent, and what is waiting for it. Read-only for anyone but the
 *  wallet's own account — clearing someone else's queue belongs in the whole
 *  relay's view, not behind a DID someone clicked. */
function MailOf({
  sender,
  caller,
  account,
  own,
  names,
}: {
  sender: MediatorTaskSender;
  caller: MediatorCaller;
  account: string;
  own: boolean;
  names: Names;
}) {
  const acct = useAsync(
    () => mediatorAccountGet(sender, caller, { did: account, includeStats: true, includeActivity: true }),
    [sender, account],
  );
  const status = useAsync(
    () => mediatorQueueStatus(sender, caller, { ...(own ? {} : { did: account }), includePeers: 8 }),
    [sender, account, own],
  );
  if (acct.error) {
    return (
      <Note tone="warn">
        The mediator has no account it will describe for this DID ({acct.error}). A DID whose
        document names this mediator but that has never signed in to it has no mail held there.
      </Note>
    );
  }
  if (!acct.data) return <Loading what="the account" />;
  const a = acct.data as Account & {
    lastReceivedAt?: number;
    lastAuthenticatedAt?: number;
    stats?: { messagesReceived?: number; messagesSent?: number };
  };
  return (
    <Panel title="Its mail" description="What the mediator is holding for this account, and what this account sent that has not been collected.">
      <div style={{ display: "flex", gap: 8, flexWrap: "wrap", alignItems: "center", fontSize: t.sm }}>
        <Pill tone="off">{a.accountType}</Pill>
        {a.acl.blocked && <Pill tone="danger">blocked</Pill>}
        {a.lastAuthenticatedAt !== undefined && (
          <span style={{ color: c.muted }}>last signed in {formatInstant(a.lastAuthenticatedAt * 1000)}</span>
        )}
        {a.lastReceivedAt !== undefined && (
          <span style={{ color: c.muted }}>· last message in {formatInstant(a.lastReceivedAt * 1000)}</span>
        )}
        {a.stats && (
          <span style={{ color: c.muted }}>
            · {countText(a.stats.messagesReceived)} received, {countText(a.stats.messagesSent)} sent, lifetime
          </span>
        )}
      </div>
      {status.error && <LoadError what="the queues" error={status.error} />}
      {status.data && (
        <div style={{ display: "grid", gap: 6 }}>
          <DepthLine label="receive" depth={status.data.queues.receive} />
          <DepthLine label="send" depth={status.data.queues.send} />
        </div>
      )}
      {status.data?.receivePeers && status.data.receivePeers.length > 0 && (
        <ReadOnlyPeers title="Waiting to be collected, from" peers={status.data.receivePeers} names={names} />
      )}
      {status.data?.sendPeers && status.data.sendPeers.length > 0 && (
        <ReadOnlyPeers title="Sent, and not yet collected by" peers={status.data.sendPeers} names={names} />
      )}
      {status.data && !status.data.sendPeers?.length && !status.data.receivePeers?.length && (
        <span style={{ color: c.faint, fontSize: t.sm }}>
          Nothing is waiting in either direction.
        </span>
      )}
    </Panel>
  );
}

function ReadOnlyPeers({ title, peers, names }: { title: string; peers: PeerDepth[]; names: Names }) {
  return (
    <div style={{ display: "grid", gap: 6 }}>
      <span style={{ fontSize: t.sm, fontWeight: 600 }}>{title}</span>
      <Table<PeerDepth>
        columns={[
          { key: "peer", header: "Account", render: (r) => <Account hash={r.peer} names={names} /> },
          { key: "count", header: "Waiting", render: (r) => <span style={{ fontVariantNumeric: "tabular-nums" }}>{r.count}</span> },
          { key: "bytes", header: "Size", render: (r) => bytesText(r.bytes) },
          { key: "oldest", header: "Oldest", render: (r) => ageText(r.oldestAgeSeconds) },
        ]}
        rows={peers}
        rowKey={(r) => r.peer}
        empty="Nothing waiting."
      />
    </div>
  );
}

// ── One relay ───────────────────────────────────────────────────────────────

function RelayView({ mediatorDid, vtaDid, parties }: { mediatorDid: string; vtaDid: string; parties: Parties }) {
  const probe = useAsync(() => mediatorOp<MediatorProbe>({ kind: "probe", mediatorDid, vtaDid }), [mediatorDid, vtaDid]);
  const sender = useMemo(() => new MediatorTaskSender(mediatorDid, vtaDid), [mediatorDid, vtaDid]);

  if (probe.error) return <LoadError what="the relay" error={probe.error} />;
  if (!probe.data) return <Loading what="the relay" />;
  const p = probe.data;
  const caller: MediatorCaller = { holder: { did: p.holderDid }, mediator: { did: mediatorDid } };
  const tooOld = p.version !== undefined && !meetsMediatorFloor(p.version);

  return (
    <div style={{ display: "grid", gap: 16 }}>
      <div style={{ display: "flex", gap: 8, alignItems: "center", flexWrap: "wrap", fontSize: t.sm }}>
        <strong style={{ fontSize: t.md }}>{didLabel(mediatorDid)}</strong>
        {p.version ? (
          <Pill tone="off">release {p.version}</Pill>
        ) : (
          // Not a warning: the lens does not need the release to work, and a
          // mediator that refuses a task it cannot serve says so itself. The
          // reason is kept for anyone who wants it.
          <span title={p.versionError ?? ""} style={{ color: c.faint, fontSize: t.xs }}>
            release not shown
          </span>
        )}
        <Pill tone={p.isInbox ? "ok" : "off"}>{p.isInbox ? "inbox" : "outbound hop"}</Pill>
        <span style={{ color: c.muted }}>
          as holder <span style={{ fontFamily: font.mono, fontSize: t.xs }}>{shortHash(p.holderDid.split(":").pop() ?? "")}</span>{" "}
          for {didLabel(vtaDid)}
        </span>
      </div>
      {tooOld && (
        <Note tone="warn">
          This mediator runs {p.version}; the lens needs affinidi-messaging-mediator{" "}
          {MEDIATOR_VERSION_FLOOR.join(".")} or later, which serves the operations tasks and
          threads a refusal back to the request that caused it. Nothing below would answer.
        </Note>
      )}
      {!tooOld && (
        <PairContext.Provider value={{ mediatorDid, vtaDid }}>
          <Standing sender={sender} caller={caller} parties={parties} vtaDid={vtaDid} />
        </PairContext.Provider>
      )}
    </div>
  );
}

function useNames(caller: MediatorCaller, vtaDid: string, parties: Parties): Names {
  const [names, setNames] = useState<Names>(new Map());
  useEffect(() => {
    let live = true;
    const labelled: Array<[string, string]> = [
      [caller.holder.did, "this wallet"],
      [vtaDid, `${didLabel(vtaDid)} (agent)`],
      [caller.mediator.did, "the mediator"],
    ];
    if (parties.service.did !== vtaDid) labelled.push([parties.service.did, `${didLabel(parties.service.did)} (agent)`]);
    void accountBook(labelled.map(([d]) => d)).then((book) => {
      if (!live) return;
      const byDid = new Map(labelled);
      const out: Names = new Map();
      for (const [hash, did] of book) out.set(hash, byDid.get(did) ?? did);
      setNames(out);
    });
    return () => {
      live = false;
    };
  }, [caller.holder.did, caller.mediator.did, vtaDid, parties.service.did]);
  return names;
}

function Standing({
  sender,
  caller,
  parties,
  vtaDid,
}: {
  sender: MediatorTaskSender;
  caller: MediatorCaller;
  parties: Parties;
  vtaDid: string;
}) {
  const account = useAsync(
    () => mediatorAccountGet(sender, caller, { includeStats: true, includeActivity: true }),
    [sender, caller.holder.did],
  );
  const names = useNames(caller, vtaDid, parties);
  const [vtaHash, setVtaHash] = useState<string>();
  useEffect(() => {
    void accountHash(vtaDid).then(setVtaHash);
  }, [vtaDid]);

  if (account.error) return <LoadError what="this wallet's account at the mediator" error={account.error} />;
  if (!account.data) return <Loading what="this wallet's account at the mediator" />;
  const standing = standingOf(account.data);

  return (
    <>
      <OwnAccount sender={sender} caller={caller} account={account.data} names={names} onChanged={account.reload} />
      <LiveTraffic
        mediatorDid={caller.mediator.did}
        vtaDid={vtaDid}
        names={names}
        wide={standing.mediatorWide}
        followDids={vtaHash ? [account.data.did, vtaHash] : [account.data.did]}
      />
      {standing.mediatorWide ? (
        <>
          <MediatorWide sender={sender} caller={caller} names={names} />
          <QueuePressure sender={sender} caller={caller} names={names} />
          <Accounts sender={sender} caller={caller} names={names} />
          <MediatorAudit sender={sender} caller={caller} names={names} />
          <MediatorConfig sender={sender} caller={caller} />
        </>
      ) : (
        <Note tone="accent">
          <div style={{ display: "grid", gap: 8 }}>
            <span>
              The mediator records this wallet as a <strong>{account.data.accountType}</strong>{" "}
              account, so it shows this wallet's own queues and traffic and nothing mediator-wide.
              To see the whole relay, the mediator's administrator promotes this account to{" "}
              <code>admin</code>:
            </span>
            <GrantLine holderDid={caller.holder.did} mediatorDid={caller.mediator.did} />
            <span style={{ color: c.muted }}>
              That makes this wallet's key for this agent an administrator of the relay — it can
              then see every account's queues and traffic. It is never offered{" "}
              <code>rootAdmin</code>.
            </span>
          </div>
        </Note>
      )}
    </>
  );
}

function GrantLine({ holderDid, mediatorDid }: { holderDid: string; mediatorDid: string }) {
  const cmd = mediatorGrantCommand({ holderDid, mediatorDid });
  return (
    <div style={{ display: "flex", gap: 8, alignItems: "flex-start" }}>
      <code style={{ fontFamily: font.mono, fontSize: t.xs, wordBreak: "break-all", flex: 1 }}>{cmd}</code>
      <CopyButton value={cmd} title="Copy the command" />
    </div>
  );
}

// ── Your account ────────────────────────────────────────────────────────────

function OwnAccount({
  sender,
  caller,
  account,
  names,
  onChanged,
}: {
  sender: MediatorTaskSender;
  caller: MediatorCaller;
  account: Account;
  names: Names;
  onChanged: () => void;
}) {
  const status = useAsync(() => mediatorQueueStatus(sender, caller, { includePeers: 8 }), [sender]);
  const reload = useCallback(() => {
    status.reload();
    onChanged();
  }, [status, onChanged]);
  const standing = standingOf(account);
  const activity = account as Account & { lastReceivedAt?: number; lastAuthenticatedAt?: number };
  const stats = (account as Account & { stats?: { messagesReceived?: number; messagesSent?: number } }).stats;

  return (
    <Panel
      title="This wallet's account"
      description="How the mediator sees the account your wallet signs in as: what is waiting in
        each of its queues, and who has not collected what it sent."
    >
      <div style={{ display: "flex", gap: 8, flexWrap: "wrap", alignItems: "center", fontSize: t.sm }}>
        <Pill tone={standing.mediatorWide ? "accent" : "off"}>{account.accountType}</Pill>
        {account.acl.blocked && <Pill tone="danger">blocked</Pill>}
        {!standing.local && <Pill tone="warn">not held here for pickup</Pill>}
        {activity.lastAuthenticatedAt !== undefined && (
          <span style={{ color: c.muted }}>last signed in {formatInstant(activity.lastAuthenticatedAt * 1000)}</span>
        )}
        {activity.lastReceivedAt !== undefined && (
          <span style={{ color: c.muted }}>· last message in {formatInstant(activity.lastReceivedAt * 1000)}</span>
        )}
        {stats && (
          <span style={{ color: c.muted }}>
            · {countText(stats.messagesReceived)} received, {countText(stats.messagesSent)} sent, lifetime
          </span>
        )}
      </div>
      {status.error && <LoadError what="the queues" error={status.error} />}
      {status.data && (
        <div style={{ display: "grid", gap: 6 }}>
          <DepthLine label="receive" depth={status.data.queues.receive} />
          <DepthLine label="send" depth={status.data.queues.send} />
        </div>
      )}
      {status.data?.sendPeers && status.data.sendPeers.length > 0 && (
        <PeerTable
          title="Sent, and not yet collected by"
          queue="send"
          peers={status.data.sendPeers}
          names={names}
          sender={sender}
          caller={caller}
          onDone={reload}
        />
      )}
      {status.data?.receivePeers && status.data.receivePeers.length > 0 && (
        <PeerTable
          title="Waiting for this wallet, from"
          queue="receive"
          peers={status.data.receivePeers}
          names={names}
          sender={sender}
          caller={caller}
          onDone={reload}
        />
      )}
      {status.data && !status.data.sendPeers?.length && !status.data.receivePeers?.length && (
        <span style={{ color: c.faint, fontSize: t.sm }}>
          Nothing is waiting in either direction — every message this wallet sent has been
          collected, and nothing is queued for it.
        </span>
      )}
    </Panel>
  );
}

function PeerTable({
  title,
  queue,
  peers,
  names,
  sender,
  caller,
  onDone,
}: {
  title: string;
  queue: Queue;
  peers: PeerDepth[];
  names: Names;
  sender: MediatorTaskSender;
  caller: MediatorCaller;
  onDone: () => void;
}) {
  return (
    <div style={{ display: "grid", gap: 6 }}>
      <span style={{ fontSize: t.sm, fontWeight: 600 }}>{title}</span>
      <Table<PeerDepth>
        columns={[
          { key: "peer", header: "Account", render: (r) => <Account hash={r.peer} names={names} /> },
          { key: "count", header: "Waiting", render: (r) => <span style={{ fontVariantNumeric: "tabular-nums" }}>{r.count}</span> },
          { key: "bytes", header: "Size", render: (r) => bytesText(r.bytes) },
          { key: "oldest", header: "Oldest", render: (r) => ageText(r.oldestAgeSeconds) },
          {
            key: "clear",
            header: "",
            render: (r) => (
              <PurgePeer
                queue={queue}
                peer={r.peer}
                names={names}
                sender={sender}
                caller={caller}
                onDone={onDone}
              />
            ),
          },
        ]}
        rows={peers}
        rowKey={(r) => r.peer}
        empty="Nothing waiting."
      />
    </div>
  );
}

/**
 * Clear one peer's messages from a queue — preview, then confirm, and the
 * confirmation is bound to the preview the person read.
 *
 * `Destructive` hands `commit` only the force flag, so the plan it showed is
 * kept here. Re-previewing inside `commit` would compare two counts taken a
 * moment apart and pass, removing whatever arrived while the person was
 * reading — an approval request among them, on the receive queue.
 */
function PurgePeer({
  queue,
  peer,
  names,
  sender,
  caller,
  onDone,
}: {
  queue: Queue;
  peer: string;
  names: Names;
  sender: MediatorTaskSender;
  caller: MediatorCaller;
  onDone: () => void;
}) {
  const shown = useRef<PurgePlan | null>(null);
  return (
    <Destructive<PurgePlan>
      label="Clear"
      preview={async () => {
        const plan = await purgePreview(sender, caller, { queue, peer });
        shown.current = plan;
        return plan;
      }}
      renderPreview={(plan) => (
        <>
          <strong>
            Remove {plan.matched} message{plan.matched === 1 ? "" : "s"} ({bytesText(plan.matchedBytes)}) from this
            wallet's {queue} queue{queue === "send" ? " addressed to" : " from"} {names.get(peer) ?? shortHash(peer)}.
          </strong>
          <span>
            {queue === "send"
              ? "They were never collected, and removing them means they never will be. If that account comes back, it will not receive them."
              : "They have not been read by this wallet. Anything among them — an approval request included — is gone."}{" "}
            If the queue changes before you confirm, nothing is removed and you are asked again.
          </span>
        </>
      )}
      commit={async () => {
        const plan = shown.current;
        if (!plan) throw new Error("there is no preview to confirm — preview it again");
        await purgeWithPlan(sender, caller, plan);
      }}
      onDone={onDone}
    />
  );
}

// ── Mediator-wide ───────────────────────────────────────────────────────────

function MediatorWide({ sender, caller }: { sender: MediatorTaskSender; caller: MediatorCaller; names: Names }) {
  const stats = useAsync(() => mediatorStats(sender, caller), [sender]);
  const s = stats.data;
  const breaker = s?.forwarding.circuitBreaker;
  return (
    <Panel title="The mediator" description="Lifetime counters since the mediator's store was created, and its live connections.">
      {stats.error && <LoadError what="the mediator's statistics" error={stats.error} />}
      {s && (
        <>
          <Tiles>
            <Tile
              label="WebSockets"
              value={countText(s.connections.websocketActive)}
              {...(s.connections.websocketMax !== undefined ? { sub: `of ${countText(s.connections.websocketMax)}` } : {})}
            />
            <Tile label="Received" value={countText(s.totals.receivedCount)} sub={bytesText(s.totals.receivedBytes)} />
            <Tile label="Sent" value={countText(s.totals.sentCount)} sub={bytesText(s.totals.sentBytes)} />
            <Tile
              label="Forwarding queue"
              value={countText(s.forwarding.queueLength)}
              {...(breaker ? { sub: `breaker ${breaker}` } : {})}
              {...(breaker && breaker !== "closed" ? { tone: c.danger } : {})}
            />
            {s.queues && (
              <Tile
                label="Oldest waiting"
                value={ageText(Math.max(s.queues.receive?.oldestAgeSeconds ?? 0, s.queues.send?.oldestAgeSeconds ?? 0))}
                sub={`${countText(s.queues.accounts)} accounts surveyed`}
              />
            )}
            <Tile label="Up" value={ageText(s.uptimeSeconds)} sub={`release ${s.version}`} />
          </Tiles>
          <div style={{ display: "flex", gap: 12, alignItems: "center" }}>
            <Button kind="quiet" onClick={stats.reload}>
              Refresh
            </Button>
          </div>
        </>
      )}
    </Panel>
  );
}

function QueuePressure({ sender, caller, names }: { sender: MediatorTaskSender; caller: MediatorCaller; names: Names }) {
  const [queue, setQueue] = useState<Queue>("receive");
  const list = useAsync(() => mediatorQueueList(sender, caller, { queue, sort: "saturation", limit: 25 }), [sender, queue]);
  return (
    <Panel
      title="Queue pressure"
      description="Every account's queue, fullest first. Read from the mediator's periodic survey,
        so a count here can be up to a minute old; an account's own view above is live."
    >
      <div style={{ display: "flex", gap: 8, alignItems: "center", flexWrap: "wrap" }}>
        {(["receive", "send"] as const).map((q) => (
          <Button key={q} kind={q === queue ? "primary" : "quiet"} onClick={() => setQueue(q)}>
            {q}
          </Button>
        ))}
        {list.data && (
          <span style={{ color: c.faint, fontSize: t.xs }}>
            survey {formatInstant(list.data.snapshotAt)}
            {list.data.truncated ? " · truncated — the survey stopped early" : ""}
          </span>
        )}
      </div>
      {list.error && <LoadError what="the queue ranking" error={list.error} />}
      {list.data && (
        <Table<QueueSummary>
          columns={[
            { key: "acct", header: "Account", render: (r) => <Account hash={r.did} names={names} /> },
            { key: "role", header: "Role", render: (r) => <span style={{ color: c.muted }}>{r.accountType ?? "—"}</span> },
            { key: "n", header: "Waiting", render: (r) => <span style={{ fontVariantNumeric: "tabular-nums" }}>{r[queue].count}</span> },
            { key: "sat", header: "Of limit", render: (r) => <Bar saturation={saturationOf(r[queue])} /> },
            { key: "old", header: "Oldest", render: (r) => ageText(r[queue].oldestAgeSeconds) },
          ]}
          rows={list.data.queues}
          rowKey={(r) => r.did}
          empty="No account has anything waiting in this queue."
        />
      )}
    </Panel>
  );
}

function Accounts({ sender, caller, names }: { sender: MediatorTaskSender; caller: MediatorCaller; names: Names }) {
  const list = useAsync(() => mediatorAccountList(sender, caller, { limit: 50, includeActivity: true }), [sender]);
  type Row = Account & { lastAuthenticatedAt?: number; lastReceivedAt?: number };
  return (
    <Panel title="Accounts" description="The first page of accounts at this mediator, with when each last signed in.">
      {list.error && <LoadError what="the account list" error={list.error} />}
      {list.data && (
        <Table<Row>
          columns={[
            { key: "acct", header: "Account", render: (r) => <Account hash={r.did} names={names} /> },
            { key: "role", header: "Role", render: (r) => r.accountType },
            { key: "q", header: "Queued", render: (r) => `${r.receiveQueueCount ?? 0} in · ${r.sendQueueCount ?? 0} out` },
            {
              key: "login",
              header: "Last signed in",
              render: (r) => (r.lastAuthenticatedAt ? formatInstant(r.lastAuthenticatedAt * 1000) : <span style={{ color: c.faint }}>—</span>),
            },
            { key: "flags", header: "", render: (r) => (r.acl.blocked ? <Pill tone="danger">blocked</Pill> : null) },
          ]}
          rows={list.data.accounts as Row[]}
          rowKey={(r) => r.did}
          empty="No accounts."
        />
      )}
      {list.data?.nextCursor && (
        <span style={{ color: c.faint, fontSize: t.xs }}>More accounts exist than are shown here.</span>
      )}
    </Panel>
  );
}

function MediatorAudit({ sender, caller, names }: { sender: MediatorTaskSender; caller: MediatorCaller; names: Names }) {
  const log = useAsync(() => auditList(sender, { holder: caller.holder, service: caller.mediator, pageSize: 25 }), [sender]);
  return (
    <Panel title="Audit" description="What administrators did at this mediator — including every traffic-monitor subscription, yours among them.">
      {log.error && <LoadError what="the audit log" error={log.error} />}
      {log.data && (
        <>
          <Table
            columns={[
              { key: "at", header: "When", render: (e) => formatInstant(e.recordedAt) },
              { key: "who", header: "Actor", render: (e) => <Account hash={typeof e.actor === "string" ? e.actor : undefined} names={names} /> },
              { key: "what", header: "Action", render: (e) => <span style={{ fontFamily: font.mono, fontSize: t.xs }}>{e.action}</span> },
              {
                key: "target",
                header: "Target",
                render: (e) => {
                  const target = (e as { target?: unknown }).target;
                  return typeof target === "string" ? <Account hash={target} names={names} /> : <span style={{ color: c.faint }}>—</span>;
                },
              },
            ]}
            rows={log.data.entries}
            rowKey={(e) => e.eventId}
            empty="Nothing recorded yet."
          />
          {log.data.truncated && <Note tone="warn">This page is truncated — it is not a complete account of what happened.</Note>}
        </>
      )}
    </Panel>
  );
}

function MediatorConfig({ sender, caller }: { sender: MediatorTaskSender; caller: MediatorCaller }) {
  const fields = useAsync(() => configShow(sender, { holder: caller.holder, service: caller.mediator }), [sender]);
  const mode = verificationModeOf(fields.data ?? undefined);
  return (
    <Panel
      title="Configuration"
      description="Read-only. Changing a running mediator needs rootAdmin, a standing this wallet is
        never given — use the mediator's own console for that."
    >
      {fields.error && <LoadError what="the configuration" error={fields.error} />}
      {mode === "warn" && (
        <Note tone="warn">
          <strong>Trust-Task verification is set to warn.</strong> An unsigned or stale
          administration task is logged and then <em>run</em>. A mediator that grants admin to
          browser-held keys should set <code>security.trust_task_verification = "enforce"</code>.
        </Note>
      )}
      {mode === "enforce" && <Pill tone="ok">Trust-Task verification enforced</Pill>}
      {fields.data && (
        <Table
          columns={[
            { key: "k", header: "Key", render: (f) => <span style={{ fontFamily: font.mono, fontSize: t.xs }}>{f.key}</span> },
            { key: "v", header: "Value", render: (f) => <span style={{ fontFamily: font.mono, fontSize: t.xs, wordBreak: "break-all" }}>{JSON.stringify(f.value)}</span> },
            { key: "s", header: "Source", render: (f) => <span style={{ color: c.muted }}>{String((f as { source?: unknown }).source ?? "")}</span> },
            { key: "r", header: "", render: (f) => ((f as { requiresRestart?: boolean }).requiresRestart ? <Pill tone="off">restart</Pill> : null) },
          ]}
          rows={fields.data}
          rowKey={(f) => f.key}
          empty="The mediator reported no settings."
        />
      )}
    </Panel>
  );
}

// ── Live traffic ────────────────────────────────────────────────────────────

type TapeLine =
  | { kind: "event"; id: number; event: MonitorEvent }
  | { kind: "gap"; id: number; missing: number }
  | { kind: "dropped"; id: number; dropped: number };

const TAPE_MAX = 300;

function LiveTraffic({
  mediatorDid,
  vtaDid,
  names,
  wide,
  followDids,
}: {
  mediatorDid: string;
  vtaDid: string;
  names: Names;
  wide: boolean;
  followDids: string[];
}) {
  const [running, setRunning] = useState(false);
  const [scope, setScope] = useState<"mine" | "all">("mine");
  const [failuresOnly, setFailuresOnly] = useState(false);
  const [tape, setTape] = useState<TapeLine[]>([]);
  const [status, setStatus] = useState<string>("");
  const [heartbeat, setHeartbeat] = useState<number | null>(null);
  const nextId = useRef(0);
  const closeRef = useRef<(() => void) | null>(null);

  const stop = useCallback(() => {
    closeRef.current?.();
    closeRef.current = null;
    setRunning(false);
  }, []);

  const start = useCallback(() => {
    stop();
    setTape([]);
    setStatus("subscribing…");
    const filter: Record<string, unknown> = {
      ...(scope === "mine" || !wide ? { dids: followDids } : {}),
      ...(failuresOnly ? { failuresOnly: true } : {}),
    };
    setRunning(true);
    closeRef.current = openMonitorPort({ mediatorDid, vtaDid, filter }, (m: MonitorMessage) => {
      if (m.kind === "granted") setStatus(`live · lease to ${formatInstant(m.expiresAt)}`);
      else if (m.kind === "ended") {
        setStatus(`ended — ${m.reason}${m.code ? ` (${m.code})` : ""}`);
        setRunning(false);
        closeRef.current = null;
      } else {
        const u = m.update as
          | { kind: "events"; events: MonitorEvent[]; dropped: number }
          | { kind: "gap"; missing: number }
          | { kind: "heartbeat" };
        if (u.kind === "heartbeat") {
          setHeartbeat(Date.now());
          return;
        }
        const add: TapeLine[] =
          u.kind === "gap"
            ? [{ kind: "gap", id: nextId.current++, missing: u.missing }]
            : [
                ...(u.dropped > 0 ? [{ kind: "dropped" as const, id: nextId.current++, dropped: u.dropped }] : []),
                ...u.events.map((event) => ({ kind: "event" as const, id: nextId.current++, event })),
              ];
        setTape((t0) => capTape(t0, add, TAPE_MAX));
      }
    });
  }, [stop, scope, wide, followDids, failuresOnly, mediatorDid, vtaDid]);

  useEffect(() => stop, [stop]);

  return (
    <Panel
      title="Live traffic"
      description="What the mediator does with messages, as it happens: received, stored, delivered,
        refused. Metadata only — the mediator never reports a message's contents, and every
        administrator's subscription is written to its audit log."
    >
      <div style={{ display: "flex", gap: 10, alignItems: "center", flexWrap: "wrap", fontSize: t.sm }}>
        {running ? (
          <Button onClick={stop}>Stop</Button>
        ) : (
          <Button kind="primary" onClick={start}>
            Watch
          </Button>
        )}
        {wide && (
          <select
            id="lens-scope"
            aria-label="Whose traffic"
            value={scope}
            disabled={running}
            onChange={(e) => setScope(e.target.value as "mine" | "all")}
            style={{ font: "inherit", fontSize: t.sm, padding: "3px 6px" }}
          >
            <option value="mine">this wallet and its agent</option>
            <option value="all">everyone on this mediator</option>
          </select>
        )}
        <label style={{ display: "inline-flex", gap: 6, alignItems: "center" }}>
          <input
            id="lens-failures"
            type="checkbox"
            checked={failuresOnly}
            disabled={running}
            onChange={(e) => setFailuresOnly(e.target.checked)}
          />
          failures only
        </label>
        {status && <span style={{ color: running ? c.ok : c.muted }}>{status}</span>}
        {running && heartbeat && <span style={{ color: c.faint, fontSize: t.xs }}>tap alive {formatInstant(heartbeat)}</span>}
      </div>
      <div
        style={{
          fontFamily: font.mono,
          fontSize: t.xs,
          maxHeight: 320,
          overflowY: "auto",
          border: `1px solid ${c.lineSoft}`,
          borderRadius: "var(--w-r-sm)",
          background: c.ground,
          display: "flex",
          flexDirection: "column-reverse",
        }}
      >
        <div>
          {tape.length === 0 && (
            <div style={{ padding: 10, color: c.faint, fontFamily: font.sans }}>
              {running ? "Nothing has matched yet." : "Press Watch to follow traffic through this relay."}
            </div>
          )}
          {tape.map((line) => (
            <TapeRow key={line.id} line={line} names={names} />
          ))}
        </div>
      </div>
    </Panel>
  );
}

function TapeRow({ line, names }: { line: TapeLine; names: Names }) {
  if (line.kind === "gap") {
    return (
      <div style={{ padding: "3px 10px", color: c.warn }}>
        ⋯ {line.missing} batch{line.missing === 1 ? "" : "es"} lost in transit — events are missing here
      </div>
    );
  }
  if (line.kind === "dropped") {
    return (
      <div style={{ padding: "3px 10px", color: c.warn }}>
        ⋯ the mediator dropped {line.dropped} event{line.dropped === 1 ? "" : "s"} (rate ceiling, or this feed was briefly not live)
      </div>
    );
  }
  const e = line.event;
  const trouble = isTrouble(e);
  const time = e.at.length >= 19 ? e.at.slice(11, 19) : e.at;
  return (
    <div
      style={{
        display: "grid",
        gridTemplateColumns: "64px 14px 78px 150px 1fr",
        gap: 6,
        padding: "2px 10px",
        alignItems: "baseline",
        background: trouble ? c.dangerSoft : undefined,
      }}
    >
      <span style={{ color: c.faint }}>{time}</span>
      <span>{directionGlyph(e.direction)}</span>
      <span style={{ color: trouble ? c.danger : c.text, fontWeight: trouble ? 650 : 400 }}>{e.stage}</span>
      <span style={{ color: c.muted, whiteSpace: "nowrap" }}>
        {e.channel} {e.protocol}
      </span>
      <span style={{ overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
        {e.from && <Account hash={e.from} names={names} />}
        {e.from && e.to && " → "}
        {e.to && <Account hash={e.to} names={names} />}
        {e.size !== undefined && <span style={{ color: c.faint }}> · {bytesText(e.size)}</span>}
        {e.latencyMs !== undefined && <span style={{ color: c.faint }}> · {e.latencyMs} ms</span>}
        {e.outcome && (
          <span style={{ color: c.danger }}>
            {" "}
            · {(e.outcome as { code?: string }).code ?? "failed"}
          </span>
        )}
      </span>
    </div>
  );
}
