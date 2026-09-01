// Services — what the agent advertises, beside what the wallet has observed.
//
// **Advertisement is not availability.** A DID document says what an agent
// *offers*; `buildVtaSession` skips a channel whose mediator it cannot reach
// and falls through to the next, so an agent routinely advertises TSP, DIDComm
// and REST while every byte goes over REST. A services list alone therefore
// answers a different question from the one an operator is asking when
// something misbehaves.
//
// So both columns are shown, and the third state is load-bearing: `up` needs
// positive evidence (a completed mediator handshake and an open socket), `down`
// is a skip the wallet recorded, and `unknown` means **not observed** — a REST
// channel is built from a URL without contacting anything. `unknown` is not a
// failure and must never be rendered as one; presenting it as a problem is how
// an operator ends up chasing a transport that is working.

import { servicesList, serviceDisable, serviceEnable, type ServiceState } from "@openvtc/pnm-core/admin";
import { agentPing } from "@openvtc/pnm-core/admin";
import { useCallback, useState } from "react";
import { Button, Did, Note, Panel, Pill } from "../../ui.js";
import { c, t, font } from "../../theme.js";
import { managerSender } from "../sender.js";
import { ConsentRequiredError } from "../carrier.js";
import { ConsentCeremony, Destructive, runMutation } from "../destructive.js";
import { Loading, LoadError, Table, type Column } from "../table.js";
import { useAsync } from "../use-async.js";
import { useTransportHealth } from "../../use-transport-health.js";
import { hasRole, type Authority, type Parties } from "../use-vta.js";
import type { Transport, TransportObservation } from "../../transports.js";

/** `ServiceKind` → the name `TransportHealth` records observations under. */
const OBSERVED_AS: Partial<Record<ServiceState["kind"], Transport>> = {
  tsp: "TSP",
  didcomm: "DIDComm",
  rest: "REST",
};

function Observed({ observation }: { observation: TransportObservation | undefined }) {
  if (!observation) {
    return (
      <span style={{ color: c.faint }} title="No session has been built over this transport yet.">
        not observed
      </span>
    );
  }
  if (observation.state === "up") return <Pill tone="ok">up</Pill>;
  if (observation.state === "unknown") {
    return (
      <span
        style={{ color: c.faint }}
        title="Built from a URL without contacting anything — construction is not evidence."
      >
        not observed
      </span>
    );
  }
  return (
    <div style={{ display: "grid", gap: 2 }}>
      <Pill tone="danger">down</Pill>
      {observation.detail && (
        <span style={{ color: c.muted, fontSize: t.xs, maxWidth: 320, lineHeight: 1.45 }}>
          {observation.detail}
        </span>
      )}
    </div>
  );
}

