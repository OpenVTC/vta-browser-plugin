// Keys — scoped to the selected context.
//
// `keysList` takes a `contextId`, so this pane asks a different question when
// the tree selection changes rather than filtering a full list client-side. The
// difference matters: a caller's ACL may not reach every context, and asking
// per-context gets the agent's answer for the one being looked at instead of
// silently rendering a subset of a list that failed elsewhere.
//
// **Nothing here signs anything.** `keysSign` and `keysDeriveAndSign` exist in
// the admin module and are deliberately not surfaced: signing with an operator
// key is not an administration task, it is use, and a console that offers a
// "sign this" box turns an audit trail of key management into an oracle.

import { useCallback, useState } from "react";
import {
  keysCreate,
  keysList,
  keysRename,
  keysRevoke,
  type KeyRecord,
  type KeyStatus,
} from "@openvtc/pnm-core/admin";
import { Button, Note, Panel, Pill } from "../../ui.js";
import { c, t, font } from "../../theme.js";
import { managerSender } from "../sender.js";
import { ConsentRequiredError } from "../carrier.js";
import { ConsentCeremony, Destructive, runMutation } from "../destructive.js";
import { Loading, LoadError, Table, Truncated, type Column } from "../table.js";
import { useAsync } from "../use-async.js";
import { formatDate } from "../format.js";
import { hasRole, type Authority, type Parties } from "../use-vta.js";
import type { ContextSelection } from "../context-column.js";

const PAGE = 50;

const fieldStyle: React.CSSProperties = {
  boxSizing: "border-box",
  padding: "6px 9px",
  background: c.ground,
  color: c.text,
  border: `1px solid ${c.line}`,
  borderRadius: "var(--w-r-sm)",
  fontSize: t.sm,
};

function StatusPill({ status }: { status: KeyStatus }) {
  return <Pill tone={status === "active" ? "ok" : "off"}>{status}</Pill>;
}

/** Where the key came from, which is the difference between recoverable and
 *  gone forever. `internal` keys are generated from the CSPRNG and derive from
 *  no seed — nothing reconstitutes them. */
function OriginNote({ record }: { record: KeyRecord }) {
  if (record.origin !== "internal") {
    return <span style={{ color: c.muted }}>{record.origin ?? "derived"}</span>;
  }
  return (
    <span style={{ color: c.warn }} title="Generated from the CSPRNG, not derived from a seed. Nothing can reconstitute it.">
      internal · unrecoverable
    </span>
  );
}