function HealthCheck({ parties }: { parties: Parties }) {
  const [result, setResult] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const ping = useCallback(async () => {
    setBusy(true);
    setError(null);
    setResult(null);
    const started = performance.now();
    try {
      await agentPing(managerSender, parties);
      setResult(`answered in ${Math.round(performance.now() - started)} ms`);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  }, [parties]);

  return (
    <Panel
      title="Reachability"
      description="Sends a messaging/ping over whichever transport the wallet actually selects.
        A round trip proves the path this console is using works end to end — which is a
        different claim from any transport being advertised."
    >
      <div style={{ display: "flex", gap: 12, alignItems: "center", flexWrap: "wrap" }}>
        <Button onClick={() => void ping()} disabled={busy}>
          {busy ? "Pinging…" : "Ping agent"}
        </Button>
        {result && <span style={{ color: c.ok, fontSize: t.sm }}>{result}</span>}
        {error && <span style={{ color: c.danger, fontSize: t.sm }}>{error}</span>}
      </div>
    </Panel>
  );
}

export function ServicesPane({
  parties,
  authority,
}: {
  parties: Parties;
  authority: Authority | null;
}) {
  const list = useAsync(
    () => servicesList(managerSender, parties),
    [parties.holder.did, parties.service.did],
  );
  const { health, sessions } = useTransportHealth(parties.service.did);

  const [error, setError] = useState<string | null>(null);
  const [pending, setPending] = useState<ConsentRequiredError | null>(null);

  const denied = authority && !hasRole(authority, "admin", "super-admin")
    ? "Changing a transport needs the admin role at this agent."
    : null;

  const columns: Column<ServiceState>[] = [
    {
      key: "kind",
      header: "Transport",
      render: (s) => <span style={{ fontWeight: 600 }}>{s.kind}</span>,
    },
    {
      key: "advertised",
      header: "Advertised",
      render: (s) => (s.enabled ? <Pill tone="ok">enabled</Pill> : <Pill tone="off">disabled</Pill>),
    },
    {
      key: "observed",
      header: "Observed",
      render: (s) => {
        const key = OBSERVED_AS[s.kind];
        return <Observed observation={key ? health[key] : undefined} />;
      },
    },
    {
      key: "endpoint",
      header: "Endpoint",
      render: (s) => (
        <div style={{ display: "grid", gap: 2, maxWidth: 380 }}>
          {s.mediatorDid && <Did value={s.mediatorDid} size={t.xs} />}
          {s.url && (
            <span style={{ fontFamily: font.mono, fontSize: t.xs, wordBreak: "break-all" }}>
              {s.url}
            </span>
          )}
          {!s.mediatorDid && !s.url && <span style={{ color: c.faint }}>—</span>}
        </div>
      ),
    },
    {
      key: "drain",
      header: "Draining",
      render: (s) =>
        s.drainsUntil ? (
          <span style={{ color: c.warn, whiteSpace: "nowrap" }}>
            until {new Date(s.drainsUntil).toLocaleString()}
          </span>
        ) : (
          <span style={{ color: c.faint }}>—</span>
        ),
    },
    {
      key: "actions",
      header: "",
      render: (s) => (
        <div style={{ minWidth: 190 }}>
          {s.enabled ? (
            <Destructive<ServiceState>
              label="Disable"
              disabledReason={denied}
              preview={async () => s}
              renderPreview={(p) => (
                <>
                  <strong>Disabling {p.kind} stops the agent advertising it.</strong>
                  <span>
                    Anything reaching this agent over {p.kind} falls back to another transport if
                    it has one — and fails outright if it does not. Your wallet's own inbox rides
                    the mediator transports, so disabling one can leave approval requests with
                    nowhere to arrive.
                  </span>
                </>
              )}
              commit={async () => {
                await serviceDisable(managerSender, { ...parties, kind: s.kind });
              }}
              onDone={list.reload}
            />
          ) : (
            <Button
              disabled={Boolean(denied)}
              {...(denied ? { title: denied } : {})}
              onClick={() => {
                setError(null);
                setPending(null);
                void runMutation(
                  async () => {
                    // An empty config is schema-valid — every member of it is
                    // optional — and means "re-enable on whatever you last
                    // held". Inventing a mediator DID here would be this
                    // console deciding one, which it has no basis to do.
                    await serviceEnable(managerSender, {
                      ...parties,
                      kind: s.kind,
                      config: {},
                    });
                  },
                  { onConsent: setPending, onError: setError },
                ).then((ok) => ok && list.reload());
              }}
            >
              Enable
            </Button>
          )}
        </div>
      ),
    },
  ];

  return (
    <div style={{ display: "grid", gap: 16, alignContent: "start" }}>
      <Panel
        title="Transports"
        description="What your agent offers, beside what your wallet has actually seen work. The
          two differ more often than you would expect — a transport can be advertised for months
          while every byte goes over another one."
      >
        {list.error && <LoadError what="the service list" error={list.error} />}
        {list.loading && !list.data && <Loading what="the service list" />}
        {error && <Note tone="danger">{error}</Note>}
        {pending && <ConsentCeremony pending={pending} />}
        {list.data && (
          <Table
            columns={columns}
            rows={list.data}
            rowKey={(s) => s.kind}
            empty="Your agent advertises no transports, which would make it unreachable. That is
              almost certainly wrong rather than deliberate."
          />
        )}
        <Note tone="accent">
          <strong>"Not observed" is not a failure.</strong> A REST channel is built from a URL
          without contacting anything, so construction proves nothing either way — and a
          transport nothing has used yet has simply not been tested. Only <em>down</em> means the
          wallet tried and could not.
        </Note>
      </Panel>

      <HealthCheck parties={parties} />

      <Panel
        title="Mediator sessions"
        description="The live sockets your wallet holds. The one marked as your inbox is the one
          whose death means nothing pushed to this wallet arrives — approval requests included."
      >
        <Table
          columns={[
            { key: "mediator", header: "Mediator", render: (s) => <Did value={s.mediatorDid} /> },
            { key: "vta", header: "For agent", render: (s) => <Did value={s.vtaDid} /> },
            {
              key: "inbox",
              header: "Role",
              render: (s) =>
                s.isInbox ? <Pill tone="ok">inbox</Pill> : <span style={{ color: c.muted }}>outbound</span>,
            },
          ]}
          rows={sessions}
          rowKey={(s) => `${s.mediatorDid}:${s.vtaDid}`}
          empty="No mediator session is open. Nothing pushed to this wallet will arrive —
            including approval requests — until one is."
        />
      </Panel>
    </div>
  );
}