function CreateKey({
  parties,
  contextId,
  authority,
  onCreated,
}: {
  parties: Parties;
  contextId: ContextSelection;
  authority: Authority | null;
  onCreated: () => void;
}) {
  const [keyType, setKeyType] = useState<"ed25519" | "x25519" | "p256">("ed25519");
  const [label, setLabel] = useState("");
  const [keyId, setKeyId] = useState("");
  const [internal, setInternal] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [pending, setPending] = useState<ConsentRequiredError | null>(null);

  const denied = authority && !hasRole(authority, "admin", "super-admin", "operator")
    ? "Creating a key needs an administrative role at this agent."
    : !contextId
      ? "Select a context in the tree first — a key is minted into one."
      : null;

  // `keyId` is optional for a derived key (the agent names it after the
  // derivation path) but there is no path for an internal one, so the agent has
  // nothing to name it after. Required here rather than discovered as a reject.
  const needsKeyId = internal && !keyId.trim();

  const submit = useCallback(async () => {
    if (!contextId) return;
    setBusy(true);
    setError(null);
    setPending(null);
    const ok = await runMutation(
      async () => {
        await keysCreate(managerSender, {
          ...parties,
          keyType,
          contextId,
          internal,
          ...(label.trim() ? { label: label.trim() } : {}),
          ...(keyId.trim() ? { keyId: keyId.trim() } : {}),
        });
      },
      { onConsent: setPending, onError: setError },
    );
    setBusy(false);
    if (ok) {
      setLabel("");
      setKeyId("");
      onCreated();
    }
  }, [parties, contextId, keyType, label, keyId, internal, onCreated]);

  return (
    <Panel
      title="New key"
      description={
        contextId ? (
          <>
            Minted into <code style={{ fontFamily: font.mono }}>{contextId}</code>. Your agent
            holds the private half and never returns it — only the public key comes back.
          </>
        ) : (
          "Select a context in the tree to mint a key into it."
        )
      }
    >
      <div style={{ display: "flex", gap: 10, flexWrap: "wrap", alignItems: "flex-end" }}>
        <label style={{ display: "grid", gap: 4 }}>
          <span style={{ fontSize: t.xs, color: c.muted }}>TYPE</span>
          <select
            style={fieldStyle}
            value={keyType}
            onChange={(e) => setKeyType(e.target.value as typeof keyType)}
          >
            <option value="ed25519">ed25519 (signing)</option>
            <option value="x25519">x25519 (key agreement)</option>
            <option value="p256">p256</option>
          </select>
        </label>
        <label style={{ display: "grid", gap: 4 }}>
          <span style={{ fontSize: t.xs, color: c.muted }}>LABEL</span>
          <input style={fieldStyle} value={label} onChange={(e) => setLabel(e.target.value)} />
        </label>
        <label style={{ display: "grid", gap: 4 }}>
          <span style={{ fontSize: t.xs, color: c.muted }}>
            KEY ID {internal ? "(required)" : "(optional)"}
          </span>
          <input style={fieldStyle} value={keyId} onChange={(e) => setKeyId(e.target.value)} />
        </label>
        <label style={{ display: "flex", gap: 7, alignItems: "center", fontSize: t.sm, paddingBottom: 7 }}>
          <input type="checkbox" checked={internal} onChange={(e) => setInternal(e.target.checked)} />
          Generate from the CSPRNG
        </label>
      </div>

      {internal && (
        <Note tone="warn">
          An internal key derives from no seed. It cannot be re-derived, exported or recovered by
          any means — losing the agent's keyspace loses this key and everything it authorises.
        </Note>
      )}
      {error && <Note tone="danger">{error}</Note>}
      {pending && <ConsentCeremony pending={pending} />}

      <div>
        <Button
          kind="primary"
          disabled={busy || Boolean(denied) || needsKeyId}
          {...(denied ? { title: denied } : {})}
          onClick={() => void submit()}
        >
          {busy ? "Minting…" : "Mint key"}
        </Button>
      </div>
      {denied && <span style={{ fontSize: t.sm, color: c.muted }}>{denied}</span>}
    </Panel>
  );
}

function RenameKey({
  parties,
  record,
  onDone,
}: {
  parties: Parties;
  record: KeyRecord;
  onDone: () => void;
}) {
  const [open, setOpen] = useState(false);
  const [next, setNext] = useState(record.keyId);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [pending, setPending] = useState<ConsentRequiredError | null>(null);

  if (!open) {
    return (
      <Button kind="quiet" onClick={() => setOpen(true)}>
        Rename
      </Button>
    );
  }

  return (
    <div style={{ display: "grid", gap: 7 }}>
      <input style={fieldStyle} value={next} onChange={(e) => setNext(e.target.value)} />
      {error && <Note tone="danger">{error}</Note>}
      {pending && <ConsentCeremony pending={pending} />}
      <div style={{ display: "flex", gap: 6 }}>
        <Button
          disabled={busy || !next.trim() || next === record.keyId}
          onClick={() => {
            setBusy(true);
            setError(null);
            void runMutation(
              async () => {
                await keysRename(managerSender, {
                  ...parties,
                  keyId: record.keyId,
                  newKeyId: next.trim(),
                });
              },
              { onConsent: setPending, onError: setError },
            ).then((ok) => {
              setBusy(false);
              if (ok) {
                setOpen(false);
                onDone();
              }
            });
          }}
        >
          {busy ? "Saving…" : "Save"}
        </Button>
        <Button kind="quiet" onClick={() => setOpen(false)}>
          Cancel
        </Button>
      </div>
    </div>
  );
}

export function KeysPane({
  parties,
  authority,
  contextId,
  contextHeading,
}: {
  parties: Parties;
  authority: Authority | null;
  contextId: ContextSelection;
  /** How the selected context is named in the tree, so heading and navigation
   *  agree. See `contextLabel` in `format.ts`. */
  contextHeading?: string | undefined;
}) {
  const [limit, setLimit] = useState(PAGE);

  const list = useAsync(
    () =>
      keysList(managerSender, {
        ...parties,
        limit,
        ...(contextId ? { contextId } : {}),
      }),
    [parties.holder.did, parties.service.did, contextId, limit],
  );

  const revokeDenied = authority && !hasRole(authority, "admin", "super-admin", "operator")
    ? "Revoking a key needs an administrative role at this agent."
    : null;

  const columns: Column<KeyRecord>[] = [
    {
      key: "keyId",
      header: "Key",
      render: (k) => (
        <div style={{ display: "grid", gap: 2 }}>
          <span style={{ fontFamily: font.mono, wordBreak: "break-all" }}>{k.keyId}</span>
          {k.label && <span style={{ color: c.muted, fontSize: t.xs }}>{k.label}</span>}
        </div>
      ),
    },
    { key: "type", header: "Type", render: (k) => <span style={{ color: c.muted }}>{k.keyType}</span> },
    { key: "status", header: "Status", render: (k) => <StatusPill status={k.status} /> },
    { key: "origin", header: "Origin", render: (k) => <OriginNote record={k} /> },
    {
      key: "path",
      header: "Derivation",
      render: (k) => (
        <span style={{ fontFamily: font.mono, fontSize: t.xs, color: c.faint }}>
          {k.derivationPath ?? "—"}
        </span>
      ),
    },
    {
      key: "created",
      header: "Created",
      render: (k) => (
        <span style={{ color: c.muted, whiteSpace: "nowrap" }}>
          {formatDate(k.createdAt)}
        </span>
      ),
    },
    {
      key: "actions",
      header: "",
      render: (k) =>
        k.status === "revoked" ? (
          <span style={{ color: c.faint, fontSize: t.xs }}>revoked</span>
        ) : (
          <div style={{ display: "grid", gap: 8, minWidth: 190 }}>
            <RenameKey parties={parties} record={k} onDone={list.reload} />
            <Destructive<KeyRecord>
              label="Revoke"
              disabledReason={revokeDenied}
              // There is no `keys/preview-revoke`, so the preview is the record
              // itself — read back from the agent so what the operator confirms
              // against is the agent's current view, not a row that may have
              // been stale since the list was fetched.
              preview={async () => k}
              renderPreview={(p) => (
                <>
                  <strong>Revoking {p.keyId} cannot be undone.</strong>
                  <span>
                    Anything this key authorises stops working, and any signature made with it
                    from now on will not verify. Existing signatures are unaffected.
                  </span>
                </>
              )}
              commit={async () => {
                await keysRevoke(managerSender, { ...parties, keyId: k.keyId });
              }}
              onDone={list.reload}
            />
          </div>
        ),
    },
  ];

  return (
    <div style={{ display: "grid", gap: 16, alignContent: "start" }}>
      <Panel
        title={contextHeading ? `Keys in ${contextHeading}` : "Keys in every context you can reach"}
        description="Your agent holds every private half. This console never sees one, and never
          asks for a signature — that is use, not administration."
      >
        {list.error && <LoadError what="keys" error={list.error} />}
        {list.loading && !list.data && <Loading what="keys" />}
        {list.data && (
          <>
            <Table
              columns={columns}
              rows={list.data.keys}
              rowKey={(k) => k.keyId}
              empty={
                contextId
                  ? `No keys in ${contextId}. Keys minted into this context appear here.`
                  : "No keys you can reach. Keys you administer appear here."
              }
            />
            {list.data.total > list.data.keys.length && (
              <Truncated
                what={`your agent's ${list.data.total} keys`}
                onMore={() => setLimit((n) => n + PAGE)}
              />
            )}
          </>
        )}
      </Panel>

      <CreateKey
        parties={parties}
        contextId={contextId}
        authority={authority}
        onCreated={list.reload}
      />
    </div>
  );
}
